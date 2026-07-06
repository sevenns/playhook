// Power actions for the launcher's Shutdown/Reboot/Sleep menu. Interface-DI (like StatsService /
// UpdaterService): the OS-touching bits — the `shutdown` command, the sleep FFI, the app quit and the
// error channel — are all injected, so this module is pure/electron/koffi-free on import and unit-
// testable in vitest without Windows (see test/power.test.ts). main.ts bootstraps it with the real
// deps and registers the IPC channels (NOT GameController — power isn't part of the game flow).
//
// The renderer confirms each action (Yes/No) BEFORE sending the IPC, so main runs the action here with
// no further prompt.
import type { Translator } from '../shared/i18n/index';
import { log } from './logger';
import { describe } from './util';

export type PowerAction = 'shutdown' | 'reboot' | 'sleep';

export interface PowerServiceDeps {
  /** process.platform, injected so a unit test drives the win32 / non-win32 branch without a real OS. */
  readonly platform: NodeJS.Platform;
  /** Runs a shell-less command (real: promisified execFile); rejects on a non-zero exit. */
  exec(file: string, args: readonly string[]): Promise<void>;
  /** Puts the PC to sleep via powrprof SetSuspendState (real: power-native.suspendToSleep). Throws on failure. */
  suspend(): void;
  /** Quits the app after a successful shutdown/reboot (real: the bootstrap quit(), which drops close-guards). */
  quit(): void;
  /** Surfaces a user-facing error in the launcher's error popup (real: send IPC.errorShow). */
  showError(message: string): void;
  /** Live translator for the error copy. */
  getTranslator(): Translator;
}

export interface PowerService {
  /** Performs a power action: shutdown/reboot run `shutdown` then quit; sleep suspends in place. */
  perform(action: PowerAction): Promise<void>;
}

export function createPowerService(deps: PowerServiceDeps): PowerService {
  const t = (): Translator => deps.getTranslator();

  async function perform(action: PowerAction): Promise<void> {
    // Platform-guard, mirroring resolveUninstaller (ipc.ts): off Windows we log and surface an error
    // instead of running anything — the `shutdown` command and the powrprof FFI are Windows-only.
    if (deps.platform !== 'win32') {
      log.warn(`[power] ${action} requested on ${deps.platform} — power actions are Windows-only`);
      deps.showError(t()('errors.powerUnsupported'));
      return;
    }
    try {
      if (action === 'sleep') {
        // Sleep suspends the machine in place — no app exit (the launcher is simply there on wake).
        deps.suspend();
        return;
      }
      // shutdown /s (power off) or /r (restart), immediate (/t 0). The command choice lives here so a
      // unit test can assert it. `shutdown` is on PATH (System32).
      const flag = action === 'shutdown' ? '/s' : '/r';
      await deps.exec('shutdown', [flag, '/t', '0']);
      // Quit ourselves once Windows has accepted the request: before-quit (main.ts) drops the window
      // hide-on-close guard, so our own preventDefault can't block the OS shutdown.
      deps.quit();
    } catch (cause) {
      log.warn(`[power] ${action} failed:`, describe(cause));
      deps.showError(t()('errors.powerFailed', { cause: describe(cause) }));
    }
  }

  return { perform };
}
