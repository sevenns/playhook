// Shared contract between main, preload and renderer.
// Types only — the file compiles to empty JS and creates no runtime dependencies,
// so the renderer can import from here via `import type` without require.
import type { Locale } from './i18n/index';

/** Display name (window title / tray tooltip). The %APPDATA% data folder is derived separately by
 * Electron from package.json `name` (currently "playhook"). */
export const APP_NAME = 'Playhook' as const;

/** Manifest file name in the card root. */
export const MANIFEST_FILENAME = 'game.json' as const;

/** File name of the stats copy on the card (best-effort). */
export const CARD_STATS_FILENAME = 'stats.json' as const;

/**
 * Directory under `userData` that holds the PC library — the local games added from this machine's own
 * disk. It is laid out exactly like a card (`game.json` + `assets/`, plus `saves/<id>/` standing in for
 * the card's save copy), so the whole manifest/asset/history pipeline reads it as an always-inserted
 * card. See ManifestSource.
 */
export const PC_LIBRARY_DIRNAME = 'pc-games' as const;

/**
 * Where a manifest came from. `card` — an inserted removable card (UNTRUSTED: every path must stay
 * inside its root). `pc` — the local library in `<userData>/pc-games`, whose games live wherever the
 * user installed them, so `pc.executable` (and a `pcSavePath`) may be ABSOLUTE. The two modes are
 * mutually exclusive per manifest: a card manifest carrying a `pc` block is rejected, and so is a PC
 * manifest without one.
 */
export type ManifestSource = 'card' | 'pc';

/**
 * How many hero backgrounds one game may carry — a CARD-FORMAT limit (not a library budget), so it lives
 * in the shared contract: main enforces it (manifest.ts) and the Customize screen caps its list by it.
 *
 * Enforced with the same split as the "≥1 heroImage" policy: the EDITOR rejects a 4th image (it gates
 * Save), the runtime stays lenient — readManifests keeps the first three and logs a warn. A hard cap in
 * the schema would turn an existing card with four backgrounds into an unreadable one.
 */
export const MAX_HERO_IMAGES = 3;

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
   * Linux-only (Р7b): extra winetricks verbs provisioned into the game's Wine prefix before the installer
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
   * Extra winetricks verbs (Р7b) provisioned into the game's Wine prefix before install, on top of the
   * linux baseline set. Linux-only; ignored on Windows. Empty by default.
   */
  readonly winetricks: readonly string[];
  /**
   * Host-view of the app-controlled install directory: every fs op (pre-clean, uninstaller search,
   * sweep) and the resolved `executable` live under it. win32: `%LOCALAPPDATA%\playhook\games\<id>`;
   * linux: `<pfx>/drive_c/playhook/games/<id>` (inside the game's Wine prefix — Р7).
   */
  readonly dir: string;
  /**
   * Installer-view of the SAME directory, fed to the silent dir-arg (`/DIR=` / `/D=`). win32: identical
   * to `dir`; linux: `C:\playhook\games\<id>` — the path the installer sees under Wine (Р7).
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
   * Linux-only (Р7b): extra winetricks verbs provisioned into the game's Wine prefix before the game
   * launches, on top of the app's baseline set (e.g. `d3dx9` for an old DX9 title). Ignored on Windows.
   * Empty by default (schema `.default([])`).
   */
  readonly winetricks: readonly string[];
  /**
   * Linux-only (Р7i): the umu `GAMEID` used when launching the game — a Steam appid or a custom UMU_ID —
   * so umu applies that game's protonfix instead of the generic `umu-default`. Absent → `umu-default`.
   * Ignored on Windows.
   */
  readonly umuGameId?: string;
}

/** UI sound-effect slots. Each maps to a file in the bundled set chosen in Settings → Audio; a card
 *  cannot supply its own (the `sounds` block in an old game.json is ignored, not rejected).
 *  `limit` is the dead end — a press that changed nothing (end of a list, a button with no meaning
 *  here); `popup-open`/`popup-close` mark a surface appearing over the screen and going away; `typing`
 *  is a character going into the on-screen keyboard, which is a keystroke rather than navigation. The
 *  kebab-case names are the file basenames, kept 1:1 so SFX_SLOT_FILE stays trivial. */
export type SfxName =
  | 'play'
  | 'navigate'
  | 'button'
  | 'back'
  | 'notify'
  | 'limit'
  | 'popup-open'
  | 'popup-close'
  | 'typing';

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
   * The Windows-dictionary save location (`%APPDATA%\…`), stored VERBATIM — a DEFERRED field (Р5/Э6).
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

/**
 * The bundled UI sound set for the renderer, delivered as data URLs. One set for the whole app — the
 * card has no say in it — rebuilt and re-sent whenever Settings → Audio changes the chosen set.
 * Kept OUT of GameInfo/AppState on purpose: AppState is re-sent on every transition and these payloads
 * are large, so they travel once, on their own channel.
 */
export interface SfxSet {
  /** UI sound effects (data URLs); any subset of slots present. */
  readonly sounds: Partial<Record<SfxName, string>>;
}

/**
 * Per-game hero background image(s) for the renderer, delivered as data URLs.
 * Kept OUT of GameInfo/AppState on purpose (like SfxSet): AppState is re-sent on every
 * transition, and an array of encoded images is a large payload — so hero images are delivered
 * once per card on their own channel and the renderer rotates through them locally.
 */
export interface HeroAssets {
  /** Hero background images (data URLs), always at least one (a wallpaper fallback when none read). */
  readonly images: readonly string[];
}

/**
 * One card in the launcher's history carousel: a game on the inserted card (`active` — launchable right
 * now) or one that was played on this device before. Deliberately LIGHT ({id,title,active}) so main can
 * re-push the whole list on every insert/removal/play; the artwork travels one card at a time, on demand,
 * over `library:grid-request` (see Р5).
 */
export interface LibraryEntry {
  readonly id: string;
  readonly title: string;
  /** The game is on the card currently inserted: it can be launched/installed right now. */
  readonly active: boolean;
  /**
   * Revision of this game's stored artwork — it changes whenever main re-copies the card's images. The
   * renderer caches decoded covers by `id + artRev`, so editing `gridImage` on the Customize screen and
   * hitting Save & Apply shows the new cover immediately, instead of serving the cached one until a
   * restart.
   * Absent while the background copy hasn't produced a record yet.
   */
  readonly artRev?: string;
  /**
   * PC library only: no launch method chosen yet. `active` stays true (the game IS the current local
   * library — Customize must stay reachable), so consumers that gate on "ready to play" (the carousel
   * dot, the "Ready to play" section, Play itself) must check this flag too, not `active` alone.
   */
  readonly unconfigured?: true;
}

/** The carousel list, already in display order — the renderer never sorts it (see orderForCarousel). */
export interface GameLibrary {
  readonly games: readonly LibraryEntry[];
}

/**
 * What is currently ON SCREEN — the source of truth for the title, the stats, the background and the
 * music, whether that game is on the inserted card or only in the history.
 *
 * It exists BECAUSE AppState cannot answer that question: AppState is the state machine of ONE game's
 * process (idle/ready/installing/running…), so browsing game B while game A installs, or showing a
 * history game with no card in (`kind: 'idle'`), has no representation there. AppState stays the truth
 * for the PHASE and the STATUS text; BrowseInfo is the truth for what you are looking at.
 */
export interface BrowseInfo {
  readonly id: string;
  readonly title: string;
  /** The browsed game is on the inserted card (so Play/Install apply to it). */
  readonly active: boolean;
  readonly stats: Stats;
  /** Only for an active game: everything the ready screen needs (requiresInstall, canUninstall, …). */
  readonly game?: GameInfo;
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
   * opens `steam://install/<appid>` (no card path, no silent-mode note). `'copy'` → the card's game
   * directory is copied to the PC (no installer runs: no silent-mode caveat, and the destination path is
   * of no use to the user). Undefined → an ordinary card game or a card-INSTALLER game, the only case
   * that shows the path. Lets the renderer pick the right confirm copy.
   */
  readonly installVia?: 'steam' | 'copy';
  /**
   * Linux only: `canUninstall` is set for a NORMAL executable game whose Wine prefix exists — so the
   * "Uninstall" action clears that Proton prefix (runtimes + any in-prefix saves), NOT an installed game.
   * The game itself stays on the card. Lets the renderer show the prefix-cleanup confirm copy instead of
   * the "uninstall from PC" one. Undefined for install/steam/copy modes and on Windows.
   */
  readonly prefixCleanupOnly?: boolean;
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
  /**
   * PC mode only: the game's executable is not on disk right now (deleted, or an external drive is
   * unplugged). The card stays in the library with its art, stats and save backup — only Play is
   * disabled and the status reads "Game files not found". Undefined for card games, whose executable is
   * verified at read time (and whose absence drops them from the card instead).
   */
  readonly unavailable?: boolean;
  /**
   * PC mode only: no launch method has been configured yet (a saved draft — see ResolvedManifest). The
   * card stays in the library, fully editable, but Play is hidden and the status line is left EMPTY (the
   * absent button already says it — see state-view.ts `statusOf`) — checked BEFORE `unavailable`, which
   * does not apply (there is no executable to be missing).
   */
  readonly unconfigured?: boolean;
}

/** The flow state machine (discriminated union). */
export type AppState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'ready'; readonly game: GameInfo }
  | { readonly kind: 'installing'; readonly game: GameInfo }
  | { readonly kind: 'uninstalling'; readonly game: GameInfo }
  /**
   * Linux-only (Р7g): the game's Wine prefix is being provisioned (winetricks) before the installer/game
   * runs. A transient screen shown WITHIN installing/launching; the renderer shows "Configuring Proton..."
   * and appends a rotating funny suffix after a minute (Р7j). Reverts to the prior state when done.
   */
  | { readonly kind: 'configuringProton'; readonly game: GameInfo }
  | { readonly kind: 'syncing-in'; readonly game: GameInfo }
  | { readonly kind: 'launching'; readonly game: GameInfo }
  | {
      readonly kind: 'running';
      readonly game: GameInfo;
      readonly since: number;
      /** A force-close (More → Force close) is in flight: the UI shows a "Force closing…" indicator and
       * hides the Force close button. Cleared back to running if the force-close fails (game stays up). */
      readonly killing?: boolean;
    }
  | { readonly kind: 'syncing-out'; readonly game: GameInfo }
  | { readonly kind: 'error'; readonly game?: GameInfo; readonly message: string };

/**
 * Update state for the settings window (discriminated union). The UpdaterService owns the current
 * snapshot, returns it on request and pushes it on every change. Maps 1:1 onto electron-updater
 * events (see updater.ts). `unsupported` is set immediately in dev / non-packaged builds, where
 * self-update is a no-op — the settings window then just shows the version and an explanatory note.
 */
export type UpdateStatus =
  | { readonly kind: 'idle' } // not checked yet
  | { readonly kind: 'checking' } // a check is in flight
  | { readonly kind: 'not-available'; readonly checkedAt: number } // up to date
  | { readonly kind: 'available'; readonly version: string } // newer version → "Update" button
  | { readonly kind: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly kind: 'downloaded'; readonly version: string } // ready → "Restart & install"
  | { readonly kind: 'error'; readonly message: string } // → "Retry"
  | { readonly kind: 'unsupported' }; // dev / not-packaged: update unavailable

/**
 * Auto-update mode (persisted in settings.json). Maps onto electron-updater flags:
 * - `download-install` → autoDownload=true, autoInstallOnAppQuit=true  (current behaviour)
 * - `download`         → autoDownload=true, autoInstallOnAppQuit=false (wait for explicit install)
 * - `off`              → autoDownload=false, no periodic check (manual "Check for updates" only)
 */
export type AutoUpdateMode = 'download' | 'download-install' | 'off';

/** UI theme for the settings window. `system` follows the OS light/dark preference. */
export type ThemeMode = 'system' | 'light' | 'dark';

/**
 * UI language mode (persisted in settings.json). `system` resolves to the OS locale in main
 * (`app.getPreferredSystemLanguages()`), `en`/`ru` are explicit. The resolved effective `Locale` is what
 * travels over IPC to the renderers; the raw mode only lives in the settings form. Mirrors ThemeMode.
 */
export type LanguageMode = 'system' | 'en' | 'ru';

/** App-wide settings (settings.json in userData), separate from per-game PcStore data. */
export interface AppSettings {
  readonly schemaVersion: 1;
  readonly autoUpdate: AutoUpdateMode;
  readonly theme: ThemeMode;
  /** UI language. Default 'system' → resolved from the OS locale in main. Mirrors `theme`. */
  readonly language: LanguageMode;
  /** Receive pre-release (beta) updates. Default false → the stable channel only. */
  readonly allowPrerelease: boolean;
  /** Enable the global Start+Back gamepad chord that summons the launcher. Default true. */
  readonly summonHotkeyEnabled: boolean;
  /**
   * Keep the display awake (no screensaver / display-sleep) while the launcher owns the session — i.e.
   * while it's on screen or a game is running. Default true. Backed by Electron's powerSaveBlocker
   * ('prevent-display-sleep'); toggling it live starts/stops the blocker in main.
   */
  readonly preventScreensaver: boolean;
  /** Launcher background-music volume, 0..1. Default 0.5. */
  readonly musicVolume: number;
  /** Launcher UI sound-effects volume, 0..1. Default 1. */
  readonly sfxVolume: number;
  /**
   * Keep the launcher visible on the empty "no card" screen instead of hiding to the tray when no card
   * is present. Default false (the background-app behaviour: hidden until a card is detected). When true
   * the empty screen stays on card removal AND is shown at startup.
   */
  readonly keepOpenWithoutCard: boolean;
  /**
   * Disable trying silent mode for install-mode installers (Linux/Proton). Default false (installers run
   * unattended). When true, the installer shows its wizard so the user can click through steps a silent
   * install would skip — e.g. a repack's crack/patch flagged `skipifsilent`. The app still steers the
   * install directory via the dir-key; the user must keep it for the completion check to find the exe.
   */
  readonly disableSilentInstall: boolean;
  /**
   * The appid of Playhook's own non-Steam shortcut (Steam Deck Game Mode tile), as an UNSIGNED 32-bit
   * number, or null when no shortcut is registered — that null is also what drives the tray item's
   * Add/Remove state, so no separate flag exists. The signed form written into `shortcuts.vdf` and the
   * 64-bit `rungameid` are DERIVED from it on the spot (platform/steam-appid.ts), never stored: three
   * copies of one number are three chances for them to disagree. Default null.
   */
  readonly steamAppIdU32: number | null;
  /**
   * Steam Deck only: launch Playhook through its Steam tile when a game card is inserted in Game Mode.
   * Default true. Turning it off removes the background service entirely (it is a `systemctl --user`
   * unit, not an in-process timer), which is the point — it frees the ~120 MB the watcher occupies for
   * users who want the tile but not the auto-launch.
   */
  readonly steamAutoLaunch: boolean;
  /**
   * Name of the UI sound set used for navigation (the folder under `audio/ui/<set>/`) — the only source
   * of UI sounds there is. A plain string (not an enum): sets are enumerated dynamically from what ships
   * in the bundle, and a missing/incomplete folder falls back at read time (see AssetReader).
   * Default 'playhook-abyss'. `.default(…)` migrates an older settings.json without the field.
   */
  readonly soundSet: string;
  /**
   * Default background ambience track (a file name under `audio/ambience/`, extension included), played
   * only when the current card has no music of its own — the game's music always wins. `null` = no
   * ambience. Default 'playhook-abyss.mp3'; `.default(…)` migrates an older settings.json without the
   * field. A name that is no longer bundled simply doesn't play (checked before reading — AssetReader).
   */
  readonly ambientTrack: string | null;
  /**
   * When true, only the global ambience plays — a card's own background music is ignored (suppressed in
   * main, so the renderer just sees no game music). When false (default), a card's music wins. Default false.
   */
  readonly onlyGlobalAmbient: boolean;
  /**
   * The user's own SteamGridDB API key, or `''` when they have not entered one. Empty by default and
   * never shipped: an open-source build cannot carry a secret, so the alternative-artwork source is
   * simply absent until the user pastes a key of their own (Settings → the SteamGridDB row). Stored in
   * plain text alongside every other setting — the same trade every launcher with this feature makes.
   */
  readonly steamGridDbApiKey: string;
}

/** The bundled UI sound sets + ambience tracks available to pick in the settings window. */
export interface AudioOptions {
  /** Sound-set folder names under `audio/ui/` (e.g. `playhook-abyss`, `ps5`); the default is always present. */
  readonly soundSets: readonly string[];
  /** Ambience file names under `audio/ambience/`, extension included (e.g. `ps5.mp3`). */
  readonly ambientTracks: readonly string[];
}

/** Launcher audio volumes (0..1), applied in the game renderer's AudioController. */
export interface AudioVolumes {
  readonly music: number;
  readonly sfx: number;
}

// ── Notifications (main owns the inbox; the renderer only shows it) ─────────────

/** What every notification carries, whatever it is about. */
interface NotificationBase {
  /** crypto.randomUUID(), assigned in main — the renderer addresses a notification by it. */
  readonly id: string;
  /** epoch ms, the sort key (ascending: the newest sits at the END of a snapshot). */
  readonly at: number;
  readonly read: boolean;
}

/**
 * One entry of the notification inbox, discriminated by `kind` so the renderer's text assembly is
 * checked by the compiler. The TEXT is deliberately not stored: it is built in the renderer from the
 * kind plus these fields, because the UI language changes live (app:language-update) and a stored
 * string would freeze at the language of the moment it was written.
 */
export type AppNotification =
  | (NotificationBase & { readonly kind: 'update-ready'; readonly version: string })
  | (NotificationBase & {
      readonly kind: 'game-installed';
      readonly gameId: string;
      readonly gameTitle: string;
    })
  | (NotificationBase & {
      readonly kind: 'game-uninstalled';
      readonly gameId: string;
      readonly gameTitle: string;
    })
  /**
   * A game was added to a card that is NOT the active one, so it was written to disk and nothing else
   * happened: the launcher's library cannot show it until that card becomes active. There is no `gameId`
   * on purpose — the id names nothing the launcher can open, so pressing this entry only dismisses it.
   */
  | (NotificationBase & { readonly kind: 'game-added-deferred'; readonly gameTitle: string })
  /** Same as `game-added-deferred`, but for a local game MOVED onto a card that is not active (Р2.5). */
  | (NotificationBase & { readonly kind: 'game-moved-deferred'; readonly gameTitle: string })
  /**
   * A move to card succeeded, but its save folder already existed and was NOT empty on the card — the
   * game's PC-side saves were left uncopied rather than overwriting someone else's progress there.
   */
  | (NotificationBase & { readonly kind: 'game-move-save-skipped'; readonly gameTitle: string })
  /**
   * The worst outcome a move can end in: the card was written, removing the game from the PC library
   * failed, and undoing the card write failed too — so the game now exists in BOTH places. Defined
   * behaviour rather than corruption (an inserted card shadows its local twin), but the user has to be
   * told, because the screen reports the move as done and closes.
   */
  | (NotificationBase & { readonly kind: 'game-move-duplicate'; readonly gameTitle: string })
  /**
   * A settings change could not be written to disk, so it did not stick. Carries no detail: the cause is
   * in the log, and the only thing the user can act on is that their setting did not save.
   */
  | (NotificationBase & { readonly kind: 'settings-write-failed' });

// Distributes over the union so each member loses the base fields on its own (a plain Omit would
// collapse the three into one non-discriminated object).
type WithoutNotificationBase<T> = T extends unknown ? Omit<T, keyof NotificationBase> : never;

/** What a source of events hands to NotificationsService.notify — the base fields are main's to fill. */
export type NotificationInput = WithoutNotificationBase<AppNotification>;

/**
 * What the renderer must show OVER the UI (the toast plate, top right). Showing a plate does NOT make the
 * notification read — that happens only when the popup is opened or an entry is pressed — so the dot
 * beside the More item survives a toast the user may well have missed.
 * `unread-summary` is the single plate shown after a game ends / after a long absence instead of a queue.
 */
export type NotificationToast =
  | { readonly kind: 'item'; readonly item: AppNotification }
  | { readonly kind: 'unread-summary'; readonly count: number };

/** IPC channels (the preload typed bridge). */
export const IPC = {
  /** main → renderer: replica of the current AppState. */
  stateUpdate: 'state:update',
  /** renderer → main: request the current state (on window startup). */
  stateRequest: 'state:request',
  /** main → game-renderer: the launcher window gained (true) / lost (false) OS focus. The renderer gates
   * gamepad input on this so a BACKGROUND launcher (e.g. under gamescope, where Chromium keeps feeding the
   * unfocused window gamepad input) doesn't act on presses meant for the running game. */
  windowFocus: 'window:focus',
  /** renderer → main: the user pressed A / clicked "Play". */
  actionLaunch: 'action:launch',
  /** renderer → main: the user confirmed "Uninstall" — remove the installed install-mode game. */
  actionUninstall: 'action:uninstall',
  /** renderer → main: hide the launcher window to the tray (the "Hide" button on the empty screen). */
  actionHide: 'action:hide',
  /** renderer → main: quit the whole app. In Game Mode (gamescope) the power menu's primary item becomes
   * "Close Playhook" (there is no tray to minimize into), which sends this instead of actionHide. */
  actionQuit: 'action:quit',
  /** renderer → main (invoke): whether this is a SteamOS Game Mode (gamescope) session. Seeded once at
   * startup so the renderer can adapt the UI (e.g. "Minimize" → "Close Playhook"). */
  gameModeRequest: 'app:game-mode-request',
  /** renderer → main: open Steam's Downloads page (steam://open/downloads) — used by the Play button
   * while a Steam download is in progress, so the user can pause/resume it in Steam itself. */
  actionOpenSteamDownloads: 'action:open-steam-downloads',
  /** renderer → main: the user confirmed "Shutdown" in the power menu — power off the PC. */
  actionShutdown: 'action:shutdown',
  /** renderer → main: the user confirmed "Reboot" in the power menu — restart the PC. */
  actionReboot: 'action:reboot',
  /** renderer → main: the user confirmed "Sleep" in the power menu — put the PC to sleep. */
  actionSleep: 'action:sleep',
  /** renderer → main: force-close the running game (from the More menu, after confirm) — kills the
   * main executable and any watchProcesses. */
  actionKill: 'action:kill',
  /** main → renderer: a transient error to surface in the error popup (e.g. a failed launch). */
  errorShow: 'error:show',
  /** main → renderer: the inserted card's background music as a data URL (or null when no card / muted
   * by the "only global ambience" setting). */
  cardMusicUpdate: 'card-music:update',
  /** renderer → main: request the current card's music (on window startup). */
  cardMusicRequest: 'card-music:request',
  /** main → game-renderer: the default ambience track as a data URL (or null when none / on card music). */
  ambientUpdate: 'ambient:update',
  /** game-renderer → main (invoke): request the current ambience data URL (on window startup). */
  ambientRequest: 'ambient:request',
  /** main → renderer: hero background images for the current game (or null when no card). */
  heroUpdate: 'hero:update',
  /** renderer → main: request the current hero images (on window startup). */
  heroRequest: 'hero:request',
  /** main → renderer: the light carousel list ({id,title,active}) — the inserted card's games plus the
   * play history, already in display order (or null when there is nothing to show at all). */
  libraryUpdate: 'library:update',
  /** renderer → main (invoke): request the current carousel list (on window startup / back-fill). */
  libraryRequest: 'library:request',
  /** renderer → main (invoke): the carousel card artwork of one game as a data URL (null when it has
   * none). Requested per visible card and cached in the renderer — the list channel stays light. */
  libraryGridRequest: 'library:grid-request',
  /** renderer → main: "the user is looking at this id" — main answers with browse:update + browse:hero
   * (+ browse:music). Does NOT change the selected game or the AppState. */
  libraryBrowse: 'library:browse',
  /** renderer → main: drop this game from the play history (its record + the copied artwork). Only ever
   * accepted for a game that is NOT available right now — main re-checks that, the menu item is the
   * renderer's half of the same rule. Saves and playtime survive: this forgets the catalogue entry, not
   * the game. */
  libraryForget: 'library:forget',
  /** main → renderer: what is on screen (title/stats/active/GameInfo) — see BrowseInfo. */
  browseUpdate: 'browse:update',
  /** renderer → main (invoke): the current BrowseInfo (seed on window startup, like state:request). */
  browseRequest: 'browse:request',
  /** main → renderer: hero backgrounds of the BROWSED game. Separate from hero:update, which keeps
   * carrying the inserted card's selected game — so browsing never overwrites the card's assets. */
  browseHero: 'browse:hero',
  /** main → renderer: background music of the browsed game (or null). Music only: the SFX set is left
   * alone, so flipping through the carousel never rebuilds the sound elements. */
  browseMusic: 'browse:music',
  /** main → renderer: the bundled UI sound set chosen in Settings → Audio — the only source of UI
   * sounds there is. Re-sent when the setting changes. */
  sfxSetUpdate: 'sfx:set-update',
  /** renderer → main (invoke): that same set (seed on window startup). */
  sfxSetRequest: 'sfx:set-request',
  /** renderer → main: pick a game by id (entering its detail screen). Switches to it on the ready screen. */
  actionSelect: 'action:select',
  /** renderer → main: request the fallback wallpaper data URL (for the idle / empty screen). */
  wallpaperRequest: 'wallpaper:request',
  /** renderer → main (invoke): the bundled startup jingle as a data URL (played once, on boot). */
  startupSoundRequest: 'audio:startup-request',
  /** game-renderer → main (invoke): request the current audio volumes (on window startup). */
  volumeRequest: 'volume:request',
  /** main → game-renderer: updated audio volumes (pushed when changed in the settings window). */
  volumeUpdate: 'volume:update',
  /** game-renderer → main (invoke): request the current effective UI locale (on window startup). */
  languageRequest: 'app:language-request',
  /** main → game-renderer: updated effective UI locale (pushed when the language changes). */
  languageUpdate: 'app:language-update',

  // ── Updates + app settings (the launcher's Settings screen; own namespace) ──
  /** main → game-renderer: the current UpdateStatus snapshot (pushed on every change). */
  updateStatusUpdate: 'update:status',
  /** game-renderer → main (invoke): request the current UpdateStatus. */
  updateStatusRequest: 'update:request',
  /** game-renderer → main: run a manual update check. */
  updateCheck: 'update:check',
  /** game-renderer → main: start downloading the available update (manual download). */
  updateDownload: 'update:download',
  /** game-renderer → main: install a downloaded update (quitAndInstall, guarded). */
  updateInstall: 'update:install',
  /** game-renderer → main (invoke): request the current AppSettings. */
  settingsRequest: 'settings:request',
  /** main → game-renderer: the full AppSettings after ANY change (including a reset) — the Settings
   * screen's single source of truth, pushed from AppSettingsStore's one write point. */
  settingsUpdate: 'settings:update',
  /** game-renderer → main: change the auto-update mode (payload AutoUpdateMode). */
  settingsSetAutoUpdate: 'settings:set-auto-update',
  /** game-renderer → main: toggle keeping the empty "no card" screen visible (payload boolean). */
  settingsSetKeepOpenWithoutCard: 'settings:set-keep-open-without-card',
  /** game-renderer → main: toggle disabling silent installer mode (payload boolean). */
  settingsSetDisableSilentInstall: 'settings:set-disable-silent-install',
  /** game-renderer → main: toggle Game Mode auto-launch on card insertion (payload boolean). */
  settingsSetSteamAutoLaunch: 'settings:set-steam-auto-launch',
  /** game-renderer → main (invoke): whether the Steam-shortcut feature exists here (linux AppImage). */
  settingsSteamAvailable: 'settings:steam-available',
  /** game-renderer → main: toggle pre-release (beta) updates (payload boolean). */
  settingsSetPrerelease: 'settings:set-prerelease',
  /** game-renderer → main: toggle the Start+Back summon hotkey (payload boolean). */
  settingsSetSummonHotkey: 'settings:set-summon-hotkey',
  /** game-renderer → main: toggle keeping the display awake (no screensaver) (payload boolean). */
  settingsSetPreventScreensaver: 'settings:set-prevent-screensaver',
  /** game-renderer → main: set the background-music volume 0..1 (payload number). */
  settingsSetMusicVolume: 'settings:set-music-volume',
  /** game-renderer → main: set the UI sound-effects volume 0..1 (payload number). */
  settingsSetSfxVolume: 'settings:set-sfx-volume',
  /** game-renderer → main: change the UI language (payload LanguageMode). */
  settingsSetLanguage: 'settings:set-language',
  /** game-renderer → main (invoke): reset all settings to defaults → returns the new AppSettings. */
  settingsReset: 'settings:reset',
  /** game-renderer → main (invoke): request the app version string. */
  appVersionRequest: 'app:version',
  /** game-renderer → main: change the navigation sound set (payload set name string). */
  settingsSetSoundSet: 'settings:set-sound-set',
  /** game-renderer → main: change the default ambience track (payload file name string or null). */
  settingsSetAmbientTrack: 'settings:set-ambient-track',
  /** game-renderer → main: toggle using only the global ambience (payload boolean). */
  settingsSetOnlyGlobalAmbient: 'settings:set-only-global-ambient',
  /** game-renderer → main (invoke): the bundled sound sets + ambience tracks to populate the dropdowns. */
  audioOptionsRequest: 'app:audio-options',
  /** game-renderer → main: store the user's SteamGridDB API key (payload string; '' clears it). */
  settingsSetSteamGridDbKey: 'settings:set-steamgriddb-key',

  // ── Customize screen: per-game game.json editing INSIDE the launcher (own namespace) ──
  // A namespace of its own rather than a move of `config:*`: the ipc-channels test requires a channel to
  // belong to exactly one preload, so these were given names of their own rather than re-pointing the
  // Configure window's `config:*` — which let that window keep working until its replacement was done.
  /** game-renderer → main (invoke): the game.json TEXT of one game by id, plus which root/source it came
   * from and the manifest's content signature (the swap guard for Save). Payload the game id. */
  gameConfigRead: 'gameConfig:read',
  /** game-renderer → main (invoke): static validation of manifest text against a root's source.
   * Payload {root, text}. */
  gameConfigValidate: 'gameConfig:validate',
  /** game-renderer → main (invoke): write game.json + try to apply it without a restart. Payload
   * {root, signature, text}; a signature mismatch means the media was swapped and the write is refused. */
  gameConfigSave: 'gameConfig:save',
  /** game-renderer → main (invoke): read a root-relative image into a data URL for a row's thumbnail
   * (null when unreadable / outside the root / not an image). Payload {root, path}. */
  gameConfigImagePreview: 'gameConfig:image-preview',
  /** game-renderer → main (invoke): post-process path(s) the in-launcher file picker chose — the same
   * card-relative / %PREFIX% / import-into-library conversions the native dialog used to feed. Payload
   * GameConfigAcceptRequest; main re-checks the root, the file type and the size. */
  gameConfigAcceptPath: 'gameConfig:accept-path',
  /** game-renderer → main (invoke): list one directory for the in-launcher file picker, plus the
   * starting points offered beside it. Read-only. Payload GameConfigListDirRequest. */
  gameConfigListDir: 'gameConfig:list-dir',
  /** game-renderer → main (invoke): every root a new game may be added to — the removable candidates
   * plus the PC library. No payload; answers with DriveCandidate[]. */
  gameConfigSources: 'gameConfig:sources',
  /** game-renderer → main (invoke): the game.json TEXT of one ROOT (not one game), for the Add-game
   * screen — the chosen root may not carry a single game yet, which `hasManifest` states outright.
   * Payload the root; answers with ConfigRootReadResult. */
  gameConfigReadRoot: 'gameConfig:read-root',
  /** game-renderer → main (invoke): moves a local (PC-library) game onto a card in one transaction — the
   * whole point being that the renderer cannot do "write the card, then write the library" as two
   * gameConfig:save calls without a window where the game exists twice or nowhere (see the plan, Р2.5).
   * Payload GameMoveRequest; answers with ConfigMoveResult. */
  gameConfigMoveToCard: 'gameConfig:move-to-card',
  /** game-renderer → main (invoke): the system clipboard as text, for the on-screen keyboard's Paste.
   * Reading it belongs to main like every other environment fact; the renderer is sandboxed and its own
   * clipboard API would need a permission prompt that Game Mode has nowhere to show. No payload. */
  clipboardRead: 'clipboard:read',

  // ── Notifications (main owns the inbox; the renderer owns the two surfaces) ──
  /** main → game-renderer: the whole inbox, oldest first. The unread COUNT is not sent — it is derived
   * from the list, and a second source of truth would have to be kept in step in four places. */
  notificationsUpdate: 'notifications:update',
  /** main → game-renderer: show a plate (one notification, or the "N unread" summary). */
  notificationsToast: 'notifications:toast',
  /** game-renderer → main (invoke): the current inbox (seed on window startup / after a reload). */
  notificationsRequest: 'notifications:request',
  // ── Online metadata ("Find online" on the Add/Customize screen; see main/metadata/) ──
  // Every channel answers with a MetadataResult: a source being offline or rate-limiting is an ordinary
  // outcome here, not an error the window should show as a crash.
  /** game-renderer → main (invoke): search every source for a game by title. Payload the query string. */
  metadataSearch: 'metadata:search',
  /** game-renderer → main (invoke): the candidate for a Steam appid the user has ALREADY named (the
   * manifest's steam.appid) — the search exists to find that number, so knowing it skips the search.
   * Payload the appid. */
  metadataSteamCandidate: 'metadata:steam-candidate',
  /** game-renderer → main (invoke): the artwork gallery for one candidate — thumbnails already encoded
   * as data: URLs (the renderer's CSP admits nothing else). Payload {candidateKey, kind}. */
  metadataArtwork: 'metadata:artwork',
  /** game-renderer → main (invoke): one variant at FULL size as a data: URL, for the lightbox. Payload
   * the variant key. Downloaded on demand — the gallery only ever holds thumbnails. */
  metadataArtworkPreview: 'metadata:artwork-preview',
  /** game-renderer → main (invoke): soundtrack albums matching a title. Payload the query string. */
  metadataMusicAlbums: 'metadata:music-albums',
  /** game-renderer → main (invoke): one album's tracks. Payload the album key. */
  metadataMusicTracks: 'metadata:music-tracks',
  /** game-renderer → main (invoke): one track as an audio data: URL, to listen before applying it.
   * Payload the track key. This is a full download — the renderer shows a status line for it. */
  metadataTrackPreview: 'metadata:track-preview',
  /** game-renderer → main (invoke): everything known about the candidate that is not a picture — the
   * en/ru descriptions, the genres, the release date, the platforms. Payload the candidate key. */
  metadataDescriptions: 'metadata:descriptions',
  /** game-renderer → main (invoke): download the chosen variant into the game's root and answer with the
   * manifest-relative path the form field takes. Payload MetadataApplyRequest. */
  metadataApply: 'metadata:apply',
  /** game-renderer → main: the user left the surface — abort whatever is still being fetched. */
  metadataCancel: 'metadata:cancel',

  /** game-renderer → main: the user pressed a notification — drop it from the inbox. Payload id. */
  notificationsDismiss: 'notifications:dismiss',
  /** game-renderer → main: "Clear all" in the notifications popup. */
  notificationsClear: 'notifications:clear',
  /** game-renderer → main: the notifications popup was opened, so the whole inbox has been seen. The
   * only other thing that clears an unread is pressing an entry, which removes it outright. */
  notificationsMarkRead: 'notifications:mark-read',
} as const;

/**
 * A removable drive the editor may write to. Unlike DriveWatcher.scan (which only sees cards WITH a
 * game.json), this lists ALL removable/non-system mountpoints, so a blank one is a candidate too —
 * `hasManifest` distinguishes them. It is what isAllowedRoot is checked against in main, and it also
 * crosses to the renderer over gameConfig:sources: the Add-game screen asks the user WHERE the new game
 * goes, and every field of this shape answers part of that question (`root` is the value it stores,
 * `label` what it shows, `isActive` which entry is preselected).
 */
export interface DriveCandidate {
  /** Mountpoint / card root, e.g. "E:\\". */
  readonly root: string;
  /**
   * What this candidate is: a removable card, or the machine's own PC library (`<userData>/pc-games`,
   * offered as one more entry in the same picker). Drives the icon/labelling and, in main, which
   * manifest source the editor validates and saves against. See ManifestSource.
   */
  readonly kind: ManifestSource;
  /**
   * Display label: "E:\\ — Hollow Knight" | "E:\\ — 3 games" | "E:\\ — invalid game.json" |
   * "E:\\ — blank drive". The PC library uses the same shape with its own name in front:
   * "This PC — Hades" | "This PC — 3 games" | "This PC — no games yet".
   */
  readonly label: string;
  /**
   * Content signature of this card's game.json — the sorted game ids (`''` blank, `'invalid'` unreadable).
   * Identifies the MEDIA, not the slot: a save compares it to detect a card swapped into the same
   * mountpoint (the drive letter never changes) and to ignore cosmetic edits. Never displayed —
   * `label` may be a bare count ("3 games") that two different cards would share.
   */
  readonly signature: string;
  /** True when a game.json exists in the root of this mountpoint. */
  readonly hasManifest: boolean;
  /** True when this root is the launcher's currently-active card (driveWatcher.getActiveRoot()). */
  readonly isActive: boolean;
}

/** A single static-validation problem in the manifest text, mapped to a field path for the UI. */
export interface ManifestValidationIssue {
  /** Dotted field path, e.g. "install.args"; "(root)" for a root/syntax error. */
  readonly path: string;
  readonly message: string;
}

/** Result of the static (fs-free) manifest validation — the verdict that blocks/allows Save. */
export type ConfigValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ManifestValidationIssue[] };

/** Result of reading a card's game.json for the editor. */
export type ConfigReadResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/**
 * Result of Save & Apply. `saved` false → nothing was written (message tells why). When written,
 * `applied` says what happened to the running launcher: `applied` (reloaded in place), `deferred`
 * (a blank/other card — DriveWatcher will pick it up, or it loads after the active card is removed),
 * or `failed` (written, but re-reading the manifest was rejected — message carries the reason).
 */
export type ConfigSaveResult =
  | {
      readonly saved: true;
      readonly applied: 'applied' | 'deferred' | 'failed';
      readonly message?: string;
    }
  | { readonly saved: false; readonly message: string };

/**
 * What a Browse is picking — it decides what the picker filters to, and what main will accept back:
 * files for exe/installer/image/audio (image is multi-select), a folder for `directory`
 * (card-relative), `pc-save` (a PC folder OUTSIDE the card, converted to a %PREFIX%\… save path) and
 * `pc-executable` (PC library only: any executable anywhere on this machine, kept ABSOLUTE).
 * `pc-save-local` is `pc-save` WITHOUT that conversion — the picked folder is kept absolute. It is for a
 * local game that runs from this machine's disk (its saves are an ordinary host folder); a local STEAM
 * game keeps `pc-save`, because its saves live inside Steam's Proton prefix, which only the %PREFIX%
 * form can name.
 */
export type ConfigPickKind =
  | 'executable'
  | 'installer'
  | 'image'
  | 'audio'
  | 'directory'
  | 'pc-save'
  | 'pc-save-local'
  | 'pc-executable';

/**
 * Result of picking path(s) for a manifest field. On success `paths` are card-RELATIVE
 * with forward slashes (ready to drop into game.json). A discriminated union (untrusted external action →
 * Result-union): success (one or more relative paths), a plain cancellation, or a rejection carrying a
 * localized message (a file outside the card root, the card root itself for a folder pick, …).
 */
export type ConfigPickResult =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly message: string };

// ── Customize screen (per-game editing in the launcher) ─────────────────────────

/**
 * One game's manifest, addressed BY ID. `root`/`source` say which file it lives in and which dialect it
 * speaks; `signature` identifies the MEDIA (the same sorted-ids signature DriveCandidate carries), so a
 * card swapped into the same mountpoint while the screen is open cannot receive the edit.
 *
 * `text` is the WHOLE file, not the one game: a card may carry several, and the screen edits its slot in
 * place so the neighbours (including any that failed to resolve) survive the round trip verbatim.
 */
export type GameConfigReadResult =
  | {
      readonly ok: true;
      readonly root: string;
      readonly source: ManifestSource;
      readonly signature: string;
      readonly text: string;
      /**
       * Whether the launcher is running on Windows. The renderer has no business asking the OS itself, and
       * the screen needs it for one decision: a game installed on THIS PC under Windows will never be run
       * through Proton, so its Linux section is not merely empty there but meaningless. A CARD keeps it on
       * either OS — the card is the portable half, and its manifest is read on the Deck too.
       */
      readonly windows: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * One ROOT's manifest, addressed by the root itself — what the Add-game screen reads once the user has
 * picked where the game goes. It is deliberately not gameConfig:read with a different payload: that
 * channel's question is "which file does game X live in", and here there may be no game X yet.
 *
 * `hasManifest` is the field ConfigReadResult cannot express: a root with no game.json is the normal
 * case here (a blank card, a first local game), and it must not be confused with a file that exists but
 * cannot be read. When it is false, `text` is `''` and the screen starts from an empty slot list —
 * sending `'[]'` instead would trip textToGames, which rejects an empty games array.
 */
export type ConfigRootReadResult =
  | {
      readonly ok: true;
      readonly root: string;
      readonly source: ManifestSource;
      readonly signature: string;
      readonly hasManifest: boolean;
      readonly text: string;
      /** Whether the launcher is running on Windows — see GameConfigReadResult.windows. */
      readonly windows: boolean;
    }
  | { readonly ok: false; readonly message: string };

/** Payload for gameConfig:save — the manifest text plus the media signature read alongside it. */
export interface GameConfigSaveRequest {
  readonly root: string;
  /** The signature from gameConfig:read; a mismatch means a different card is in the slot now. */
  readonly signature: string;
  readonly text: string;
}

/**
 * Payload for gameConfig:move-to-card — moving a local (PC-library) game onto a card (see the plan Р2.5).
 * `fromText` is deliberately NOT part of this payload: main derives the PC library's post-move text
 * itself, from a fresh read, by removing the game being moved (see game-move.ts) — the same
 * never-trust-the-renderer's-derived-text stance the rest of this file takes for the writable side of a
 * save (GameConfigService.save re-validates instead of trusting the renderer's verdict).
 */
export interface GameMoveRequest {
  /** The id the moved game carries in `toText` — i.e. what it will be called ON THE CARD. */
  readonly id: string;
  /**
   * The id the game was READ with, and the only thing the PC-library side of the move is addressed by
   * (which slot to remove, whose manifest to resolve, whose sync-state to drop).
   *
   * Separate from `id` on purpose: `id` comes from an editable form field, so the two can disagree, and
   * addressing the library by the EDITED value would remove — and copy the assets and saves of — whichever
   * other local game happens to answer to it. main additionally refuses a move where they differ at all:
   * a rename would orphan everything keyed by the old id (stats, history, pending-flush) — see the plan's
   * assumption 4 — so the rename belongs in a separate Save, before or after the move.
   */
  readonly fromId: string;
  readonly fromRoot: string;
  /** The signature gameConfig:read gave for the PC library — a mismatch means it changed underneath us. */
  readonly fromSignature: string;
  readonly toRoot: string;
  /** The signature the target card was read against (gameConfig:sources / gameConfig:read-root). */
  readonly toSignature: string;
  /** The target card's WHOLE game.json text, with the moved game's slot already inserted. */
  readonly toText: string;
}

/**
 * Result of a PC → card move. `moved` false → nothing changed on EITHER side (message tells why).
 * `applied` mirrors ConfigSaveResult's meaning for the TARGET card. There is no `warning` counterpart:
 * a move that succeeded but skipped something non-fatal (an existing non-empty save folder on the card,
 * a library write that could not be undone) closes the screen, so the only place left to say it is a
 * notification — which is where main sends it.
 */
export type ConfigMoveResult =
  | {
      readonly moved: true;
      readonly applied: 'applied' | 'deferred';
    }
  | { readonly moved: false; readonly message: string };

/**
 * Payload for gameConfig:accept-path: absolute path(s) the in-launcher picker chose, and what field they
 * are for. Unlike the native dialog this comes FROM the renderer, so main re-checks everything the dialog
 * used to guarantee — see GameConfigService.acceptPickedPaths.
 */
export interface GameConfigAcceptRequest {
  readonly root: string;
  readonly kind: ConfigPickKind;
  readonly paths: readonly string[];
  /**
   * A root-RELATIVE sub-directory the resulting manifest path is measured from, when the field is not
   * measured from the root itself. Only "move game to PC" uses one: there the manifest resolves
   * `executable` under the install directory, which receives the CONTENTS of the named game folder, so
   * a card-relative path would be one level too deep. Re-checked against the root in main.
   */
  readonly base?: string;
}

/**
 * Payload for gameConfig:list-dir. With `path` it lists that directory; without one main picks the
 * STARTING point for the field (`kind`) — the directory of `current` when it is already filled, else the
 * card root / the home folder / %APPDATA% (see the plan, Р5.2).
 */
export interface GameConfigListDirRequest {
  readonly path?: string;
  readonly root?: string;
  readonly kind?: ConfigPickKind;
  /** The field's current value, so a filled field reopens where it points. */
  readonly current?: string;
  /** The sub-directory this field is measured from — see GameConfigAcceptRequest.base. */
  readonly base?: string;
}

/** One entry of a listed directory. Symlinks are reported as what they point AT, or skipped when broken. */
export interface DirEntry {
  readonly name: string;
  readonly kind: 'dir' | 'file';
}

/** A starting point offered in the picker's left column. Not a restriction — see the plan, Р5.2. */
export interface DirRoot {
  readonly path: string;
  readonly label: string;
  readonly kind: 'card' | 'pc' | 'home' | 'drive';
}

/**
 * Result of one directory listing. The roots travel with every answer (including a failure) so the picker
 * can always offer a way out of a directory it could not read.
 */
export type ListDirResult =
  | {
      readonly ok: true;
      readonly path: string;
      /** null at a filesystem root — there is nowhere further up. */
      readonly parent: string | null;
      readonly entries: readonly DirEntry[];
      readonly roots: readonly DirRoot[];
    }
  | { readonly ok: false; readonly message: string; readonly roots: readonly DirRoot[] };

// ── Online metadata (Steam / SteamGridDB / Khinsider; see the metadata:* channels) ──────────────

/**
 * Which external source an answer came from. The renderer only ever shows it as a label beside a
 * candidate; every request is addressed by an opaque `key` instead, so a provider can change how it
 * identifies a game without the renderer knowing.
 */
export type MetadataProviderId =
  | 'steam'
  | 'steamgriddb'
  | 'wallhaven'
  | 'wallpapercave'
  | 'gog'
  | 'khinsider';

/** Which artwork slot a variant is offered for: the portrait cover, or a hero background. */
export type ArtworkKind = 'grid' | 'hero';

/**
 * The Result-union every metadata call answers with — the same never-throw-across-IPC stance the
 * manifest reader takes for untrusted disk data (see CLAUDE.md). A source being offline, rate-limiting
 * or answering with something the schema rejects is a NORMAL outcome here, not an exception.
 */
export type MetadataResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/**
 * A game as the sources know it. `key` is opaque to the renderer and round-trips back in every request.
 *
 * One candidate can carry SEVERAL references at once: the sources are searched in parallel and their
 * answers are merged by title, so a game that both Steam and GOG know appears once and either source can
 * be asked about it. `provider` names the source the key belongs to, which is also the one whose
 * spelling of the title is shown.
 */
export interface GameCandidate {
  readonly key: string;
  readonly title: string;
  readonly provider: MetadataProviderId;
  /** Set when the candidate is a Steam app — what the CDN art and the descriptions are addressed by. */
  readonly steamAppId?: number;
  /** Set when GOG sells this game. A STRING: GOG's product ids are not numbers. */
  readonly gogId?: string;
}

/**
 * One offered picture. `thumbDataUrl` is a data: URL because the renderer's CSP allows no other image
 * source (`img-src data:`) — main downloads the bytes and encodes them, exactly as it does for the hero
 * and the carousel art.
 */
export interface ArtworkVariant {
  readonly key: string;
  readonly kind: ArtworkKind;
  readonly provider: MetadataProviderId;
  readonly width?: number;
  readonly height?: number;
  readonly thumbDataUrl: string;
}

/**
 * One page of a gallery. The sources hold far more than a screen's worth — a busy game has hundreds of
 * wallpapers, most of them not what this user wants — so the gallery shows a page at a time and says
 * whether there is another behind it. `hasMore` false is what removes the "load more" tile: an offer to
 * fetch nothing is worse than no offer at all.
 */
export interface ArtworkPage {
  readonly variants: readonly ArtworkVariant[];
  readonly hasMore: boolean;
}

/** One soundtrack album as the music provider knows it. */
export interface MusicAlbum {
  readonly key: string;
  readonly title: string;
  readonly trackCount?: number;
}

/** One track inside an album. `sizeBytes` is what the source claims, shown before a long download. */
export interface MusicTrack {
  readonly key: string;
  readonly title: string;
  readonly sizeBytes?: number;
}

/**
 * Text a source carries per language. Both fields are optional: Steam answers in whatever languages the
 * publisher supplied, and a missing translation is normal. Consumers fall back `[locale] ?? en`.
 */
export interface LocalizedText {
  readonly en?: string;
  readonly ru?: string;
}

/** The platforms a store states a game runs on. Kept as the store's own three, lower-cased. */
export type GamePlatform = 'windows' | 'mac' | 'linux';

/**
 * The facts about a game that are worth keeping but have no screen of their own yet: the description,
 * and the three fields a future library view would sort and filter by.
 *
 * Stored now, shown later — deliberately. They arrive inside answers this feature already fetches (the
 * Steam store page, the GOG catalogue entry), so keeping them costs nothing extra at the time the user
 * picks a game, whereas going back for them afterwards would mean asking the same endpoints again for a
 * game the user has moved on from.
 */
export interface GameDetails {
  /** Short description per language (see LocalizedText). */
  readonly description?: LocalizedText;
  /** Genres as the ENGLISH store names them — a filter has to compare them, so they must not shift. */
  readonly genres?: readonly string[];
  /** Release date as `YYYY-MM-DD`, or `YYYY` when the store states no more than a year. */
  readonly releaseDate?: string;
  /** Which platforms the store says it runs on natively. */
  readonly platforms?: readonly GamePlatform[];
}

/** Which manifest field an applied download lands in. `hero` carries the 0-based rotation index. */
export type MetadataApplySlot = 'grid' | 'music' | { readonly hero: number };

/**
 * Payload for metadata:apply — "download this variant and put it into that game's root". Like
 * GameConfigAcceptRequest this comes FROM the renderer, so main re-checks every part of it (the root is
 * a live candidate, the id matches the manifest id syntax, the hero index is in range) BEFORE any
 * network or disk work happens.
 */
export interface MetadataApplyRequest {
  readonly root: string;
  /** The game id the target file is named after (see shared/asset-move-names.ts). */
  readonly gameId: string;
  readonly variantKey: string;
  readonly slot: MetadataApplySlot;
}

/**
 * Result of metadata:apply. On success `path` is the MANIFEST-relative path the renderer writes into the
 * form field — the same shape gameConfig:accept-path answers with, so both pickers feed the form
 * identically.
 */
export type MetadataApplyResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

/** API that preload exposes on `window.api`. */
export interface RendererApi {
  onStateUpdate(callback: (state: AppState) => void): void;
  /** Launcher window focus changes (true = foreground). Used to gate gamepad input while backgrounded. */
  onWindowFocus(callback: (focused: boolean) => void): void;
  requestState(): Promise<AppState>;
  requestLaunch(): void;
  requestUninstall(): void;
  requestHide(): void;
  /** Quit the whole app (Game Mode's "Close Playhook" — no tray to minimize into). */
  requestQuit(): void;
  /** Whether this is a SteamOS Game Mode (gamescope) session, seeded once at startup. */
  requestGameMode(): Promise<boolean>;
  /** Open Steam's Downloads page so the user can pause/resume a Steam download from Steam itself. */
  openSteamDownloads(): void;
  /** Power off the PC (after the in-launcher confirm). */
  requestShutdown(): void;
  /** Restart the PC (after the in-launcher confirm). */
  requestReboot(): void;
  /** Put the PC to sleep (after the in-launcher confirm). */
  requestSleep(): void;
  /** Force-close the running game (after the in-launcher confirm). */
  requestKill(): void;
  onError(callback: (message: string) => void): void;
  /** The inserted card's background music (data URL), or null when there is none. */
  onCardMusic(callback: (url: string | null) => void): void;
  requestCardMusic(): Promise<string | null>;
  /** Live default-ambience updates (data URL or null), pushed when the track changes in settings. */
  onAmbientUpdate(callback: (url: string | null) => void): void;
  /** The current default-ambience data URL (on window startup); null when no ambience is set. */
  requestAmbient(): Promise<string | null>;
  onHeroUpdate(callback: (assets: HeroAssets | null) => void): void;
  requestHero(): Promise<HeroAssets | null>;
  /** Live carousel-list updates (card games + history, in display order; null when there is nothing). */
  onLibraryUpdate(callback: (library: GameLibrary | null) => void): void;
  /** Current carousel list (on window startup / back-fill after a reload). */
  requestLibrary(): Promise<GameLibrary | null>;
  /** The carousel card artwork of one game as a data URL (null when it has none). Cached per id. */
  requestGrid(id: string): Promise<string | null>;
  /**
   * Tell main which game the carousel is on — it answers with browse:update/hero/music. `immediate` says
   * the user COMMITTED to this game (opened its screen) rather than flipped onto it, so the heavy half
   * (hero images, music) is read at once instead of waiting out main's debounce.
   *
   * `null` is the carousel standing on one of the launcher's own cards: nothing is on screen, and main
   * answers with an empty browse (and pins the cursor there — see the browse section in ipc.ts).
   */
  browseGame(id: string | null, immediate?: boolean): void;
  /** Drop a game from the play history. Refused by main for a game that is available right now (on the
   *  card or in the PC library) — that one is not history, it is a game you can play. */
  forgetGame(id: string): void;
  /** Live updates of what is on screen (title/stats/active/GameInfo). */
  onBrowseUpdate(callback: (browse: BrowseInfo | null) => void): void;
  /** What is on screen right now (on window startup). */
  requestBrowse(): Promise<BrowseInfo | null>;
  /** Hero backgrounds of the browsed game (independent of the inserted card's hero:update). */
  onBrowseHero(callback: (assets: HeroAssets | null) => void): void;
  /** Background music of the browsed game (music only — the SFX set is untouched). */
  onBrowseMusic(callback: (url: string | null) => void): void;
  /** Live updates of the bundled UI sound set (the chosen set changed in Settings). */
  onSfxSet(callback: (set: SfxSet | null) => void): void;
  /** The bundled UI sound set (on window startup). */
  requestSfxSet(): Promise<SfxSet | null>;
  /** Pick a game by id (entering its detail screen) — switches to it on the ready screen. */
  selectGame(id: string): void;
  requestWallpaper(): Promise<string | null>;
  /** The bundled startup jingle as a data URL, or null when it can't be read. Played once, on boot. */
  requestStartupSound(): Promise<string | null>;
  /** Current launcher audio volumes (on window startup). */
  requestVolumes(): Promise<AudioVolumes>;
  /** Live audio-volume updates, pushed when a volume changes (the Settings screen or a reset). */
  onVolumesUpdate(callback: (volumes: AudioVolumes) => void): void;
  /** Current effective UI locale (on window startup). */
  getLanguage(): Promise<Locale>;
  /** Live UI-locale updates, pushed when the language changes. */
  onLanguageUpdate(callback: (locale: Locale) => void): void;

  // ── Settings screen (moved here with the window it used to live in) ──
  /** The current AppSettings (seed for the Settings screen). */
  getSettings(): Promise<AppSettings>;
  /** Live AppSettings pushes — the screen's single source of truth, including after a reset. */
  onSettingsUpdate(callback: (settings: AppSettings) => void): void;
  /** Whether the Steam-related row exists at all — false on Windows and on a non-AppImage run. */
  isSteamAvailable(): Promise<boolean>;
  /** The bundled sound sets + ambience tracks, to populate the Audio dropdowns. */
  getAudioOptions(): Promise<AudioOptions>;
  /** The app version string, shown beside the screen title. */
  getAppVersion(): Promise<string>;
  setAutoUpdate(mode: AutoUpdateMode): void;
  setPrerelease(on: boolean): void;
  setSummonHotkey(on: boolean): void;
  /** Toggle keeping the display awake (no screensaver / display-sleep) while the launcher owns the session. */
  setPreventScreensaver(on: boolean): void;
  /** Toggle keeping the empty "no card" screen visible instead of hiding to the tray. */
  setKeepOpenWithoutCard(on: boolean): void;
  /** Toggle disabling silent installer mode (installers show their wizard when on). */
  setDisableSilentInstall(on: boolean): void;
  /** Toggle the Game Mode card-insert auto-launch (Steam Deck only; see AppSettings.steamAutoLaunch). */
  setSteamAutoLaunch(on: boolean): void;
  /** Change the navigation sound set (applied live by main). */
  setSoundSet(set: string): void;
  /** Change the default ambience track (null = no ambience; applied live by main). */
  setAmbientTrack(track: string | null): void;
  /** Toggle using only the global ambience (a card's own music ignored when on). */
  setOnlyGlobalAmbient(on: boolean): void;
  /** Store the user's SteamGridDB API key ('' clears it and turns that source off). */
  setSteamGridDbKey(key: string): void;
  setMusicVolume(volume: number): void;
  setSfxVolume(volume: number): void;
  /** Change the UI language (the effective locale comes back via onLanguageUpdate). */
  setLanguage(mode: LanguageMode): void;
  /** Resets all settings to defaults. The screen re-renders from the settings:update push instead. */
  resetSettings(): Promise<AppSettings>;
  onUpdateStatus(callback: (status: UpdateStatus) => void): void;
  requestUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): void;
  downloadUpdate(): void;
  installUpdate(): void;

  // ── Customize screen (per-game game.json editing; see the gameConfig:* channels) ──
  /** The manifest text of one game by id, with the root/source/signature it was read against. */
  readGameConfig(id: string): Promise<GameConfigReadResult>;
  /** Static (fs-free) validation of the edited text — the Save verdict, debounced by the screen. */
  validateGameConfig(root: string, text: string): Promise<ConfigValidationResult>;
  /** Write game.json and try to apply it without a restart; refused when the media signature moved on. */
  saveGameConfig(request: GameConfigSaveRequest): Promise<ConfigSaveResult>;
  /** A root-relative image as a data URL for a row's thumbnail (null when unreadable). */
  getGameConfigImage(root: string, path: string): Promise<string | null>;
  /** Post-process path(s) the in-launcher picker chose into what the manifest field stores. */
  acceptGameConfigPaths(request: GameConfigAcceptRequest): Promise<ConfigPickResult>;
  /** List one directory for the in-launcher file picker (read-only). */
  listGameConfigDir(request: GameConfigListDirRequest): Promise<ListDirResult>;
  /** Every root a new game may be added to — the cards plus the PC library (the Add-game screen). */
  listGameConfigSources(): Promise<readonly DriveCandidate[]>;
  /** The manifest text of one ROOT, for adding a game to it (the root may carry no game yet). */
  readGameConfigRoot(root: string): Promise<ConfigRootReadResult>;
  /** Moves a local (PC-library) game onto a card in one transaction (see GameMoveRequest). */
  moveGameConfigToCard(request: GameMoveRequest): Promise<ConfigMoveResult>;
  /** The clipboard as text, for the on-screen keyboard's Paste key. Empty when there is nothing to paste. */
  readClipboard(): Promise<string>;

  // ── Online metadata ("Find online"; see the metadata:* channels) ──
  /** Search every source for a game by title. */
  searchMetadata(query: string): Promise<MetadataResult<readonly GameCandidate[]>>;
  /** The candidate behind a Steam appid the manifest already names — no search needed. */
  requestMetadataSteamCandidate(appId: number): Promise<MetadataResult<GameCandidate>>;
  /**
   * One page of the artwork gallery for a candidate — thumbnails arrive as data: URLs. Page 0 starts the
   * gallery over; every later page continues where the previous one stopped.
   */
  requestMetadataArtwork(
    candidateKey: string,
    kind: ArtworkKind,
    page: number,
  ): Promise<MetadataResult<ArtworkPage>>;
  /** One variant at full size as a data: URL, for the lightbox. */
  requestMetadataArtworkPreview(variantKey: string): Promise<MetadataResult<string>>;
  /** Soundtrack albums matching a title. */
  searchMetadataMusic(query: string): Promise<MetadataResult<readonly MusicAlbum[]>>;
  /** One album's tracks. */
  requestMetadataTracks(albumKey: string): Promise<MetadataResult<readonly MusicTrack[]>>;
  /** One track as an audio data: URL (a full download — show a status line while it runs). */
  requestMetadataTrackPreview(trackKey: string): Promise<MetadataResult<string>>;
  /** The candidate's descriptions, genres, release date and platforms — see GameDetails. */
  requestMetadataDescriptions(candidateKey: string): Promise<MetadataResult<GameDetails>>;
  /** Download the chosen variant into the game's root; answers with the manifest-relative path. */
  applyMetadata(request: MetadataApplyRequest): Promise<MetadataApplyResult>;
  /** Abort whatever is still being fetched (the user left the surface). */
  cancelMetadata(): void;

  // ── Notifications (the toast + the "Notifications" popup; see the notifications:* channels) ──
  /** Live inbox pushes — the popup list is drawn from the latest snapshot, never from local edits. */
  onNotifications(callback: (items: readonly AppNotification[]) => void): void;
  /** Show a plate over the UI (one notification, or the "N unread" summary). */
  onNotificationToast(callback: (toast: NotificationToast) => void): void;
  /** The current inbox (seed on window startup). */
  requestNotifications(): Promise<readonly AppNotification[]>;
  /** The user pressed a notification — it leaves the inbox (pressing one is what removes it). */
  dismissNotification(id: string): void;
  /** "Clear all" — empties the inbox. */
  clearNotifications(): void;
  /** The popup was opened — everything in the inbox counts as seen. */
  markNotificationsRead(): void;
}

declare global {
  interface Window {
    readonly api: RendererApi;
  }
}
