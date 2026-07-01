// Typed main↔settings-renderer bridge (contextIsolation: true, nodeIntegration: false, sandbox: true).
// Separate from preload.ts so the settings window gets its own `window.settingsApi`, isolated from the
// game `window.api` contract (A1). As in preload.ts, channels are inlined as string LITERALS rather
// than imported from shared: a sandboxed preload cannot require arbitrary files. Only `import type`
// from shared is allowed (types erase at compile time). The literals below MUST match the IPC channel
// values in shared/types.ts symbol-for-symbol — the compiler cannot catch a drift here (I1).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AppSettings,
  AutoUpdateMode,
  SettingsApi,
  ThemeMode,
  UpdateStatus,
} from '../shared/types';

const CHANNELS = {
  updateStatusUpdate: 'update:status',
  updateStatusRequest: 'update:request',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  settingsRequest: 'settings:request',
  settingsSetAutoUpdate: 'settings:set-auto-update',
  settingsSetTheme: 'settings:set-theme',
  settingsSetPrerelease: 'settings:set-prerelease',
  settingsSetSummonHotkey: 'settings:set-summon-hotkey',
  settingsSetMusicVolume: 'settings:set-music-volume',
  settingsSetSfxVolume: 'settings:set-sfx-volume',
  settingsReset: 'settings:reset',
  titleBarOverlayUpdate: 'settings:titlebar-overlay',
  appVersionRequest: 'app:version',
  appIconRequest: 'app:icon',
  moveSoundRequest: 'app:move-sound',
  openLogs: 'app:open-logs',
  openGamesFolder: 'app:open-games-folder',
} as const;

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
