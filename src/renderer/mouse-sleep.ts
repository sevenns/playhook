// How far the mouse has to travel before the UI listens to it again.
//
// A launcher driven by a gamepad has a pointer sitting somewhere on the screen at all times, and that
// resting pointer is a second, uninvited input: it hovers whatever slides under it, its wheel flips the
// carousel, a bumped Deck trackpad moves it. The per-surface hover guards (hover-guard.ts) answer the
// narrow question "did the mouse move, or did the UI move under it?" — six pixels is enough for that.
// They cannot answer the wider one: "is the user ON the mouse right now?" A hand resting on a trackpad
// clears six pixels without meaning anything by it.
//
// So the mouse is ASLEEP by default and the whole UI ignores it (see controls.ts, where sleep swallows
// every pointer gesture and every key/pad step puts it back to sleep). Waking it takes a deliberate
// shove: this meter adds up the distance travelled and only reports a wake once the total crosses
// WAKE_TRAVEL_PX. Distance TRAVELLED, not distance from the start — shaking the mouse in place is as
// good a "hello" as dragging it across the screen, and both beat a drift nobody meant.

/** Total travel, in CSS pixels, that wakes the mouse. Roughly a deliberate shove; a nudge won't do it. */
export const WAKE_TRAVEL_PX = 150;
/** A gap this long between moves starts the count over: two nudges a second apart are not one shove. */
export const TRAVEL_RESET_MS = 250;

export interface WakeMeter {
  /** Feeds one real (non-synthetic) pointer position. True exactly once, on the move that wakes it. */
  moved(x: number, y: number, now: number): boolean;
  /** Forgets the travel so far — the mouse went back to sleep, or has just woken. */
  reset(): void;
}

export function createWakeMeter(): WakeMeter {
  let lastX = 0;
  let lastY = 0;
  let lastAt = 0;
  let travel = 0;

  return {
    moved: (x, y, now) => {
      const continues = lastAt !== 0 && now - lastAt <= TRAVEL_RESET_MS;
      travel = continues ? travel + Math.hypot(x - lastX, y - lastY) : 0;
      lastX = x;
      lastY = y;
      lastAt = now;
      if (travel < WAKE_TRAVEL_PX) return false;
      travel = 0;
      return true;
    },
    reset: () => {
      lastAt = 0;
      travel = 0;
    },
  };
}
