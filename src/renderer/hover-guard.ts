// The "did the MOUSE move, or did the UI move under it?" guard, shared by every surface that opens on
// top of another one (Settings, Customize, the file picker, the on-screen keyboard).
//
// A surface that opens under a resting cursor makes Chromium fire pointer events at it: the element
// moved, not the mouse. Taken as hover, that drags the focus off whatever the surface just focused (the
// current value, the bottom button) — the "it opened and blinked" stutter, reproducible by simply parking
// the mouse where an item will appear. Comparing against the previous event's coordinates is not enough
// on its own: the guard has to already KNOW where the pointer is, which is why `track` runs from a
// window-level listener that keeps going while everything is closed.
//
// So opening ARMS the guard at the pointer's current position, and hover stays asleep until the mouse has
// actually travelled HOVER_WAKE_PX from there.

/** How far the pointer must travel before hover may take the focus again. */
const HOVER_WAKE_PX = 6;

export interface HoverGuard {
  /** Records where the pointer is (call from a window-level mousemove, even while closed). */
  track(x: number, y: number): void;
  /** Called whenever a surface opens or a key/pad step lands: hover sleeps until the pointer leaves. */
  arm(): void;
  /** Whether this move is the user's, rather than the UI arriving under a still pointer. */
  awake(x: number, y: number): boolean;
}

export function createHoverGuard(): HoverGuard {
  let pointerX = -1;
  let pointerY = -1;
  let armedAt: { readonly x: number; readonly y: number } | null = null;

  return {
    track: (x, y) => {
      pointerX = x;
      pointerY = y;
    },
    arm: () => {
      armedAt = { x: pointerX, y: pointerY };
    },
    awake: (x, y) => {
      if (armedAt === null) return true;
      if (Math.hypot(x - armedAt.x, y - armedAt.y) < HOVER_WAKE_PX) return false;
      armedAt = null;
      return true;
    },
  };
}
