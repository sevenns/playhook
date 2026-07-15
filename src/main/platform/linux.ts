// Linux (SteamOS / Proton) implementations of the platform services. Built up stage by stage per the
// SteamOS port plan; in the foundation stage (Э0) these replicate the pre-port graceful degradation on
// non-Windows (null Steam path, no visible processes, no power actions) so createPlatform is complete and
// behaviour on the untouched paths is unchanged. Each service is filled in by its own stage:
//   ProcessMonitor → Э2 (/proc scan)   SteamLocator → Э3 (known paths)   GameProcessLauncher → Э4 (umu-run)
//   SavePathResolver → Э5/Э6 (Wine prefix / compatdata)   PowerBackend → Э7 (systemctl / logind)
import type {
  Platform,
  PlatformDeps,
  PowerBackend,
} from './types';
import { createLinuxProcessMonitor } from './proc';
import { createLinuxSteamLocator } from './steam-locator.linux';
import { createLinuxGameLauncher } from './game-launcher.linux';
import { createLinuxSavePathResolver } from './save-path.linux';
import { installDirs } from './umu';

// ── PowerBackend — Э7 (systemctl poweroff/reboot/suspend via logind). Placeholder: unsupported. ──
function createPowerBackend(): PowerBackend {
  return {
    supported: false,
    run: () => Promise.reject(new Error('power actions are not supported on Linux yet (Proton port stage 7)')),
    suspend: () => Promise.reject(new Error('suspend is not supported on Linux yet (Proton port stage 7)')),
  };
}

/** Assembles the linux platform bundle. The game launcher shares the /proc monitor (for force-kill) and
 * needs userData (Wine prefixes) + the bundled umu-run path. */
export function createLinuxPlatform(deps: PlatformDeps): Platform {
  const processMonitor = createLinuxProcessMonitor();
  const steamLocator = createLinuxSteamLocator();
  return {
    processMonitor,
    steamLocator,
    gameLauncher: createLinuxGameLauncher({
      userData: deps.userData,
      umuRunPath: deps.umuRunPath,
      monitor: processMonitor,
    }),
    savePathResolver: createLinuxSavePathResolver({ userData: deps.userData, steamLocator }),
    powerBackend: createPowerBackend(),
    // Install mode is always supported on linux — the prefix is created on demand (Р7). Both views come
    // from umu.installDirs (host path inside the prefix + the `C:\playhook\games\<id>` installer view).
    resolveInstallDir: (id) => installDirs(deps.userData, id),
  };
}
