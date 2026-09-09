// The tempo of a HELD direction, shared by both input models: the gamepad polls its own buttons
// (gamepad.ts) while the keyboard runs on timers (controls.ts), but the delay before the auto-move
// starts, its cadence, and the rule for chaining one run into the next must feel identical on both.

/** How long a direction must be HELD before the auto-move kicks in (a normal press stays one move). */
export const HOLD_DELAY_MS = 175;

/** The auto-move's own cadence once it has kicked in. Also what the strip's glide step is derived from. */
export const NAV_REPEAT_MS = 110;

/**
 * How long a finished run stays "warm": a direction pressed within this window continues the previous
 * auto-move instead of starting a new one, and so skips the initial delay. It is what makes swinging
 * left→right mid-flight one uninterrupted glide rather than two runs with a stall between them — the
 * stick passes through its centre on the way over, and the d-pad has a gap of its own, so the release
 * that happens in between must not count as "the user stopped". Stopping for real outlasts this.
 */
export const AUTO_CHAIN_MS = 200;

/**
 * Whether a hold starting at `now` continues the run whose last repeat fired at `lastRepeatAt`.
 * Pure — unit-tested.
 */
export function continuesRun(lastRepeatAt: number, now: number): boolean {
  return now - lastRepeatAt < AUTO_CHAIN_MS;
}

/** The shared "is the auto-move still warm" state — one per app, since there is one pair of hands. */
export interface AutoRepeatChain {
  /** Records an auto-move step, keeping the run warm. */
  noteRepeat(now: number): void;
  /** Whether a hold starting now may skip the initial delay (see continuesRun). */
  continues(now: number): boolean;
}

export function createAutoRepeatChain(): AutoRepeatChain {
  let lastRepeatAt = Number.NEGATIVE_INFINITY;
  return {
    noteRepeat(now: number): void {
      lastRepeatAt = now;
    },
    continues(now: number): boolean {
      return continuesRun(lastRepeatAt, now);
    },
  };
}
