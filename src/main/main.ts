// Application bootstrap (stage 1): single-instance, tray, lifecycle, auto-launch.
// Background app: the window is shown when a card is inserted or manually via the tray;
// closing the window hides it to the tray instead of quitting the program.
import path from 'node:path';
import { app, Menu, shell, type Tray } from 'electron';
import { log, logFilePath } from './logger';
import { StateManager } from './state';
import { GameWindow } from './window';
import { PcStore } from './pc-store';
import { StatsService } from './stats';
import { DriveWatcher } from './drive-watcher';
import { GameController } from './ipc';
import { GlobalGamepad } from './gamepad-global';
import { createTray } from './tray';

// Hidden start (auto-launch): `openAsHidden` is macOS-only and is ignored on Windows (R6),
// so we implement it ourselves via the `--hidden` arg + a manual process.argv check.
const startedHidden = process.argv.includes('--hidden');

let trayRef: Tray | null = null;
let controllerRef: GameController | null = null;
let windowRef: GameWindow | null = null;
let globalGamepadRef: GlobalGamepad | null = null;
let quitting = false;

function configureAutoLaunch(): void {
  // openAtLogin is reliable for an NSIS install; portable is best-effort (R6).
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
}

function quit(): void {
  quitting = true;
  controllerRef?.shutdown();
  globalGamepadRef?.stop();
  windowRef?.allowClose();
  app.quit();
}

async function bootstrap(): Promise<void> {
  // No application menu (removes the File/Edit/View… bar entirely).
  Menu.setApplicationMenu(null);

  log.info(`[main] starting v${app.getVersion()} — log file: "${logFilePath()}"`);

  const store = new PcStore(app.getPath('userData'));
  await store.init();

  const state = new StateManager();
  const window = new GameWindow();
  const stats = new StatsService(store);
  const watcher = new DriveWatcher();

  windowRef = window;
  const controller = new GameController({ state, window, store, stats, watcher });
  controllerRef = controller;
  controller.init();

  window.create();
  // A manual launch shows the window (provides feedback); auto-launch (--hidden) goes to the tray.
  if (!startedHidden) window.showAndFocus();

  trayRef = createTray({
    onShow: () => window.showAndFocus(),
    onOpenLogs: () => void shell.openPath(path.dirname(logFilePath())),
    onQuit: () => quit(),
  });

  // Global Start+Back hotkey: re-summon the launcher when it's hidden (e.g. minimized to the tray
  // while a card is ready). Deliberately a NO-OP while a game is running: pulling the launcher over
  // a running game only causes focus trouble, and there's nothing to do mid-game.
  const globalGamepad = new GlobalGamepad();
  globalGamepadRef = globalGamepad;
  globalGamepad.onChord(() => {
    if (state.get().kind === 'running') return;
    window.showAndFocus(true);
  });
  globalGamepad.start();

  watcher.start();
  configureAutoLaunch();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // A second instance just brings the current one's window forward. argv is mangled on
  // Windows Chromium (#20322) — we don't rely on it; if needed, data would go via additionalData.
  app.on('second-instance', () => {
    windowRef?.showAndFocus();
  });

  // A background app doesn't quit when the window is closed/hidden — it lives in the tray.
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    controllerRef?.shutdown();
    globalGamepadRef?.stop();
    windowRef?.allowClose();
  });

  app.whenReady().then(bootstrap).catch((cause: unknown) => {
    log.error('[main] bootstrap failed:', cause);
    app.quit();
  });
}
