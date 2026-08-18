// Pure geometry of the history carousel, in DESIGN pixels (the 1920x1080 mockup grid — the renderer
// multiplies by `--px`, see styles.css). No DOM, so the maths is unit-testable.
//
// The strip does the moving, not the selection: the selected card always sits at the same anchor and the
// row slides under it. Cards to its LEFT keep the normal width, which is what makes the offset linear in
// the index — no per-index accumulation, no dependency on WHICH card is selected.

/** Unselected card size (Figma "Home": Rectangle 11/12/13 are 90x135, bottom-aligned with the selected). */
export const CARD_W = 90;
export const CARD_H = 135;
/** Selected card size (it grows in place, anchored at its bottom-left corner). */
export const SEL_W = 136;
export const SEL_H = 204;
/** Gap between cards. */
export const GAP = 16;

/** The distance one card advances the strip. */
export const STEP = CARD_W + GAP;

/**
 * How far the strip is translated (design px, negative = leftwards) so that card `index` lands on the
 * anchor. Linear by the invariant above; index 0 means "no shift".
 */
export function stripOffset(index: number): number {
  return 0 - index * STEP; // written as a subtraction so index 0 yields +0, not the -0 of `-index * STEP`
}

/**
 * The left edge of card `index` once the strip is at `stripOffset(selected)` — relative to the strip's
 * own origin, i.e. to the anchor. Zero for the selected card (that IS the anchor), which is the invariant
 * the layout rests on: the selected card's left edge never moves, whichever card it is.
 */
export function cardLeft(index: number, selected: number): number {
  return (index - selected) * STEP;
}

/**
 * Clamps a target index into the list — the carousel does not wrap. An empty list yields 0, so the caller
 * can use the result unconditionally.
 */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index));
}

/**
 * How many cards the strip shows at once, counting the selected one. The row is anchored at the LEFT of
 * the screen and grows rightwards, so a long history would otherwise run all the way to the right edge —
 * a wall of covers with no shape. The window keeps the row short: the ones past it wait off-view and fade
 * in as the selection moves onto them (isWithinWindow + `.is-beyond` in styles.css).
 *
 * Cards BEHIND the selection need no such rule: the strip slides left, so they leave the screen on their
 * own (the one directly behind stays as a sliver — the hint that the row continues that way).
 */
export const VISIBLE_CARDS = 9;

/**
 * Whether card `index` is inside the shown window when `selected` is on the anchor — the selected card
 * and the `size - 1` cards after it. Everything before the selection is left alone (see VISIBLE_CARDS).
 */
export function isWithinWindow(index: number, selected: number, size = VISIBLE_CARDS): boolean {
  return index < selected + size;
}

/**
 * Which card the strip aligns itself to — the selection, until the selection walks onto the launcher
 * cards at its tail. There the strip STOPS and the highlight travels on by itself, so all four of them
 * stay where they were instead of sliding leftwards one by one as the selection eats through them.
 *
 * Stopping exactly at the last GAME is not a detail: while a game is selected the anchor invariant above
 * still holds, which is what the play button's morph rests on (the selected card and the button occupy
 * the same box at that instant). The launcher cards have no detail screen to morph into, so the strip is
 * free to stand still for them.
 */
export function anchorIndex(index: number, gameCount: number): number {
  if (gameCount <= 0) return 0;
  return Math.min(index, gameCount - 1);
}

/**
 * How many GAMES the strip carries at most. Home is a shortlist, not the whole library: with the four
 * launcher cards after them the row tops out at 13 cards, and everything past that lives on the Library
 * screen, which is built for it. The list arrives already ordered (card first, then the PC library, then
 * history), so the cap keeps the most relevant ones — it never re-sorts.
 */
export const MAX_STRIP_GAMES = 9;

/** How many places of stagger the returning strip is allowed to spread over (see fanIndex). */
export const FAN_MAX = 4;

// The morph's duration, in milliseconds. MIRRORS `--morph` in styles.css — CSS cannot read this and JS
// cannot set it, so the two must be edited together.
const MORPH_MS = 240;

/**
 * How long flipping through cards is refused for after coming back from the detail screen: exactly the
 * morph, i.e. until the selected card stands at full size again. Not the whole return — the fan behind it
 * is still fading in, but by then the strip is laid out and a move through it is clean. Blocking until the
 * last card had finished would only feel sticky.
 */
export const RETURN_LOCK_MS = MORPH_MS;

/**
 * How long the return's staggered fade-in runs in total: the morph, plus the last card's stagger, plus
 * the fade itself. The renderer keeps `data-returning` on for exactly this long, which is what scopes the
 * fan's transition-delay to the return — a card scrolling INTO the window while flipping must fade in at
 * once, not wait out a delay meant for the hand-back. Mirrors styles.css (0.35s + 4 * 50ms + 0.4s).
 */
export const RETURN_FAN_MS = MORPH_MS + FAN_MAX * 50 + 400;

/**
 * The card's place in the "fan": how many steps from the selection it comes in, once the selected card is
 * back from the detail screen (styles.css multiplies this by the stagger). Capped, or the far end of a
 * 40-game history would still be fading in seconds after the near cards are done.
 */
export function fanIndex(index: number, selected: number): number {
  return Math.min(Math.abs(index - selected), FAN_MAX);
}

/**
 * Whether card `index` is close enough to the anchor to be worth loading its artwork. The window is
 * generous on both sides (the strip animates, and a held direction moves several cards before a repaint),
 * but bounded — a 40-game history must not decode 40 covers at once.
 */
export function isNearViewport(index: number, selected: number, radius = 12): boolean {
  return Math.abs(index - selected) <= radius;
}
