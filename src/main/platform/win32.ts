// Windows implementations of the platform services. These wrap the existing win32 code (tasklist/taskkill
// process control, the registry Steam lookup, the spawn/ShellExecuteEx launchers, the env-based save-path
// mapping, the `shutdown` command + powrprof suspend). Behaviour is 1:1 with the pre-port code — the port
// only routes it through the interfaces so a linux implementation can take its place (Р3/Р4/Р5/Р9).
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GameProcessLauncher,
  Platform,
  PlatformDeps,
  PowerBackend,
  ProcessMonitor,
  ProcessSnapshot,
  RemovableMounter,
  SavePathResolver,
  SteamLocator,
} from './types';
import {
  launchGame,
  launchInstaller,
  launchUninstaller,
} from '../game-launcher';
import { getSteamPath } from '../registry';
import { suspendToSleep } from '../power-native';
import {
  expandPcSavePath,
  absoluteToPcSavePath,
  type ManifestEnv,
  type InstallDirResolver,
} from '../manifest';
import { createTranslator } from '../../shared/i18n/index';

const execFileAsync = promisify(execFile);

// ── ProcessMonitor (tasklist / taskkill) ─────────────────────────────────────
// Substring matching over a single unfiltered `tasklist /NH /FO CSV` snapshot (lower-cased), exactly as
// the pre-port game-launcher did: an image name is "present" if it appears anywhere in the CSV, a pid if
// its quoted form `"<pid>"` does. Any error → an empty snapshot (everything reads as absent — "error = dead").

/** Builds a ProcessSnapshot over a lower-cased tasklist CSV. Matching semantics: substring (win32 detail). */
function makeWin32Snapshot(rawLower: string): ProcessSnapshot {
  return {
    hasImageName: (name) => rawLower.includes(name.toLowerCase()),
    hasPid: (pid) => rawLower.includes(`"${pid}"`),
  };
}

function createProcessMonitor(): ProcessMonitor {
  const monitor: ProcessMonitor = {
    async snapshot(): Promise<ProcessSnapshot> {
      try {
        const { stdout } = await execFileAsync('tasklist', ['/NH', '/FO', 'CSV'], { windowsHide: true });
        return makeWin32Snapshot(stdout.toLowerCase());
      } catch {
        return makeWin32Snapshot('');
      }
    },
    async isPidAlive(pid): Promise<boolean> {
      try {
        const { stdout } = await execFileAsync(
          'tasklist',
          ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
          { windowsHide: true },
        );
        return stdout.includes(`"${pid}"`);
      } catch {
        return false;
      }
    },
    async killTree(pid): Promise<void> {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } catch {
        // taskkill exits non-zero when the pid no longer exists → already dead, nothing to do.
      }
    },
    async killByName(names): Promise<void> {
      for (const name of names) {
        try {
          await execFileAsync('taskkill', ['/F', '/IM', name], { windowsHide: true });
        } catch {
          // Non-zero exit = the image isn't running (already dead) → nothing to do.
        }
      }
    },
    // On Windows, Steam launches the game's `.exe`, so the watched image names ARE the running signal
    // (1:1 with the pre-port steam-mode behaviour). The appid is unused here.
    async isSteamGameRunning(_appid, watchNames): Promise<boolean> {
      const snap = await monitor.snapshot();
      return watchNames.some((name) => snap.hasImageName(name));
    },
    killSteamGame(_appid, watchNames): Promise<void> {
      return monitor.killByName(watchNames);
    },
  };
  return monitor;
}

// ── SteamLocator (registry) ──────────────────────────────────────────────────

function createSteamLocator(): SteamLocator {
  return { locateSteam: () => getSteamPath() };
}

// ── GameProcessLauncher (spawn / ShellExecuteEx) ─────────────────────────────

function createGameLauncher(monitor: ProcessMonitor): GameProcessLauncher {
  return {
    launchGame: (manifest) => launchGame(manifest, monitor),
    launchInstaller: (install, silent) => launchInstaller(install, silent, monitor),
    // No Wine prefix on Windows: the install dir needs no preparation beyond the controller's own
    // pre-clean, and `copy` can write into it straight away.
    prepareInstallDir: () => Promise.resolve(),
    launchUninstaller: (target) => launchUninstaller(target, monitor),
    // win32: no Wine prefix — uninstall removes the app-controlled install dir (after the game's own
    // uninstaller runs). 1:1 with the pre-port behaviour.
    uninstallDir: (install) => install.dir,
  };
}

// ── SavePathResolver (env-based %PREFIX% mapping) ────────────────────────────
// Reuses the existing pure expanders. The resolver contract returns null on failure (Р5: "nothing to
// sync"), so the translator only matters for messages we never surface here — a fixed 'en' one suffices.

const noopTranslator = createTranslator('en');

function createSavePathResolver(deps: PlatformDeps): SavePathResolver {
  const env = (): ManifestEnv => ({ documents: deps.getDocuments(), t: noopTranslator });
  return {
    resolvePcSavePath: (_manifest, pcSavePath) => {
      const result = expandPcSavePath(pcSavePath, env());
      return Promise.resolve(result.ok ? result.value : null);
    },
    toManifestPcSavePath: (absolute) => absoluteToPcSavePath(absolute, env()),
  };
}

// ── InstallDirResolver (`%LOCALAPPDATA%\playhook\games\<id>`) ────────────────
// Both views coincide on Windows: the installer writes to the same real path the app reads. Absent
// `%LOCALAPPDATA%` (unusual setups) → null, so install mode is rejected exactly as the pre-port check did.

function createInstallDirResolver(): InstallDirResolver {
  return (id) => {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData === undefined || localAppData === '') return null;
    // `id` is already constrained to [A-Za-z0-9._-] (no separators / not . or ..) → a safe folder name.
    const dir = path.join(localAppData, 'playhook', 'games', id);
    return { hostDir: dir, installerDir: dir };
  };
}

// ── PowerBackend (`shutdown` + powrprof suspend) ─────────────────────────────

function createPowerBackend(): PowerBackend {
  return {
    supported: true,
    async run(action): Promise<void> {
      // shutdown /s (power off) or /r (restart), immediate (/t 0). `shutdown` is on PATH (System32).
      const flag = action === 'shutdown' ? '/s' : '/r';
      await execFileAsync('shutdown', [flag, '/t', '0'], { windowsHide: true });
    },
    suspend(): Promise<void> {
      suspendToSleep();
      return Promise.resolve();
    },
  };
}

// ── RemovableMounter (no-op) ─────────────────────────────────────────────────
// Windows mounts removable media itself (a drive letter appears on insert), so there is nothing to sweep.

function createRemovableMounter(): RemovableMounter {
  return { mountAll: () => Promise.resolve() };
}

/** Assembles the win32 platform bundle. */
export function createWin32Platform(deps: PlatformDeps): Platform {
  // The launcher's normal-path GameProcess monitors by pid through this same monitor (tasklist), so build
  // it first and hand it to the launcher.
  const processMonitor = createProcessMonitor();
  return {
    processMonitor,
    steamLocator: createSteamLocator(),
    gameLauncher: createGameLauncher(processMonitor),
    savePathResolver: createSavePathResolver(deps),
    powerBackend: createPowerBackend(),
    removableMounter: createRemovableMounter(),
    resolveInstallDir: createInstallDirResolver(),
  };
}
