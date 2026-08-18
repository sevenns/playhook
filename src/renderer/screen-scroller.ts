// The scrolling behaviour shared by every full-screen surface of the launcher (Settings, Customize, and
// the file picker): one fixed duration and easing, plus the edge fades that soften a row cut by the clip.
// Lifted verbatim out of settings-screen.ts when the second screen appeared — it was already closed over
// nothing but `box` and the design-pixel unit, so the move is a move, not a rewrite.

/**
 * How long the list takes to reach a new scroll target. The scroll is animated here rather than left to
 * `scrollIntoView({behavior:'smooth'})`: the native one picks its own duration per distance, so a held
 * direction produced a different (and visibly uneven) glide on every step. One fixed duration with one
 * easing, re-aimed from wherever the current animation is, reads as a single continuous movement.
 */
const SCROLL_MS = 220;
/** How much of the list is kept visible past the focused row, so the next one is always already in view. */
const SCROLL_MARGIN_PX = 90;
/** The mask's fade height at each edge (mirrors --fade-size in styles.css). */
const EDGE_FADE_PX = 28;

/** Standard ease-in-out — the same shape as the CSS transitions the focus highlight uses. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** One design pixel in real px (--px is a vh unit, so it changes with the window). */
export function pxUnit(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--px');
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? (parsed * window.innerHeight) / 100 : 1;
}

/**
 * A pace other than the default one. The Library grid needs it: while a direction is HELD its rows must
 * scroll at exactly the repeat interval and in `linear`, so the steps glue into one continuous glide
 * instead of easing in and out 143 ms at a time (the same trick the carousel's strip plays in CSS).
 */
export interface GlideOptions {
  readonly durationMs: number;
  readonly linear: boolean;
}

export interface Scroller {
  /** Animates (or jumps) to a scrollTop. */
  to(top: number, instant?: boolean): void;
  /** Recomputes --fade-top / --fade-bottom for the current position. */
  fades(): void;
  /** Brings `target` into view, keeping SCROLL_MARGIN_PX of context beyond it. */
  reveal(target: HTMLElement, instant?: boolean): void;
  /** `to`, at a caller-chosen pace. */
  glide(top: number, options: GlideOptions): void;
  /** `reveal`, at a caller-chosen pace. */
  revealGlide(target: HTMLElement, options: GlideOptions): void;
}

export function createScroller(box: HTMLElement): Scroller {
  let target = 0;
  let from = 0;
  let startedAt = 0;
  let frame = 0;
  // The pace of the animation currently running. Held in state rather than read from the constants,
  // because a caller may ask for another one (see GlideOptions) — the defaults are what `to` passes.
  let durationMs = SCROLL_MS;
  let linear = false;

  const clamp = (top: number): number =>
    Math.min(Math.max(0, top), Math.max(0, box.scrollHeight - box.clientHeight));

  /**
   * Where the LAID-OUT content ends, in scroll coordinates — read from the last child's layout box and
   * not from `scrollHeight`.
   *
   * The two differ while anything inside is animating: a transformed descendant counts towards the
   * scrollable overflow, so an entrance that slides its rows in from 12px below makes a list that exactly
   * fills its box report 12px of content past the bottom for as long as the animation runs. The fade below
   * then switches on, dims the last row, and switches off again when the animation lands — a blink, on
   * every open, on the one row the user is most likely to be looking at. `offsetTop`/`offsetHeight` ignore
   * transforms, which is exactly the difference needed: the fade is about content the clip cuts, not about
   * decoration passing over it.
   */
  const contentBottom = (): number => {
    const last = box.lastElementChild;
    if (!(last instanceof HTMLElement)) return box.scrollHeight;
    // A positioned box IS the offsetParent of its children, and then their offsetTop is already measured
    // from it; an unpositioned one shares an offsetParent with them, and the difference is what counts.
    const origin = last.offsetParent === box ? 0 : box.offsetTop;
    return last.offsetTop - origin + last.offsetHeight;
  };

  const fades = (): void => {
    // A fade only belongs where there IS content beyond the edge — at the very top and the very bottom
    // the corresponding one is switched off, or the first and last rows read as dimmed for no reason.
    const top = box.scrollTop > 1 ? EDGE_FADE_PX : 0;
    const bottom = box.scrollTop < contentBottom() - box.clientHeight - 1 ? EDGE_FADE_PX : 0;
    box.style.setProperty('--fade-top', `calc(${top} * var(--px))`);
    box.style.setProperty('--fade-bottom', `calc(${bottom} * var(--px))`);
  };

  const step = (): void => {
    const progress = Math.min(1, (performance.now() - startedAt) / durationMs);
    box.scrollTop = from + (target - from) * (linear ? progress : easeInOut(progress));
    fades();
    if (progress >= 1) {
      box.scrollTop = target;
      frame = 0;
      fades();
      return;
    }
    frame = requestAnimationFrame(step);
  };

  const move = (top: number, instant: boolean, ms: number, isLinear: boolean): void => {
    const goal = clamp(top);
    if (instant) {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      target = goal;
      box.scrollTop = goal;
      fades();
      return;
    }
    // Already heading there AT THE SAME PACE — a re-aim that only changes the pace still has to restart,
    // or a held direction would keep gliding on the single-step easing it began with.
    const sameGoal = frame !== 0 && Math.abs(goal - target) < 0.5;
    if (sameGoal && ms === durationMs && isLinear === linear) return;
    target = goal;
    from = box.scrollTop;
    startedAt = performance.now();
    durationMs = ms;
    linear = isLinear;
    if (frame === 0) frame = requestAnimationFrame(step);
  };

  const revealWith = (el: HTMLElement, instant: boolean, ms: number, isLinear: boolean): void => {
    const margin = SCROLL_MARGIN_PX * pxUnit();
    const top = el.offsetTop - box.offsetTop;
    const bottom = top + el.offsetHeight;
    const viewTop = box.scrollTop;
    const viewBottom = viewTop + box.clientHeight;
    if (top - margin < viewTop) move(top - margin, instant, ms, isLinear);
    else if (bottom + margin > viewBottom) {
      move(bottom + margin - box.clientHeight, instant, ms, isLinear);
    } else fades();
  };

  const to = (top: number, instant = false): void => move(top, instant, SCROLL_MS, false);
  const reveal = (el: HTMLElement, instant = false): void => revealWith(el, instant, SCROLL_MS, false);
  const glide = (top: number, options: GlideOptions): void =>
    move(top, false, options.durationMs, options.linear);
  const revealGlide = (el: HTMLElement, options: GlideOptions): void =>
    revealWith(el, false, options.durationMs, options.linear);

  box.addEventListener('scroll', () => fades(), { passive: true });
  return { to, fades, reveal, glide, revealGlide };
}
