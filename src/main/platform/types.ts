// Platform abstraction layer (interface-DI). The launcher's OS-specific behaviour — process
// monitoring, Steam discovery, game/installer spawning, save-path resolution and power actions — lives
// behind these interfaces so a win32 and a linux (SteamOS/Proton) implementation can be swapped wholesale
// by createPlatform(process.platform). See the SteamOS port plan (decisions Р3/Р4/Р5/Р9) and CLAUDE.md
// ("Adding a new service": interface-DI is the testable shape).
//
// Types only — no koffi/electron here, so this file is import-safe from anywhere (incl. unit tests). The
// concrete win32/linux implementations (which DO pull koffi on Windows) live in ./win32 and ./linux and
// are selected at runtime by ./index.
import type {
  ResolvedManifest,
  LaunchTarget,
  ResolvedInstall,
  ResolvedInstallerRun,
} from '../../shared/types';
import type { GameProcess } from '../game-launcher';
import type { PowerAction } from '../power';
import type { InstallDirResolver } from '../manifest';

/**
 * An atomic snapshot of the running processes (one OS call). The same snapshot answers BOTH "is a watched
 * image running?" and "is the launcher pid alive?" so the watched-process waits test both against one
 * consistent view (see game-launcher's waitForWatched*). The matching SEMANTICS are a platform detail:
 * win32 substring-matches a `tasklist` CSV, linux matches a `/proc/<pid>/cmdline` basename.
 */
export interface ProcessSnapshot {
  /** Whether a process with this image name (a bare `*.exe` basename) is present. */
  hasImageName(name: string): boolean;
  /** Whether the process with this pid is present in the snapshot. */
  hasPid(pid: number): boolean;
}

/**
 * Platform process control: the snapshot-based watched-process tracking plus targeted liveness and
 * force-kill. win32 wraps `tasklist`/`taskkill`; linux walks `/proc` and sends signals (Р3).
 */
export interface ProcessMonitor {
  /** One atomic snapshot of all visible processes. */
  snapshot(): Promise<ProcessSnapshot>;
  /** Targeted liveness check for a single pid (cheaper than a full snapshot). Any error → false ("dead"). */
  isPidAlive(pid: number): Promise<boolean>;
  /** Force-kills the whole process tree rooted at `pid` (best-effort; "already gone" counts as success). */
  killTree(pid: number): Promise<void>;
  /** Force-kills every process whose image matches one of the given (bare) names (best-effort). */
  killByName(names: readonly string[]): Promise<void>;
  /**
   * Whether a Steam game (by appid) is currently running. On win32 this falls back to the (Windows-
   * dictionary) `watchNames` image match — Windows Steam runs the game's `.exe`. On linux it keys on
   * `SteamAppId`/`SteamGameId` in `/proc/<pid>/environ`, which Steam stamps on every game process — robust
   * for BOTH native-Linux and Proton games, whose binary names differ from the manifest's `*.exe`.
   */
  isSteamGameRunning(appid: number, watchNames: readonly string[]): Promise<boolean>;
  /**
   * Force-kills a running Steam game (force-close). win32: kills by `watchNames`. linux: SIGTERM/SIGKILL
   * every process tagged with this `SteamAppId`, plus a by-name sweep as a fallback.
   */
  killSteamGame(appid: number, watchNames: readonly string[]): Promise<void>;
}

/** Locates the local Steam installation (the source of the steamapps libraries + compatdata prefixes). */
export interface SteamLocator {
  /**
   * The Steam install root (the dir containing `steamapps/`), or null when Steam isn't found. On win32
   * this reads the registry (Valve\Steam); on linux it probes the well-known data dirs — native,
   * flatpak, snap (Р4). Best-effort: any error → null.
   */
  locateSteam(): Promise<string | null>;
}

/**
 * Spawns the game / installer / uninstaller. win32 dispatches to a direct `spawn` or an elevated
 * ShellExecuteEx per manifest.runAsAdmin; linux runs everything through umu-run in the game's Wine
 * prefix (Р1/Р7) with no elevation (runAsAdmin is a no-op there — Р6).
 */
export interface GameProcessLauncher {
  /**
   * Launches the game executable and returns a GameProcess. Throws on failure. `onProvisioning` (linux
   * only) fires true/false around a winetricks prefix provisioning step, so the caller can show a
   * "Configuring Proton" status; win32 never provisions and ignores it.
   */
  launchGame(
    manifest: ResolvedManifest,
    onProvisioning?: (active: boolean) => void,
  ): Promise<GameProcess>;
  /**
   * Launches the install-mode installer into the app-controlled directory. `silent` (from settings) runs
   * it unattended (default) or shows its wizard when the user disabled silent mode. `onProvisioning` — see
   * launchGame. Throws on failure.
   */
  launchInstaller(
    install: ResolvedInstallerRun,
    silent: boolean,
    onProvisioning?: (active: boolean) => void,
  ): Promise<GameProcess>;
  /**
   * Prepares the install directory's ENVIRONMENT before files are put there by other means than an
   * installer run — i.e. the `copy` install type, which starts no process of its own and would otherwise
   * never trigger the setup that launchInstaller performs implicitly.
   * win32: nothing to do (no-op). linux: creates and provisions the game's Wine prefix (baseline +
   * `install.winetricks`), exactly as launchInstaller does before running an installer — so the copied
   * files land in a ready prefix rather than a bare one. `onProvisioning` — see launchGame.
   * Throws on failure.
   */
  prepareInstallDir(
    install: ResolvedInstall,
    onProvisioning?: (active: boolean) => void,
  ): Promise<void>;
  /** Launches a resolved uninstaller target silently. Throws on failure. */
  launchUninstaller(target: LaunchTarget): Promise<GameProcess>;
  /**
   * The directory whose removal fully uninstalls the game (removed best-effort by the controller — Р7f).
   * win32: the app-controlled install dir. linux: the WHOLE per-game Wine prefix — it holds the install
   * dir AND the game's provisioned runtimes (dotnet/GE-Proton env), so uninstall reclaims all of it.
   */
  uninstallDir(install: NonNullable<ResolvedManifest['install']>): string;
  /**
   * The per-game cleanup target for a NORMAL executable game (no install block): the Wine prefix a launch
   * created, or null when there is nothing to clean — win32 (an exe runs directly, no prefix) or linux
   * before the first launch (prefix not created yet). Lets the launcher offer "clear the Proton prefix"
   * for a play-only game whose only PC footprint is that prefix; the game itself stays on the card.
   */
  prefixCleanupDir(gameId: string): Promise<string | null>;
}

/**
 * Resolves the Windows-dictionary `pcSavePath` to a physical folder for THIS game (Р5). The moment of
 * resolution moved from manifest-read to sync-time so an unresolvable location (a Wine/compatdata prefix
 * that doesn't exist yet) is a no-op sync, not a rejected card. win32 keeps the env-based mapping; linux
 * maps every prefix inside the game's Wine prefix (exe/install) or the Steam compatdata prefix (steam).
 */
export interface PcSaveLocation {
  /** The ABSOLUTE host folder this game's saves live in. May not exist yet (the game hasn't saved). */
  readonly path: string;
  /**
   * Whether the CONTAINER that owns this location is present — win32: always true (the user profile);
   * linux: the game's Wine prefix / Steam compatdata.
   *
   * False is NOT "the saves were deleted", it is "the whole environment is absent" (first launch, or the
   * prefix was wiped by an uninstall). The distinction is critical for change-detection: an empty PC side
   * with a stale baseline reads as "every save was deleted here" and would propagate that phantom deletion
   * onto the card, destroying the only copy. The caller must discard the baseline instead and restore from
   * the card — see GameController.runSaveSync.
   */
  readonly containerExists: boolean;
}

export interface SavePathResolver {
  /**
   * Resolves a manifest `pcSavePath` (`%APPDATA%\rest`, …) to this game's save location, or null when the
   * location is genuinely unknowable — steam mode with no compatdata AND no appmanifest (the game isn't
   * installed, so there is nothing to launch or sync either). The caller treats null as "nothing to sync"
   * (a logged no-op), not an error. Async + per-game.
   */
  resolvePcSavePath(manifest: ResolvedManifest, pcSavePath: string): Promise<PcSaveLocation | null>;
  /**
   * Reverse (Configure window): an absolute PC folder → a `%PREFIX%/…` manifest string, or null when it
   * lives under none of the allowed bases (so it can't be expressed and the caller rejects it).
   */
  toManifestPcSavePath(absolute: string): string | null;
}

/**
 * Executes the OS power actions behind the launcher's Shutdown/Reboot/Sleep menu (Р9). win32 uses the
 * `shutdown` command + the powrprof SetSuspendState FFI; linux uses logind via `systemctl` (Э7). The
 * PowerService (power.ts) owns the user-facing flow (confirm, quit, error copy) — this is only the OS bit.
 */
export interface PowerBackend {
  /** Whether power actions are supported on this platform. False → PowerService surfaces "unsupported". */
  readonly supported: boolean;
  /** Powers off (`shutdown`) or restarts (`reboot`) the machine. Resolves once the OS accepts the request. */
  run(action: Exclude<PowerAction, 'sleep'>): Promise<void>;
  /** Suspends the machine in place (no app exit). Throws on failure. */
  suspend(): Promise<void>;
}

/**
 * Mounts inserted-but-unmounted removable volumes so the drive watcher can see them (Р10). Only SteamOS
 * **Game Mode** needs this: gamescope's session automounts ext4 only, so an exFAT/NTFS card appears as a
 * block device with no mountpoint and `scan()` (which walks mountpoints) never finds it. win32 and the
 * KDE desktop session automount on their own → no-op there. The caller decides WHEN to sweep; this is
 * only the OS bit.
 */
export interface RemovableMounter {
  /**
   * Best-effort: mount every removable, unmounted volume that carries a filesystem. **Never throws** — a
   * failure (no permission, device busy) is logged and the sweep moves on, because an automount failure
   * must not break card detection. Idempotent: already-mounted volumes are skipped.
   */
  mountAll(): Promise<void>;
}

/** Where a non-Steam shortcut should point. `appName` is fixed (`Playhook`) — it feeds the appid hash. */
export interface SteamShortcutTarget {
  /** The executable path, UNQUOTED. The quoting that Steam stores (and that the hash covers) is applied
   * by the implementation via `quoteExePath`, so the `Exe` field and the appid can never disagree. */
  readonly exePath: string;
  readonly appName: string;
  readonly startDir: string;
  /**
   * Absolute path to the tile icon. Must be a REAL file on disk: the app's own `icon.png` ships inside the
   * asar, which Steam (an outside process) cannot read — so the caller extracts it next to the stable
   * launcher symlink and passes that path.
   */
  readonly iconPath: string;
}

/** Result of an operation on Steam's own files — untrusted data in a foreign format, so a Result-union
 * (CLAUDE.md error-handling convention), not a throw. */
export type SteamShortcutFailure = { readonly ok: false; readonly message: string };
export type SteamShortcutResult<T> = ({ readonly ok: true } & T) | SteamShortcutFailure;
/** The same union for an operation that returns nothing but success. */
export type SteamShortcutVoidResult = { readonly ok: true } | SteamShortcutFailure;

/**
 * Registering Playhook with Steam as a non-Steam game, so it gets a Game Mode tile (with the overlay and
 * QAM that a tile brings). Linux-only: `supported` is false on win32, where every method refuses.
 *
 * Playhook WRITES `shortcuts.vdf` itself rather than asking Steam to add the entry, because only then does
 * it own both the name and the appid — an entry Steam adds gets a random appid it would have to read back
 * (steam-for-linux#9463) and a name taken from the file's basename (verified on a Deck).
 */
export interface SteamShortcuts {
  /** Whether the platform supports the operation at all (win32 → false; the tray item is hidden there). */
  readonly supported: boolean;
  /** Adds (or updates in place) Playhook's shortcut. Returns the appid to persist. */
  addShortcut(
    target: SteamShortcutTarget,
  ): Promise<SteamShortcutResult<{ readonly appIdU32: number }>>;
  /** Removes the record with exactly this appid — never a foreign one that merely shares the Exe. */
  removeShortcut(appIdU32: number): Promise<SteamShortcutVoidResult>;
  /** Whether a record with this appid is present (startup self-healing: a missing one means it was lost). */
  hasShortcut(appIdU32: number): Promise<boolean>;
  /**
   * Names of FOREIGN records whose `Exe` points at Playhook (e.g. a tile the user added by hand through
   * Steam's UI). Adding on top of one would leave two tiles, so the caller asks the user to remove theirs
   * instead of deleting it for them — it may carry their own artwork and playtime.
   */
  findForeignShortcuts(exeHints: readonly string[]): Promise<readonly string[]>;
  /**
   * Copies the tile artwork into `userdata/<id>/config/grid/`. Best-effort by design: a tile with no
   * artwork is merely plain, so a failure here must never fail the whole "Add to Steam".
   */
  writeArtwork(appIdU32: number, sources: SteamArtworkSources): Promise<void>;
  /** Deletes the artwork we wrote (only our own appid's files). Best-effort. */
  removeArtwork(appIdU32: number): Promise<void>;
}

/** Absolute paths to the bundled artwork, per Steam grid slot. A slot may be omitted. */
export interface SteamArtworkSources {
  /** 920×430 — the wide capsule in the library. */
  readonly wide?: string;
  /** 600×900 — the portrait/grid capsule. */
  readonly portrait?: string;
  /** 1920×620 — the hero banner on the game's page. */
  readonly hero?: string;
  /** Logo drawn over the hero; needs transparency, hence a PNG. */
  readonly logo?: string;
}

/** The full set of platform services, selected as a unit by createPlatform(process.platform). */
export interface Platform {
  readonly processMonitor: ProcessMonitor;
  readonly steamLocator: SteamLocator;
  readonly steamShortcuts: SteamShortcuts;
  readonly gameLauncher: GameProcessLauncher;
  readonly savePathResolver: SavePathResolver;
  readonly powerBackend: PowerBackend;
  readonly removableMounter: RemovableMounter;
  /**
   * Resolves the app-controlled install directory for an install-mode game id (Р7), injected into
   * readManifests. win32 derives `%LOCALAPPDATA%\playhook\games\<id>`; linux the game's Wine prefix.
   */
  readonly resolveInstallDir: InstallDirResolver;
}

/** Environment a platform needs at construction (resolved once in main from Electron's app paths). */
export interface PlatformDeps {
  /** The user's Documents known folder (win32 %DOCUMENTS%); resolved via app.getPath('documents'). */
  readonly getDocuments: () => string;
  /** app.getPath('userData') — the base for per-game Wine prefixes on linux (`<userData>/prefixes/<id>`). */
  readonly userData: string;
  /** Absolute path to the bundled umu-run zipapp (extraResources), run via system python3 on linux (Р1).
   * Unused on win32. */
  readonly umuRunPath: string;
}
