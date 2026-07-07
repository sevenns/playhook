// Typed main↔settings-renderer bridge (contextIsolation: true, nodeIntegration: false, sandbox: true).
// Separate from preload.ts so the settings window gets its own `window.settingsApi`, isolated from the
// game `window.api` contract. As in preload.ts, channels are inlined as string LITERALS rather
// than imported from shared: a sandboxed preload cannot require arbitrary files. Only `import type`
// from shared is allowed (types erase at compile time). `satisfies Partial<typeof IPC>` restores a
// compile-time guard over these literals: a wrong value (TS2322) or a typo'd key (TS2353) fails
// typecheck. Partial<> still cannot catch a *missing* channel — the ipc-channels unit test guards
// that this CHANNELS map equals its slice of the shared IPC source of truth.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AppSettings,
  AutoUpdateMode,
  LanguageMode,
  SettingsApi,
  ThemeMode,
  UpdateStatus,
  WallpaperResult,
} from '../shared/types';
import type { IPC } from '../shared/types';
import type { Locale } from '../shared/i18n/index';

const CHANNELS = {
  updateStatusUpdate: 'update:status',
  updateStatusRequest: 'update:request',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  settingsRequest: 'settings:request',
  settingsSetAutoUpdate: 'settings:set-auto-update',
  settingsSetAlwaysShowEmptyScreen: 'settings:set-always-show-empty-screen',
  settingsSetTheme: 'settings:set-theme',
  settingsSetPrerelease: 'settings:set-prerelease',
  settingsSetSummonHotkey: 'settings:set-summon-hotkey',
  settingsSetMusicVolume: 'settings:set-music-volume',
  settingsSetSfxVolume: 'settings:set-sfx-volume',
  settingsSetLanguage: 'settings:set-language',
  settingsLanguageRequest: 'settings:language-request',
  settingsLanguageUpdate: 'settings:language-update',
  settingsReset: 'settings:reset',
  titleBarOverlayUpdate: 'settings:titlebar-overlay',
  appVersionRequest: 'app:version',
  appIconRequest: 'app:icon',
  moveSoundRequest: 'app:move-sound',
  openLogs: 'app:open-logs',
  openGamesFolder: 'app:open-games-folder',
  wallpaperPick: 'wallpaper:pick',
  wallpaperClear: 'wallpaper:clear',
  wallpaperPreviewRequest: 'wallpaper:preview-request',
} as const satisfies Partial<typeof IPC>;

const api: SettingsApi = {
  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke(CHANNELS.appVersionRequest) as Promise<string>;
  },
  getAppIcon(): Promise<string> {
    return ipcRenderer.invoke(CHANNELS.appIconRequest) as Promise<string>;
  },
  getMoveSound(): Promise<string> {
    return ipcRenderer.invoke(CHANNELS.moveSoundRequest) as Promise<string>;
  },
  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke(CHANNELS.settingsRequest) as Promise<AppSettings>;
  },
  setAutoUpdate(mode: AutoUpdateMode): void {
    ipcRenderer.send(CHANNELS.settingsSetAutoUpdate, mode);
  },
  setAlwaysShowEmptyScreen(on: boolean): void {
    ipcRenderer.send(CHANNELS.settingsSetAlwaysShowEmptyScreen, on);
  },
  setTheme(mode: ThemeMode): void {
    ipcRenderer.send(CHANNELS.settingsSetTheme, mode);
  },
  setPrerelease(on: boolean): void {
    ipcRenderer.send(CHANNELS.settingsSetPrerelease, on);
  },
  setSummonHotkey(on: boolean): void {
    ipcRenderer.send(CHANNELS.settingsSetSummonHotkey, on);
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
  getLanguage(): Promise<Locale> {
    return ipcRenderer.invoke(CHANNELS.settingsLanguageRequest) as Promise<Locale>;
  },
  onLanguageUpdate(callback: (locale: Locale) => void): void {
    ipcRenderer.on(CHANNELS.settingsLanguageUpdate, (_event: IpcRendererEvent, locale: Locale) => {
      callback(locale);
    });
  },
  reset(): Promise<AppSettings> {
    return ipcRenderer.invoke(CHANNELS.settingsReset) as Promise<AppSettings>;
  },
  setTitleBarDark(dark: boolean): void {
    ipcRenderer.send(CHANNELS.titleBarOverlayUpdate, dark);
  },
  openLogs(): void {
    ipcRenderer.send(CHANNELS.openLogs);
  },
  openGamesFolder(): void {
    ipcRenderer.send(CHANNELS.openGamesFolder);
  },
  pickWallpaper(): Promise<WallpaperResult> {
    return ipcRenderer.invoke(CHANNELS.wallpaperPick) as Promise<WallpaperResult>;
  },
  clearWallpaper(): Promise<{ dataUrl: string }> {
    return ipcRenderer.invoke(CHANNELS.wallpaperClear) as Promise<{ dataUrl: string }>;
  },
  requestWallpaperPreview(): Promise<{ dataUrl: string }> {
    return ipcRenderer.invoke(CHANNELS.wallpaperPreviewRequest) as Promise<{ dataUrl: string }>;
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
};

contextBridge.exposeInMainWorld('settingsApi', api);
