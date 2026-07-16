// Linux (SteamOS / Proton) implementations of the platform services. Built up stage by stage per the
// SteamOS port plan; in the foundation stage (Э0) these replicate the pre-port graceful degradation on
// non-Windows (null Steam path, no visible processes, no power actions) so createPlatform is complete and
// behaviour on the untouched paths is unchanged. Each service is filled in by its own stage:
//   ProcessMonitor → Э2 (/proc scan)   SteamLocator → Э3 (known paths)   GameProcessLauncher → Э4 (umu-run)
//   SavePathResolver → Э5/Э6 (Wine prefix / compatdata)   PowerBackend → Э7 (systemctl / logind)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

// ── PowerBackend — Э7 (systemctl poweroff/reboot/suspend via logind). ──
// SteamOS runs logind, which lets the active session's user issue poweroff/reboot/suspend without root
// (the standard polkit policy for a logged-in seat — Р9). No `--no-wall`/root needed; `systemctl` is on
// PATH. Rejects propagate to PowerService, which surfaces the error copy and does NOT quit.
function createPowerBackend(): PowerBackend {
  return {
    supported: true,
    async run(action): Promise<void> {
      const verb = action === 'shutdown' ? 'poweroff' : 'reboot';
      await execFileAsync('systemctl', [verb]);
    },
    async suspend(): Promise<void> {
      await execFileAsync('systemctl', ['suspend']);
    },
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
