/**
 * Pure geometry and stepping rules of the Library grid, in DESIGN pixels (the same grid
 * carousel-geometry.ts works in — the renderer multiplies by `--px`, see styles.css). No DOM, so the
 * maths is unit-testable.
 *
 * The grid does NOT move under the selection the way the carousel's strip does: the cards stand still and
 * the highlight walks them, so every step is a pure index move plus a verdict for the caller (sound, or a
 * hand-over to the sidebar).
 */
import { RING_INSET } from './carousel-geometry.js';
import { clampIndex } from './index-math.js';
import type { LibraryEntry } from '../shared/types.js';

/** Card size of the grid (Figma "Library"), and the gap between cards. */
export const LIB_CARD_W = 200;
export const LIB_CARD_H = 300;
export const LIB_GAP = 16;

/** How much the selected card grows in place. MIRRORS `--card-scale` on `.card.is-selected` in styles.css. */
export const LIB_CARD_SCALE = 1.06;

/** Where the focus ring stands, in REAL px — the units its container's coordinates already come in. */
export interface RingBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The box the focus ring takes around the selected grid card, from that card's MEASURED offset.
 *
 * Measured rather than derived, unlike the carousel's ringLeft: the grid is `justify-content: center`,
 * so the track's own left edge depends on how much slack the pane has — a formula over columns and gaps
 * would not know that shift. `offsetLeft/offsetTop` are unaffected by the card's `scale`, so the reading
 * stays true while it is growing.
 *
 * The ring wraps the card AT ITS GROWN SIZE and stays concentric with it: the scale spreads over both
 * sides, so half of the growth comes off the offset, and the stand-off comes off on top of that.
 */
export function ringBox(offsetLeft: number, offsetTop: number, pxUnit: number): RingBox {
  const growX = (LIB_CARD_W * (LIB_CARD_SCALE - 1)) / 2;
  const growY = (LIB_CARD_H * (LIB_CARD_SCALE - 1)) / 2;
  return {
    x: offsetLeft - (growX + RING_INSET) * pxUnit,
    y: offsetTop - (growY + RING_INSET) * pxUnit,
    w: (LIB_CARD_W * LIB_CARD_SCALE + 2 * RING_INSET) * pxUnit,
    h: (LIB_CARD_H * LIB_CARD_SCALE + 2 * RING_INSET) * pxUnit,
  };
}

/** How many rows around the selected one keep their artwork loaded (see isNearInGrid). */
export const LIB_ART_ROWS = 4;

/**
 * What a step did: it moved the selection, it hit a wall (the caller sounds `limit`), or it walked off the
 * left edge and the sidebar takes the focus.
 */
export type GridMove = 'moved' | 'at-end' | 'to-sidebar';

export type GridDir = 'left' | 'right' | 'up' | 'down';

export interface GridStep {
  readonly index: number;
  readonly result: GridMove;
}

/** Which section of the library is shown. */
export type LibraryFilter = 'all' | 'playable';

/**
 * How many columns fit into `innerWidth` design px. The card size is fixed and the count follows from the
 * screen, because `--px` is tied to the HEIGHT: a 16:9 screen is 1920 design px wide and a Steam Deck's
 * 16:10 one only 1728, so the same layout yields 6 columns there and 5 here. Never below 1.
 */
export function gridColumns(innerWidth: number, cardW = LIB_CARD_W, gap = LIB_GAP): number {
  const fits = Math.floor((innerWidth + gap) / (cardW + gap));
  return Math.max(1, fits);
}

/** Which row card `index` sits in. */
export function rowOf(index: number, cols: number): number {
  if (cols <= 0) return 0;
  return Math.floor(index / cols);
}

/**
 * Where one press lands. Left off the first column hands over to the sidebar; every other edge is a dead
 * end that stops rather than wrapping onto the neighbouring row (the mockup's rule: a row is a row). Down
 * from the last full row lands on the last card, so a ragged final row still catches the focus.
 */
export function gridStep(index: number, dir: GridDir, count: number, cols: number): GridStep {
  if (count <= 0 || cols <= 0) return { index: 0, result: 'at-end' };
  const current = clampIndex(index, 0, count);
  const column = current % cols;
  const row = rowOf(current, cols);
  const lastRow = rowOf(count - 1, cols);
  if (dir === 'left') {
    if (column === 0) return { index: current, result: 'to-sidebar' };
    return { index: current - 1, result: 'moved' };
  }
  if (dir === 'right') {
    if (column === cols - 1 || current + 1 >= count) return { index: current, result: 'at-end' };
    return { index: current + 1, result: 'moved' };
  }
  if (dir === 'up') {
    if (row === 0) return { index: current, result: 'at-end' };
    return { index: current - cols, result: 'moved' };
  }
  if (row === lastRow) return { index: current, result: 'at-end' };
  return { index: Math.min(current + cols, count - 1), result: 'moved' };
}

/**
 * Whether card `index` is close enough to the selection to be worth holding its artwork. Counted in ROWS,
 * not in cards: the grid scrolls vertically, so a window of rows is what the viewport actually walks
 * through. Bounded, or a library of hundreds would decode every cover it ever passed.
 */
export function isNearInGrid(
  index: number,
  selected: number,
  cols: number,
  radiusRows = LIB_ART_ROWS,
): boolean {
  return Math.abs(rowOf(index, cols) - rowOf(selected, cols)) <= radiusRows;
}

/**
 * The games of one section, in main's order — the renderer never re-sorts (see orderForCarousel).
 * "Ready to play" is the games on the inserted card; "All" is everything, history included.
 */
export function filterLibrary(
  games: readonly LibraryEntry[],
  filter: LibraryFilter,
): readonly LibraryEntry[] {
  if (filter === 'all') return games;
  return games.filter((game) => game.active && game.unconfigured !== true);
}
