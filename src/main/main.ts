// Application bootstrap: single-instance, tray, lifecycle, auto-launch.
// Background app: the window is shown ONLY when a valid game card is detected (state 'ready'); with
// no game it stays hidden in the tray. Closing the window hides it to the tray, not quits.
import path from 'node:path';
import fs from 'node:fs';
import { app, ipcMain, Menu, powerSaveBlocker, shell, type Tray } from 'electron';
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
import { createKeepAwakeService, type KeepAwakeService } from './keep-awake';
import { createPlatform } from './platform';
import { isGamescopeSession } from './gamescope';
import { IPC } from '../shared/types';
import { type Locale } from '../shared/i18n/index';

// SteamOS Game Mode (gamescope) session, computed once from the environment (it never changes at runtime).
// In Game Mode there is no tray, the window is always shown (empty/error screen), and closing it quits the
// app. Read by the controller (hide/show decisions), the tray bootstrap and the window-all-closed handler.
const gameModeSession = isGamescopeSession();

// NOTE — the Game Mode `--no-sandbox` flag is NOT set here. Chromium consumes sandbox switches while it
// boots, before this script runs, so `app.commandLine.appendSwitch('no-sandbox')` is silently ignored: the
// flag has to be on the real argv. It is injected one layer down, by the Linux launcher wrapper that
// scripts/after-pack.mjs bakes into the package (same gamescope gate as isGamescopeSession).

// Keep-alive reference so the Tray (and its icon) isn't garbage-collected; also read to rebuild the
// context menu on a language change (setContextMenu in applyLanguage).
let trayRef: Tray | null = null;
let controllerRef: GameController | null = null;
let windowRef: GameWindow | null = null;
let settingsWindowRef: SettingsWindow | null = null;
let configureWindowRef: ConfigureWindow | null = null;
let globalGamepadRef: GlobalGamepad | null = null;
let keepAwakeRef: KeepAwakeService | null = null;
let quitting = false;
// Whether the global Start+Back summon chord is active (mirrors AppSettings.summonHotkeyEnabled, toggled
// live from the settings window). Read inside the chord callback so a toggle takes effect immediately.
let summonHotkeyEnabled = true;

function configureAutoLaunch(): void {
  // openAtLogin is reliable for an NSIS install; portable is best-effort.
  // No `--hidden` arg needed: the app always starts hidden and only shows on a valid card.
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: true });
    return;
  }
  if (process.platform === 'linux') {
    configureLinuxAutoLaunch();
  }
}

/**
 * Linux autostart (Р11). Electron's app.setLoginItemSettings is macOS/Windows-only, so we write an XDG
 * autostart entry by hand. Only meaningful for the packaged AppImage (Exec points at $APPIMAGE) and only
 * in Desktop Mode — in Game Mode the app runs as a non-Steam game with no autostart mechanism, so we skip
 * it there. Best-effort: any failure is logged, never fatal.
 */
function configureLinuxAutoLaunch(): void {
  if (gameModeSession) return; // Game Mode: no XDG autostart — Steam owns the lifecycle.
  const appImage = process.env['APPIMAGE'];
  if (appImage === undefined || appImage === '') return; // dev / non-AppImage run — nothing to register.
  try {
    const autostartDir = path.join(app.getPath('home'), '.config', 'autostart');
    fs.mkdirSync(autostartDir, { recursive: true });
    const desktopEntry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Playhook',
      `Exec=${appImage}`,
      'X-GNOME-Autostart-enabled=true',
      'Terminal=false',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(autostartDir, 'playhook.desktop'), desktopEntry, 'utf8');
  } catch (cause) {
    log.warn('[main] failed to write Linux autostart entry:', cause instanceof Error ? cause.message : String(cause));
  }
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
  keepAwakeRef?.dispose();
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

  // Platform services (process monitor / Steam locator / launcher / save-path resolver / power) selected
  // once for the running OS. Every OS-specific behaviour flows through this bundle (see platform/index.ts).
  // The bundled umu-run zipapp (extraResources, linux only): packaged it lives under resourcesPath; in dev
  // it sits in the repo's resources/ (fetched by scripts/fetch-umu.mjs). Resolved here so platform/ stays
  // electron-free.
  const umuRunPath = app.isPackaged
    ? path.join(process.resourcesPath, 'umu', 'umu-run')
    : path.join(app.getAppPath(), 'resources', 'umu', 'umu-run');
  const platform = createPlatform(process.platform, {
    getDocuments: () => app.getPath('documents'),
    userData: app.getPath('userData'),
    umuRunPath,
  });

  // Game Mode only (Р10): gamescope automounts ext4 but not exFAT/NTFS, so an inserted card can sit there
  // unmounted and invisible to the scan. Sweeping it into /run/media restores hot-swap for those cards.
  // Windows and the KDE desktop session automount on their own → no sweep wired there.
  const watcher = new DriveWatcher(
    undefined,
    gameModeSession ? () => platform.removableMounter.mountAll() : null,
  );

  windowRef = window;
  const controller = new GameController({ state, window, store, stats, watcher, settings, platform, isGamescope: gameModeSession, getTranslator });
  controllerRef = controller;
  controller.init();

  // Keep the display awake while the launcher owns the session. Single recompute point over two flags
  // (the setting + whether the window is on screen) plus the running AppState — main is single-threaded,
  // so the three sources (visibility / setting / state) can't race. The blocker itself is idempotent.
  const keepAwake = createKeepAwakeService({
    start: () => powerSaveBlocker.start('prevent-display-sleep'),
    stop: (id) => powerSaveBlocker.stop(id),
    isStarted: (id) => powerSaveBlocker.isStarted(id),
  });
  keepAwakeRef = keepAwake;
  let preventScreensaverEnabled = initialSettings.preventScreensaver;
  let windowVisible = false; // the window is created hidden (show:false); the 'show' event flips this
  const recomputeKeepAwake = (): void => {
    // `|| running` holds the blocker even if a game minimized our window into exclusive-fullscreen
    // (windowVisible would be false there), which is the whole point of covering the running state.
    const running = state.get().kind === 'running';
    keepAwake.setActive(preventScreensaverEnabled && (windowVisible || running));
  };
  // Recompute on every state change so entering/leaving `running` toggles the blocker (the window-visibility
  // and setting sources push their own recompute). A second subscriber alongside the controller's replicator.
  state.subscribe(() => recomputeKeepAwake());

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
    onPreventScreensaverChanged: (enabled) => {
      preventScreensaverEnabled = enabled;
      recomputeKeepAwake();
    },
    onAlwaysShowEmptyScreenChanged: (enabled) => controller.setAlwaysShowEmptyScreen(enabled),
    onVolumesChanged: (volumes) => {
      const bw = window.browserWindow;
      if (bw !== null && !bw.isDestroyed()) bw.webContents.send(IPC.volumeUpdate, volumes);
    },
    // A general "Reset to defaults" writes customWallpaper=null, but the copied file must be deleted
    // separately — delegate to the controller (it owns the AssetReader + the game window push).
    onWallpaperReset: () => controller.resetCustomWallpaper(),
    onLanguageChanged: (mode) => applyLanguage(mode),
    // Push a theme change to the Configure window so an open one recolors live (the settings window
    // applies it locally; the game window doesn't use the Fluent theme). No-op when it was never opened.
    onThemeChanged: (mode) => {
      const configureBw = configureWindow.browserWindow;
      if (configureBw !== null && !configureBw.isDestroyed()) {
        configureBw.webContents.send(IPC.configThemeUpdate, mode);
      }
    },
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
    toManifestPcSavePath: (absolute) => platform.savePathResolver.toManifestPcSavePath(absolute),
  });
  gameConfig.init();
  const configureWindow = new ConfigureWindow(gameConfig, getTranslator);
  configureWindowRef = configureWindow;

  window.create(
    (shown) => {
      windowVisible = shown;
      recomputeKeepAwake();
    },
    // Game Mode: no tray to hide into, and Steam closes a non-Steam game by closing its window → let the
    // close through and quit on window-all-closed (Р8, point 5). Desktop/Windows keep the hide-to-tray guard.
    { hideToTrayOnClose: !gameModeSession },
  );
  // Normally start hidden in the tray — the window appears only when a valid game card is detected
  // (GameController shows it on the 'ready' state). But if "always show the no-card screen" is enabled,
  // seed the controller with it now so it shows the empty screen at startup (reconciles: idle + no card).
  controller.setAlwaysShowEmptyScreen(initialSettings.alwaysShowEmptyScreen);

  const trayCallbacks: TrayCallbacks = {
    onShow: () => window.showAndFocus(),
    onOpenConfigureGame: () => configureWindow.openOrFocus(),
    onOpenSettings: () => settingsWindow.openOrFocus(),
    onQuit: () => quit(),
  };
  // SteamOS Game Mode has no system tray (gamescope). Skip it there — the window is always shown and Steam
  // manages the app as a non-Steam game. Desktop Mode (KDE) and Windows keep the tray (applyLanguage's
  // `trayRef?.setContextMenu` no-ops when it's null).
  if (!gameModeSession) {
    trayRef = createTray(localeService.t, trayCallbacks);
  } else {
    log.info('[main] SteamOS Game Mode detected — running without a tray');
  }

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
    backend: platform.powerBackend,
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
  // while a card is ready). Also works WHILE a game is running — the user can pull the launcher back
  // over the game (e.g. to return to it or reach the power menu) without alt-tabbing.
  const globalGamepad = new GlobalGamepad();
  globalGamepadRef = globalGamepad;
  globalGamepad.onChord(() => {
    if (!summonHotkeyEnabled) return; // toggled off in the settings window
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

  // A background app doesn't quit when the window is closed/hidden — it lives in the tray. Exception:
  // SteamOS Game Mode has no tray and the window's close isn't guarded, so a real close means the user
  // ended the (non-Steam) game → quit (Р8, point 5).
  app.on('window-all-closed', () => {
    if (quitting || gameModeSession) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    controllerRef?.shutdown();
    globalGamepadRef?.stop();
    keepAwakeRef?.dispose();
    windowRef?.allowClose();
    settingsWindowRef?.allowClose();
    configureWindowRef?.allowClose();
  });

  app.whenReady().then(bootstrap).catch((cause: unknown) => {
    log.error('[main] bootstrap failed:', cause);
    app.quit();
  });
}
