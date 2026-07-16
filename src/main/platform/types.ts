// Platform abstraction layer (interface-DI). The launcher's OS-specific behaviour — process
// monitoring, Steam discovery, game/installer spawning, save-path resolution and power actions — lives
// behind these interfaces so a win32 and a linux (SteamOS/Proton) implementation can be swapped wholesale
// by createPlatform(process.platform). See the SteamOS port plan (decisions Р3/Р4/Р5/Р9) and CLAUDE.md
// ("Adding a new service": interface-DI is the testable shape).
//
// Types only — no koffi/electron here, so this file is import-safe from anywhere (incl. unit tests). The
// concrete win32/linux implementations (which DO pull koffi on Windows) live in ./win32 and ./linux and
// are selected at runtime by ./index.
import type { ResolvedManifest, LaunchTarget } from '../../shared/types';
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
    install: NonNullable<ResolvedManifest['install']>,
    silent: boolean,
    onProvisioning?: (active: boolean) => void,
  ): Promise<GameProcess>;
  /** Launches a resolved uninstaller target silently. Throws on failure. */
  launchUninstaller(target: LaunchTarget): Promise<GameProcess>;
  /**
   * The directory whose removal fully uninstalls the game (removed best-effort by the controller — Р7f).
   * win32: the app-controlled install dir. linux: the WHOLE per-game Wine prefix — it holds the install
   * dir AND the game's provisioned runtimes (dotnet/GE-Proton env), so uninstall reclaims all of it.
   */
  uninstallDir(install: NonNullable<ResolvedManifest['install']>): string;
}

/**
 * Resolves the Windows-dictionary `pcSavePath` to a physical folder for THIS game (Р5). The moment of
 * resolution moved from manifest-read to sync-time so an unresolvable location (a Wine/compatdata prefix
 * that doesn't exist yet) is a no-op sync, not a rejected card. win32 keeps the env-based mapping; linux
 * maps every prefix inside the game's Wine prefix (exe/install) or the Steam compatdata prefix (steam).
 */
export interface SavePathResolver {
  /**
   * Resolves a manifest `pcSavePath` (`%APPDATA%\rest`, …) to the ABSOLUTE folder for this game, or null
   * when the location can't exist yet (prefix not created) — the caller treats null as "nothing to sync"
   * (a logged no-op), not an error. Async + per-game.
   */
  resolvePcSavePath(manifest: ResolvedManifest, pcSavePath: string): Promise<string | null>;
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

/** The full set of platform services, selected as a unit by createPlatform(process.platform). */
export interface Platform {
  readonly processMonitor: ProcessMonitor;
  readonly steamLocator: SteamLocator;
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
