// Small DOM lookup helpers shared across the renderer modules. Throw on a missing element
// so a broken index.html fails loudly at startup rather than producing silent null-deref bugs later.

export function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} not found`);
  return el as T;
}

export function reqQuery<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`${selector} not found`);
  return el;
}

/**
 * A canvas by id, checked rather than cast: `req` would happily hand back a div typed as a canvas, and
 * the first getContext call would then be the thing that failed — a frame late and far from the cause.
 */
export function reqCanvas(id: string): HTMLCanvasElement {
  const el = req<HTMLElement>(id);
  if (!(el instanceof HTMLCanvasElement)) throw new Error(`#${id} is not a canvas`);
  return el;
}

/** Gamepad A doesn't trigger :active — how long the press class stays on to play the scale-down. */
export const PRESS_MS = 130;

/** The same press flash the rest of the UI uses on a button that was pressed by the pad or the keyboard. */
export function pressFlash(el: HTMLElement): void {
  el.classList.add('is-pressed');
  window.setTimeout(() => el.classList.remove('is-pressed'), PRESS_MS);
}
