// macOS GameProcessLauncher: run a NATIVE mac game — a bare mach-o binary or a `.app` bundle.
//
// A `.app` is a directory, so it cannot be spawned; the real binary at `Contents/MacOS/<CFBundleExecutable>`
// is resolved first and spawned directly. `open -a` would be the obvious alternative and is deliberately
// NOT used: it returns immediately and hands back the pid of `open`, not of the game, which would break the
// pid tracking the whole launch flow is built on.
//
// What this launcher REFUSES, each with its own message rather than a generic failure:
//  • a Windows `*.exe` — the card is cross-platform, macOS is not (Wine/CrossOver is out of scope);
//  • install mode — `resolveInstallDir` is null on darwin, so an install-mode card never resolves anyway;
//  • a Gatekeeper-blocked binary — a quarantined game downloaded from the internet is SIGKILLed by
//    syspolicyd with no UI at all, so an instant death right after spawn is reported as what it is.
import { spawn } from 'node:child_process';
import type { GameProcessLauncher, ProcessMonitor } from './types';
import type { GameProcess } from '../game-launcher';
import type { Translator } from '../../shared/i18n/index';
import { isAppBundlePath, resolveAppBundleExecutable } from './app-bundle.darwin';
import { delay } from '../util';
import { log } from '../logger';

/**
 * How long a freshly spawned game is watched for the instant, UI-less SIGKILL that Gatekeeper delivers to a
 * quarantined binary. Only the RESOLVE of the launch is delayed by this, never the game itself; a real
 * game is still alive when the window closes.
 */
const GATEKEEPER_PROBE_MS = 500;

/** Dependencies the darwin launcher closes over (the shared ProcessMonitor + the live translator). */
export interface DarwinGameLauncherDeps {
  /** The `ps` ProcessMonitor — used for liveness and the force-kill tree. */
  readonly monitor: ProcessMonitor;
  /** The live translator (read per call so a language change applies to the next refusal). */
  readonly getTranslator: () => Translator;
}

/** Whether a launch target is a Windows executable (which macOS cannot run — see the header). */
function isWindowsExecutable(target: string): boolean {
  return /\.exe$/i.test(target);
}

/**
 * Spawns a native mac binary and wraps it as a GameProcess. `detached: false` + `unref()` mirrors the win32
 * normal path: the child is not tied to our event loop, and tracking happens by pid through the monitor.
 *
 * The one darwin-specific step is the Gatekeeper probe: the promise resolves only after a short window, so
 * a binary that syspolicyd killed on sight becomes a targeted error instead of a launch that silently never
 * starts (the caller would otherwise wait out `launchTimeoutSec` and report a generic timeout).
 */
function spawnGameProcess(
  file: string,
  args: readonly string[],
  cwd: string,
  deps: DarwinGameLauncherDeps,
): Promise<GameProcess> {
  return new Promise<GameProcess>((resolve, reject) => {
    const child = spawn(file, [...args], { cwd, detached: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      if (typeof child.pid !== 'number') {
        reject(new Error('process started without a pid'));
        return;
      }
      const pid = child.pid;
      child.removeListener('error', reject);
      let exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null;
      child.once('exit', (code, signal) => {
        exit = { code, signal };
      });
      child.unref();
      void delay(GATEKEEPER_PROBE_MS).then(() => {
        // A quarantined/unsigned binary is killed by syspolicyd within milliseconds, and specifically with
        // SIGKILL. SIGKILL alone, not "any signal": a game that crashes on its own dies by SIGSEGV/SIGBUS
        // /SIGABRT, and blaming Gatekeeper for that sends the user off to fix a security setting that was
        // never in the way. Anything else is left to the normal "did not start" path.
        if (exit !== null && exit.signal === 'SIGKILL') {
          log.warn(`[launch] "${file}" was SIGKILLed on start — Gatekeeper?`);
          reject(new Error(deps.getTranslator()('errors.macGameBlocked', { path: file })));
          return;
        }
        resolve({
          pid,
          isAlive: () => (exit !== null ? Promise.resolve(false) : deps.monitor.isPidAlive(pid)),
          kill: async () => {
            // Reused-pid guard, as on win32: `running` outlives the real process by the exit debounce, so
            // only kill while the pid is still ours.
            if (await deps.monitor.isPidAlive(pid)) await deps.monitor.killTree(pid);
          },
          dispose: () => {},
        });
      });
    });
  });
}

/** Builds the macOS GameProcessLauncher. */
export function createDarwinGameLauncher(deps: DarwinGameLauncherDeps): GameProcessLauncher {
  /** The refusal shared by every install-mode entry point (install mode is unsupported on macOS). */
  const refuseInstall = (): never => {
    throw new Error(deps.getTranslator()('errors.macInstallUnsupported'));
  };
  return {
    async launchGame(manifest): Promise<GameProcess> {
      const t = deps.getTranslator();
      if (manifest.raw.runAsAdmin) {
        // Symmetric with linux: there is no elevation to ask for here, and refusing would break a
        // legitimate two-platform card that sets runAsAdmin for its Windows side.
        log.warn(`[launch] runAsAdmin ignored on macOS (no elevation) id=${manifest.raw.id}`);
      }
      const target = manifest.executablePath;
      if (isWindowsExecutable(target)) {
        throw new Error(t('errors.macWindowsGame'));
      }
      let file = target;
      if (isAppBundlePath(target)) {
        const resolved = await resolveAppBundleExecutable(target);
        if (resolved === null) {
          throw new Error(t('errors.macAppBundleUnreadable', { path: target }));
        }
        file = resolved;
        log.info(`[launch] app bundle "${target}" → "${file}"`);
      }
      log.info(`[launch] spawn id=${manifest.raw.id} exe="${file}"`);
      return spawnGameProcess(file, manifest.raw.args, manifest.cwd, deps);
    },
    // Install mode is out of scope on macOS: Windows installers cannot run, and `resolveInstallDir` returns
    // null so an install-mode card is already rejected at manifest-read. These stay total and explicit.
    launchInstaller: () => refuseInstall(),
    prepareInstallDir: () => refuseInstall(),
    launchUninstaller: () => refuseInstall(),
    // Never reached (install mode never resolves on darwin); returns the same dir win32 would, so the
    // interface stays total rather than throwing from a getter-shaped method.
    uninstallDir: (install) => install.dir,
    // No Wine prefix on macOS — a game runs directly and leaves nothing of ours to clean up.
    prefixCleanupDir: () => Promise.resolve(null),
  };
}
