// Linux (SteamOS / Proton) implementations of the platform services. Built up stage by stage per the
// SteamOS port plan; in the foundation stage (Э0) these replicate the pre-port graceful degradation on
// non-Windows (null Steam path, no visible processes, no power actions) so createPlatform is complete and
// behaviour on the untouched paths is unchanged. Each service is filled in by its own stage:
//   ProcessMonitor → Э2 (/proc scan)   SteamLocator → Э3 (known paths)   GameProcessLauncher → Э4 (umu-run)
//   SavePathResolver → Э5/Э6 (Wine prefix / compatdata)   PowerBackend → Э7 (systemctl / logind)
import type {
  GameProcessLauncher,
  Platform,
  PowerBackend,
  SavePathResolver,
  SteamLocator,
} from './types';
import type { GameProcess } from '../game-launcher';
import { createLinuxProcessMonitor } from './proc';

// ── SteamLocator — Э3 (probe ~/.local/share/Steam, flatpak, snap). Placeholder: not found. ──
function createSteamLocator(): SteamLocator {
  return { locateSteam: () => Promise.resolve(null) };
}

// ── GameProcessLauncher — Э4 (umu-run in the game's Wine prefix). Placeholder: unsupported. ──
function unsupportedLaunch(): Promise<GameProcess> {
  return Promise.reject(new Error('game launch is not supported on Linux yet (Proton port stage 4)'));
}

function createGameLauncher(): GameProcessLauncher {
  return {
    launchGame: unsupportedLaunch,
    launchInstaller: unsupportedLaunch,
    launchUninstaller: unsupportedLaunch,
  };
}

// ── SavePathResolver — Э5/Э6 (map %PREFIX% inside the Wine/compatdata prefix). Placeholder: unresolvable. ──
function createSavePathResolver(): SavePathResolver {
  return {
    // null = "nothing to sync" (the prefix doesn't exist yet) — a logged no-op, not an error (Р5).
    resolvePcSavePath: () => Promise.resolve(null),
    toManifestPcSavePath: () => null,
  };
}

// ── PowerBackend — Э7 (systemctl poweroff/reboot/suspend via logind). Placeholder: unsupported. ──
function createPowerBackend(): PowerBackend {
  return {
    supported: false,
    run: () => Promise.reject(new Error('power actions are not supported on Linux yet (Proton port stage 7)')),
    suspend: () => Promise.reject(new Error('suspend is not supported on Linux yet (Proton port stage 7)')),
  };
}

/** Assembles the linux platform bundle. (PlatformDeps — userData for Wine prefixes — is added from Э4.) */
export function createLinuxPlatform(): Platform {
  return {
    processMonitor: createLinuxProcessMonitor(),
    steamLocator: createSteamLocator(),
    gameLauncher: createGameLauncher(),
    savePathResolver: createSavePathResolver(),
    powerBackend: createPowerBackend(),
  };
}
