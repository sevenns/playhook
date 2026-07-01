// Application bootstrap (stage 1): single-instance, tray, lifecycle, auto-launch.
// Background app: the window is shown ONLY when a valid game card is detected (state 'ready'); with
// no game it stays hidden in the tray. Closing the window hides it to the tray, not quits.
import path from 'node:path';
import fs from 'node:fs';
import { app, Menu, shell, type Tray } from 'electron';
import { log, logFilePath } from './logger';
import { StateManager } from './state';
import { GameWindow } from './window';
import { PcStore } from './pc-store';
import { AppSettingsStore } from './app-settings';
import { StatsService } from './stats';
import { DriveWatcher } from './drive-watcher';
import { GameController } from './ipc';
import { GlobalGamepad } from './gamepad-global';
import { createTray } from './tray';
import { UpdaterService } from './updater';
import { SettingsWindow } from './settings-window';
import { IPC } from '../shared/types';

let trayRef: Tray | null = null;
let controllerRef: GameController | null = null;
let windowRef: GameWindow | null = null;
let settingsWindowRef: SettingsWindow | null = null;
let globalGamepadRef: GlobalGamepad | null = null;
let quitting = false;
// Whether the global Start+Back summon chord is active (mirrors AppSettings.summonHotkeyEnabled, toggled
// live from the settings window). Read inside the chord callback so a toggle takes effect immediately.
let summonHotkeyEnabled = true;

function configureAutoLaunch(): void {
  // openAtLogin is reliable for an NSIS install; portable is best-effort (R6).
  // No `--hidden` arg needed: the app always starts hidden and only shows on a valid card.
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: true });
}

// Opens the log folder (settings window "Open logs" — moved here from the tray menu).
function openLogs(): void {
  void shell.openPath(path.dirname(logFilePath()));
}

// Opens the app-controlled games install root (%LOCALAPPDATA%\playhook\games; see manifest.ts). Created
// on first use so there's always something to open. On non-Windows dev LOCALAPPDATA is absent — fall
// back to appData so the action opens something rather than erroring.
function openGamesFolder(): void {
  const localAppData = process.env['LOCALAPPDATA'];
  const base = localAppData !== undefined && localAppData !== '' ? localAppData : app.getPath('appData');
  const dir = path.join(base, 'playhook', 'games');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort: openPath below will surface nothing if the dir couldn't be created
  }
  void shell.openPath(dir);
}

function quit(): void {
  quitting = true;
  controllerRef?.shutdown();
  globalGamepadRef?.stop();
  windowRef?.allowClose();
  settingsWindowRef?.allowClose();
  app.quit();
}

async function bootstrap(): Promise<void> {
  // No application menu (removes the File/Edit/View… bar entirely).
  Menu.setApplicationMenu(null);

  log.info(`[main] starting v${app.getVersion()} — log file: "${logFilePath()}"`);

  const store = new PcStore(app.getPath('userData'));
  await store.init();

  const settings = new AppSettingsStore(app.getPath('userData'));
  summonHotkeyEnabled = (await settings.read()).summonHotkeyEnabled;

  const state = new StateManager();
  const window = new GameWindow();
  const stats = new StatsService(store);
  const watcher = new DriveWatcher();

  windowRef = window;
  const controller = new GameController({ state, window, store, stats, watcher });
  controllerRef = controller;
  controller.init();

  // Update service + settings window. isBusy covers ALL in-flight states (not just a running game),
  // so a manual install can't tear down a save-sync / game install (§5, N4). beforeInstall drops both
  // windows' close-guards synchronously before quitAndInstall (§5.1, B1).
  const updater = new UpdaterService({
    settings,
    isBusy: () => {
      const kind = state.get().kind;
      return kind !== 'idle' && kind !== 'ready' && kind !== 'error';
    },
    beforeInstall: () => {
      quitting = true;
      window.allowClose();
      settingsWindow.allowClose();
    },
    openLogs,
    openGamesFolder,
    onSummonHotkeyChanged: (enabled) => {
      summonHotkeyEnabled = enabled;
    },
    onVolumesChanged: (volumes) => {
      const bw = window.browserWindow;
      if (bw !== null && !bw.isDestroyed()) bw.webContents.send(IPC.volumeUpdate, volumes);
    },
  });
  const settingsWindow = new SettingsWindow(updater);
  settingsWindowRef = settingsWindow;

  window.create();
  // Always start hidden in the tray — the window appears only when a valid game card is detected
  // (GameController shows it on the 'ready' state). No black "Insert a game card" screen on launch.

  trayRef = createTray({
    onShow: () => window.showAndFocus(),
    onOpenSettings: () => settingsWindow.openOrFocus(),
    onQuit: () => quit(),
  });

  // Global Start+Back hotkey: re-summon the launcher when it's hidden (e.g. minimized to the tray
  // while a card is ready). Deliberately a NO-OP while a game is running: pulling the launcher over
  // a running game only causes focus trouble, and there's nothing to do mid-game.
  const globalGamepad = new GlobalGamepad();
  globalGamepadRef = globalGamepad;
  globalGamepad.onChord(() => {
    if (!summonHotkeyEnabled) return; // toggled off in the settings window
    if (state.get().kind === 'running') return;
    window.showAndFocus(true);
  });
  globalGamepad.start();

  watcher.start();
  configureAutoLaunch();
  // Registers all update:* / settings:* / app:version IPC synchronously, then (packaged only) wires
  // autoUpdater + the periodic timer per the persisted auto-update mode.
  updater.init().catch((cause: unknown) => log.error('[updater] init failed:', cause));
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
    settingsWindowRef?.allowClose();
  });

  app.whenReady().then(bootstrap).catch((cause: unknown) => {
    log.error('[main] bootstrap failed:', cause);
    app.quit();
  });
}
