import { vi } from 'vitest';
import type { AudioController } from '../../../src/renderer/audio';
import type {
  FilePickerSurface,
  GameSettingsScreenApi,
  TextEntrySurface,
} from '../../../src/renderer/game-settings-screen';
import type { FilePickerApi } from '../../../src/renderer/file-picker';
import type { OnlinePickerSurface } from '../../../src/renderer/online-picker';
import type { SettingsScreenApi } from '../../../src/renderer/settings-screen';
import type {
  ConfigPickKind,
  ConfigPickResult,
  ConfigValidationResult,
  ListDirResult,
  SfxName,
} from '../../../src/shared/types';

export interface FakeAudio extends AudioController {
  /** Every `play(name)` in order — the launcher's navigation feedback is part of the behaviour. */
  readonly played: readonly SfxName[];
  readonly limits: () => number;
  readonly reset: () => void;
}

export function fakeAudio(): FakeAudio {
  const played: SfxName[] = [];
  let limits = 0;
  const noop = (): void => undefined;
  return {
    played,
    limits: () => limits,
    reset: () => {
      played.length = 0;
      limits = 0;
    },
    setCardMusic: noop,
    setBrowseMusic: noop,
    setAmbient: noop,
    setSounds: noop,
    play: (name) => {
      played.push(name);
    },
    playLimit: () => {
      limits += 1;
    },
    rearmLimit: noop,
    playStartup: () => Promise.resolve(),
    setMusicPlaying: noop,
    setMusicVolume: noop,
    setSfxVolume: noop,
  };
}

interface KeyboardRequest {
  readonly value: string;
  readonly mode: 'text' | 'id' | 'number';
  readonly title: string;
  readonly onDone: (value: string) => void;
}

export interface FakeKeyboard extends TextEntrySurface {
  readonly requests: readonly KeyboardRequest[];
  readonly last: () => KeyboardRequest;
  /** Answers the pending request, as the real keyboard's Done key does. */
  readonly commit: (value: string) => void;
  /** Drops the pending request without answering, as B does. */
  readonly cancel: () => void;
}

export function fakeKeyboard(): FakeKeyboard {
  const requests: KeyboardRequest[] = [];
  let pending: KeyboardRequest | null = null;
  const noop = (): void => undefined;
  return {
    requests,
    last: () => {
      const request = requests.at(-1);
      if (request === undefined) throw new Error('keyboard was never opened');
      return request;
    },
    commit: (value) => {
      const request = pending;
      if (request === null) throw new Error('keyboard is not open');
      pending = null;
      request.onDone(value);
    },
    cancel: () => {
      pending = null;
    },
    isOpen: () => pending !== null,
    open: (request) => {
      requests.push(request);
      pending = request;
    },
    close: () => {
      pending = null;
    },
    navUp: noop,
    navDown: noop,
    navLeft: noop,
    navRight: noop,
    navActivate: noop,
    navBack: noop,
    relocalize: noop,
  };
}

interface PickerRequest {
  readonly root: string;
  readonly kind: ConfigPickKind;
  readonly current: string;
  readonly multi: boolean;
  readonly base?: string;
  /** Set when the screen is editing a game from the history — see FilePickerSurface.open. */
  readonly historyId?: string;
  readonly onDone: (result: ConfigPickResult) => void;
}

export interface FakePicker extends FilePickerSurface {
  readonly requests: readonly PickerRequest[];
  readonly last: () => PickerRequest;
  readonly done: (result: ConfigPickResult) => void;
}

export function fakePicker(): FakePicker {
  const requests: PickerRequest[] = [];
  let pending: PickerRequest | null = null;
  const noop = (): void => undefined;
  return {
    requests,
    last: () => {
      const request = requests.at(-1);
      if (request === undefined) throw new Error('picker was never opened');
      return request;
    },
    done: (result) => {
      const request = pending;
      if (request === null) throw new Error('picker is not open');
      pending = null;
      request.onDone(result);
    },
    isOpen: () => pending !== null,
    open: (request) => {
      requests.push(request);
      pending = request;
    },
    navUp: noop,
    navDown: noop,
    navLeft: noop,
    navRight: noop,
    navActivate: noop,
    navBack: noop,
    relocalize: noop,
  };
}

interface OnlineRequest {
  readonly query: string;
  readonly appId?: number;
}

export interface FakeOnlinePicker extends OnlinePickerSurface {
  readonly requests: readonly OnlineRequest[];
}

export function fakeOnlinePicker(): FakeOnlinePicker {
  const requests: OnlineRequest[] = [];
  let open = false;
  const noop = (): void => undefined;
  return {
    requests,
    isOpen: () => open,
    open: (request) => {
      requests.push(request);
      open = true;
    },
    close: () => {
      open = false;
    },
    navUp: noop,
    navDown: noop,
    navLeft: noop,
    navRight: noop,
    navActivate: noop,
    navBack: noop,
    relocalize: noop,
  };
}

export function fakeSettingsApi(): SettingsScreenApi {
  return {
    setAutoUpdate: vi.fn(),
    setPrerelease: vi.fn(),
    setSummonHotkey: vi.fn(),
    setPreventScreensaver: vi.fn(),
    setKeepOpenWithoutCard: vi.fn(),
    setDisableSilentInstall: vi.fn(),
    setSteamAutoLaunch: vi.fn(),
    setSoundSet: vi.fn(),
    setAmbientTrack: vi.fn(),
    setOnlyGlobalAmbient: vi.fn(),
    setMusicVolume: vi.fn(),
    setSfxVolume: vi.fn(),
    setLanguage: vi.fn(),
    setSteamGridDbKey: vi.fn(),
    resetSettings: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
  };
}

/** A directory tree keyed by absolute path, as the picker's `listDir` sees it. */
export interface FakeTree {
  readonly [path: string]: readonly { readonly name: string; readonly kind: 'dir' | 'file' }[];
}

export interface FakeFilePickerApi extends FilePickerApi {
  readonly listed: readonly string[];
  readonly accepted: readonly (readonly string[])[];
  /** What `acceptPaths` answers with; the default turns the picked paths into relative ones. */
  acceptWith: (paths: readonly string[]) => ConfigPickResult;
}

const PICKER_ROOTS = [{ path: '/card', label: 'Card', kind: 'card' as const }];

export function fakeFilePickerApi(tree: FakeTree, start = '/card'): FakeFilePickerApi {
  const listed: string[] = [];
  const accepted: (readonly string[])[] = [];
  const parentOf = (path: string): string | null => {
    const at = path.lastIndexOf('/');
    if (at <= 0) return null;
    return path.slice(0, at);
  };
  const api: FakeFilePickerApi = {
    listed,
    accepted,
    acceptWith: (paths) => ({ ok: true, paths }),
    listDir: (request) => {
      const path = request.path ?? start;
      listed.push(path);
      const entries = tree[path];
      const result: ListDirResult =
        entries === undefined
          ? { ok: false, message: `no such directory: ${path}`, roots: PICKER_ROOTS }
          : { ok: true, path, parent: parentOf(path), entries, roots: PICKER_ROOTS };
      return Promise.resolve(result);
    },
    acceptPaths: (request) => {
      accepted.push(request.paths);
      return Promise.resolve(api.acceptWith(request.paths));
    },
    acceptHistoryPaths: (request) => {
      accepted.push(request.paths);
      return Promise.resolve(api.acceptWith(request.paths));
    },
  };
  return api;
}

const VALID: ConfigValidationResult = { ok: true };

export function fakeGameSettingsApi(
  overrides: Partial<GameSettingsScreenApi> = {},
): GameSettingsScreenApi {
  return {
    read: vi.fn(() => Promise.resolve({ ok: false, message: 'not stubbed' } as const)),
    validate: vi.fn(() => Promise.resolve(VALID)),
    save: vi.fn(() => Promise.resolve({ saved: true, applied: 'applied' } as const)),
    imagePreview: vi.fn(() => Promise.resolve(null)),
    readHistory: vi.fn(() => Promise.resolve({ ok: false, message: 'not stubbed' } as const)),
    saveHistory: vi.fn(() => Promise.resolve({ saved: true, applied: 'deferred' } as const)),
    historyAssetPreview: vi.fn(() => Promise.resolve(null)),
    sources: vi.fn(() => Promise.resolve([])),
    readRoot: vi.fn(() => Promise.resolve({ ok: false, message: 'not stubbed' } as const)),
    forgetHistory: vi.fn(),
    moveToCard: vi.fn(() => Promise.resolve({ moved: false, message: 'not stubbed' } as const)),
    acceptPath: vi.fn(() => Promise.resolve({ ok: false, cancelled: true } as const)),
    searchMetadata: vi.fn(() => Promise.resolve({ ok: true, value: [] } as const)),
    requestSteamCandidate: vi.fn(() =>
      Promise.resolve({ ok: false, message: 'not stubbed' } as const),
    ),
    metadataDescriptions: vi.fn(() =>
      Promise.resolve({ ok: false, message: 'not stubbed' } as const),
    ),
    applyMetadata: vi.fn(() => Promise.resolve({ ok: false, message: 'not stubbed' } as const)),
    cancelMetadata: vi.fn(),
    ...overrides,
  };
}
