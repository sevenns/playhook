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
 * Optional `install` block in `game.json` (install mode).
 * When present, the card carries an INSTALLER (not the game itself): the app runs it silently,
 * feeding it the install directory through the installer's own dir-key, and only afterwards does
 * `executable` resolve relative to that install directory (not the card root). See ResolvedManifest.
 */
export interface InstallManifest {
  /** Path to the installer (e.g. setup.exe) RELATIVE to the card root. */
  readonly installer: string;
  /**
   * Installer family — decides how the install directory is passed silently:
   * `nsis` → `/S /D=<dir>`, `inno` → `/VERYSILENT /DIR="<dir>"`, `custom` → caller-supplied `args`
   * with a single `{dir}` placeholder. MSI is out of MVP (its dir-property name isn't standardized).
   */
  readonly type: 'nsis' | 'inno' | 'custom';
  /** Run the installer elevated (UAC). Forbidden for `custom` (the card would control elevated argv). */
  readonly runAsAdmin: boolean;
  /**
   * For `custom`: the full argument list, with exactly one token containing the `{dir}` placeholder
   * (the install directory is substituted in). For `nsis`/`inno`: optional EXTRA flags appended to the
   * built-in silent + dir flags.
   */
  readonly args: readonly string[];
}

/**
 * Optional `steam` block in `game.json` (Steam mode).
 * When present, the card is just a POINTER to a Steam app (by appid) — it carries no game files,
 * only the manifest, cover art and optional saves. Launch/install go through `steam://` URIs
 * (shell.openExternal), and "installed" is decided by Steam's own `.acf` state — NOT by a file on
 * the card. A separate backend from install mode (no card installer, no app-controlled dir).
 */
export interface SteamManifest {
  /** The Steam application id. For base games `rungameid == appid`. */
  readonly appid: number;
}

/**
 * Raw `game.json` manifest after zod-schema validation (section 3a).
 * The executable/heroImage/saveOnCard paths are relative to the SD root;
 * pcSavePath is absolute with an env prefix from the whitelist.
 */
export interface GameManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  /** Card-relative path to the game/launcher .exe. Omitted in Steam mode (launch goes via steam://). */
  readonly executable?: string;
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
  /**
   * Optional install mode: when set, the card holds an installer and `executable` is interpreted
   * relative to the install directory (controlled by the app), not the card root. See InstallManifest.
   */
  readonly install?: InstallManifest;
  /**
   * Optional Steam mode: when set, the card is a pointer to a Steam app (by appid) and there are no
   * game files on the card — launch/install go through `steam://` URIs. Mutually exclusive with
   * `install`/`executable` and requires `watchProcesses` (enforced by the schema). See SteamManifest.
   */
  readonly steam?: SteamManifest;
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
  /**
   * The effective launch target. In install mode this is `<installDir>/<executable>` (and `cwd` its
   * dirname) — it may NOT exist yet (that is exactly the "not installed" state). For a normal game it
   * is `<root>/<executable>`, verified to exist at read time.
   *
   * In Steam mode there is no card executable, so both are empty strings (`''`). They are NEVER read
   * in Steam mode: every consumer (launchGame, pollForExecutable, the buildGameInfo existence check)
   * branches on `steam` first. Kept as required `string` on purpose — making them optional would ripple
   * type errors into the hot normal/install paths whose only fix is a non-null assertion (banned).
   */
  readonly executablePath: string;
  readonly cwd: string;
  readonly heroImagePath?: string;
  readonly saveOnCardPath?: string;
  readonly pcSavePath?: string;
  /** Resolved, card-relative sound-effect file paths (any subset present). */
  readonly soundPaths?: Partial<Record<SfxName, string>>;
  /** Resolved background-music file path. */
  readonly backgroundMusicPath?: string;
  /** Resolved install descriptor (install mode only). */
  readonly install?: {
    /** Absolute path to the installer (setup.exe) on the card. */
    readonly installerPath: string;
    readonly type: InstallManifest['type'];
    readonly runAsAdmin: boolean;
    readonly args: readonly string[];
    /** The install directory the app controls: `%LOCALAPPDATA%\playhook\games\<id>`. */
    readonly dir: string;
  };
  /** Resolved Steam descriptor (Steam mode only). When present, launch/install go through steam://. */
  readonly steam?: {
    readonly appid: number;
  };
}

/**
 * What to launch, decoupled from a manifest so both a game launch and an installer launch reuse the
 * same backend (normal spawn vs elevated ShellExecuteEx). The args are FINAL tokens — any installer
 * quoting is already baked in (see buildInstallerArgs), so the backend passes them through verbatim.
 */
export interface LaunchTarget {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly runAsAdmin: boolean;
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
  /**
   * True when the game is not yet usable and the button should read "Install" instead of "Play":
   * either an install-mode game whose resolved `executable` doesn't exist yet on disk, OR a Steam-mode
   * game that isn't fully installed in Steam (`.acf` state). False for an ordinary card game and for an
   * already-installed install/Steam game. NOTE: this is NO LONGER equivalent to "has an install block".
   */
  readonly requiresInstall: boolean;
  /**
   * Install-mode (card installer) AND the game is installed (the resolved executable exists). Drives
   * the "Uninstall" button, shown only for an installed install-mode game. Steam-mode games NEVER set
   * this (uninstall is managed in Steam itself) — so it is no longer mutually exclusive with
   * `requiresInstall` across all modes; the relation only holds within card-install mode.
   */
  readonly canUninstall: boolean;
  /**
   * Install mode (card installer) only: the app-controlled install directory
   * (`%LOCALAPPDATA%\playhook\games\<id>`). Surfaced so the install-confirmation popup can show the
   * destination path — handy to copy if the installer opens a non-silent picker. Undefined otherwise.
   */
  readonly installDir?: string;
  /**
   * How the game is installed/launched when `requiresInstall` is true. `'steam'` → the install action
   * opens `steam://install/<appid>` (no card path, no silent-mode note). Undefined → an ordinary card
   * game or a card-installer game. Lets the renderer pick the right confirm copy.
   */
  readonly installVia?: 'steam';
  /**
   * Steam mode only: a download/update is in progress (the `.acf` exists but isn't fully installed).
   * Drives a non-blocking "Installing…" indicator — NOT a blocking `installing` state (a Steam download
   * can run for hours; the window stays usable). No percent: Steam exposes no reliable real-time
   * progress in the files we can read (see steam.ts AcfState). Undefined when not downloading.
   */
  readonly steamInstalling?: boolean;
  /**
   * Steam mode only: the in-progress download is PAUSED (Steam's `UpdateResult` is non-zero). Only
   * meaningful together with `steamInstalling` — flips the indicator text to "Installing paused…".
   */
  readonly steamPaused?: boolean;
  /**
   * Steam mode only: completion fraction (0..1) captured at pause. Steam's byte counters are only fresh
   * while paused, so this is present ONLY with `steamPaused` (and may still be absent if uncomputable) —
   * renders as "Installing paused on N%…".
   */
  readonly steamPausedProgress?: number;
  /**
   * Steam mode only: a Steam uninstall we requested is in progress. Drives a non-blocking
   * "Uninstalling…" indicator (no percentage — removal isn't a download). Set optimistically right
   * after opening `steam://uninstall`; cleared when Steam drops the `.acf` (→ "Install") or, if the
   * user cancelled Steam's dialog, by a timeout in the background poller (→ back to "Play"/"Uninstall").
   */
  readonly steamUninstalling?: boolean;
}

/** The flow state machine (discriminated union, section 4). */
export type AppState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'ready'; readonly game: GameInfo }
  | { readonly kind: 'installing'; readonly game: GameInfo }
  | { readonly kind: 'uninstalling'; readonly game: GameInfo }
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
  /** renderer → main: the user confirmed "Uninstall" — remove the installed install-mode game. */
  actionUninstall: 'action:uninstall',
  /** renderer → main: hide the launcher window to the tray (the "Hide" button on the empty screen). */
  actionHide: 'action:hide',
  /** renderer → main: open Steam's Downloads page (steam://open/downloads) — used by the Play button
   * while a Steam download is in progress, so the user can pause/resume it in Steam itself. */
  actionOpenSteamDownloads: 'action:open-steam-downloads',
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
  requestUninstall(): void;
  requestHide(): void;
  /** Open Steam's Downloads page so the user can pause/resume a Steam download from Steam itself. */
  openSteamDownloads(): void;
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
