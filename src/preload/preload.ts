// Typed main↔renderer bridge (contextIsolation: true, nodeIntegration: false).
// Channels are inlined as literals rather than imported from shared, so the preload
// stays sandbox-compatible (a sandboxed preload cannot require arbitrary files).
// `satisfies Partial<typeof IPC>` gives us the compile-time bridge back: a wrong channel
// value (TS2322) or a typo'd key (TS2353) now fails typecheck. `import type` keeps IPC
// out of the runtime bundle (it erases), so the sandbox stays intact. Partial<> cannot
// catch a *missing* channel though — that completeness is guarded by the ipc-channels
// unit test (shared/types.ts is the single source of truth).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppState, AudioAssets, AudioVolumes, HeroAssets, RendererApi } from '../shared/types';
import type { IPC } from '../shared/types';
import type { Locale } from '../shared/i18n/index';

const CHANNELS = {
  stateUpdate: 'state:update',
  stateRequest: 'state:request',
  actionLaunch: 'action:launch',
  actionUninstall: 'action:uninstall',
  actionHide: 'action:hide',
  actionOpenSteamDownloads: 'action:open-steam-downloads',
  actionShutdown: 'action:shutdown',
  actionReboot: 'action:reboot',
  actionSleep: 'action:sleep',
  actionKill: 'action:kill',
  errorShow: 'error:show',
  audioUpdate: 'audio:update',
  audioRequest: 'audio:request',
  heroUpdate: 'hero:update',
  heroRequest: 'hero:request',
  wallpaperRequest: 'wallpaper:request',
  wallpaperUpdate: 'wallpaper:update',
  volumeRequest: 'volume:request',
  volumeUpdate: 'volume:update',
  languageRequest: 'app:language-request',
  languageUpdate: 'app:language-update',
} as const satisfies Partial<typeof IPC>;

const api: RendererApi = {
  onStateUpdate(callback: (state: AppState) => void): void {
    ipcRenderer.on(CHANNELS.stateUpdate, (_event: IpcRendererEvent, state: AppState) => {
      callback(state);
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
  onAudioUpdate(callback: (assets: AudioAssets | null) => void): void {
    ipcRenderer.on(CHANNELS.audioUpdate, (_event: IpcRendererEvent, assets: AudioAssets | null) => {
      callback(assets);
    });
  },
  requestAudio(): Promise<AudioAssets | null> {
    return ipcRenderer.invoke(CHANNELS.audioRequest) as Promise<AudioAssets | null>;
  },
  onHeroUpdate(callback: (assets: HeroAssets | null) => void): void {
    ipcRenderer.on(CHANNELS.heroUpdate, (_event: IpcRendererEvent, assets: HeroAssets | null) => {
      callback(assets);
    });
  },
  requestHero(): Promise<HeroAssets | null> {
    return ipcRenderer.invoke(CHANNELS.heroRequest) as Promise<HeroAssets | null>;
  },
  requestWallpaper(): Promise<string | null> {
    return ipcRenderer.invoke(CHANNELS.wallpaperRequest) as Promise<string | null>;
  },
  onWallpaperUpdate(callback: (url: string) => void): void {
    ipcRenderer.on(CHANNELS.wallpaperUpdate, (_event: IpcRendererEvent, url: string) => {
      callback(url);
    });
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
};

contextBridge.exposeInMainWorld('api', api);
