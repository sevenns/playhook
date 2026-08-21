// Pure geometry of the history carousel, in DESIGN pixels (the 1920x1080 mockup grid — the renderer
// multiplies by `--px`, see styles.css). No DOM, so the maths is unit-testable.
//
// The strip does the moving, not the selection: the selected card always sits at the same anchor and the
// row slides under it. Cards to its LEFT keep the normal width and the normal gap, which is what keeps
// the offset a straight multiple of the index — no per-index accumulation, no dependency on WHICH card
// is selected. The selected card's own breathing room (SEL_MARGIN) is the one constant added on top.

/** Unselected card size (Figma "Home": Rectangle 11/12/13 are 90x135, bottom-aligned with the selected). */
export const CARD_W = 90;
export const CARD_H = 135;
/** Selected card size (it grows in place, anchored at its bottom-left corner). */
export const SEL_W = 136;
export const SEL_H = 204;
/** Gap between two ordinary cards. MIRRORED by #carousel-strip's `gap` in styles.css. */
export const GAP = 8;

/**
 * Gap on either side of the SELECTED card: it is the one thing being looked at, so it gets the room to
 * be looked at. MIRRORED by the `margin` on `#carousel-strip .card.is-selected` in styles.css, which
 * spells it as the DIFFERENCE below — flex lays one gap between every pair, and the selected card adds
 * the rest with margins of its own.
 */
export const SEL_GAP = 24;

/** What the selected card adds on each side, over the gap the row already has. */
export const SEL_MARGIN = SEL_GAP - GAP;

/** The distance one card advances the strip. */
export const STEP = CARD_W + GAP;

/**
 * The canvas the focus body is drawn on, in design px: the whole row plus slack on every side.
 *
 * Sized from the COUNT rather than measured, for the same reason the offsets are: the row's own width
 * is mid-transition half the time (the selected card is growing), and a canvas resized per frame would
 * clear itself on every one. The widest the row can be is every card unselected but one, i.e. the
 * selected card sitting at the last step.
 */
export function stripCanvas(count: number, margin = 26): { readonly width: number; readonly height: number } {
  const cards = Math.max(count, 1);
  return {
    // The row's own width does not depend on WHICH card is selected: one card is wide, the rest are not,
    // and the selected one's margins are there wherever it stands.
    width: (cards - 1) * STEP + SEL_W + 2 * SEL_MARGIN + 2 * margin,
    height: SEL_H + 2 * margin,
  };
}

/**
 * How far the strip is translated (design px, negative = leftwards) so that card `index` lands on the
 * anchor.
 *
 * A straight multiple of the step, plus the selected card's own left margin: everything before it is an
 * ordinary card at the ordinary gap, and the card itself then starts one margin further in. That extra
 * is the SAME for every index — including 0, where the first card is pushed off the strip's origin by
 * its margin like any other — so this stays one line and never accumulates.
 */
export function stripOffset(index: number): number {
  return 0 - (index * STEP + SEL_MARGIN); // subtraction first, so index 0 yields a plain -SEL_MARGIN
}

/**
 * The left edge of card `index` once the strip is at `stripOffset(selected)` — relative to the strip's
 * own origin, i.e. to the anchor. Zero for the selected card (that IS the anchor), which is the invariant
 * the layout rests on: the selected card's left edge never moves, whichever card it is.
 *
 * The two sides are NOT mirror images, which is the whole reason this is spelled out rather than left as
 * `(index - selected) * STEP`: to the left the row is ordinary cards at the ordinary gap, while to the
 * right everything is pushed out by how much wider the selected card is AND by its two margins.
 */
export function cardLeft(index: number, selected: number): number {
  if (index === selected) return 0;
  if (index < selected) return (index - selected) * STEP - SEL_MARGIN;
  return SEL_W + SEL_GAP + (index - selected - 1) * STEP;
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
