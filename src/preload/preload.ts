// Typed main↔renderer bridge (contextIsolation: true, nodeIntegration: false).
// Channels are inlined as literals rather than imported from shared, so the preload
// stays sandbox-compatible (a sandboxed preload cannot require arbitrary files).
// The literals must match the IPC channels in shared/types.ts.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppState, AudioAssets, AudioVolumes, HeroAssets, RendererApi } from '../shared/types';

const CHANNELS = {
  stateUpdate: 'state:update',
  stateRequest: 'state:request',
  actionLaunch: 'action:launch',
  actionUninstall: 'action:uninstall',
  actionHide: 'action:hide',
  actionOpenSteamDownloads: 'action:open-steam-downloads',
  errorShow: 'error:show',
  audioUpdate: 'audio:update',
  audioRequest: 'audio:request',
  heroUpdate: 'hero:update',
  heroRequest: 'hero:request',
  wallpaperRequest: 'wallpaper:request',
  volumeRequest: 'volume:request',
  volumeUpdate: 'volume:update',
} as const;

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
  requestVolumes(): Promise<AudioVolumes> {
    return ipcRenderer.invoke(CHANNELS.volumeRequest) as Promise<AudioVolumes>;
  },
  onVolumesUpdate(callback: (volumes: AudioVolumes) => void): void {
    ipcRenderer.on(CHANNELS.volumeUpdate, (_event: IpcRendererEvent, volumes: AudioVolumes) => {
      callback(volumes);
    });
  },
};

contextBridge.exposeInMainWorld('api', api);
