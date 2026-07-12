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
import {
  prefixDir,
  prefixForInstall,
  pendingWinetricks,
  buildUmuEnv,
  buildUmuArgs,
  DEFAULT_PROTON,
} from './umu';
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

// ── Proton debug logging (opt-in via PLAYHOOK_PROTON_LOG) ────────────────────
// When the env var is set at app launch, every umu run gets PROTON_LOG=1 pointing at
// `<userData>/proton-logs`; after each run we log the file path + a tail into the app log, so a crash can
// be diagnosed straight from the app's own logs without a manual terminal repro. Off by default (PROTON_LOG
// is heavy — it slows the game and produces large files).

/** The Proton debug-log dir when PLAYHOOK_PROTON_LOG is set, else undefined (feature off). */
function protonLogDir(userData: string): string | undefined {
  const flag = process.env['PLAYHOOK_PROTON_LOG'];
  if (flag === undefined || flag === '' || flag === '0') return undefined;
  return path.join(userData, 'proton-logs');
}

/** Ensures the Proton-log dir exists (Proton won't create PROTON_LOG_DIR itself). No-op when off. */
async function ensureLogDir(logDir: string | undefined): Promise<void> {
  if (logDir !== undefined) await fse.ensureDir(logDir);
}

/**
 * After a umu run exits, finds the newest `*.log` Proton wrote in `logDir` and logs its path plus a tail
 * into the app log. Best-effort: any error is a warned no-op (the primary launch outcome is unaffected).
 * Called only when Proton logging is enabled (env carries PROTON_LOG_DIR).
 */
async function collectProtonLog(logDir: string): Promise<void> {
  try {
    const names = (await fse.readdir(logDir)).filter((name) => name.endsWith('.log'));
    let newest: { readonly path: string; readonly mtimeMs: number } | null = null;
    for (const name of names) {
      const full = path.join(logDir, name);
      const stat = await fse.stat(full);
      if (newest === null || stat.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: stat.mtimeMs };
    }
    if (newest === null) return;
    const tail = (await fse.readFile(newest.path, 'utf8')).slice(-UMU_OUTPUT_TAIL_BYTES);
    log.info(`[umu] Proton debug log: ${newest.path}\n--- proton log tail ---\n${tail.trim()}`);
  } catch (cause) {
    log.warn(`[umu] failed to collect Proton debug log: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
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
        // Opt-in: pull Proton's own verbose log (its path was set in the env by buildUmuEnv) into ours.
        const logDir = env['PROTON_LOG_DIR'];
        if (logDir !== undefined && logDir !== '') void collectProtonLog(logDir);
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

// ── Prefix dependency provisioning (Р7b) ─────────────────────────────────────
// Before an installer runs, its Wine prefix gets a baseline set of runtimes (mfc42/gdiplus/vcrun/…) plus
// any card-specific extras, via `umu-run winetricks`. A skinned Inno installer (isskin.dll) fails to load
// on a bare prefix without these; games in the same prefix benefit too. Idempotent: the applied verbs are
// recorded in a per-prefix sentinel so re-installs skip the (slow) step; the winetricks DOWNLOADS are
// globally cached by winetricks, so a new prefix re-applies without re-downloading.

/** Per-prefix marker file listing the winetricks verbs already provisioned (newline-separated). */
const WINETRICKS_SENTINEL = '.playhook-winetricks';

/** Reads the verbs already provisioned in `prefix` (empty if the sentinel is missing/unreadable). */
async function readDoneVerbs(prefix: string): Promise<string[]> {
  try {
    const text = await fse.readFile(path.join(prefix, WINETRICKS_SENTINEL), 'utf8');
    return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return []; // missing sentinel = nothing provisioned yet (normal first install)
  }
}

/**
 * Spawns `python3 umu-run winetricks -q <verbs…>` and resolves true on a clean exit, false otherwise
 * (best-effort — a failure is logged and the install proceeds; the installer then either finds the
 * runtimes already present or fails with its own error). Awaits completion, keeping only an output tail.
 */
function runWinetricks(
  umuRunPath: string,
  prefix: string,
  verbs: readonly string[],
  logDir: string | undefined,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const env = buildUmuEnv(process.env, { prefix, proton: DEFAULT_PROTON, protonLogDir: logDir });
    const child = spawn('python3', [umuRunPath, 'winetricks', '-q', ...verbs], {
      cwd: prefix,
      env,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let outputTail = '';
    const capture = (chunk: unknown): void => {
      outputTail = (outputTail + String(chunk)).slice(-UMU_OUTPUT_TAIL_BYTES);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', (err) => {
      log.warn(`[install] winetricks spawn failed: ${err.message}`);
      resolve(false);
    });
    child.once('exit', (code) => {
      if (logDir !== undefined) void collectProtonLog(logDir);
      if (code === 0 || code === null) {
        resolve(true);
        return;
      }
      log.warn(`[install] winetricks exited code=${code} — output tail:\n${outputTail.trim()}`);
      resolve(false);
    });
  });
}

/**
 * Ensures the baseline + card-`extra` winetricks verbs are provisioned in `prefix` (Р7b). Idempotent via
 * the per-prefix sentinel; a no-op when everything is already applied. Best-effort: a winetricks failure
 * is logged and provisioning does NOT record success (so the next attempt retries), but the install is
 * allowed to proceed regardless (chosen behaviour — the installer surfaces its own error if deps are
 * truly missing). Needs network the first time (like the GE-Proton download), same as game launch in Э4.
 */
async function ensurePrefixDeps(
  umuRunPath: string,
  prefix: string,
  extra: readonly string[],
  logDir: string | undefined,
  onProvisioning?: (active: boolean) => void,
): Promise<void> {
  const done = await readDoneVerbs(prefix);
  const pending = pendingWinetricks(extra, done);
  if (pending.length === 0) return; // nothing to do → no "Configuring Proton" status
  // Signal the provisioning window ONLY when winetricks actually runs (Р7g). `finally` guarantees the
  // status is torn down even if the run throws, so the launch screen never gets stuck on it.
  onProvisioning?.(true);
  try {
    log.info(`[install] provisioning prefix winetricks: ${pending.join(' ')}`);
    const ok = await runWinetricks(umuRunPath, prefix, pending, logDir);
    if (!ok) {
      log.warn('[install] winetricks provisioning failed — proceeding; installer may fail on missing runtimes');
      return;
    }
    // Persist the union of previously-done and newly-applied verbs so re-installs skip this step.
    const union = [...new Set([...done, ...pending])];
    try {
      await fse.writeFile(path.join(prefix, WINETRICKS_SENTINEL), `${union.join('\n')}\n`);
    } catch (cause) {
      // Non-fatal: without the sentinel the next install re-runs winetricks (idempotent, just slower).
      log.warn(`[install] failed to write winetricks sentinel: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  } finally {
    onProvisioning?.(false);
  }
}

/** Builds the linux GameProcessLauncher (umu-run / Proton). */
export function createLinuxGameLauncher(deps: LinuxGameLauncherDeps): GameProcessLauncher {
  return {
    async launchGame(manifest, onProvisioning): Promise<GameProcess> {
      if (manifest.raw.runAsAdmin) {
        // Р6: there is no elevation under Proton — everything runs as the user. Ignore rather than reject,
        // so a legitimate two-platform card (runAsAdmin for Windows) still launches on Linux.
        log.warn(`[launch] runAsAdmin ignored on Linux (no elevation under Proton) id=${manifest.raw.id}`);
      }
      await ensurePython3();
      const prefix = prefixDir(deps.userData, manifest.raw.id);
      await fse.ensureDir(prefix);
      const logDir = protonLogDir(deps.userData);
      await ensureLogDir(logDir);
      // Р7b: provision the game's own winetricks verbs (baseline + card `winetricks`) before launch — only
      // when the card lists any, so an ordinary game with no verbs launches unchanged (no extra step).
      if (manifest.raw.winetricks.length > 0) {
        await ensurePrefixDeps(deps.umuRunPath, prefix, manifest.raw.winetricks, logDir, onProvisioning);
      }
      const env = buildUmuEnv(process.env, { prefix, proton: DEFAULT_PROTON, protonLogDir: logDir });
      const args = buildUmuArgs(deps.umuRunPath, manifest.executablePath, manifest.raw.args);
      log.info(`[launch] umu-run id=${manifest.raw.id} prefix="${prefix}" exe="${manifest.executablePath}"`);
      return spawnUmuProcess(args, manifest.cwd, env, deps.monitor);
    },
    // Install mode (Р7): run the card's installer .exe through umu-run in the game's Wine prefix, feeding
    // it the app-controlled dir via the family's silent dir-key (unquoted on linux — see buildInstallerArgs).
    // cwd is the installer's own folder on the card (host path); the install dir may not exist yet (the
    // installer creates it, and the controller pre-cleaned it). runAsAdmin is ignored (no elevation — Р6).
    async launchInstaller(install, silent, onProvisioning): Promise<GameProcess> {
      if (install.runAsAdmin) {
        log.warn('[install] runAsAdmin ignored on Linux (no elevation under Proton)');
      }
      await ensurePython3();
      // The prefix that makes `install.installerDir` (C:\…) map onto `install.dir` (the host dir).
      const prefix = prefixForInstall(install.dir);
      await fse.ensureDir(prefix);
      const logDir = protonLogDir(deps.userData);
      await ensureLogDir(logDir);
      // Р7b: provision the runtimes the installer/game need (baseline + card extras) before it runs.
      // Also initializes the prefix (first `umu-run` here does the Proton upgrade), so the installer
      // launches into a ready environment.
      await ensurePrefixDeps(deps.umuRunPath, prefix, install.winetricks, logDir, onProvisioning);
      const env = buildUmuEnv(process.env, { prefix, proton: DEFAULT_PROTON, protonLogDir: logDir });
      // silent:false drops the silent flags → Proton shows the installer's wizard (no windowsHide concept
      // on linux — umu surfaces the Wine window whenever the installer isn't running silently).
      const installerArgs = buildInstallerArgs(install.type, install.installerDir, install.args, false, silent);
      const args = buildUmuArgs(deps.umuRunPath, install.installerPath, installerArgs);
      const cwd = path.dirname(install.installerPath);
      log.info(
        `[install] umu-run installer silent=${silent} prefix="${prefix}" installer="${install.installerPath}" dir="${install.installerDir}"`,
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
      const logDir = protonLogDir(deps.userData);
      await ensureLogDir(logDir);
      const env = buildUmuEnv(process.env, { prefix, proton: DEFAULT_PROTON, protonLogDir: logDir });
      const args = buildUmuArgs(deps.umuRunPath, target.file, target.args);
      log.info(`[uninstall] umu-run uninstaller prefix="${prefix}" file="${target.file}"`);
      return spawnUmuProcess(args, target.cwd, env, deps.monitor);
    },
    // Р7f: uninstall removes the WHOLE per-game prefix (it contains the install dir + the game's runtimes),
    // reclaiming the full disk footprint — not just the game files under drive_c/playhook/games/<id>.
    uninstallDir: (install) => prefixForInstall(install.dir),
  };
}
