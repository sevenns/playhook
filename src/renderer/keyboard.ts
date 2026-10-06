// Keyboard navigation (Desktop Mode / no gamepad): WASD + arrows move, Space/Enter activate, Tab/Backspace
// (and Esc) step back — the SAME six primitives as the gamepad (gamepad.ts), so the two input models stay
// in lockstep; controls.ts owns the primitives and hands them to both.
// No key of its own for "go to More": on home, back has nothing above it to return to, so it doubles as
// that toggle (see navBack in controls.ts) and Tab / Esc / B all reach the button.
// Edge-only (event.repeat ignored) to match the gamepad's one-move-per-press feel. preventDefault stops
// the browser default (Tab focus traversal, Space scroll / native button press, arrow scroll) from firing
// alongside our custom navigation. A backgrounded launcher doesn't receive keydown (the OS routes keys to
// the focused window), so — unlike the Gamepad API — no explicit pause is needed here.
import { HOLD_DELAY_MS, NAV_REPEAT_MS, type AutoRepeatChain } from './auto-repeat.js';

export interface KeyboardHandlers {
  readonly onLeft: (repeat: boolean) => void;
  readonly onRight: (repeat: boolean) => void;
  readonly onUp: (repeat: boolean) => void;
  readonly onDown: (repeat: boolean) => void;
  readonly onActivate: () => void;
  readonly onBack: () => void;
  /** A held direction went up (or the window lost it mid-hold) — what ends a hold, as on the pad. */
  readonly onDirectionsReleased: () => void;
}

export interface KeyboardDeps {
  /**
   * The boot fence, as a full return rather than a gated call: the repeat timer armed on a press outlives
   * the boot screen, so a direction merely GATED at dispatch would come back to life the moment the UI
   * appeared and flip the row for a press made before it existed.
   */
  isFenced(): boolean;
}

/** Listens on `window` from the moment it is created — there is nothing to start, unlike the pad's polling. */
export function createKeyboardController(
  handlers: KeyboardHandlers,
  chain: AutoRepeatChain,
  deps: KeyboardDeps,
): void {
  const KEY_NAV: Readonly<Record<string, (repeat: boolean) => void>> = {
    a: handlers.onLeft,
    arrowleft: handlers.onLeft,
    d: handlers.onRight,
    arrowright: handlers.onRight,
    w: handlers.onUp,
    arrowup: handlers.onUp,
    s: handlers.onDown,
    arrowdown: handlers.onDown,
    ' ': handlers.onActivate,
    enter: handlers.onActivate,
    tab: handlers.onBack,
    backspace: handlers.onBack,
    escape: handlers.onBack,
  };
  // The four directions are the exception to the edge model: holding one flips through the carousel,
  // runs down the Settings list or through a popup stack, matching the gamepad's hold-to-repeat. The
  // repeat is OURS, on a timer — the OS supplies its
  // own, but at a rate and an initial delay that are the user's system settings, not ours, so the two
  // input models would drift apart (and chaining one run into the next would be impossible: the OS
  // restarts its full delay on every new key). Native repeats are dropped. Every other key stays one
  // action per press.
  const REPEATABLE_KEYS = new Set([
    'a',
    'arrowleft',
    'd',
    'arrowright',
    'w',
    'arrowup',
    's',
    'arrowdown',
  ]);
  // The key whose repeat is running, and its timer. Only one at a time: with two directions down the
  // last one pressed owns the run, which is what a keyboard's own repeat does too.
  let heldKey: string | null = null;
  let keyRepeatTimer = 0;

  function stopKeyRepeat(): void {
    if (keyRepeatTimer !== 0) {
      window.clearTimeout(keyRepeatTimer);
      keyRepeatTimer = 0;
    }
    heldKey = null;
  }

  function scheduleKeyRepeat(key: string, handler: (repeat: boolean) => void, delay: number): void {
    keyRepeatTimer = window.setTimeout(() => {
      keyRepeatTimer = 0;
      if (heldKey !== key) return;
      chain.noteRepeat(performance.now());
      handler(true);
      scheduleKeyRepeat(key, handler, NAV_REPEAT_MS);
    }, delay);
  }

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const handler = KEY_NAV[key];
    if (handler === undefined) return;
    event.preventDefault(); // suppress the native default even on auto-repeat (e.g. Tab traversal)
    if (event.repeat) return; // the OS cadence is not ours — the timer below drives the run
    if (deps.isFenced()) return;
    handler(false);
    if (!REPEATABLE_KEYS.has(key)) return;
    stopKeyRepeat(); // a second direction takes the run over from the first
    heldKey = key;
    // A key taken up while the previous run is still warm continues it, delay skipped — same rule as the
    // pad's (auto-repeat.ts), so swinging left→right glides on either device.
    const now = performance.now();
    scheduleKeyRepeat(key, handler, chain.continues(now) ? NAV_REPEAT_MS : HOLD_DELAY_MS);
  });
  // The keyboard's half of "the hold is over". A keyup can be missed (the window loses focus mid-hold and
  // the release goes to whoever took it), which is what the flip watchdog in controls.ts covers — and the
  // blur below, which also has to stop a timer nobody would otherwise turn off.
  window.addEventListener('keyup', (event) => {
    const key = event.key.toLowerCase();
    if (heldKey === key) stopKeyRepeat();
    if (REPEATABLE_KEYS.has(key)) handlers.onDirectionsReleased();
  });
  window.addEventListener('blur', () => {
    if (heldKey === null) return;
    stopKeyRepeat();
    handlers.onDirectionsReleased();
  });
}
