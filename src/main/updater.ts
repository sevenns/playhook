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
import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { log } from './logger';
import { IPC, type AutoUpdateMode, type UpdateStatus } from '../shared/types';
import { type AppSettingsStore } from './app-settings';
import { ipcMain } from 'electron';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check every 6h for long-running instances

export interface UpdaterDeps {
  readonly settings: AppSettingsStore;
  /** True while ANY in-flight operation runs (not only a running game) — blocks the manual install. */
  readonly isBusy: () => boolean;
  /** Drops both windows' close-guards synchronously right before quitAndInstall (§5.1). */
  readonly beforeInstall: () => void;
}

export class UpdaterService {
  private status: UpdateStatus = { kind: 'idle' };
  private window: BrowserWindow | null = null;
  // True while a user-triggered manual action (check/download) is in flight — the `error` policy uses
  // it to decide whether a network error should surface in the UI or be logged only (I4).
  private activeAction = false;
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

    this.subscribe();
    const settings = await this.deps.settings.read();
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
    ipcMain.handle(IPC.appVersionRequest, (): string => app.getVersion());
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
      this.handleError(err);
    });
  }

  // I4: an `error` from autoUpdater is global and also catches network failures of the BACKGROUND
  // periodic check (routine for a long-lived background app). Only surface it in the UI when it came
  // during a manual action, OR when the current status is not a terminal, useful one — never clobber a
  // downloaded/downloading state (the user still wants to install / see progress) with a background
  // network blip.
  private handleError(err: unknown): void {
    const terminal = this.status.kind === 'downloaded' || this.status.kind === 'downloading';
    if (this.activeAction || !terminal) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ kind: 'error', message });
    }
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

  // A background check does NOT set activeAction, so a network error while a useful state is shown is
  // logged only (see handleError). The status transitions still flow through the shared event handlers.
  private backgroundCheck(): void {
    void autoUpdater.checkForUpdates().catch((cause: unknown) => {
      log.error('[updater] background check failed:', cause);
    });
  }

  check(): void {
    if (!app.isPackaged) return; // unsupported in dev — the IPC is registered but this is a no-op.
    this.activeAction = true;
    // The 'error' event (fired BEFORE the promise rejects) owns the status transition; this .catch only
    // prevents an unhandled rejection and must NOT re-transition, or we'd double the error state (N7).
    void autoUpdater
      .checkForUpdates()
      .catch((cause: unknown) => log.error('[updater] check failed:', cause))
      .finally(() => {
        this.activeAction = false;
      });
  }

  download(): void {
    if (!app.isPackaged) return;
    this.activeAction = true;
    void autoUpdater
      .downloadUpdate()
      .catch((cause: unknown) => log.error('[updater] download failed:', cause))
      .finally(() => {
        this.activeAction = false;
      });
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
