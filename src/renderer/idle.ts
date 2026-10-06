// The idle countdown and the mouse's sleep, split out of controls.ts. After IDLE_MS with no input the
// bar highlight goes dormant AND the mouse falls asleep; any input restarts the countdown. The gamepad
// puts the mouse to sleep at once (the user switched to the pad), a deliberate shove wakes it back up
// (mouse-sleep.ts), and while it is asleep every pointer gesture but a move is swallowed here, in the
// capture phase on window — so no surface has to gate them itself.
//
// The `mouse-asleep` class on <html> is the contract the surfaces read (`classList.contains`) and the
// DOM tests build on: this module is its single writer.
import type { HoverGuard } from './hover-guard.js';
import { createWakeMeter } from './mouse-sleep.js';

/** After this long with no input the highlight retires and the cursor hides — both "went idle" at once. */
const IDLE_MS = 5_000;

export interface IdleDeps {
  readonly hover: Pick<HoverGuard, 'arm'>;
  /**
   * With a full-screen overlay up there is no bar highlight to retire and no carousel to hand back to:
   * firing would strip the return point on More and light the strip up under the veil — so the countdown
   * is not armed while this says so.
   */
  isSuspended(): boolean;
  /** The countdown ran out: the bar highlight goes dormant (the cursor is already hidden by then). */
  onIdle(): void;
}

export interface IdleGuard {
  /** (Re)starts the countdown. */
  arm(): void;
  isMouseAsleep(): boolean;
  /** Puts the mouse to sleep or wakes it: hides the cursor AND turns every pointer gesture on or off. */
  setMouseAsleep(asleep: boolean): void;
  /**
   * Gamepad/keyboard input = activity: the mouse goes to sleep at once (the user switched to the pad, so
   * the pointer parked on screen stops counting as input at all), hover is disarmed, the idle countdown
   * restarts.
   */
  noteGamepadActivity(): void;
  /** Real mouse movement, with the mouse already awake = activity: keep the cursor up, restart the idle. */
  noteMouseActivity(): void;
  /**
   * A real (non-synthetic) pointer move. Asleep, a move is not input — it only feeds the wake meter — so
   * this answers false until the travel adds up to a shove; the move that wakes it (and every move while
   * awake) counts as activity and answers true.
   */
  pointerMoved(x: number, y: number, now: number): boolean;
}

export function createIdleGuard(deps: IdleDeps): IdleGuard {
  let idleTimer = 0;
  // The launcher OPENS with the mouse asleep (index.html carries the class from the first frame, so there
  // is no moment where a parked pointer can hover something before this file runs). Waking it takes a
  // deliberate shove — see mouse-sleep.ts and the swallowing listener below.
  let mouseAsleep = true;
  const wakeMeter = createWakeMeter();

  function setMouseAsleep(asleep: boolean): void {
    if (mouseAsleep === asleep) return;
    mouseAsleep = asleep;
    document.documentElement.classList.toggle('mouse-asleep', asleep);
    wakeMeter.reset();
  }

  function arm(): void {
    if (idleTimer !== 0) window.clearTimeout(idleTimer);
    if (deps.isSuspended()) return;
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      setMouseAsleep(true);
      deps.onIdle();
    }, IDLE_MS);
  }

  function noteGamepadActivity(): void {
    setMouseAsleep(true);
    // Explicitly, not just via setMouseAsleep: while the mouse is ALREADY asleep that call is a no-op,
    // and the travel a bumped trackpad has quietly banked up has to die on every pad step regardless —
    // otherwise a hand resting on the Deck adds up to a wake across a whole session of pressing buttons.
    wakeMeter.reset();
    // Every keyboard/gamepad step re-arms the hover guard: last input wins. Without this, one real mouse
    // move wakes hover for good, and from then on any element that slides under the still cursor — a
    // scrolling list, a popup opening — can take the focus back off the key that just moved it.
    deps.hover.arm();
    arm();
  }

  function noteMouseActivity(): void {
    setMouseAsleep(false);
    arm();
  }

  // Every OTHER thing a pointer can do, switched off in one place for as long as the mouse is asleep.
  //
  // Asleep means the mouse is OUT of the UI, not merely invisible: clicks, the wheel, right-click-as-back,
  // the hover reads on every surface. Gating each of those where it lives would be a list to keep in sync,
  // and one forgotten entry is a stutter nobody can reproduce — which is exactly how a resting cursor kept
  // stealing the popup's focus. So the gestures die here, in the capture phase on window, before any
  // surface sees them. Moves are the deliberate exception: they are the way back (see pointerMoved).
  //
  // Two things still get through. Untrusted events, because a synthetic .click() is our own code driving
  // the UI rather than a mouse (file-picker.ts does that). And touch: a finger on the Deck's screen is a
  // poke at one specific thing, never a pointer drifting under a resting hand, so it wakes the mouse and
  // proceeds — the click Chromium synthesises after it then lands on a UI that is already awake.
  const SLEPT_THROUGH: readonly string[] = [
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'wheel',
    'mousedown',
    'mouseup',
    'mouseover',
    'mouseout',
    'mouseenter',
    'mouseleave',
    'pointerdown',
    'pointerup',
    'pointerover',
    'pointerout',
    'pointerenter',
    'pointerleave',
  ];
  SLEPT_THROUGH.forEach((type) => {
    window.addEventListener(
      type,
      (event) => {
        if (!mouseAsleep || !event.isTrusted) return;
        if (event instanceof PointerEvent && event.pointerType === 'touch') {
          noteMouseActivity();
          return;
        }
        event.stopImmediatePropagation();
        // Not merely "don't route it": the default has to go too, or a sleeping wheel still scrolls the
        // list under the cursor and a sleeping middle-click still opens Chromium's autoscroll.
        if (event.cancelable) event.preventDefault();
      },
      { capture: true, passive: false },
    );
  });

  return {
    arm,
    isMouseAsleep: () => mouseAsleep,
    setMouseAsleep,
    noteGamepadActivity,
    noteMouseActivity,
    pointerMoved: (x, y, now) => {
      if (mouseAsleep && !wakeMeter.moved(x, y, now)) return false;
      noteMouseActivity();
      return true;
    },
  };
}
