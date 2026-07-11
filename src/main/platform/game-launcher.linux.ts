// Linux GameProcessLauncher: run the card's Windows .exe through umu-launcher / Proton (Р1/Р2). The
// bundled umu-run zipapp is invoked as `python3 <umu-run> <exe> <args…>` in the game's own Wine prefix.
// umu-run stays alive for the whole session, so the launched CHILD is the completion signal (its exit
// event) — no /proc snapshots needed for the plain exe path (Р3); watchProcesses games still track via the
// ProcessMonitor. Install/uninstall run the same way (Р7): the installer/uninstaller .exe is launched
// through umu-run in the game's OWN Wine prefix, so what it writes to `C:\playhook\games\<id>` lands in
// that prefix's `drive_c` — exactly where the game later launches from.
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fse from 'fs-extra';
import type { GameProcessLauncher, ProcessMonitor } from './types';
import type { GameProcess } from '../game-launcher';
import { prefixDir, prefixForInstall, buildUmuEnv, buildUmuArgs, DEFAULT_PROTON } from './umu';
import { buildInstallerArgs } from '../launch-args';
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
// Cap on the umu/Proton output we retain for diagnostics (last N chars of the combined stream).
const UMU_OUTPUT_TAIL_BYTES = 8192;

function spawnUmuProcess(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  monitor: ProcessMonitor,
): Promise<GameProcess> {
  return new Promise<GameProcess>((resolve, reject) => {
    // Pipe (not ignore) so umu/Proton output is captured for diagnostics — a silent early exit is otherwise
    // undebuggable. We keep only the tail (a game runs for hours; the buffer stays bounded).
    const child = spawn('python3', [...args], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let outputTail = '';
    const capture = (chunk: unknown): void => {
      outputTail = (outputTail + String(chunk)).slice(-UMU_OUTPUT_TAIL_BYTES);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', reject);
    child.once('spawn', () => {
      if (typeof child.pid !== 'number') {
        reject(new Error('umu-run started without a pid'));
        return;
      }
      const pid = child.pid;
      child.removeListener('error', reject);
      let exited = false;
      child.once('exit', (code, signal) => {
        exited = true;
        if (code === 0 || code === null) {
          log.info(`[umu] exited code=${code ?? 'null'} signal=${signal ?? ''}`);
        } else {
          // A non-zero exit (esp. a near-instant one) is a failed launch, not a played session — surface the
          // captured output so the cause is visible (bad Proton, no network for the GE-Proton download, an
          // env conflict, …).
          log.warn(
            `[umu] exited code=${code} signal=${signal ?? ''} — output tail:\n${outputTail.trim()}`,
          );
        }
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
    // Install mode (Р7): run the card's installer .exe through umu-run in the game's Wine prefix, feeding
    // it the app-controlled dir via the family's silent dir-key (unquoted on linux — see buildInstallerArgs).
    // cwd is the installer's own folder on the card (host path); the install dir may not exist yet (the
    // installer creates it, and the controller pre-cleaned it). runAsAdmin is ignored (no elevation — Р6).
    async launchInstaller(install): Promise<GameProcess> {
      if (install.runAsAdmin) {
        log.warn('[install] runAsAdmin ignored on Linux (no elevation under Proton)');
      }
      await ensurePython3();
      // The prefix that makes `install.installerDir` (C:\…) map onto `install.dir` (the host dir).
      const prefix = prefixForInstall(install.dir);
      await fse.ensureDir(prefix);
      const env = buildUmuEnv(process.env, { prefix, proton: DEFAULT_PROTON });
      const installerArgs = buildInstallerArgs(install.type, install.installerDir, install.args, false);
      const args = buildUmuArgs(deps.umuRunPath, install.installerPath, installerArgs);
      const cwd = path.dirname(install.installerPath);
      log.info(
        `[install] umu-run installer prefix="${prefix}" installer="${install.installerPath}" dir="${install.installerDir}"`,
      );
      return spawnUmuProcess(args, cwd, env, deps.monitor);
    },
    // Uninstall (Р7): the target (uninstaller .exe found in the install dir + silent flags) is resolved by
    // the controller; there is no registry fallback on linux. Run it through umu-run in the same prefix.
    async launchUninstaller(target): Promise<GameProcess> {
      if (target.runAsAdmin) {
        log.warn('[uninstall] runAsAdmin ignored on Linux (no elevation under Proton)');
      }
      await ensurePython3();
      // target.cwd is the (host-view) install dir → recover the prefix that owns it.
      const prefix = prefixForInstall(target.cwd);
      await fse.ensureDir(prefix);
      const env = buildUmuEnv(process.env, { prefix, proton: DEFAULT_PROTON });
      const args = buildUmuArgs(deps.umuRunPath, target.file, target.args);
      log.info(`[uninstall] umu-run uninstaller prefix="${prefix}" file="${target.file}"`);
      return spawnUmuProcess(args, target.cwd, env, deps.monitor);
    },
  };
}
