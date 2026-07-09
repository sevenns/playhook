// Keeps the display awake while the launcher owns the session (on screen, or a game running), so the
// screensaver / display-sleep don't kick in. Interface-DI (like PowerService / UpdaterService): the
// Electron powerSaveBlocker is injected, so this module is pure/electron-free on import and unit-testable
// in vitest without electron (see test/keep-awake.test.ts). main.ts bootstraps it with the real deps
// (electron.powerSaveBlocker) and drives setActive from the keep-awake recompute.
//
// We deliberately use 'prevent-display-sleep' (NOT 'prevent-app-suspension'): only the former holds the
// DISPLAY (it maps to SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED) on Windows), which is
// what actually stops the screen from blanking. The blocker is idempotent here via the stored blockerId.
import { log } from './logger';

export interface KeepAwakeDeps {
  /** Starts a display-sleep blocker, returns its id (real: powerSaveBlocker.start('prevent-display-sleep')). */
  readonly start: () => number;
  /** Stops the blocker with the given id (real: powerSaveBlocker.stop). */
  readonly stop: (id: number) => void;
  /** Whether the blocker id is currently active (real: powerSaveBlocker.isStarted). */
  readonly isStarted: (id: number) => boolean;
}

export interface KeepAwakeService {
  /** Idempotently starts (active=true) / stops (active=false) the single display blocker. */
  setActive(active: boolean): void;
  /** Stops the blocker if active; a no-op when nothing is held (safe to call twice on quit). */
  dispose(): void;
}

export function createKeepAwakeService(deps: KeepAwakeDeps): KeepAwakeService {
  // The single held blocker id, or null when nothing is active. All transitions go through here so a
  // double start/stop can't leak or double-free a blocker.
  let blockerId: number | null = null;

  function setActive(active: boolean): void {
    if (active) {
      if (blockerId !== null && deps.isStarted(blockerId)) return; // already holding
      blockerId = deps.start();
      log.info(`[keep-awake] display blocker started id=${blockerId}`);
      return;
    }
    if (blockerId === null) return; // nothing to stop
    if (deps.isStarted(blockerId)) deps.stop(blockerId);
    log.info(`[keep-awake] display blocker stopped id=${blockerId}`);
    blockerId = null;
  }

  function dispose(): void {
    // On null this is a pure no-op — the double call from quit() + before-quit is safe.
    if (blockerId === null) return;
    setActive(false);
  }

  return { setActive, dispose };
}
