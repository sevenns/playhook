// Auto-update via electron-updater + GitHub Releases (public repo → no client token).
// Background app: historically we downloaded updates silently and let electron-updater install them
// on the NEXT quit (autoInstallOnAppQuit). We deliberately never called quitAndInstall() ourselves,
// so an update could never interrupt a running game — it applied when the user quit from the tray or
// rebooted. Only the packaged nsis build self-updates; in dev (not packaged) this is a no-op.
//
// This file is now a SERVICE (UpdaterService) driving the launcher's Settings screen:
//  • It owns an UpdateStatus snapshot, returns it on request and pushes it to the launcher window on
//    every change (only while that window is attached and alive).
//  • It supports a MANUAL path — check / download / install triggered from the Settings screen. The
//    manual install (quitAndInstall) DOES restart the app, which breaks the original "never interrupt"
//    philosophy, so install() is double-guarded (see below) so it can only run when it's safe.
//  • It applies an auto-update MODE (download-install / download / off) from AppSettingsStore, mapping
//    it onto autoUpdater.autoDownload / autoInstallOnAppQuit and the periodic-check timer.
//
// Two install guards protect the "never interrupt an in-flight operation" invariant:
//  (a) status guard — install only from the `downloaded` snapshot (closes a race where the mode is
//      flipped mid-download and a stale install fires);
//  (b) busy guard — install only when the app is idle/ready/error, i.e. NOT during any in-flight
//      operation (running, launching, installing, uninstalling, syncing-in/out) — not just a running
//      game, because quitAndInstall's app.quit() would also tear down a save-sync or a game install.
//
// Window-guard lifecycle: quitAndInstall() closes ALL app windows BEFORE emitting `before-quit`
// (AppUpdater docs), bypassing main.ts.quit(). GameWindow holds a
// close→preventDefault+hide guard, so the install could hang on those guards. Hence beforeInstall() is
// called SYNCHRONOUSLY right before quitAndInstall() to drop those guards first.
import path from 'node:path';
import fs from 'node:fs/promises';
import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { log } from './logger';
import {
  IPC,
  type AppSettings,
  type AudioOptions,
  type AudioVolumes,
  type AutoUpdateMode,
  type LanguageMode,
  type UpdateStatus,
} from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { type AppSettingsStore } from './app-settings';
import { type NotificationsService } from './notifications';
import { DEFAULT_SOUND_SET } from './asset-reader';
import { ipcMain } from 'electron';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check every 6h for long-running instances

export interface UpdaterDeps {
  readonly settings: AppSettingsStore;
  /**
   * The launcher's notification inbox. Told when an update has finished DOWNLOADING — that is the
   * actionable moment ("it will apply on the next restart"), whereas `available` is a couple of seconds
   * of transit the user can do nothing with (autoDownload is on in every mode but `off`). Its writes are
   * also drained before quitAndInstall, beside the settings store's.
   */
  readonly notifications: NotificationsService;
  /** True while ANY in-flight operation runs (not only a running game) — blocks the manual install. */
  readonly isBusy: () => boolean;
  /** Drops both windows' close-guards synchronously right before quitAndInstall. */
  readonly beforeInstall: () => void;
  /** Applies the Start+Back summon-hotkey toggle to the running global gamepad listener. */
  readonly onSummonHotkeyChanged: (enabled: boolean) => void;
  /** Applies the keep-display-awake toggle (recomputes the powerSaveBlocker in main). */
  readonly onPreventScreensaverChanged: (enabled: boolean) => void;
  /**
   * Applies the Game Mode auto-launch toggle: installs or tears down the watcher service. Steam Deck
   * only; a no-op elsewhere.
   */
  readonly onSteamAutoLaunchChanged: (enabled: boolean) => Promise<void>;
  /** Whether the Steam-shortcut feature exists on this machine (linux + packaged AppImage). */
  readonly isSteamAvailable: () => boolean;
  /** Applies the "always show the no-card screen" toggle (reconciles the launcher's visibility). */
  readonly onKeepOpenWithoutCardChanged: (enabled: boolean) => void;
  /** Pushes new audio volumes to the game renderer so they apply live. */
  readonly onVolumesChanged: (volumes: AudioVolumes) => void;
  /** Applies a navigation-sound-set change (re-reads + re-pushes the current sfx to the game window). */
  readonly onSoundSetChanged: (set: string) => void;
  /** Applies an "only global ambience" toggle (recomputes + re-pushes the card's music). */
  readonly onAudioScopeChanged: () => void;
  /** Applies a default-ambience change (re-reads the track + pushes it to the game window). */
  readonly onAmbientChanged: (track: string | null) => void;
  /** Applies a UI-language change (re-resolve locale, rebuild tray/titles, push to live windows). */
  readonly onLanguageChanged: (mode: LanguageMode) => void;
  /** The current translator (for the install-busy soft error surfaced in the launcher). */
  readonly getTranslator: () => Translator;
}

export class UpdaterService {
  private status: UpdateStatus = { kind: 'idle' };
  private window: BrowserWindow | null = null;
  // Last version reported by `update-available` — carried into the `downloading` snapshot, since the
  // download-progress event itself has no version field.
  private pendingVersion: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: UpdaterDeps) {}

  /**
   * The single point where all update:* / settings:* / app:version IPC is registered, plus (when
   * packaged) autoUpdater subscriptions, the initial check and the periodic timer. Keeping IPC
   * registration here — and NOWHERE else — rules out a duplicate ipcMain.handle (a crash) or a
   * forgotten channel. In dev / non-packaged the IPC is still registered (so the Settings screen can
   * show the version and persist the mode), but there are NO autoUpdater subscriptions and NO timer.
   */
  async init(): Promise<void> {
    this.registerIpc();

    if (!app.isPackaged) {
      this.status = { kind: 'unsupported' };
      log.info('[updater] disabled (not packaged) — the Settings screen still works (version/mode only)');
      return;
    }

    // NSIS differential (delta) downloads try to reuse blocks from the currently-installed version and
    // fall back to a FULL download when that fails (NsisUpdater.doDownloadUpdate). On a fast-moving
    // prerelease channel that fallback happens almost every time, so the user saw TWO 0→100% passes:
    // a failed differential attempt, then the full download. We publish small installers to a public
    // repo, so the delta savings aren't worth it — force a single, clean full download.
    autoUpdater.disableDifferentialDownload = true;

    this.subscribe();
    const settings = await this.deps.settings.read();
    // Pre-release channel: on an alpha build electron-updater defaults allowPrerelease to true; make it
    // explicit from the persisted setting (default false → stable only).
    autoUpdater.allowPrerelease = settings.allowPrerelease;
    this.applyMode(settings.autoUpdate);
    if (settings.autoUpdate !== 'off') this.backgroundCheck();
  }

  /**
   * Attaches the launcher window so status changes are pushed to it, and sends the current snapshot now.
   * Called ONCE at bootstrap: the launcher window is created at startup and lives for the whole session
   * (hiding to the tray does not destroy it), and every push re-checks isDestroyed() anyway.
   */
  attachWindow(window: BrowserWindow): void {
    this.window = window;
    this.pushStatus();
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  // ── IPC ──────────────────────────────────────────────────────────────────

  private registerIpc(): void {
    ipcMain.handle(IPC.updateStatusRequest, (): UpdateStatus => this.status);
    ipcMain.on(IPC.updateCheck, () => this.check());
    ipcMain.on(IPC.updateDownload, () => this.download());
    ipcMain.on(IPC.updateInstall, () => void this.install());
    ipcMain.handle(IPC.settingsRequest, () => this.deps.settings.read());
    // Drives whether the Steam settings are rendered at all — the renderer has no way to know the OS.
    ipcMain.handle(IPC.settingsSteamAvailable, () => this.deps.isSteamAvailable());
    ipcMain.on(IPC.settingsSetAutoUpdate, (_event, mode: AutoUpdateMode) => {
      void this.deps.settings
        .setAutoUpdate(mode)
        .then(() => {
          // Persist always, but only touch autoUpdater in a packaged build.
          if (app.isPackaged) this.applyMode(mode);
        })
        .catch((cause: unknown) =>
          log.error('[updater] failed to persist auto-update mode:', cause),
        );
    });
    ipcMain.on(IPC.settingsSetPrerelease, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ allowPrerelease: on })
        .then(() => {
          if (app.isPackaged) autoUpdater.allowPrerelease = on;
        })
        .catch((cause: unknown) =>
          log.error('[updater] failed to persist prerelease flag:', cause),
        );
    });
    ipcMain.on(IPC.settingsSetSummonHotkey, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ summonHotkeyEnabled: on })
        .then(() => this.deps.onSummonHotkeyChanged(on))
        .catch((cause: unknown) => log.error('[updater] failed to persist summon hotkey:', cause));
    });
    ipcMain.on(IPC.settingsSetPreventScreensaver, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ preventScreensaver: on })
        .then(() => this.deps.onPreventScreensaverChanged(on))
        .catch((cause: unknown) =>
          log.error('[updater] failed to persist prevent-screensaver:', cause),
        );
    });
    ipcMain.on(IPC.settingsSetKeepOpenWithoutCard, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ keepOpenWithoutCard: on })
        .then(() => this.deps.onKeepOpenWithoutCardChanged(on))
        .catch((cause: unknown) =>
          log.error('[updater] failed to persist always-show-empty-screen:', cause),
        );
    });
    // No side-effect on toggle: the install flow reads disableSilentInstall from settings at install time.
    ipcMain.on(IPC.settingsSetSteamAutoLaunch, (_event, on: boolean) => {
      this.deps.settings
        .patch({ steamAutoLaunch: on })
        .then(() => this.deps.onSteamAutoLaunchChanged(on))
        .catch((cause: unknown) => log.error('[updater] failed to set steam auto-launch:', cause));
    });

    ipcMain.on(IPC.settingsSetDisableSilentInstall, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ disableSilentInstall: on })
        .catch((cause: unknown) =>
          log.error('[updater] failed to persist disable-silent-install:', cause),
        );
    });
    ipcMain.on(IPC.settingsSetMusicVolume, (_event, volume: number) => {
      void this.setVolume({ musicVolume: volume });
    });
    ipcMain.on(IPC.settingsSetSfxVolume, (_event, volume: number) => {
      void this.setVolume({ sfxVolume: volume });
    });
    ipcMain.on(IPC.settingsSetSoundSet, (_event, set: string) => {
      void this.deps.settings
        .patch({ soundSet: set })
        .then(() => this.deps.onSoundSetChanged(set))
        .catch((cause: unknown) => log.error('[updater] failed to persist sound set:', cause));
    });
    ipcMain.on(IPC.settingsSetAmbientTrack, (_event, track: string | null) => {
      void this.deps.settings
        .patch({ ambientTrack: track })
        .then(() => this.deps.onAmbientChanged(track))
        .catch((cause: unknown) => log.error('[updater] failed to persist ambient track:', cause));
    });
    ipcMain.on(IPC.settingsSetOnlyGlobalAmbient, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ onlyGlobalAmbient: on })
        .then(() => this.deps.onAudioScopeChanged())
        .catch((cause: unknown) => log.error('[updater] failed to persist only-global-ambient:', cause));
    });
    // Language mirrors the summon-hotkey path: persist, then hand the mode to the deps callback (main
    // re-resolves the locale, rebuilds tray/titles and pushes the effective locale to every live window).
    ipcMain.on(IPC.settingsSetLanguage, (_event, mode: LanguageMode) => {
      void this.deps.settings
        .setLanguage(mode)
        .then(() => this.deps.onLanguageChanged(mode))
        .catch((cause: unknown) => log.error('[updater] failed to persist language:', cause));
    });
    ipcMain.handle(IPC.settingsReset, (): Promise<AppSettings> => this.resetSettings());
    // game-renderer startup: hand it the current volumes to seed its AudioController.
    ipcMain.handle(IPC.volumeRequest, async (): Promise<AudioVolumes> => {
      const settings = await this.deps.settings.read();
      return { music: settings.musicVolume, sfx: settings.sfxVolume };
    });
    ipcMain.handle(IPC.appVersionRequest, (): string => app.getVersion());
    ipcMain.handle(IPC.audioOptionsRequest, (): Promise<AudioOptions> => this.readAudioOptions());
  }

  // Resets settings to defaults and re-applies every side effect (auto-update mode, prerelease flag,
  // summon-hotkey toggle, renderer volumes). The Settings screen repaints from the settings:update push
  // the write itself emits (AppSettingsStore.onChange), not from this return value — which is kept
  // because settings:reset is an invoke.
  private async resetSettings(): Promise<AppSettings> {
    const next = await this.deps.settings.reset();
    if (app.isPackaged) {
      autoUpdater.allowPrerelease = next.allowPrerelease;
      this.applyMode(next.autoUpdate);
    }
    this.deps.onSummonHotkeyChanged(next.summonHotkeyEnabled);
    this.deps.onPreventScreensaverChanged(next.preventScreensaver);
    this.deps.onKeepOpenWithoutCardChanged(next.keepOpenWithoutCard);
    // A reset turns auto-launch back on — the watcher unit has to come back with it, or the setting
    // would say "on" while nothing is actually watching.
    await this.deps.onSteamAutoLaunchChanged(next.steamAutoLaunch);
    this.deps.onVolumesChanged({ music: next.musicVolume, sfx: next.sfxVolume });
    this.deps.onSoundSetChanged(next.soundSet);
    this.deps.onAmbientChanged(next.ambientTrack);
    this.deps.onLanguageChanged(next.language);
    return next;
  }

  // Persists a volume change and pushes the full volume pair to the game renderer so it applies live.
  private async setVolume(
    partial: { musicVolume?: number } | { sfxVolume?: number },
  ): Promise<void> {
    try {
      const next = await this.deps.settings.patch(partial);
      this.deps.onVolumesChanged({ music: next.musicVolume, sfx: next.sfxVolume });
    } catch (cause) {
      log.error('[updater] failed to persist volume:', cause);
    }
  }

  // The bundled sound sets + ambience tracks, read once from dist/audio/index.json (generated at build
  // time by copy-assets — the runtime never does a readdir over the asar). A read/parse failure falls back
  // to a minimal, always-valid set so the settings dropdowns still populate.
  private audioOptions: AudioOptions | null = null;
  private async readAudioOptions(): Promise<AudioOptions> {
    if (this.audioOptions !== null) return this.audioOptions;
    try {
      const text = await fs.readFile(path.join(__dirname, '../audio/index.json'), 'utf8');
      const parsed = JSON.parse(text) as { soundSets?: unknown; ambientTracks?: unknown };
      const asStringArray = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
      const soundSets = asStringArray(parsed.soundSets);
      this.audioOptions = {
        soundSets: soundSets.length > 0 ? soundSets : [DEFAULT_SOUND_SET],
        ambientTracks: asStringArray(parsed.ambientTracks),
      };
    } catch (cause) {
      log.warn('[updater] failed to read audio index — using defaults:', cause);
      this.audioOptions = { soundSets: [DEFAULT_SOUND_SET], ambientTracks: [] };
    }
    return this.audioOptions;
  }

  // ── autoUpdater event mapping ─────────────────────────────────────────

  private subscribe(): void {
    autoUpdater.on('checking-for-update', () => {
      log.info('[updater] checking for update');
      this.setStatus({ kind: 'checking' });
    });
    autoUpdater.on('update-available', (info) => {
      log.info(`[updater] update available: ${info.version}`);
      this.pendingVersion = info.version;
      this.setStatus({ kind: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
      log.info('[updater] up to date');
      this.setStatus({ kind: 'not-available', checkedAt: Date.now() });
    });
    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent);
      log.info(`[updater] downloading ${percent}%`);
      this.setStatus({ kind: 'downloading', version: this.pendingVersion ?? '', percent });
    });
    autoUpdater.on('update-downloaded', (info) => {
      log.info(`[updater] downloaded ${info.version}`);
      this.setStatus({ kind: 'downloaded', version: info.version });
      // The Settings screen only shows this to someone who is already IN the Settings screen; the
      // notification is what reaches everyone else. Deduplicated by version inside the service — the
      // periodic check keeps re-reporting the same downloaded build every 6 hours.
      this.deps.notifications.notifyUpdateReady(info.version);
    });
    autoUpdater.on('error', (err) => {
      log.error('[updater] error:', err);
      this.handleError();
    });
  }

  // We NEVER surface a raw autoUpdater error to the user — those are stack traces / HTTP 404s (e.g. a
  // missing latest.yml on a prerelease channel) that mean nothing to them. The error is already logged
  // above for debugging; here we resolve the UI to a friendly, non-alarming state:
  //  • downloaded / unsupported → left untouched (a ready-to-install update / a dev build);
  //  • downloading that fell over → offer the update again if the version is known, else "up to date";
  //  • anything else (a failed check, idle, available) → "up to date" — the background auto-check /
  //    autoDownload will still pick up a real update later, so this is the least-surprising message.
  private handleError(): void {
    if (this.status.kind === 'downloaded' || this.status.kind === 'unsupported') return;
    if (this.status.kind === 'downloading') {
      this.setStatus(
        this.pendingVersion !== null
          ? { kind: 'available', version: this.pendingVersion }
          : { kind: 'not-available', checkedAt: Date.now() },
      );
      return;
    }
    this.setStatus({ kind: 'not-available', checkedAt: Date.now() });
  }

  // ── Auto-update mode → electron-updater flags + timer ──────────────────

  applyMode(mode: AutoUpdateMode): void {
    autoUpdater.autoDownload = mode !== 'off';
    autoUpdater.autoInstallOnAppQuit = mode === 'download-install';
    this.stopTimer();
    // `off` runs no periodic check — only the manual "Check for updates" button works.
    if (mode !== 'off') {
      this.timer = setInterval(() => this.backgroundCheck(), CHECK_INTERVAL_MS);
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Manual actions (from the settings UI) ──────────────────────────────────

  // Status transitions flow through the shared autoUpdater event handlers; both the background and the
  // manual paths just kick off checkForUpdates and swallow the rejection (the 'error' event, fired
  // BEFORE the promise rejects, already resolved the UI via handleError — re-handling here would double
  // it). The only difference is logging context.
  private backgroundCheck(): void {
    void autoUpdater.checkForUpdates().catch((cause: unknown) => {
      log.error('[updater] background check failed:', cause);
    });
  }

  check(): void {
    if (!app.isPackaged) return; // unsupported in dev — the IPC is registered but this is a no-op.
    void autoUpdater
      .checkForUpdates()
      .catch((cause: unknown) => log.error('[updater] check failed:', cause));
  }

  download(): void {
    if (!app.isPackaged) return;
    void autoUpdater
      .downloadUpdate()
      .catch((cause: unknown) => log.error('[updater] download failed:', cause));
  }

  async install(): Promise<void> {
    // (a) status guard: only from `downloaded` — the UI shows the install button only then, but this
    // also closes the race "mode flipped to off mid-download → stray install".
    if (this.status.kind !== 'downloaded') {
      log.warn('[updater] install ignored: no downloaded update in snapshot');
      return;
    }
    // (b) busy guard: quitAndInstall restarts the app; refuse while any in-flight op is running so we
    // don't tear down a game / save-sync / install. Surface a soft, TRANSIENT error to the window
    // WITHOUT dropping the internal `downloaded` snapshot — so once the app is idle the install button
    // is still there (reopening the window / requestUpdateStatus returns `downloaded`).
    if (this.deps.isBusy()) {
      log.info('[updater] install deferred: app busy');
      this.pushTransient({
        kind: 'error',
        message: this.deps.getTranslator()('errors.finishBeforeInstall'),
      });
      return;
    }
    // Drain any in-flight settings writes FIRST: quitAndInstall tears the process down, and a write cut
    // off mid-flight is the root cause of settings loss after an update. beforeInstall stays SYNCHRONOUS
    // right before quitAndInstall (nothing awaited between them) — its contract of dropping the window
    // close-guards with no yield in the way is preserved.
    await this.deps.settings.flush();
    // Same reason for the inbox: a notification written as the process goes down would come back
    // truncated, and the file is read on the very next start.
    await this.deps.notifications.flush();
    log.info('[updater] installing update — quitAndInstall');
    this.deps.beforeInstall(); // drop both windows' close-guards synchronously first
    autoUpdater.quitAndInstall();
  }

  // ── Pushing status to the settings window ──────────────────────────────────

  private setStatus(next: UpdateStatus): void {
    this.status = next;
    this.pushStatus();
  }

  private pushStatus(): void {
    this.pushTransient(this.status);
  }

  // Sends a status to the window without mutating the internal snapshot — used both for the normal
  // push (with this.status) and for the transient busy-install soft error (which keeps `downloaded`).
  private pushTransient(status: UpdateStatus): void {
    const window = this.window;
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(IPC.updateStatusUpdate, status);
    }
  }
}
