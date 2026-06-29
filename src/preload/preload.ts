// Typed main↔renderer bridge (contextIsolation: true, nodeIntegration: false).
// Channels are inlined as literals rather than imported from shared, so the preload
// stays sandbox-compatible (a sandboxed preload cannot require arbitrary files).
// The literals must match the IPC channels in shared/types.ts.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppState, AudioAssets, RendererApi } from '../shared/types';

const CHANNELS = {
  stateUpdate: 'state:update',
  stateRequest: 'state:request',
  actionLaunch: 'action:launch',
  actionHide: 'action:hide',
  audioUpdate: 'audio:update',
  audioRequest: 'audio:request',
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
  requestHide(): void {
    ipcRenderer.send(CHANNELS.actionHide);
  },
  onAudioUpdate(callback: (assets: AudioAssets | null) => void): void {
    ipcRenderer.on(CHANNELS.audioUpdate, (_event: IpcRendererEvent, assets: AudioAssets | null) => {
      callback(assets);
    });
  },
  requestAudio(): Promise<AudioAssets | null> {
    return ipcRenderer.invoke(CHANNELS.audioRequest) as Promise<AudioAssets | null>;
  },
};

contextBridge.exposeInMainWorld('api', api);
