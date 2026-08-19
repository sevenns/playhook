// Application bootstrap: single-instance, tray, lifecycle, auto-launch.
// Background app: the window is shown ONLY when a valid game card is detected (state 'ready'); with
// no game it stays hidden in the tray. Closing the window hides it to the tray, not quits.
import path from 'node:path';
import fs from 'node:fs';
import { app, dialog, ipcMain, Menu, powerSaveBlocker, shell, type Tray } from 'electron';
import { log, logFilePath, setLogBaseDir } from './logger';
import { StateManager } from './state';
import { GameWindow } from './window';
import { PcStore } from './pc-store';
import { AppSettingsStore } from './app-settings';
import { StatsService } from './stats';
import { LibraryStore } from './library-store';
import { PcLibraryStore } from './pc-library';
import { DriveWatcher } from './drive-watcher';
import { GameController } from './ipc';
import { GlobalGamepad } from './gamepad-global';
import { createTray, buildTrayMenu, type TrayCallbacks, type TraySteamState } from './tray';
import { createSteamShortcutService } from './steam-shortcut';
import { installDaemonUnit, removeDaemonUnit } from './daemon-unit';
import { UpdaterService } from './updater';
import { NotificationsService } from './notifications';
import { NotificationsStore } from './notifications-store';
import { GameConfigService } from './game-config';
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
let globalGamepadRef: GlobalGamepad | null = null;
let keepAwakeRef: KeepAwakeService | null = null;
let quitting = false;
// Whether the global Start+Back summon chord is active (mirrors AppSettings.summonHotkeyEnabled, toggled
// live from the Settings screen). Read inside the chord callback so a toggle takes effect immediately.
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
    log.warn(
      '[main] failed to write Linux autostart entry:',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

// Opens the log folder (the tray's "Open logs").
function openLogs(): void {
  void shell.openPath(path.dirname(logFilePath()));
}

// Opens the app-controlled games install root (%LOCALAPPDATA%\playhook\games; see manifest.ts). Created
// on first use so there's always something to open. On non-Windows dev LOCALAPPDATA is absent — fall
// back to appData so the action opens something rather than erroring.
function openGamesFolder(): void {
  const localAppData = process.env['LOCALAPPDATA'];
  const base =
    localAppData !== undefined && localAppData !== '' ? localAppData : app.getPath('appData');
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
  app.quit();
}

async function bootstrap(): Promise<void> {
  // FIRST, before any log line: logger.ts is deliberately electron-free (the Game Mode daemon loads it
  // under ELECTRON_RUN_AS_NODE, where importing electron fails), so it cannot ask app.getPath() itself.
  setLogBaseDir(app.getPath('userData'));

  // No application menu (removes the File/Edit/View… bar entirely).
  Menu.setApplicationMenu(null);

  log.info(`[main] starting v${app.getVersion()} — log file: "${logFilePath()}"`);

  const store = new PcStore(app.getPath('userData'));
  await store.init();

  // Every write (a setter, a reset) funnels through the store's one persist() and is pushed straight to
  // the launcher, so the Settings screen never has to derive state from a setter's own return value —
  // and a setter added later cannot forget to notify. windowRef is used (not `window`, declared below)
  // because this runs before the window exists; the guard covers that gap.
  const settings = new AppSettingsStore(app.getPath('userData'), (next) => {
    const bw = windowRef?.browserWindow ?? null;
    if (bw !== null && !bw.isDestroyed()) bw.webContents.send(IPC.settingsUpdate, next);
  });
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

  // The notification inbox. Whether an arriving notification may make noise is a question about the
  // whole app — is the window on screen, is it in front, is a game running — and all three facts are
  // main's own, read live here. Whether the user has TOUCHED anything recently is deliberately NOT one
  // of them: someone reading the launcher without pressing buttons is still looking at it.
  const notifications = new NotificationsService({
    store: new NotificationsStore(app.getPath('userData')),
    presence: () => {
      const bw = windowRef?.browserWindow ?? null;
      return {
        windowVisible: window.isShown(),
        windowFocused: bw !== null && !bw.isDestroyed() && bw.isFocused(),
        gameRunning: state.get().kind === 'running',
      };
    },
    push: (channel, payload) => {
      const bw = windowRef?.browserWindow ?? null;
      if (bw !== null && !bw.isDestroyed()) bw.webContents.send(channel, payload);
    },
  });
  await notifications.init();

  // One summary plate for everything that piled up while a game was running. StateManager.subscribe
  // hands the listener only the NEW state, so the previous kind is tracked here — the same shape the
  // keep-awake recompute below uses.
  let previousStateKind = state.get().kind;
  state.subscribe((next) => {
    const previous = previousStateKind;
    previousStateKind = next.kind;
    if (previous === 'running' && next.kind !== 'running') notifications.announceUnreadAfterGame();
  });

  // The launch history behind the carousel: copies of every inserted game's art/audio, so the launcher
  // has something to show with no card in. init() re-syncs its cached stats and runs the GC; a failure
  // there must not stop the app from starting (the carousel just falls back to the card's games).
  const library = new LibraryStore({ baseDir: app.getPath('userData'), readStats: (id) => stats.read(id) });
  await library.init().catch((cause: unknown) => log.warn('[library] init failed:', cause));

  // The PC library: local games added from this machine's own disk, kept in `<userData>/pc-games` and
  // read as a card that is always inserted (see pc-library.ts). Its skeleton is created up front so the
  // the editor can offer "This PC" even before the first local game exists.
  const pcLibrary = new PcLibraryStore({ baseDir: app.getPath('userData') });
  await pcLibrary.init().catch((cause: unknown) => log.warn('[pc-library] init failed:', cause));

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

  // Game Mode only (Р10), as a safety net: the gamescope session normally mounts an inserted card itself,
  // but one that arrives unmounted is invisible to the scan (it has no path to look under). Sweeping it
  // into /run/media keeps hot-swap working in that case. Windows and the KDE desktop session mount on
  // their own → no sweep wired there.
  const watcher = new DriveWatcher(
    undefined,
    gameModeSession ? () => platform.removableMounter.mountAll() : null,
  );

  windowRef = window;
  const controller = new GameController({
    state,
    window,
    store,
    stats,
    library,
    pcLibrary,
    watcher,
    settings,
    notifications,
    platform,
    isGamescope: gameModeSession,
    getTranslator,
  });
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

  // Update service. isBusy covers ALL in-flight states (not just a running game), so a manual install
  // can't tear down a save-sync / game install. beforeInstall drops the windows' close-guards
  // synchronously before quitAndInstall.
  const updater = new UpdaterService({
    settings,
    notifications,
    isBusy: () => {
      const kind = state.get().kind;
      return kind !== 'idle' && kind !== 'ready' && kind !== 'error';
    },
    beforeInstall: () => {
      quitting = true;
      window.allowClose();
    },
    onSummonHotkeyChanged: (enabled) => {
      summonHotkeyEnabled = enabled;
    },
    onPreventScreensaverChanged: (enabled) => {
      preventScreensaverEnabled = enabled;
      recomputeKeepAwake();
    },
    onKeepOpenWithoutCardChanged: (enabled) => controller.setKeepOpenWithoutCard(enabled),
    // Game Mode auto-launch toggle (Steam Deck): installs or tears down the watcher unit. Turning it off
    // stops a separate process, so the memory is actually returned — that is the point of the option.
    onSteamAutoLaunchChanged: (enabled) => steamShortcut.applyAutoLaunch(enabled),
    isSteamAvailable: () => steamShortcut.isAvailable(),
    onVolumesChanged: (volumes) => {
      const bw = window.browserWindow;
      if (bw !== null && !bw.isDestroyed()) bw.webContents.send(IPC.volumeUpdate, volumes);
    },
    // The sound-set / ambience / only-global changes are re-read + re-pushed by the controller (it owns the
    // AssetReader and the game window) — the Settings screen only persisted the new value.
    onSoundSetChanged: () => void controller.refreshAudio(),
    onAudioScopeChanged: () => void controller.refreshAudio(),
    onAmbientChanged: (track) => void controller.setAmbientTrack(track),
    onLanguageChanged: (mode) => applyLanguage(mode),
    getTranslator,
  });

  // Backend of the launcher's Customize screen. getActiveRoot / reloadManifest / findGameSource come
  // from the controller and the watcher (interface-DI).
  const gameConfig = new GameConfigService({
    getActiveRoot: () => watcher.getActiveRoot(),
    reloadManifest: (root) => controller.reloadManifest(root),
    pcLibrary,
    reloadPcLibrary: () => controller.reloadPcLibrary(),
    getTranslator,
    toManifestPcSavePath: (absolute) => platform.savePathResolver.toManifestPcSavePath(absolute),
    findGameSource: (id) => controller.findGameSource(id),
    notify: (input) => notifications.notify(input),
    resolveManifest: (id) => controller.findManifest(id),
    isBusy: () => controller.isBusy(),
    pcStore: store,
    savePathResolver: platform.savePathResolver,
  });
  gameConfig.init();

  window.create(
    (shown) => {
      windowVisible = shown;
      recomputeKeepAwake();
    },
    // Game Mode: no tray to hide into, and Steam closes a non-Steam game by closing its window → let the
    // close through and quit on window-all-closed (Р8, point 5). Desktop/Windows keep the hide-to-tray guard.
    { hideToTrayOnClose: !gameModeSession },
  );
  // The update status is pushed to the launcher, which is where the Settings screen lives now. Attached
  // once, right after the window exists: it survives the whole session (hiding to the tray does not
  // destroy it), and every push re-checks isDestroyed().
  const launcherWindow = window.browserWindow;
  if (launcherWindow !== null) updater.attachWindow(launcherWindow);
  // The launcher came back to the front — release whatever piled up while it was away (a toast held
  // because the window was hidden or behind something, and the summary after a game). Both events are
  // needed: showing from the tray does not necessarily focus, and focusing does not re-show.
  if (launcherWindow !== null) {
    launcherWindow.on('show', () => notifications.onLauncherFronted());
    launcherWindow.on('focus', () => notifications.onLauncherFronted());
  }
  // Normally start hidden in the tray — the window appears only when a valid game card is detected
  // (GameController shows it on the 'ready' state). But if "always show the no-card screen" is enabled,
  // seed the controller with it now so it shows the empty screen at startup (reconciles: idle + no card).
  controller.setKeepOpenWithoutCard(initialSettings.keepOpenWithoutCard);

  // Steam Deck Game Mode tile: writes Playhook into Steam's shortcuts.vdf as a non-Steam game. Available
  // only for a packaged AppImage on linux (the appid is derived from the launcher path, which a dev run
  // doesn't have) — elsewhere `isAvailable()` is false and the tray item never appears. The icon is copied
  // out of the asar because Steam, an outside process, cannot read a path inside it.
  const steamShortcut = createSteamShortcutService({
    platform,
    settings,
    getTranslator,
    home: app.getPath('home'),
    sourceIconPath: path.join(__dirname, '../icon.png'),
    // Library artwork, bundled by copy-assets into dist/steam. The logo drawn over the hero is the app
    // icon itself (it is the only asset with transparency). Read from inside the asar and copied out to
    // Steam's grid dir — plain fs reads work there through Electron's asar shim.
    artwork: {
      portrait: path.join(__dirname, '../steam/600x900.jpg'),
      wide: path.join(__dirname, '../steam/920x430.jpg'),
      hero: path.join(__dirname, '../steam/hero.jpg'),
      logo: path.join(__dirname, '../icon.png'),
    },
    appImagePath: process.env['APPIMAGE'] ?? null,
    notify: (title, message) => {
      void dialog.showMessageBox({ type: 'info', title, message });
    },
    onStateChanged: () => refreshTrayMenu(),
    // Game Mode auto-launch (phase 2): the systemd user unit that watches for a card while in Game Mode
    // and launches our tile through Steam. Installed with the shortcut, removed with it.
    installDaemon: async (appImagePath) => {
      await installDaemonUnit(app.getPath('home'), appImagePath);
    },
    removeDaemon: () => removeDaemonUnit(app.getPath('home')),
  });

  /** The tray item's state, derived from the service (no separate flag to drift out of sync). */
  function steamMenuState(): TraySteamState {
    return {
      visible: steamShortcut.isAvailable(),
      registered: steamShortcut.isRegistered(),
      busy: steamShortcut.isBusy(),
    };
  }

  /**
   * The single place the tray menu is rebuilt. Both triggers go through it — a language change and a
   * Steam-shortcut state change — because rebuilding from only one of them would drop the other's state
   * (switching language used to reset the Steam item back to its startup label).
   */
  function refreshTrayMenu(): void {
    trayRef?.setContextMenu(buildTrayMenu(localeService.t, trayCallbacks, steamMenuState()));
  }

  const trayCallbacks: TrayCallbacks = {
    onShow: () => window.showAndFocus(),
    onOpenLogs: () => openLogs(),
    onOpenGamesFolder: () => openGamesFolder(),
    onToggleSteamShortcut: () => {
      void (steamShortcut.isRegistered() ? steamShortcut.remove() : steamShortcut.add());
    },
    onQuit: () => quit(),
  };
  // SteamOS Game Mode has no system tray (gamescope). Skip it there — the window is always shown and Steam
  // manages the app as a non-Steam game. Desktop Mode (KDE) and Windows keep the tray (refreshTrayMenu
  // no-ops when trayRef is null).
  if (!gameModeSession) {
    trayRef = createTray(localeService.t, trayCallbacks, steamMenuState());
  } else {
    log.info('[main] SteamOS Game Mode detected — running without a tray');
  }
  // Re-point the stable launcher symlink (the appid depends on it surviving updates) and drop a stored
  // appid whose record no longer exists. Only meaningful in Desktop Mode, which is the only place the tray
  // — the feature's single entry point — exists.
  if (!gameModeSession) {
    steamShortcut
      .reconcile()
      .catch((cause: unknown) => log.warn('[steam-shortcut] reconcile failed:', cause));
  }

  // UI-locale wiring. The launcher seeds via an invoke (effective Locale) and receives live pushes; the
  // set-language SEND lives in UpdaterService (with the other settings:* writes). No did-finish-load hook
  // — the invoke-seed covers startup instead.
  ipcMain.handle(IPC.languageRequest, (): Locale => localeService.current());

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
  // Game Mode "Close Playhook": full quit via the same bootstrap path as the tray Quit (drops the window
  // close-guards, disposes services). Only ever sent from the Game Mode power menu — Desktop keeps hiding.
  ipcMain.on(IPC.actionQuit, () => quit());

  // Applies a language change everywhere: re-resolve the locale, rebuild the tray menu, re-title the
  // and push the effective locale to the launcher.
  // Called from the settings set-language handler and from resetSettings (both via UpdaterService deps).
  function applyLanguage(mode: typeof initialSettings.language): void {
    localeService.setMode(mode);
    const locale = localeService.current();
    refreshTrayMenu();
    const gameBw = window.browserWindow;
    if (gameBw !== null && !gameBw.isDestroyed())
      gameBw.webContents.send(IPC.languageUpdate, locale);
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
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((cause: unknown) => {
      log.error('[main] bootstrap failed:', cause);
      app.quit();
    });
}
