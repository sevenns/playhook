// Gamepad polling in the renderer.
// HTML5 Gamepad API + requestAnimationFrame loop, standard mapping.
// Navigation: D-pad Left/Right (buttons[14]/[15]) or left-stick X (axes[0]) for the bar; D-pad
// Up/Down (buttons[12]/[13]) or left-stick Y (axes[1]) for the vertical stacks and the Settings list.
// A = buttons[0] (activate focused control), B = buttons[1] (back / close popup),
// Y = buttons[3] (hand the focus between the carousel strip and the bar — see controls.ts).
// We fire on the press EDGE (false→true) so one press / one stick tilt = one action.

export interface GamepadController {
  start(): void;
  stop(): void;
  /** Pauses/resumes ACTING on input while keeping the poll alive: paused, presses are read (so button
   * state stays in sync — no phantom edge fires on resume) but no handler runs. Used to ignore gamepad
   * while the launcher is backgrounded (a game is on top). */
  setPaused(paused: boolean): void;
}

export interface GamepadHandlers {
  readonly onLeft: (repeat: boolean) => void;
  /** `repeat` marks a press produced by the hold auto-repeat rather than by a fresh press — the two mean
   *  different things where a stop is also a step (see navRight in controls.ts). */
  readonly onRight: (repeat: boolean) => void;
  readonly onUp: (repeat: boolean) => void;
  readonly onDown: (repeat: boolean) => void;
  readonly onA: () => void;
  readonly onB: () => void;
  readonly onY: () => void;
  /** Every direction has just gone up — the edge, fired once, not on every idle frame. What ends a hold
   *  for consumers that treat holding as a state rather than as a stream of presses. */
  readonly onDirectionsReleased: () => void;
}

const BTN = { a: 0, b: 1, y: 3, dpadUp: 12, dpadDown: 13, dpadLeft: 14, dpadRight: 15 } as const;
const STICK_X_AXIS = 0;
const STICK_Y_AXIS = 1;
const STICK_DEADZONE = 0.5;
/**
 * How long a direction stays deaf to the STICK after the opposite one is released. A thumbstick springs
 * back through centre and overshoots past the deadzone on the far side, which the edge detector reads as
 * a deliberate press the other way — one step down, then an instant step back up. The d-pad is exempt:
 * it has no spring, and gating it would eat honest quick reversals.
 */
const STICK_SETTLE_MS = 140;

/** How long a direction must be HELD before the auto-repeat kicks in (a normal press stays one move). */
const HOLD_DELAY_MS = 350;
/** The auto-repeat's own cadence once it has kicked in. Shared with the keyboard, whose OS repeat rate is
 *  far faster than anything usable here — see controls.ts. */
export const NAV_REPEAT_MS = 110;

export function createGamepadController(handlers: GamepadHandlers): GamepadController {
  let rafId = 0;
  let running = false;
  let paused = false;
  const prev = { left: false, right: false, up: false, down: false, a: false, b: false, y: false };
  // Auto-repeat bookkeeping. Horizontal: holding left/right flips through the carousel, where running
  // down a 40-game history one press at a time is the thing to avoid. Vertical: the same for the long
  // Settings list — the repeat is DELIVERED for up/down too, and the consumer decides whether it applies
  // (controls.ts drops it outside the Settings screen, where the popup stacks are short and cyclic).
  const heldSince = { left: 0, right: 0, up: 0, down: 0 };
  const lastFire = { left: 0, right: 0, up: 0, down: 0 };
  // The stick's own previous state per direction, and the moment each one was RELEASED (the edge, not
  // every idle frame — timing it from "currently centred" would leave both directions of an axis
  // permanently gating each other). The clock STICK_SETTLE_MS runs from for the opposite direction.
  const stickPrev = { left: false, right: false, up: false, down: false };
  const stickReleasedAt = {
    left: Number.NEGATIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    up: Number.NEGATIVE_INFINITY,
    down: Number.NEGATIVE_INFINITY,
  };

  const isDown = (index: number): boolean => {
    for (const pad of navigator.getGamepads()) {
      if (pad === null) continue;
      const button = pad.buttons[index];
      if (button !== undefined && button.pressed) return true;
    }
    return false;
  };

  const axis = (index: number): number => {
    for (const pad of navigator.getGamepads()) {
      if (pad === null) continue;
      const value = pad.axes[index];
      if (typeof value === 'number' && Math.abs(value) > STICK_DEADZONE) return value;
    }
    return 0;
  };

  /**
   * One horizontal direction, with hold-to-repeat: fires on the press edge as before, then — once the
   * direction has been held for HOLD_DELAY_MS — again every NAV_REPEAT_MS for as long as it stays down.
   * Releasing resets the clock, so a quick tap is still exactly one move.
   *
   * `heldSince === 0` means "not counting yet": that is the released state, and also what a pause leaves
   * behind, so a direction held across a resume starts its delay from scratch and doesn't burst.
   */
  const stepHeld = (
    dir: 'left' | 'right' | 'up' | 'down',
    down: boolean,
    fire: (repeat: boolean) => void,
  ): void => {
    if (!down) {
      heldSince[dir] = 0;
      return;
    }
    const now = performance.now();
    if (!prev[dir] || heldSince[dir] === 0) {
      heldSince[dir] = now;
      lastFire[dir] = now;
      if (!prev[dir]) fire(false); // an edge; resuming onto a held direction is not one
      return;
    }
    if (now - heldSince[dir] < HOLD_DELAY_MS || now - lastFire[dir] < NAV_REPEAT_MS) return;
    lastFire[dir] = now;
    fire(true);
  };

  type Dir = 'left' | 'right' | 'up' | 'down';
  const OPPOSITE: Readonly<Record<Dir, Dir>> = {
    left: 'right',
    right: 'left',
    up: 'down',
    down: 'up',
  };

  /**
   * Whether `dir` is pressed, with the spring-back guard applied: a STICK deflection is ignored while the
   * opposite direction's own release is still settling. A d-pad press always counts.
   */
  const pressed = (dir: Dir, dpad: boolean, stick: boolean, now: number): boolean => {
    if (stickPrev[dir] && !stick) stickReleasedAt[dir] = now; // the release EDGE starts the clock
    stickPrev[dir] = stick;
    if (dpad) return true;
    if (!stick) return false;
    return now - stickReleasedAt[OPPOSITE[dir]] >= STICK_SETTLE_MS;
  };

  const poll = (): void => {
    if (!running) return;
    const x = axis(STICK_X_AXIS);
    const y = axis(STICK_Y_AXIS);
    const now = performance.now();
    const left = pressed('left', isDown(BTN.dpadLeft), x < -STICK_DEADZONE, now);
    const right = pressed('right', isDown(BTN.dpadRight), x > STICK_DEADZONE, now);
    // Standard mapping: stick Y is +down / -up.
    const up = pressed('up', isDown(BTN.dpadUp), y < -STICK_DEADZONE, now);
    const down = pressed('down', isDown(BTN.dpadDown), y > STICK_DEADZONE, now);
    const a = isDown(BTN.a);
    const b = isDown(BTN.b);
    const yButton = isDown(BTN.y);

    // While paused (launcher backgrounded), read inputs but don't act — prev is still updated below, so a
    // button held across resume won't fire a phantom edge.
    if (!paused) {
      stepHeld('left', left, handlers.onLeft);
      stepHeld('right', right, handlers.onRight);
      stepHeld('up', up, handlers.onUp);
      stepHeld('down', down, handlers.onDown);
      if (a && !prev.a) handlers.onA();
      if (b && !prev.b) handlers.onB();
      if (yButton && !prev.y) handlers.onY();
    } else {
      // Paused: forget any hold in progress, so resuming can't drop straight into a repeat burst.
      heldSince.left = 0;
      heldSince.right = 0;
      heldSince.up = 0;
      heldSince.down = 0;
    }

    // The release edge, reported whether or not we are acting on input: a pause must not leave a consumer
    // believing a direction is still held (the launcher is backgrounded — nothing is being flipped).
    if ((prev.left || prev.right || prev.up || prev.down) && !(left || right || up || down)) {
      handlers.onDirectionsReleased();
    }

    prev.left = left;
    prev.right = right;
    prev.up = up;
    prev.down = down;
    prev.a = a;
    prev.b = b;
    prev.y = yButton;
    rafId = requestAnimationFrame(poll);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      rafId = requestAnimationFrame(poll);
    },
    stop(): void {
      running = false;
      cancelAnimationFrame(rafId);
    },
    setPaused(value: boolean): void {
      paused = value;
    },
  };
}
