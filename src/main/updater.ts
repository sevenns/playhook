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
//  • It applies an auto-update MODE (download-install / download / off) — read from AppSettingsStore at
//    startup, then handed over by SettingsService on every change — mapping it onto
//    autoUpdater.autoDownload / autoInstallOnAppQuit and the periodic-check timer.
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
import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { log } from './logger';
import { IPC, type AutoUpdateMode, type UpdateStatus } from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { type AppSettingsStore } from './app-settings';
import { type NotificationsService } from './notifications';
import { ipcMain } from 'electron';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check every 6h for long-running instances

/**
 * Whether this build can self-update at all: it must be PACKAGED, and it must not be the macOS one —
 * Squirrel.Mac only applies an update to a code-signed bundle, and this project ships an unsigned dmg
 * (no Apple Developer account). Everywhere that would otherwise touch `autoUpdater` asks this first, so the macOS build cannot
 * start a check whose install step is guaranteed to fail.
 */
function updatesSupported(): boolean {
  return app.isPackaged && process.platform !== 'darwin';
}

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
   * The single point where all update:* IPC is registered, plus (when packaged) autoUpdater
   * subscriptions, the initial check and the periodic timer. Keeping IPC registration here — and
   * NOWHERE else — rules out a duplicate ipcMain.handle (a crash) or a forgotten channel. In dev /
   * non-packaged the IPC is still registered (so the Settings screen can show the status), but there
   * are NO autoUpdater subscriptions and NO timer. The settings:* channels live in SettingsService.
   */
  async init(): Promise<void> {
    this.registerIpc();

    // macOS FIRST, before the packaged check: Squirrel.Mac refuses to apply an update to an app bundle
    // that is not code-signed, and this build is not (no Apple Developer account). Wiring autoUpdater
    // anyway would mean a check that finds a version, downloads it and then fails at install — so the
    // Settings screen is told to explain manual updating instead.
    //
    // The order matters: on macOS this holds for a DEV run too, so reporting `not-packaged` there would be
    // the less true of two truths — and it would show a developer on a Mac a screen the user never sees
    // (the auto-update mode rows), which is exactly the kind of false green this port has to avoid.
    if (process.platform === 'darwin') {
      this.status = { kind: 'unsupported', reason: 'platform' };
      log.info('[updater] disabled on macOS (unsigned build — Squirrel.Mac requires a signed bundle)');
      return;
    }

    if (!app.isPackaged) {
      this.status = { kind: 'unsupported', reason: 'not-packaged' };
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
  }

  // ── Settings side effects (handed over by SettingsService) ────────────────

  /**
   * Applies a persisted auto-update mode. Persisting is SettingsService's job; this only touches
   * autoUpdater, and only in a build that can self-update at all.
   */
  applyAutoUpdateMode(mode: AutoUpdateMode): void {
    if (updatesSupported()) this.applyMode(mode);
  }

  /** Applies the pre-release channel flag, under the same guard as the mode. */
  setAllowPrerelease(on: boolean): void {
    if (updatesSupported()) autoUpdater.allowPrerelease = on;
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

  private applyMode(mode: AutoUpdateMode): void {
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
    if (!updatesSupported()) return; // dev / macOS — the IPC is registered but this is a no-op.
    void autoUpdater
      .checkForUpdates()
      .catch((cause: unknown) => log.error('[updater] check failed:', cause));
  }

  download(): void {
    if (!updatesSupported()) return;
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

  // ── Pushing status to the Settings screen ──────────────────────────────────

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
