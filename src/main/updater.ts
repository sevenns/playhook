// Auto-update via electron-updater + GitHub Releases (public repo → no client token).
// Background app: historically we downloaded updates silently and let electron-updater install them
// on the NEXT quit (autoInstallOnAppQuit). We deliberately never called quitAndInstall() ourselves,
// so an update could never interrupt a running game — it applied when the user quit from the tray or
// rebooted. Only the packaged nsis build self-updates; in dev (not packaged) this is a no-op.
//
// This file is now a SERVICE (UpdaterService) driving the settings window:
//  • It owns an UpdateStatus snapshot, returns it on request and pushes it to the settings window on
//    every change (only while that window is attached and alive).
//  • It supports a MANUAL path — check / download / install triggered from the settings UI. The
//    manual install (quitAndInstall) DOES restart the app, which breaks the original "never interrupt"
//    philosophy, so install() is double-guarded (see below) so it can only run when it's safe.
//  • It applies an auto-update MODE (download-install / download / off) from AppSettingsStore, mapping
//    it onto autoUpdater.autoDownload / autoInstallOnAppQuit and the periodic-check timer.
//
// Two install guards protect the "never interrupt an in-flight operation" invariant (§5):
//  (a) status guard — install only from the `downloaded` snapshot (closes a race where the mode is
//      flipped mid-download and a stale install fires);
//  (b) busy guard — install only when the app is idle/ready/error, i.e. NOT during any in-flight
//      operation (running, launching, installing, uninstalling, syncing-in/out) — not just a running
//      game, because quitAndInstall's app.quit() would also tear down a save-sync or a game install.
//
// Window-guard lifecycle (§5.1): quitAndInstall() closes ALL app windows BEFORE emitting `before-quit`
// (AppUpdater docs), bypassing main.ts.quit(). Both GameWindow and SettingsWindow hold a
// close→preventDefault+hide guard, so the install could hang on those guards. Hence beforeInstall() is
// called SYNCHRONOUSLY right before quitAndInstall() to drop both windows' guards first.
import path from 'node:path';
import fs from 'node:fs/promises';
import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { log } from './logger';
import {
  IPC,
  type AppSettings,
  type AudioVolumes,
  type AutoUpdateMode,
  type ThemeMode,
  type UpdateStatus,
} from '../shared/types';
import { type AppSettingsStore } from './app-settings';
import { ipcMain } from 'electron';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check every 6h for long-running instances

export interface UpdaterDeps {
  readonly settings: AppSettingsStore;
  /** True while ANY in-flight operation runs (not only a running game) — blocks the manual install. */
  readonly isBusy: () => boolean;
  /** Drops both windows' close-guards synchronously right before quitAndInstall (§5.1). */
  readonly beforeInstall: () => void;
  /** Opens the log folder in the OS file manager (settings window "Open logs"). */
  readonly openLogs: () => void;
  /** Opens the games install folder in the OS file manager (settings window "Open games folder"). */
  readonly openGamesFolder: () => void;
  /** Applies the Start+Back summon-hotkey toggle to the running global gamepad listener. */
  readonly onSummonHotkeyChanged: (enabled: boolean) => void;
  /** Pushes new audio volumes to the game renderer so they apply live. */
  readonly onVolumesChanged: (volumes: AudioVolumes) => void;
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
   * forgotten channel. In dev / non-packaged the IPC is still registered (so the settings window can
   * show the version and persist the mode), but there are NO autoUpdater subscriptions and NO timer.
   */
  async init(): Promise<void> {
    this.registerIpc();

    if (!app.isPackaged) {
      this.status = { kind: 'unsupported' };
      log.info('[updater] disabled (not packaged) — settings window still works (version/mode only)');
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

  /** Attaches the settings window so status changes are pushed to it. Sends the current snapshot now. */
  attachWindow(window: BrowserWindow): void {
    this.window = window;
    this.pushStatus();
  }

  /** Detaches the settings window (on hide/close) so nothing is pushed to a hidden/destroyed window. */
  detachWindow(): void {
    this.window = null;
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  // ── IPC ──────────────────────────────────────────────────────────────────

  private registerIpc(): void {
    ipcMain.handle(IPC.updateStatusRequest, (): UpdateStatus => this.status);
    ipcMain.on(IPC.updateCheck, () => this.check());
    ipcMain.on(IPC.updateDownload, () => this.download());
    ipcMain.on(IPC.updateInstall, () => this.install());
    ipcMain.handle(IPC.settingsRequest, () => this.deps.settings.read());
    ipcMain.on(IPC.settingsSetAutoUpdate, (_event, mode: AutoUpdateMode) => {
      void this.deps.settings
        .setAutoUpdate(mode)
        .then(() => {
          // A7: persist always, but only touch autoUpdater in a packaged build.
          if (app.isPackaged) this.applyMode(mode);
        })
        .catch((cause: unknown) => log.error('[updater] failed to persist auto-update mode:', cause));
    });
    // Theme is a pure renderer concern — persist it so the choice survives a restart; nothing to apply
    // in main (the settings renderer applies the theme live via setTheme).
    ipcMain.on(IPC.settingsSetTheme, (_event, mode: ThemeMode) => {
      void this.deps.settings
        .setTheme(mode)
        .catch((cause: unknown) => log.error('[updater] failed to persist theme:', cause));
    });
    ipcMain.on(IPC.settingsSetPrerelease, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ allowPrerelease: on })
        .then(() => {
          if (app.isPackaged) autoUpdater.allowPrerelease = on;
        })
        .catch((cause: unknown) => log.error('[updater] failed to persist prerelease flag:', cause));
    });
    ipcMain.on(IPC.settingsSetSummonHotkey, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ summonHotkeyEnabled: on })
        .then(() => this.deps.onSummonHotkeyChanged(on))
        .catch((cause: unknown) => log.error('[updater] failed to persist summon hotkey:', cause));
    });
    ipcMain.on(IPC.settingsSetMusicVolume, (_event, volume: number) => {
      void this.setVolume({ musicVolume: volume });
    });
    ipcMain.on(IPC.settingsSetSfxVolume, (_event, volume: number) => {
      void this.setVolume({ sfxVolume: volume });
    });
    ipcMain.handle(IPC.settingsReset, (): Promise<AppSettings> => this.resetSettings());
    // game-renderer startup: hand it the current volumes to seed its AudioController.
    ipcMain.handle(IPC.volumeRequest, async (): Promise<AudioVolumes> => {
      const settings = await this.deps.settings.read();
      return { music: settings.musicVolume, sfx: settings.sfxVolume };
    });
    ipcMain.handle(IPC.appVersionRequest, (): string => app.getVersion());
    ipcMain.handle(IPC.appIconRequest, (): Promise<string> => this.readIconDataUrl());
    // Imperative maintenance actions — the logic (paths, shell) lives in main.ts callbacks; registered
    // here only to keep every settings-window channel in one place (avoids a duplicate handler).
    ipcMain.on(IPC.openLogs, () => this.deps.openLogs());
    ipcMain.on(IPC.openGamesFolder, () => this.deps.openGamesFolder());
  }

  // Resets settings to defaults and re-applies every side effect (auto-update mode, prerelease flag,
  // summon-hotkey toggle, game-renderer volumes). Theme is re-applied by the settings renderer from the
  // returned AppSettings. Returns the defaults so the settings UI can re-render its controls.
  private async resetSettings(): Promise<AppSettings> {
    const next = await this.deps.settings.reset();
    if (app.isPackaged) {
      autoUpdater.allowPrerelease = next.allowPrerelease;
      this.applyMode(next.autoUpdate);
    }
    this.deps.onSummonHotkeyChanged(next.summonHotkeyEnabled);
    this.deps.onVolumesChanged({ music: next.musicVolume, sfx: next.sfxVolume });
    return next;
  }

  // Persists a volume change and pushes the full volume pair to the game renderer so it applies live.
  private async setVolume(partial: { musicVolume?: number } | { sfxVolume?: number }): Promise<void> {
    try {
      const next = await this.deps.settings.patch(partial);
      this.deps.onVolumesChanged({ music: next.musicVolume, sfx: next.sfxVolume });
    } catch (cause) {
      log.error('[updater] failed to persist volume:', cause);
    }
  }

  // The settings window shows the app icon in its custom title bar. CSP there is `img-src data:`, so we
  // hand the icon over as a data URL rather than a file path. Read once and cache.
  private iconDataUrl: string | null = null;
  private async readIconDataUrl(): Promise<string> {
    if (this.iconDataUrl !== null) return this.iconDataUrl;
    try {
      const buffer = await fs.readFile(path.join(__dirname, '../icon.png'));
      this.iconDataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
    } catch (cause) {
      log.error('[updater] failed to read app icon:', cause);
      this.iconDataUrl = ''; // empty → the renderer just hides the <img>
    }
    return this.iconDataUrl;
  }

  // ── autoUpdater event mapping (§3) ─────────────────────────────────────────

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

  // ── Auto-update mode → electron-updater flags + timer (§4) ──────────────────

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
  // it, N7). The only difference is logging context.
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

  install(): void {
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
        message: 'Finish what’s running before installing the update.',
      });
      return;
    }
    log.info('[updater] installing update — quitAndInstall');
    this.deps.beforeInstall(); // drop both windows' close-guards synchronously (§5.1) first
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
