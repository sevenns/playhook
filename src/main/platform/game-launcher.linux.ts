// Linux GameProcessLauncher: run the card's Windows .exe through umu-launcher / Proton (Р1/Р2). The
// bundled umu-run zipapp is invoked as `python3 <umu-run> <exe> <args…>` in the game's own Wine prefix.
// umu-run stays alive for the whole session, so the launched CHILD is the completion signal (its exit
// event) — no /proc snapshots needed for the plain exe path (Р3); watchProcesses games still track via the
// ProcessMonitor. Install/uninstall through umu land in stage 5 (this launcher rejects them for now).
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fse from 'fs-extra';
import type { GameProcessLauncher, ProcessMonitor } from './types';
import type { GameProcess } from '../game-launcher';
import { prefixDir, buildUmuEnv, buildUmuArgs, DEFAULT_PROTON } from './umu';
import { log } from '../logger';

const execFileAsync = promisify(execFile);

/** Dependencies the linux launcher closes over (resolved from PlatformDeps + the shared ProcessMonitor). */
export interface LinuxGameLauncherDeps {
  /** app.getPath('userData') — base for `<userData>/prefixes/<id>`. */
  readonly userData: string;
  /** Absolute path to the bundled umu-run zipapp. */
  readonly umuRunPath: string;
  /** The /proc ProcessMonitor — used to force-kill the game's process group. */
  readonly monitor: ProcessMonitor;
}

let python3Available = false;

/**
 * Verifies a system python3 is present (the umu zipapp needs it — Р1). SteamOS ships it; on desktop
 * distros it is almost always there. Throws a clear, user-facing error otherwise so the controller can
 * surface it instead of a cryptic spawn failure.
 */
async function ensurePython3(): Promise<void> {
  if (python3Available) return;
  try {
    await execFileAsync('python3', ['--version']);
    python3Available = true;
  } catch {
    throw new Error(
      'python3 was not found — it is required to run Windows games via umu/Proton. Install python3 (it is preinstalled on SteamOS).',
    );
  }
}

/**
 * Spawns `python3 <umu-run> …` and wraps it as a GameProcess. `detached: true` makes umu-run a process-
 * group leader so a force-close can signal the whole group (`-pid`); the child reference is kept (not
 * unref'd) so Node reaps it on exit and `isAlive` tracks that exit event precisely — no zombie, no pid
 * reuse. The kill delegates to the ProcessMonitor's group kill (the by-name sweep in the controller does
 * the rest for processes wineserver re-parented out of the group).
 */
function spawnUmuProcess(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  monitor: ProcessMonitor,
): Promise<GameProcess> {
  return new Promise<GameProcess>((resolve, reject) => {
    const child = spawn('python3', [...args], {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      if (typeof child.pid !== 'number') {
        reject(new Error('umu-run started without a pid'));
        return;
      }
      const pid = child.pid;
      child.removeListener('error', reject);
      let exited = false;
      child.once('exit', () => {
        exited = true;
      });
      resolve({
        pid,
        isAlive: () => Promise.resolve(!exited),
        kill: async () => {
          if (!exited) await monitor.killTree(pid);
        },
        dispose: () => {},
      });
    });
  });
}

/** Builds the linux GameProcessLauncher (umu-run / Proton). */
export function createLinuxGameLauncher(deps: LinuxGameLauncherDeps): GameProcessLauncher {
  return {
    async launchGame(manifest): Promise<GameProcess> {
      if (manifest.raw.runAsAdmin) {
        // Р6: there is no elevation under Proton — everything runs as the user. Ignore rather than reject,
        // so a legitimate two-platform card (runAsAdmin for Windows) still launches on Linux.
        log.warn(`[launch] runAsAdmin ignored on Linux (no elevation under Proton) id=${manifest.raw.id}`);
      }
      await ensurePython3();
      const prefix = prefixDir(deps.userData, manifest.raw.id);
      await fse.ensureDir(prefix);
      const env = buildUmuEnv(process.env, { prefix, proton: DEFAULT_PROTON });
      const args = buildUmuArgs(deps.umuRunPath, manifest.executablePath, manifest.raw.args);
      log.info(`[launch] umu-run id=${manifest.raw.id} prefix="${prefix}" exe="${manifest.executablePath}"`);
      return spawnUmuProcess(args, manifest.cwd, env, deps.monitor);
    },
    // Install / uninstall through Proton is stage 5 — reject clearly until then.
    launchInstaller(): Promise<GameProcess> {
      return Promise.reject(new Error('install mode via Proton is not implemented yet (Proton port stage 5)'));
    },
    launchUninstaller(): Promise<GameProcess> {
      return Promise.reject(new Error('uninstall via Proton is not implemented yet (Proton port stage 5)'));
    },
  };
}
