// "Is the user actually at the launcher right now?" — the renderer's half of the presence signal main
// uses to decide whether a notification may make noise (see notifications-model.ts). Input from the
// gamepad or the mouse keeps it awake; IDLE_MS of silence turns it off, and it stays off until the boot
// reveal declares the UI visible at all.
//
// Deliberately NOT folded into the bar's own idle timer (controls.ts armIdleTimer): that one is
// suspended while a full-screen overlay is up, because it has a highlight to retire and none exists
// there. Presence has the opposite need — someone who walks away from an open Settings screen is exactly
// as absent as someone who walks away from the carousel, and on the shared timer they would have stayed
// "active" forever.

/** How long without input before the user counts as away. Mirrors the bar's own idle window. */
const IDLE_MS = 5_000;

export interface Presence {
  /** Input happened — the user is here. Restarts the countdown. */
  note(): void;
  /** The boot reveal is done: the UI is on screen, so presence may start counting at all. */
  reveal(): void;
}

export interface PresenceDeps {
  /** Called only when the value FLIPS — main is told about changes, not fed a stream. */
  onChange(active: boolean): void;
}

export function createPresence(deps: PresenceDeps): Presence {
  let revealed = false;
  let active = false;
  let timer = 0;

  function set(next: boolean): void {
    if (active === next) return;
    active = next;
    deps.onChange(next);
  }

  function note(): void {
    // Before the reveal there is nothing on screen to see a toast on, so input (a stray mouse move over
    // the boot backdrop) must not be mistaken for the user watching.
    if (!revealed) return;
    set(true);
    if (timer !== 0) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      set(false);
    }, IDLE_MS);
  }

  return {
    note,
    reveal: () => {
      if (revealed) return;
      revealed = true;
      // The reveal itself counts as the user being here: they are looking at the launcher the moment it
      // appears, whether or not they have touched anything yet.
      note();
    },
  };
}
