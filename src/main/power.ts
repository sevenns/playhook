// Power actions for the launcher's Shutdown/Reboot/Sleep menu. Interface-DI (like StatsService /
// UpdaterService): the OS-touching bits are delegated to the platform PowerBackend (win32 `shutdown` +
// powrprof FFI; linux `systemctl` via logind — Р9), and the app quit + error channel are injected, so
// this module is pure/electron/koffi-free on import and unit-testable in vitest with a fake backend (see
// test/power.test.ts). main.ts bootstraps it with the real backend and registers the IPC channels (NOT
// GameController — power isn't part of the game flow).
//
// The renderer confirms each action (Yes/No) BEFORE sending the IPC, so main runs the action here with
// no further prompt.
import type { Translator } from '../shared/i18n/index';
import type { PowerBackend } from './platform';
import { log } from './logger';
import { describe } from './util';

export type PowerAction = 'shutdown' | 'reboot' | 'sleep';

export interface PowerServiceDeps {
  /** OS backend for the actual power commands (platform.powerBackend). `supported=false` → we surface
   *  "unsupported" instead of running anything, replacing the old win32-only guard (Р9). */
  readonly backend: PowerBackend;
  /** Quits the app after a successful shutdown/reboot (real: the bootstrap quit(), which drops close-guards). */
  quit(): void;
  /** Surfaces a user-facing error in the launcher's error popup (real: send IPC.errorShow). */
  showError(message: string): void;
  /** Live translator for the error copy. */
  getTranslator(): Translator;
}

export interface PowerService {
  /** Performs a power action: shutdown/reboot run the backend then quit; sleep suspends in place. */
  perform(action: PowerAction): Promise<void>;
}

export function createPowerService(deps: PowerServiceDeps): PowerService {
  const t = (): Translator => deps.getTranslator();

  async function perform(action: PowerAction): Promise<void> {
    // Platform-guard via the backend: an unsupported platform (no PowerBackend commands) logs and surfaces
    // an error instead of running anything, exactly as the old win32-only guard did.
    if (!deps.backend.supported) {
      log.warn(`[power] ${action} requested but power actions are unsupported on this platform`);
      deps.showError(t()('errors.powerUnsupported'));
      return;
    }
    try {
      if (action === 'sleep') {
        // Sleep suspends the machine in place — no app exit (the launcher is simply there on wake).
        await deps.backend.suspend();
        return;
      }
      // shutdown / reboot: the backend chooses the OS command (win32 `shutdown /s|/r`; linux `systemctl
      // poweroff|reboot`). Resolves once the OS has accepted the request.
      await deps.backend.run(action);
      // Quit ourselves once the OS has accepted the request: before-quit (main.ts) drops the window
      // hide-on-close guard, so our own preventDefault can't block the OS shutdown.
      deps.quit();
    } catch (cause) {
      log.warn(`[power] ${action} failed:`, describe(cause));
      deps.showError(t()('errors.powerFailed', { cause: describe(cause) }));
    }
  }

  return { perform };
}
