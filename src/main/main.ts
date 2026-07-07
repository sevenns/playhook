// Application bootstrap: single-instance, tray, lifecycle, auto-launch.
// Background app: the window is shown ONLY when a valid game card is detected (state 'ready'); with
// no game it stays hidden in the tray. Closing the window hides it to the tray, not quits.
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, ipcMain, Menu, shell, type Tray } from 'electron';
import { log, logFilePath } from './logger';
import { StateManager } from './state';
import { GameWindow } from './window';
import { PcStore } from './pc-store';
import { AppSettingsStore } from './app-settings';
import { StatsService } from './stats';
import { DriveWatcher } from './drive-watcher';
import { GameController } from './ipc';
import { GlobalGamepad } from './gamepad-global';
import { createTray, buildTrayMenu, type TrayCallbacks } from './tray';
import { UpdaterService } from './updater';
import { SettingsWindow } from './settings-window';
import { GameConfigService } from './game-config';
import { ConfigureWindow } from './configure-window';
import { LocaleService } from './locale';
import { createPowerService } from './power';
import { suspendToSleep } from './power-native';
import { IPC } from '../shared/types';
import { type Locale } from '../shared/i18n/index';

const execFileAsync = promisify(execFile);

// Keep-alive reference so the Tray (and its icon) isn't garbage-collected; also read to rebuild the
// context menu on a language change (setContextMenu in applyLanguage).
let trayRef: Tray | null = null;
let controllerRef: GameController | null = null;
let windowRef: GameWindow | null = null;
let settingsWindowRef: SettingsWindow | null = null;
let configureWindowRef: ConfigureWindow | null = null;
let globalGamepadRef: GlobalGamepad | null = null;
let quitting = false;
// Whether the global Start+Back summon chord is active (mirrors AppSettings.summonHotkeyEnabled, toggled
// live from the settings window). Read inside the chord callback so a toggle takes effect immediately.
let summonHotkeyEnabled = true;

function configureAutoLaunch(): void {
  // openAtLogin is reliable for an NSIS install; portable is best-effort.
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
  configureWindowRef?.allowClose();
  app.quit();
}

async function bootstrap(): Promise<void> {
  // No application menu (removes the File/Edit/View… bar entirely).
  Menu.setApplicationMenu(null);

  log.info(`[main] starting v${app.getVersion()} — log file: "${logFilePath()}"`);

  const store = new PcStore(app.getPath('userData'));
  await store.init();

  const settings = new AppSettingsStore(app.getPath('userData'));
  const initialSettings = await settings.read();
  summonHotkeyEnabled = initialSettings.summonHotkeyEnabled;

  // Resolve the effective UI locale ONCE at startup from the persisted mode (the system locale is not
  // watched live — a Windows display-language change requires a sign-out and app restart anyway).
  // localeService.t is read live by every consumer, so a later setMode applies everywhere.
  const localeService = new LocaleService(initialSettings.language);
  const getTranslator = (): typeof localeService.t => localeService.t;

  const state = new StateManager();
  const window = new GameWindow(getTranslator);
  const stats = new StatsService(store);
  const watcher = new DriveWatcher();

  windowRef = window;
  const controller = new GameController({ state, window, store, stats, watcher, settings, getTranslator });
  controllerRef = controller;
  controller.init();

  // Update service + settings window. isBusy covers ALL in-flight states (not just a running game),
  // so a manual install can't tear down a save-sync / game install. beforeInstall drops both
  // windows' close-guards synchronously before quitAndInstall.
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
      configureWindow.allowClose();
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
    // A general "Reset to defaults" writes customWallpaper=null, but the copied file must be deleted
    // separately — delegate to the controller (it owns the AssetReader + the game window push).
    onWallpaperReset: () => controller.resetCustomWallpaper(),
    onLanguageChanged: (mode) => applyLanguage(mode),
    getTranslator,
  });
  const settingsWindow = new SettingsWindow(updater, getTranslator);
  settingsWindowRef = settingsWindow;

  // Configure-game window + its backend. getActiveRoot / reloadManifest come from the controller/watcher
  // (interface-DI); the theme comes from the same settings store the settings window uses.
  const gameConfig = new GameConfigService({
    settings,
    getActiveRoot: () => watcher.getActiveRoot(),
    reloadManifest: (root) => controller.reloadManifest(root),
    getTranslator,
  });
  gameConfig.init();
  const configureWindow = new ConfigureWindow(gameConfig, getTranslator);
  configureWindowRef = configureWindow;

  window.create();
  // Always start hidden in the tray — the window appears only when a valid game card is detected
  // (GameController shows it on the 'ready' state). No black "Insert a game card" screen on launch.

  const trayCallbacks: TrayCallbacks = {
    onShow: () => window.showAndFocus(),
    onOpenConfigureGame: () => configureWindow.openOrFocus(),
    onOpenSettings: () => settingsWindow.openOrFocus(),
    onQuit: () => quit(),
  };
  trayRef = createTray(localeService.t, trayCallbacks);

  // UI-locale wiring. Each window seeds via an invoke (effective Locale) and receives live pushes; the
  // set-language SEND lives in UpdaterService (with the other settings:* writes). No did-finish-load hooks
  // — the plain windows are created lazily, so there's nothing to hook; the invoke-seed covers startup
  // instead. All three requests just return the current effective locale.
  ipcMain.handle(IPC.languageRequest, (): Locale => localeService.current());
  ipcMain.handle(IPC.settingsLanguageRequest, (): Locale => localeService.current());
  ipcMain.handle(IPC.configLanguageRequest, (): Locale => localeService.current());

  // Power menu (Shutdown/Reboot/Sleep). Wired here, NOT in GameController, so the game controller stays
  // free of power concerns. The renderer confirms each action before sending; shutdown/reboot quit via
  // the bootstrap quit() (drops the window close-guards), sleep suspends in place.
  const power = createPowerService({
    platform: process.platform,
    exec: async (file, args) => {
      await execFileAsync(file, [...args], { windowsHide: true });
    },
    suspend: suspendToSleep,
    quit: () => quit(),
    showError: (message) => {
      const bw = window.browserWindow;
      if (bw !== null && !bw.isDestroyed()) bw.webContents.send(IPC.errorShow, message);
    },
    getTranslator,
  });
  ipcMain.on(IPC.actionShutdown, () => void power.perform('shutdown'));
  ipcMain.on(IPC.actionReboot, () => void power.perform('reboot'));
  ipcMain.on(IPC.actionSleep, () => void power.perform('sleep'));

  // Applies a language change everywhere: re-resolve the locale, rebuild the tray menu, re-title the plain
  // windows, and push the effective locale to every live webContents (game/settings/configure). Called
  // from the settings set-language handler and from resetSettings (both via UpdaterService deps).
  function applyLanguage(mode: typeof initialSettings.language): void {
    localeService.setMode(mode);
    const locale = localeService.current();
    trayRef?.setContextMenu(buildTrayMenu(localeService.t, trayCallbacks));
    settingsWindow.refreshTitle();
    configureWindow.refreshTitle();
    const gameBw = window.browserWindow;
    if (gameBw !== null && !gameBw.isDestroyed()) gameBw.webContents.send(IPC.languageUpdate, locale);
    const settingsBw = settingsWindow.browserWindow;
    if (settingsBw !== null && !settingsBw.isDestroyed()) {
      settingsBw.webContents.send(IPC.settingsLanguageUpdate, locale);
    }
    const configureBw = configureWindow.browserWindow;
    if (configureBw !== null && !configureBw.isDestroyed()) {
      configureBw.webContents.send(IPC.configLanguageUpdate, locale);
    }
  }

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
    configureWindowRef?.allowClose();
  });

  app.whenReady().then(bootstrap).catch((cause: unknown) => {
    log.error('[main] bootstrap failed:', cause);
    app.quit();
  });
}
