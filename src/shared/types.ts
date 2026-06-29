// Shared contract between main, preload and renderer.
// Types only — the file compiles to empty JS and creates no runtime dependencies,
// so the renderer can import from here via `import type` without require.

/** Display name (window title / tray tooltip). The %APPDATA% data folder is derived separately by
 * Electron from package.json `name` (currently "playhook"). */
export const APP_NAME = 'Playhook' as const;

/** Manifest file name in the card root. */
export const MANIFEST_FILENAME = 'game.json' as const;

/** File name of the stats copy on the card (best-effort). */
export const CARD_STATS_FILENAME = 'stats.json' as const;

/**
 * Raw `game.json` manifest after zod-schema validation (section 3a).
 * The executable/heroImage/saveOnCard paths are relative to the SD root;
 * pcSavePath is absolute with an env prefix from the whitelist.
 */
export interface GameManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly executable: string;
  readonly args: readonly string[];
  /** Launch the .exe elevated (UAC "runas") for executables whose manifest requires administrator. */
  readonly runAsAdmin: boolean;
  /**
   * Image names of the GAME's own processes (e.g. ["Game-Win64-Shipping.exe"]) for launcher/wrapper
   * setups where `executable` spawns a launcher that starts the game in a separate process and exits.
   * When set, liveness is tracked by these names (presence in `tasklist`), not (only) by the spawned
   * launcher's pid. When omitted, behaviour is unchanged — the pid path stays the default for
   * self-contained .exe games.
   */
  readonly watchProcesses?: readonly string[];
  readonly heroImage?: string;
  readonly saveOnCard?: string;
  readonly pcSavePath?: string;
  readonly launchTimeoutSec: number;
  /** Optional per-game UI sound effects (card-relative paths). Missing slots are silent. */
  readonly sounds?: SoundManifest;
  /** Optional looping background music (card-relative path), played while the window is visible. */
  readonly backgroundMusic?: string;
}

/** UI sound-effect slots. Each maps to a file in game.json (all optional). */
export type SfxName = 'play' | 'navigate' | 'button' | 'back';

/** The `sounds` block in game.json — a file per UI sound slot. */
export interface SoundManifest {
  /** Pressing the "Play" button. */
  readonly play?: string;
  /** Moving focus between UI controls. */
  readonly navigate?: string;
  /** Pressing an ordinary button (e.g. "Info"). */
  readonly button?: string;
  /** Hiding something — gamepad B closing the info popup. */
  readonly back?: string;
}

/**
 * Manifest with already-resolved and security-checked paths (P6/R7).
 * All *Path values are absolute; the card's relative paths are verified to stay
 * "inside the root", and pcSavePath is expanded from the env whitelist.
 */
export interface ResolvedManifest {
  readonly raw: GameManifest;
  readonly root: string;
  readonly executablePath: string;
  readonly cwd: string;
  readonly heroImagePath?: string;
  readonly saveOnCardPath?: string;
  readonly pcSavePath?: string;
  /** Resolved, card-relative sound-effect file paths (any subset present). */
  readonly soundPaths?: Partial<Record<SfxName, string>>;
  /** Resolved background-music file path. */
  readonly backgroundMusicPath?: string;
}

/**
 * Per-game audio for the renderer, delivered as data URLs.
 * Kept OUT of GameInfo/AppState on purpose: AppState is re-sent on every transition, and these
 * payloads (especially music) can be large — so audio is delivered once per card on its own channel.
 */
export interface AudioAssets {
  /** UI sound effects (data URLs); any subset of slots present. */
  readonly sounds: Partial<Record<SfxName, string>>;
  /** Looping background music (data URL), if the manifest provides it. */
  readonly music?: string;
}

/** Game statistics. The source of truth is on the PC; the card copy is best-effort. */
export interface Stats {
  readonly schemaVersion: 1;
  readonly totalPlaySeconds: number;
  readonly lastPlayedAt: string | null;
  readonly launchCount: number;
}

/** What the renderer shows in the `ready` window. */
export interface GameInfo {
  readonly id: string;
  readonly title: string;
  /** Background data URL (main reads the file and encodes it), or undefined. */
  readonly heroImageDataUrl?: string;
  readonly lastPlayedAt: string | null;
  readonly totalPlaySeconds: number;
  readonly launchCount: number;
}

/** The flow state machine (discriminated union, section 4). */
export type AppState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'ready'; readonly game: GameInfo }
  | { readonly kind: 'syncing-in'; readonly game: GameInfo }
  | { readonly kind: 'launching'; readonly game: GameInfo }
  | { readonly kind: 'running'; readonly game: GameInfo; readonly since: number }
  | { readonly kind: 'syncing-out'; readonly game: GameInfo }
  | { readonly kind: 'error'; readonly game?: GameInfo; readonly message: string };

/** IPC channels (the preload typed bridge). */
export const IPC = {
  /** main → renderer: replica of the current AppState. */
  stateUpdate: 'state:update',
  /** renderer → main: request the current state (on window startup). */
  stateRequest: 'state:request',
  /** renderer → main: the user pressed A / clicked "Play". */
  actionLaunch: 'action:launch',
  /** renderer → main: hide the launcher window to the tray (the "Hide" button on the empty screen). */
  actionHide: 'action:hide',
  /** main → renderer: a transient error to surface in the error popup (e.g. a failed launch). */
  errorShow: 'error:show',
  /** main → renderer: audio assets for the current game (or null when no card). */
  audioUpdate: 'audio:update',
  /** renderer → main: request the current audio assets (on window startup). */
  audioRequest: 'audio:request',
  /** renderer → main: request the fallback wallpaper data URL (for the idle / empty screen). */
  wallpaperRequest: 'wallpaper:request',
} as const;

/** API that preload exposes on `window.api`. */
export interface RendererApi {
  onStateUpdate(callback: (state: AppState) => void): void;
  requestState(): Promise<AppState>;
  requestLaunch(): void;
  requestHide(): void;
  onError(callback: (message: string) => void): void;
  onAudioUpdate(callback: (assets: AudioAssets | null) => void): void;
  requestAudio(): Promise<AudioAssets | null>;
  requestWallpaper(): Promise<string | null>;
}

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    readonly api: RendererApi;
  }
}
