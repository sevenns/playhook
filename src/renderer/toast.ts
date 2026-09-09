// The notification stack: plates in the top-right corner, six seconds each, newest on top.
//
// It used to be ONE plate with a queue behind it — a second message waited for the first to leave, which
// on a screen that reports several things in a row (a background applied, then a track, then a save)
// meant the later ones arrived long after the action that caused them. Now they stack: a new plate is
// prepended and the ones already up slide down by their own height, so two messages read as two messages
// rather than one overwriting the other.
//
// Plates are not interactive (pointer-events: none in styles.css): there is nothing to press on them,
// and notifications are only clickable inside the popup. That is also what keeps them out of the way of
// the hover guard in controls.ts.
import { type AudioController } from './audio.js';
import { req } from './dom.js';

/**
 * How long a plate stays up, and how long its exit transition runs (both must match .toast-plate in
 * styles.css). SHOW_MS is also the length of the single pulse animation, which is what puts the beats in
 * the middle of the plate's life rather than at some arbitrary point of a loop.
 */
const SHOW_MS = 6000;
const EXIT_MS = 300;
/**
 * How many plates the corner may hold at once. Beyond this the oldest is retired early: a column of
 * notifications taller than the screen is not more information, it is a wall, and the ones still worth
 * reading are the recent ones (the popup keeps the full list either way).
 */
const MAX_PLATES = 3;

export interface ToastDeps {
  readonly audio: AudioController;
  /**
   * Whether the corner is currently taken — the notifications popup lives in exactly the same place. A
   * blocked message is not dropped, it waits: the popup's own list is showing the very same notification
   * live, so nothing is lost by holding the plate until the popup closes.
   */
  isBlocked(): boolean;
}

export interface Toast {
  /** Queues a plate. Showing one is purely a display: read state is main's, and only the popup moves it. */
  show(text: string): void;
  /** The corner is free again (the popup closed) — resume the queue. */
  resume(): void;
}

export function createToast(deps: ToastDeps): Toast {
  const stack = req('toast');
  const waiting: string[] = [];
  /** The plates on screen, newest first — the same order they are laid out in. */
  const plates: HTMLElement[] = [];

  function pump(): void {
    if (deps.isBlocked()) return;
    while (waiting.length > 0) {
      const text = waiting.shift();
      if (text === undefined) return;
      add(text);
    }
  }

  function add(text: string): void {
    const plate = document.createElement('div');
    plate.className = 'toast-plate';
    const pulse = document.createElement('div');
    pulse.className = 'toast-pulse';
    const line = document.createElement('span');
    line.className = 'toast-text';
    line.textContent = text; // never innerHTML: the text carries a game title off the card
    pulse.append(line);
    plate.append(pulse);
    stack.prepend(plate);
    plates.unshift(plate);
    stack.setAttribute('aria-hidden', 'false');
    // The entrance has to be a CHANGE of class, not the class it was born with, or there is nothing for
    // the transition to run from — hence the frame between appending and opening.
    requestAnimationFrame(() => plate.classList.add('is-open'));
    deps.audio.play('notify');
    window.setTimeout(() => retire(plate), SHOW_MS);
    while (plates.length > MAX_PLATES) {
      const oldest = plates[plates.length - 1];
      if (oldest === undefined) break;
      retire(oldest);
    }
  }

  /** Slides one plate out and takes it off the stack once the transition has run. */
  function retire(plate: HTMLElement): void {
    const at = plates.indexOf(plate);
    if (at === -1) return; // already on its way out
    plates.splice(at, 1);
    plate.classList.remove('is-open');
    window.setTimeout(() => {
      plate.remove();
      if (plates.length === 0) stack.setAttribute('aria-hidden', 'true');
    }, EXIT_MS);
  }

  return {
    show: (text) => {
      waiting.push(text);
      pump();
    },
    resume: () => pump(),
  };
}
