// The manifest domain model: what a card's (or the PC library's) game.json declares, and the RESOLVED
// form the launcher works with once every path has been checked. Main-only — the renderer edits a
// manifest as text and reads the launcher's view of a game through GameInfo / BrowseInfo — so it lives
// next to manifest.ts rather than in the shared contract.
import type { LocalizedText, GamePlatform, ManifestSource } from '../shared/types';

/** Manifest file name in the card root. */
export const MANIFEST_FILENAME = 'game.json' as const;

/**
 * Optional `install` block in `game.json` (install mode).
 * When present, the card carries an INSTALLER (not the game itself): the app runs it silently,
 * feeding it the install directory through the installer's own dir-key, and only afterwards does
 * `executable` resolve relative to that install directory (not the card root). See ResolvedManifest.
 *
 * `type: 'copy'` is the exception: nothing is installed and no process runs — the card carries the
 * game's directory and the app copies it into the install dir ("move game to PC" in the UI). It reuses
 * this block because everything AROUND the installer run is identical (install dir, Install/Play
 * routing, requiresInstall, uninstall).
 */
export interface InstallManifest {
  /**
   * Path RELATIVE to the card root. For `nsis`/`inno`/`custom`: the installer file (e.g. setup.exe).
   * For `copy`: the root of the game DIRECTORY to copy to the PC.
   */
  readonly installer: string;
  /**
   * Installer family — decides how the install directory is passed silently:
   * `nsis` → `/S /D=<dir>`, `inno` → `/VERYSILENT /DIR="<dir>"`, `custom` → caller-supplied `args`
   * with a single `{dir}` placeholder. MSI is out of MVP (its dir-property name isn't standardized).
   * `copy` runs no installer at all — the app copies `installer` (a directory) into the install dir.
   */
  readonly type: 'nsis' | 'inno' | 'custom' | 'copy';
  /**
   * Run the installer elevated (UAC). Forbidden for `custom` (the card would control elevated argv)
   * and for `copy` (no process to elevate).
   */
  readonly runAsAdmin: boolean;
  /**
   * For `custom`: the full argument list, with exactly one token containing the `{dir}` placeholder
   * (the install directory is substituted in). For `nsis`/`inno`: optional EXTRA flags appended to the
   * built-in silent + dir flags. Forbidden (must be empty) for `copy`.
   */
  readonly args: readonly string[];
  /**
   * Linux-only: extra winetricks verbs provisioned into the game's Wine prefix before the installer
   * runs, on top of the app's baseline set (e.g. a skinned Inno installer needing `mfc42`/`gdiplus`, or a
   * game needing `dotnet48`). Ignored on Windows. Empty by default (schema `.default([])`).
   */
  readonly winetricks: readonly string[];
}

/**
 * The install types that actually RUN an installer process, i.e. everything but `copy`.
 * Narrowing a parameter to this makes the compiler PROVE that `copy` never reaches installer-argv or
 * uninstaller code (where it would otherwise be silently mistaken for nsis) — the caller must rule it
 * out explicitly. Preferred over a runtime throw: the guarantee holds at compile time.
 */
export type InstallerRunType = Exclude<InstallManifest['type'], 'copy'>;

/** Fields shared by every resolved install descriptor, whatever the type (see ResolvedInstall). */
interface ResolvedInstallBase {
  /** Absolute path on the card: the installer file, or — for `copy` — the game directory to copy. */
  readonly installerPath: string;
  readonly runAsAdmin: boolean;
  readonly args: readonly string[];
  /**
   * Extra winetricks verbs provisioned into the game's Wine prefix before install, on top of the
   * linux baseline set. Linux-only; ignored on Windows. Empty by default.
   */
  readonly winetricks: readonly string[];
  /**
   * Host-view of the app-controlled install directory: every fs op (pre-clean, uninstaller search,
   * sweep) and the resolved `executable` live under it. win32: `%LOCALAPPDATA%\playhook\games\<id>`;
   * linux: `<pfx>/drive_c/playhook/games/<id>` (inside the game's Wine prefix).
   */
  readonly dir: string;
  /**
   * Installer-view of the SAME directory, fed to the silent dir-arg (`/DIR=` / `/D=`). win32: identical
   * to `dir`; linux: `C:\playhook\games\<id>` — the path the installer sees under Wine.
   */
  readonly installerDir: string;
}

/** A resolved install that RUNS an installer — the only shape installer/uninstaller code accepts. */
export interface ResolvedInstallerRun extends ResolvedInstallBase {
  readonly type: InstallerRunType;
}

/** A resolved `copy` install: `installerPath` is a DIRECTORY, copied wholesale into `dir`. */
export interface ResolvedCopyInstall extends ResolvedInstallBase {
  readonly type: 'copy';
}

/**
 * Resolved install descriptor. A discriminated union on `type` so that ruling out `copy` narrows the
 * whole descriptor — that is what lets the compiler prove `copy` never reaches installer-argv or
 * uninstaller code, instead of it silently falling into the nsis branch.
 */
export type ResolvedInstall = ResolvedInstallerRun | ResolvedCopyInstall;

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
 * Optional `pc` block in `game.json` (PC mode — a game already installed on this machine's disk).
 * Only valid in the PC library (`<userData>/pc-games/game.json`): it is the one place a manifest may
 * name an ABSOLUTE path, because there is no card root to be relative to. Mutually exclusive with
 * `install`/`steam`/`executable`/`saveOnCard` (enforced by the schema).
 */
export interface PcManifest {
  /**
   * ABSOLUTE path to the game's .exe on this PC. Its existence is NOT checked at read time: a game
   * deleted from disk keeps its library card (art, stats, save backup) and is merely `unavailable` —
   * exactly like an install-mode game that isn't installed yet.
   */
  readonly executable: string;
}

/**
 * Raw `game.json` manifest after zod-schema validation.
 * The executable/saveOnCard paths and each heroImage entry are relative to the SD root;
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
   *
   * The `.exe` suffix is optional: a native macOS process has none, and steam mode requires this field.
   * Keep `*.exe` names on a card meant to travel (the macOS matcher normalizes the suffix away, so one
   * spelling works on all three OSes); a bare name is for a mac-only record. See the schema in manifest.ts.
   */
  readonly watchProcesses?: readonly string[];
  /**
   * Card-relative hero background image(s). Accepts a single path OR a non-empty array of paths.
   * When several are given, the renderer cross-fades between them (GTA-5-style loading rotation).
   * Normalized to an array of resolved paths in ResolvedManifest.heroImagePaths.
   */
  readonly heroImage?: string | readonly string[];
  /**
   * Card-relative GRID image — the game's card in the launcher's history carousel (a portrait cover, not a
   * background). Optional: when absent the carousel falls back to the first heroImage, cropped to the card
   * (object-fit: cover), so existing cards keep working unchanged.
   */
  readonly gridImage?: string;
  readonly saveOnCard?: string;
  readonly pcSavePath?: string;
  readonly launchTimeoutSec: number;
  /**
   * How many seconds a force-close (More → Force close) waits for the game's processes to actually
   * disappear before reporting a failure. A killed process lingers in `tasklist` for a moment (and a
   * launcher/wrapper may take longer to tear down), so this is the MAX wait — the wait ends early the
   * instant every target process is gone. Default 60. Raise it for games that shut down slowly.
   */
  readonly killTimeoutSec: number;
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
  /**
   * Optional PC mode: the game already lives on this machine's disk and `pc.executable` is its absolute
   * path. Accepted ONLY in the PC library (see ManifestSource); mutually exclusive with
   * `install`/`steam`/`executable`/`saveOnCard`. See PcManifest.
   */
  readonly pc?: PcManifest;
  /** Optional looping background music (card-relative path), played while the window is visible. */
  readonly backgroundMusic?: string;
  /**
   * Optional localized description of the game (en/ru), filled by the "Find online" flow. Nothing in the
   * UI reads it yet — it is stored now so the data exists when a screen for it does. Parsed leniently: a
   * malformed value is dropped, never a reason to reject the manifest (see manifest.ts).
   */
  readonly description?: LocalizedText;
  /** Genres, in the English store's wording. Same deal as `description`: stored now, shown later. */
  readonly genres?: readonly string[];
  /** Release date, `YYYY-MM-DD` or `YYYY`. Stored now, shown later. */
  readonly releaseDate?: string;
  /** Platforms the store states native support for. Stored now, shown later. */
  readonly platforms?: readonly GamePlatform[];
  /**
   * Linux-only: extra winetricks verbs provisioned into the game's Wine prefix before the game
   * launches, on top of the app's baseline set (e.g. `d3dx9` for an old DX9 title). Ignored on Windows.
   * Empty by default (schema `.default([])`).
   */
  readonly winetricks: readonly string[];
  /**
   * Linux-only: the umu `GAMEID` used when launching the game — a Steam appid or a custom UMU_ID —
   * so umu applies that game's protonfix instead of the generic `umu-default`. Absent → `umu-default`.
   * Ignored on Windows.
   */
  readonly umuGameId?: string;
}

/**
 * Manifest with already-resolved and security-checked paths.
 * All *Path values are absolute; the card's relative paths are verified to stay
 * "inside the root", and pcSavePath is expanded from the env whitelist.
 */
export interface ResolvedManifest {
  readonly raw: GameManifest;
  readonly root: string;
  /**
   * Which root this manifest was read from — a card, or the PC library. Set in exactly one place (the
   * resolver), and branched on wherever "is this game's source available?" differs: a card game needs its
   * card inserted, a PC game is always there. See ManifestSource.
   */
  readonly source: ManifestSource;
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
  /** Resolved, card-relative hero image paths (normalized to an array when at least one is set). */
  readonly heroImagePaths?: readonly string[];
  /** Resolved, card-relative grid (carousel card) image path. Absent → the carousel falls back to hero. */
  readonly gridImagePath?: string;
  readonly saveOnCardPath?: string;
  /**
   * The Windows-dictionary save location (`%APPDATA%\…`), stored VERBATIM — a DEFERRED field.
   * Only its syntax is validated at read time (prefix allowlist + no traversal); the physical folder is
   * resolved per-game at sync time via the platform SavePathResolver. This matters on Linux, where the
   * real location lives inside the game's Wine prefix / Steam compatdata and may not exist until the first
   * launch — resolving it eagerly (and rejecting the card when absent) would break install/steam modes.
   */
  readonly pcSavePath?: string;
  /** Resolved background-music file path. */
  readonly backgroundMusicPath?: string;
  /** Resolved install descriptor (install mode only). */
  readonly install?: ResolvedInstall;
  /** Resolved Steam descriptor (Steam mode only). When present, launch/install go through steam://. */
  readonly steam?: {
    readonly appid: number;
  };
  /** PC library only: no launch method chosen yet — the game is visible but cannot be started. */
  readonly unconfigured?: true;
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
