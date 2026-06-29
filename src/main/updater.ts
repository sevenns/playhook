// Auto-update via electron-updater + GitHub Releases (public repo → no client token).
// Background app: we download updates silently and let electron-updater install them on the NEXT
// quit (autoInstallOnAppQuit). We deliberately never call quitAndInstall() ourselves, so an update
// can never interrupt a running game — it applies when the user quits from the tray or reboots.
// Only the packaged nsis build self-updates; in dev (not packaged) this is a no-op.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { log } from './logger';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check every 6h for long-running instances

export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    log.info('[updater] disabled (not packaged)');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => log.info('[updater] checking for update'));
  autoUpdater.on('update-available', (info) => log.info(`[updater] update available: ${info.version}`));
  autoUpdater.on('update-not-available', () => log.info('[updater] up to date'));
  autoUpdater.on('download-progress', (p) =>
    log.info(`[updater] downloading ${Math.round(p.percent)}%`),
  );
  autoUpdater.on('update-downloaded', (info) =>
    log.info(`[updater] downloaded ${info.version} — will install on next quit`),
  );
  autoUpdater.on('error', (err) => log.error('[updater] error:', err));

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch((cause: unknown) => {
      log.error('[updater] check failed:', cause);
    });
  };

  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
