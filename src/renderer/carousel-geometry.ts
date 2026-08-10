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
 * Whether card `index` is close enough to the anchor to be worth loading its artwork. The window is
 * generous on both sides (the strip animates, and a held direction moves several cards before a repaint),
 * but bounded — a 40-game history must not decode 40 covers at once.
 */
export function isNearViewport(index: number, selected: number, radius = 12): boolean {
  return Math.abs(index - selected) <= radius;
}
