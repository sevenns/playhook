// Shared contract between main, preload and renderer.
// Types only — the file compiles to empty JS and creates no runtime dependencies,
// so the renderer can import from here via `import type` without require.

/** Application name — the root of the state directory under %APPDATA%. */
export const APP_NAME = 'microsd-game-launcher' as const;

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
  readonly heroImage?: string;
  readonly saveOnCard?: string;
  readonly pcSavePath?: string;
  readonly launchTimeoutSec: number;
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
} as const;

/** API that preload exposes on `window.api`. */
export interface RendererApi {
  onStateUpdate(callback: (state: AppState) => void): void;
  requestState(): Promise<AppState>;
  requestLaunch(): void;
}

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    readonly api: RendererApi;
  }
}
