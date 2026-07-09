// Typed main↔configure-renderer bridge (contextIsolation: true, nodeIntegration: false, sandbox: true).
// Separate from preload.ts / settings-preload.ts so the Configure-game window gets its own
// `window.configureApi`, isolated from the game `window.api` and the settings `window.settingsApi`.
// As in the other preloads, channels are inlined as string LITERALS (a sandboxed preload cannot require
// arbitrary files) and only `import type` from shared is allowed. `satisfies Partial<typeof IPC>`
// restores a compile-time guard over these literals; the ipc-channels unit test guards that this
// CHANNELS map equals its slice of the shared IPC source of truth (and doesn't overlap the others).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AppSettings,
  ConfigEditorCommand,
  ConfigureApi,
  ConfigPickKind,
  ConfigPickResult,
  ConfigReadResult,
  ConfigSaveResult,
  ConfigTemplates,
  ConfigValidationResult,
  DriveCandidate,
  ThemeMode,
} from '../shared/types';
import type { IPC } from '../shared/types';
import type { Locale } from '../shared/i18n/index';

const CHANNELS = {
  configDrivesRequest: 'config:drives-request',
  configDrivesUpdate: 'config:drives-update',
  configRead: 'config:read',
  configValidate: 'config:validate',
  configSave: 'config:save',
  configTemplatesRequest: 'config:templates-request',
  configSchemaRequest: 'config:schema-request',
  configSettingsRequest: 'config:settings-request',
  configIconRequest: 'config:icon',
  configVersionRequest: 'config:version',
  configEditorCommand: 'config:editor-command',
  configEditorActive: 'config:editor-active',
  configTitleBarOverlay: 'config:titlebar-overlay',
  configLanguageRequest: 'config:language-request',
  configLanguageUpdate: 'config:language-update',
  configThemeUpdate: 'config:theme-update',
  configPickPath: 'config:pick-path',
  configImagePreview: 'config:image-preview',
  configOpenExternal: 'config:open-external',
} as const satisfies Partial<typeof IPC>;

const api: ConfigureApi = {
  getDrives(): Promise<readonly DriveCandidate[]> {
    return ipcRenderer.invoke(CHANNELS.configDrivesRequest) as Promise<readonly DriveCandidate[]>;
  },
  onDrivesUpdate(callback: (drives: readonly DriveCandidate[]) => void): void {
    ipcRenderer.on(
      CHANNELS.configDrivesUpdate,
      (_event: IpcRendererEvent, drives: readonly DriveCandidate[]) => {
        callback(drives);
      },
    );
  },
  readConfig(root: string): Promise<ConfigReadResult> {
    return ipcRenderer.invoke(CHANNELS.configRead, root) as Promise<ConfigReadResult>;
  },
  validateConfig(text: string): Promise<ConfigValidationResult> {
    return ipcRenderer.invoke(CHANNELS.configValidate, text) as Promise<ConfigValidationResult>;
  },
  saveConfig(root: string, text: string): Promise<ConfigSaveResult> {
    return ipcRenderer.invoke(CHANNELS.configSave, { root, text }) as Promise<ConfigSaveResult>;
  },
  getTemplates(): Promise<ConfigTemplates> {
    return ipcRenderer.invoke(CHANNELS.configTemplatesRequest) as Promise<ConfigTemplates>;
  },
  pickPath(root: string, kind: ConfigPickKind): Promise<ConfigPickResult> {
    return ipcRenderer.invoke(CHANNELS.configPickPath, { root, kind }) as Promise<ConfigPickResult>;
  },
  getImagePreview(root: string, path: string): Promise<string | null> {
    return ipcRenderer.invoke(CHANNELS.configImagePreview, { root, path }) as Promise<string | null>;
  },
  openExternal(url: string): void {
    ipcRenderer.send(CHANNELS.configOpenExternal, url);
  },
  getSchema(): Promise<unknown> {
    return ipcRenderer.invoke(CHANNELS.configSchemaRequest) as Promise<unknown>;
  },
  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke(CHANNELS.configSettingsRequest) as Promise<AppSettings>;
  },
  getAppIcon(): Promise<string> {
    return ipcRenderer.invoke(CHANNELS.configIconRequest) as Promise<string>;
  },
  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke(CHANNELS.configVersionRequest) as Promise<string>;
  },
  onEditorCommand(callback: (command: ConfigEditorCommand) => void): void {
    ipcRenderer.on(
      CHANNELS.configEditorCommand,
      (_event: IpcRendererEvent, command: ConfigEditorCommand) => {
        callback(command);
      },
    );
  },
  setJsonEditorActive(active: boolean): void {
    ipcRenderer.send(CHANNELS.configEditorActive, active);
  },
  setTitleBarDark(dark: boolean): void {
    ipcRenderer.send(CHANNELS.configTitleBarOverlay, dark);
  },
  getLanguage(): Promise<Locale> {
    return ipcRenderer.invoke(CHANNELS.configLanguageRequest) as Promise<Locale>;
  },
  onLanguageUpdate(callback: (locale: Locale) => void): void {
    ipcRenderer.on(CHANNELS.configLanguageUpdate, (_event: IpcRendererEvent, locale: Locale) => {
      callback(locale);
    });
  },
  onThemeUpdate(callback: (mode: ThemeMode) => void): void {
    ipcRenderer.on(CHANNELS.configThemeUpdate, (_event: IpcRendererEvent, mode: ThemeMode) => {
      callback(mode);
    });
  },
};

contextBridge.exposeInMainWorld('configureApi', api);
