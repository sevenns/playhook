// Typed main↔renderer bridge (contextIsolation: true, nodeIntegration: false).
// Channels are inlined as literals rather than imported from shared, so the preload
// stays sandbox-compatible (a sandboxed preload cannot require arbitrary files).
// `satisfies Partial<typeof IPC>` gives us the compile-time bridge back: a wrong channel
// value (TS2322) or a typo'd key (TS2353) now fails typecheck. `import type` keeps IPC
// out of the runtime bundle (it erases), so the sandbox stays intact. Partial<> cannot
// catch a *missing* channel though — that completeness is guarded by the ipc-channels
// unit test (shared/types.ts is the single source of truth).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AppNotification,
  AppSettings,
  AppState,
  NotificationToast,
  SfxSet,
  AudioOptions,
  AudioVolumes,
  AutoUpdateMode,
  BrowseInfo,
  ConfigMoveResult,
  ConfigPickResult,
  ConfigRootReadResult,
  ConfigSaveResult,
  ConfigValidationResult,
  DriveCandidate,
  GameConfigAcceptRequest,
  GameConfigListDirRequest,
  GameConfigReadResult,
  GameConfigSaveRequest,
  GameLibrary,
  GameMoveRequest,
  HeroAssets,
  LanguageMode,
  ListDirResult,
  RendererApi,
  UpdateStatus,
} from '../shared/types';
import type { IPC } from '../shared/types';
import type { Locale } from '../shared/i18n/index';

const CHANNELS = {
  stateUpdate: 'state:update',
  stateRequest: 'state:request',
  actionLaunch: 'action:launch',
  actionUninstall: 'action:uninstall',
  actionHide: 'action:hide',
  actionQuit: 'action:quit',
  gameModeRequest: 'app:game-mode-request',
  actionOpenSteamDownloads: 'action:open-steam-downloads',
  actionShutdown: 'action:shutdown',
  actionReboot: 'action:reboot',
  actionSleep: 'action:sleep',
  actionKill: 'action:kill',
  errorShow: 'error:show',
  cardMusicUpdate: 'card-music:update',
  cardMusicRequest: 'card-music:request',
  ambientUpdate: 'ambient:update',
  ambientRequest: 'ambient:request',
  windowFocus: 'window:focus',
  heroUpdate: 'hero:update',
  heroRequest: 'hero:request',
  libraryUpdate: 'library:update',
  libraryRequest: 'library:request',
  libraryGridRequest: 'library:grid-request',
  libraryBrowse: 'library:browse',
  libraryForget: 'library:forget',
  browseUpdate: 'browse:update',
  browseRequest: 'browse:request',
  browseHero: 'browse:hero',
  browseMusic: 'browse:music',
  sfxSetUpdate: 'sfx:set-update',
  sfxSetRequest: 'sfx:set-request',
  actionSelect: 'action:select',
  wallpaperRequest: 'wallpaper:request',
  startupSoundRequest: 'audio:startup-request',
  volumeRequest: 'volume:request',
  volumeUpdate: 'volume:update',
  languageRequest: 'app:language-request',
  languageUpdate: 'app:language-update',
  // Settings screen (these lived in settings-preload.ts until the window became a launcher screen).
  updateStatusUpdate: 'update:status',
  updateStatusRequest: 'update:request',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  settingsRequest: 'settings:request',
  settingsUpdate: 'settings:update',
  settingsSteamAvailable: 'settings:steam-available',
  settingsReset: 'settings:reset',
  settingsSetAutoUpdate: 'settings:set-auto-update',
  settingsSetPrerelease: 'settings:set-prerelease',
  settingsSetSummonHotkey: 'settings:set-summon-hotkey',
  settingsSetPreventScreensaver: 'settings:set-prevent-screensaver',
  settingsSetKeepOpenWithoutCard: 'settings:set-keep-open-without-card',
  settingsSetDisableSilentInstall: 'settings:set-disable-silent-install',
  settingsSetSteamAutoLaunch: 'settings:set-steam-auto-launch',
  settingsSetMusicVolume: 'settings:set-music-volume',
  settingsSetSfxVolume: 'settings:set-sfx-volume',
  settingsSetSoundSet: 'settings:set-sound-set',
  settingsSetAmbientTrack: 'settings:set-ambient-track',
  settingsSetOnlyGlobalAmbient: 'settings:set-only-global-ambient',
  settingsSetLanguage: 'settings:set-language',
  appVersionRequest: 'app:version',
  audioOptionsRequest: 'app:audio-options',
  // Customize screen — per-game game.json editing, in the launcher's own namespace (see shared/types).
  gameConfigRead: 'gameConfig:read',
  gameConfigValidate: 'gameConfig:validate',
  gameConfigSave: 'gameConfig:save',
  gameConfigImagePreview: 'gameConfig:image-preview',
  gameConfigAcceptPath: 'gameConfig:accept-path',
  gameConfigListDir: 'gameConfig:list-dir',
  gameConfigSources: 'gameConfig:sources',
  gameConfigReadRoot: 'gameConfig:read-root',
  gameConfigMoveToCard: 'gameConfig:move-to-card',
  clipboardRead: 'clipboard:read',
  // Notifications — the inbox lives in main; these are its two surfaces in the renderer.
  notificationsUpdate: 'notifications:update',
  notificationsToast: 'notifications:toast',
  notificationsRequest: 'notifications:request',
  notificationsDismiss: 'notifications:dismiss',
  notificationsClear: 'notifications:clear',
  notificationsMarkRead: 'notifications:mark-read',
} as const satisfies Partial<typeof IPC>;

const api: RendererApi = {
  onStateUpdate(callback: (state: AppState) => void): void {
    ipcRenderer.on(CHANNELS.stateUpdate, (_event: IpcRendererEvent, state: AppState) => {
      callback(state);
    });
  },
  onWindowFocus(callback: (focused: boolean) => void): void {
    ipcRenderer.on(CHANNELS.windowFocus, (_event: IpcRendererEvent, focused: boolean) => {
      callback(focused);
    });
  },
  requestState(): Promise<AppState> {
    return ipcRenderer.invoke(CHANNELS.stateRequest) as Promise<AppState>;
  },
  requestLaunch(): void {
    ipcRenderer.send(CHANNELS.actionLaunch);
  },
  requestUninstall(): void {
    ipcRenderer.send(CHANNELS.actionUninstall);
  },
  requestHide(): void {
    ipcRenderer.send(CHANNELS.actionHide);
  },
  requestQuit(): void {
    ipcRenderer.send(CHANNELS.actionQuit);
  },
  requestGameMode(): Promise<boolean> {
    return ipcRenderer.invoke(CHANNELS.gameModeRequest) as Promise<boolean>;
  },
  openSteamDownloads(): void {
    ipcRenderer.send(CHANNELS.actionOpenSteamDownloads);
  },
  requestShutdown(): void {
    ipcRenderer.send(CHANNELS.actionShutdown);
  },
  requestReboot(): void {
    ipcRenderer.send(CHANNELS.actionReboot);
  },
  requestSleep(): void {
    ipcRenderer.send(CHANNELS.actionSleep);
  },
  requestKill(): void {
    ipcRenderer.send(CHANNELS.actionKill);
  },
  onError(callback: (message: string) => void): void {
    ipcRenderer.on(CHANNELS.errorShow, (_event: IpcRendererEvent, message: string) => {
      callback(message);
    });
  },
  onCardMusic(callback: (url: string | null) => void): void {
    ipcRenderer.on(CHANNELS.cardMusicUpdate, (_event: IpcRendererEvent, assets: string | null) => {
      callback(assets);
    });
  },
  requestCardMusic(): Promise<string | null> {
    return ipcRenderer.invoke(CHANNELS.cardMusicRequest) as Promise<string | null>;
  },
  onAmbientUpdate(callback: (url: string | null) => void): void {
    ipcRenderer.on(CHANNELS.ambientUpdate, (_event: IpcRendererEvent, url: string | null) => {
      callback(url);
    });
  },
  requestAmbient(): Promise<string | null> {
    return ipcRenderer.invoke(CHANNELS.ambientRequest) as Promise<string | null>;
  },
  onHeroUpdate(callback: (assets: HeroAssets | null) => void): void {
    ipcRenderer.on(CHANNELS.heroUpdate, (_event: IpcRendererEvent, assets: HeroAssets | null) => {
      callback(assets);
    });
  },
  requestHero(): Promise<HeroAssets | null> {
    return ipcRenderer.invoke(CHANNELS.heroRequest) as Promise<HeroAssets | null>;
  },
  onLibraryUpdate(callback: (library: GameLibrary | null) => void): void {
    ipcRenderer.on(CHANNELS.libraryUpdate, (_event: IpcRendererEvent, library: GameLibrary | null) => {
      callback(library);
    });
  },
  requestLibrary(): Promise<GameLibrary | null> {
    return ipcRenderer.invoke(CHANNELS.libraryRequest) as Promise<GameLibrary | null>;
  },
  requestGrid(id: string): Promise<string | null> {
    return ipcRenderer.invoke(CHANNELS.libraryGridRequest, id) as Promise<string | null>;
  },
  browseGame(id: string | null, immediate = false): void {
    ipcRenderer.send(CHANNELS.libraryBrowse, id, immediate);
  },
  forgetGame(id: string): void {
    ipcRenderer.send(CHANNELS.libraryForget, id);
  },
  onBrowseUpdate(callback: (browse: BrowseInfo | null) => void): void {
    ipcRenderer.on(CHANNELS.browseUpdate, (_event: IpcRendererEvent, browse: BrowseInfo | null) => {
      callback(browse);
    });
  },
  requestBrowse(): Promise<BrowseInfo | null> {
    return ipcRenderer.invoke(CHANNELS.browseRequest) as Promise<BrowseInfo | null>;
  },
  onBrowseHero(callback: (assets: HeroAssets | null) => void): void {
    ipcRenderer.on(CHANNELS.browseHero, (_event: IpcRendererEvent, assets: HeroAssets | null) => {
      callback(assets);
    });
  },
  onBrowseMusic(callback: (url: string | null) => void): void {
    ipcRenderer.on(CHANNELS.browseMusic, (_event: IpcRendererEvent, url: string | null) => {
      callback(url);
    });
  },
  onSfxSet(callback: (set: SfxSet | null) => void): void {
    ipcRenderer.on(CHANNELS.sfxSetUpdate, (_event: IpcRendererEvent, assets: SfxSet | null) => {
      callback(assets);
    });
  },
  requestSfxSet(): Promise<SfxSet | null> {
    return ipcRenderer.invoke(CHANNELS.sfxSetRequest) as Promise<SfxSet | null>;
  },
  selectGame(id: string): void {
    ipcRenderer.send(CHANNELS.actionSelect, id);
  },
  requestWallpaper(): Promise<string | null> {
    return ipcRenderer.invoke(CHANNELS.wallpaperRequest) as Promise<string | null>;
  },
  requestStartupSound(): Promise<string | null> {
    return ipcRenderer.invoke(CHANNELS.startupSoundRequest) as Promise<string | null>;
  },
  requestVolumes(): Promise<AudioVolumes> {
    return ipcRenderer.invoke(CHANNELS.volumeRequest) as Promise<AudioVolumes>;
  },
  onVolumesUpdate(callback: (volumes: AudioVolumes) => void): void {
    ipcRenderer.on(CHANNELS.volumeUpdate, (_event: IpcRendererEvent, volumes: AudioVolumes) => {
      callback(volumes);
    });
  },
  getLanguage(): Promise<Locale> {
    return ipcRenderer.invoke(CHANNELS.languageRequest) as Promise<Locale>;
  },
  onLanguageUpdate(callback: (locale: Locale) => void): void {
    ipcRenderer.on(CHANNELS.languageUpdate, (_event: IpcRendererEvent, locale: Locale) => {
      callback(locale);
    });
  },
  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke(CHANNELS.settingsRequest) as Promise<AppSettings>;
  },
  onSettingsUpdate(callback: (settings: AppSettings) => void): void {
    ipcRenderer.on(CHANNELS.settingsUpdate, (_event: IpcRendererEvent, settings: AppSettings) => {
      callback(settings);
    });
  },
  isSteamAvailable(): Promise<boolean> {
    return ipcRenderer.invoke(CHANNELS.settingsSteamAvailable) as Promise<boolean>;
  },
  getAudioOptions(): Promise<AudioOptions> {
    return ipcRenderer.invoke(CHANNELS.audioOptionsRequest) as Promise<AudioOptions>;
  },
  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke(CHANNELS.appVersionRequest) as Promise<string>;
  },
  setAutoUpdate(mode: AutoUpdateMode): void {
    ipcRenderer.send(CHANNELS.settingsSetAutoUpdate, mode);
  },
  setPrerelease(on: boolean): void {
    ipcRenderer.send(CHANNELS.settingsSetPrerelease, on);
  },
  setSummonHotkey(on: boolean): void {
    ipcRenderer.send(CHANNELS.settingsSetSummonHotkey, on);
  },
  setPreventScreensaver(on: boolean): void {
    ipcRenderer.send(CHANNELS.settingsSetPreventScreensaver, on);
  },
  setKeepOpenWithoutCard(on: boolean): void {
    ipcRenderer.send(CHANNELS.settingsSetKeepOpenWithoutCard, on);
  },
  setDisableSilentInstall(on: boolean): void {
    ipcRenderer.send(CHANNELS.settingsSetDisableSilentInstall, on);
  },
  setSteamAutoLaunch(on: boolean): void {
    ipcRenderer.send(CHANNELS.settingsSetSteamAutoLaunch, on);
  },
  setSoundSet(set: string): void {
    ipcRenderer.send(CHANNELS.settingsSetSoundSet, set);
  },
  setAmbientTrack(track: string | null): void {
    ipcRenderer.send(CHANNELS.settingsSetAmbientTrack, track);
  },
  setOnlyGlobalAmbient(on: boolean): void {
    ipcRenderer.send(CHANNELS.settingsSetOnlyGlobalAmbient, on);
  },
  setMusicVolume(volume: number): void {
    ipcRenderer.send(CHANNELS.settingsSetMusicVolume, volume);
  },
  setSfxVolume(volume: number): void {
    ipcRenderer.send(CHANNELS.settingsSetSfxVolume, volume);
  },
  setLanguage(mode: LanguageMode): void {
    ipcRenderer.send(CHANNELS.settingsSetLanguage, mode);
  },
  resetSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke(CHANNELS.settingsReset) as Promise<AppSettings>;
  },
  onUpdateStatus(callback: (status: UpdateStatus) => void): void {
    ipcRenderer.on(CHANNELS.updateStatusUpdate, (_event: IpcRendererEvent, status: UpdateStatus) => {
      callback(status);
    });
  },
  requestUpdateStatus(): Promise<UpdateStatus> {
    return ipcRenderer.invoke(CHANNELS.updateStatusRequest) as Promise<UpdateStatus>;
  },
  checkForUpdates(): void {
    ipcRenderer.send(CHANNELS.updateCheck);
  },
  downloadUpdate(): void {
    ipcRenderer.send(CHANNELS.updateDownload);
  },
  installUpdate(): void {
    ipcRenderer.send(CHANNELS.updateInstall);
  },
  readGameConfig(id: string): Promise<GameConfigReadResult> {
    return ipcRenderer.invoke(CHANNELS.gameConfigRead, id) as Promise<GameConfigReadResult>;
  },
  validateGameConfig(root: string, text: string): Promise<ConfigValidationResult> {
    return ipcRenderer.invoke(CHANNELS.gameConfigValidate, {
      root,
      text,
    }) as Promise<ConfigValidationResult>;
  },
  saveGameConfig(request: GameConfigSaveRequest): Promise<ConfigSaveResult> {
    return ipcRenderer.invoke(CHANNELS.gameConfigSave, request) as Promise<ConfigSaveResult>;
  },
  getGameConfigImage(root: string, path: string): Promise<string | null> {
    return ipcRenderer.invoke(CHANNELS.gameConfigImagePreview, { root, path }) as Promise<
      string | null
    >;
  },
  acceptGameConfigPaths(request: GameConfigAcceptRequest): Promise<ConfigPickResult> {
    return ipcRenderer.invoke(CHANNELS.gameConfigAcceptPath, request) as Promise<ConfigPickResult>;
  },
  listGameConfigDir(request: GameConfigListDirRequest): Promise<ListDirResult> {
    return ipcRenderer.invoke(CHANNELS.gameConfigListDir, request) as Promise<ListDirResult>;
  },
  listGameConfigSources(): Promise<readonly DriveCandidate[]> {
    return ipcRenderer.invoke(CHANNELS.gameConfigSources) as Promise<readonly DriveCandidate[]>;
  },
  readGameConfigRoot(root: string): Promise<ConfigRootReadResult> {
    return ipcRenderer.invoke(CHANNELS.gameConfigReadRoot, root) as Promise<ConfigRootReadResult>;
  },
  moveGameConfigToCard(request: GameMoveRequest): Promise<ConfigMoveResult> {
    return ipcRenderer.invoke(CHANNELS.gameConfigMoveToCard, request) as Promise<ConfigMoveResult>;
  },
  readClipboard(): Promise<string> {
    return ipcRenderer.invoke(CHANNELS.clipboardRead) as Promise<string>;
  },
  onNotifications(callback: (items: readonly AppNotification[]) => void): void {
    ipcRenderer.on(
      CHANNELS.notificationsUpdate,
      (_event: IpcRendererEvent, items: readonly AppNotification[]) => {
        callback(items);
      },
    );
  },
  onNotificationToast(callback: (toast: NotificationToast) => void): void {
    ipcRenderer.on(CHANNELS.notificationsToast, (_event: IpcRendererEvent, toast: NotificationToast) => {
      callback(toast);
    });
  },
  requestNotifications(): Promise<readonly AppNotification[]> {
    return ipcRenderer.invoke(CHANNELS.notificationsRequest) as Promise<readonly AppNotification[]>;
  },
  dismissNotification(id: string): void {
    ipcRenderer.send(CHANNELS.notificationsDismiss, id);
  },
  clearNotifications(): void {
    ipcRenderer.send(CHANNELS.notificationsClear);
  },
  markNotificationsRead(): void {
    ipcRenderer.send(CHANNELS.notificationsMarkRead);
  },
};

contextBridge.exposeInMainWorld('api', api);
