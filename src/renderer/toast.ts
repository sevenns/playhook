// The notification toast: one plate in the top-right corner, three seconds, then out. Plates never
// overlap — a second one arriving mid-show waits its turn — because they share the corner and, more to
// the point, because two plates on screen at once is two things to read and no time to read either.
//
// The plate is not interactive (pointer-events: none in styles.css): there is nothing to press on it,
// and notifications are only clickable inside the popup. That is also what keeps it out of the way of
// the hover guard in controls.ts.
import { type AudioController } from './audio.js';
import { req } from './dom.js';

/** How long a plate stays up, and how long its exit transition runs (must match .toast in styles.css). */
const SHOW_MS = 3000;
const EXIT_MS = 300;

export interface ToastDeps {
  readonly audio: AudioController;
  /**
   * Whether the corner is currently taken — the notifications popup lives in exactly the same place. A
   * blocked toast is not dropped, it waits: the popup's own list is showing the very same notification
   * live, so nothing is lost by holding the plate until the popup closes.
   */
  isBlocked(): boolean;
}

export interface Toast {
  /**
   * Queues a plate. `onShown` fires the moment it actually reaches the screen — that is what the live
   * path reports back to main as "the user has seen this one", so a plate still sitting in the queue
   * when the app closes stays unread.
   */
  show(text: string, onShown?: () => void): void;
  /** The corner is free again (the popup closed) — resume the queue. */
  resume(): void;
}

interface Pending {
  readonly text: string;
  readonly onShown?: () => void;
}

export function createToast(deps: ToastDeps): Toast {
  const toast = req('toast');
  const textEl = req('toast-text');
  const queue: Pending[] = [];
  let busy = false;

  function pump(): void {
    if (busy || deps.isBlocked()) return;
    const next = queue.shift();
    if (next === undefined) return;
    busy = true;
    textEl.textContent = next.text; // never innerHTML: the text carries a game title off the card
    toast.setAttribute('aria-hidden', 'false');
    toast.classList.add('is-open');
    // One sound per plate, at the moment it appears — a queued plate makes its own sound when its turn
    // comes, not when it was enqueued.
    deps.audio.play('notify');
    next.onShown?.();
    window.setTimeout(() => {
      toast.classList.remove('is-open');
      toast.setAttribute('aria-hidden', 'true');
      window.setTimeout(() => {
        busy = false;
        pump();
      }, EXIT_MS);
    }, SHOW_MS);
  }

  return {
    show: (text, onShown) => {
      queue.push({ text, onShown });
      pump();
    },
    resume: () => pump(),
  };
}
