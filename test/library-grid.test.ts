// The Library grid's stepping rules: where a press lands, which edges are walls and which one hands the
// focus to the sidebar. Nothing else in the renderer states that — library-screen.ts only paints what
// these functions decide — so a wrapped row or a swallowed dead end would only ever be caught on a Deck.
import { describe, expect, it } from 'vitest';
import {
  filterLibrary,
  gridColumns,
  gridStep,
  isNearInGrid,
  LIB_CARD_W,
  LIB_GAP,
  rowOf,
} from '../src/renderer/library-grid';
import type { LibraryEntry } from '../src/shared/types';

const game = (id: string, active: boolean): LibraryEntry => ({ id, title: id, active });

describe('gridColumns', () => {
  it('fits 6 columns into a 16:9 screen and 5 into a Steam Deck one', () => {
    // 1920 - 500 (sidebar edge) - 44 (padding) = 1376; the Deck is 1728 design px wide, so 1184.
    expect(gridColumns(1376)).toBe(6);
    expect(gridColumns(1184)).toBe(5);
  });

  it('counts the trailing card with no gap after it', () => {
    expect(gridColumns(LIB_CARD_W)).toBe(1);
    expect(gridColumns(LIB_CARD_W * 2 + LIB_GAP)).toBe(2);
    expect(gridColumns(LIB_CARD_W * 2 + LIB_GAP - 1)).toBe(1);
  });

  it('never drops below one column, however narrow the area is', () => {
    expect(gridColumns(0)).toBe(1);
    expect(gridColumns(-100)).toBe(1);
  });
});

describe('rowOf', () => {
  it('groups the indices by the column count', () => {
    expect(rowOf(0, 6)).toBe(0);
    expect(rowOf(5, 6)).toBe(0);
    expect(rowOf(6, 6)).toBe(1);
    expect(rowOf(13, 6)).toBe(2);
  });
});

describe('gridStep', () => {
  it('walks within a row and stops at its right edge', () => {
    expect(gridStep(0, 'right', 20, 6)).toEqual({ index: 1, result: 'moved' });
    expect(gridStep(5, 'right', 20, 6)).toEqual({ index: 5, result: 'at-end' });
  });

  it('stops at the last card even mid-row', () => {
    expect(gridStep(15, 'right', 16, 6)).toEqual({ index: 15, result: 'at-end' });
  });

  it('hands the focus to the sidebar off the first column, and steps otherwise', () => {
    expect(gridStep(6, 'left', 20, 6)).toEqual({ index: 6, result: 'to-sidebar' });
    expect(gridStep(7, 'left', 20, 6)).toEqual({ index: 6, result: 'moved' });
  });

  it('never wraps a row into its neighbour', () => {
    expect(gridStep(5, 'right', 20, 6).index).toBe(5);
    expect(gridStep(6, 'left', 20, 6).index).toBe(6);
  });

  it('walks the rows and stops at the first and the last', () => {
    expect(gridStep(2, 'up', 20, 6)).toEqual({ index: 2, result: 'at-end' });
    expect(gridStep(8, 'up', 20, 6)).toEqual({ index: 2, result: 'moved' });
    expect(gridStep(8, 'down', 20, 6)).toEqual({ index: 14, result: 'moved' });
    expect(gridStep(19, 'down', 20, 6)).toEqual({ index: 19, result: 'at-end' });
  });

  it('lands on the last card when the final row is ragged', () => {
    // 16 games, 6 columns: the last row holds 12..15, so down from 11 catches its end, not a hole.
    expect(gridStep(11, 'down', 16, 6)).toEqual({ index: 15, result: 'moved' });
    expect(gridStep(14, 'down', 16, 6)).toEqual({ index: 14, result: 'at-end' });
  });

  it('treats an empty grid as a dead end in every direction', () => {
    for (const dir of ['left', 'right', 'up', 'down'] as const) {
      expect(gridStep(0, dir, 0, 6)).toEqual({ index: 0, result: 'at-end' });
    }
  });
});

describe('isNearInGrid', () => {
  it('keeps a window of rows around the selection', () => {
    expect(isNearInGrid(0, 0, 6)).toBe(true);
    expect(isNearInGrid(5, 0, 6)).toBe(true);
    expect(isNearInGrid(24, 0, 6, 4)).toBe(true);
    expect(isNearInGrid(30, 0, 6, 4)).toBe(false);
  });

  it('is symmetric — the window reaches up as far as it reaches down', () => {
    expect(isNearInGrid(0, 24, 6, 4)).toBe(true);
    expect(isNearInGrid(0, 30, 6, 4)).toBe(false);
  });
});

describe('filterLibrary', () => {
  const games = [game('a', true), game('b', false), game('c', true)];

  it('shows everything, history included, under "All"', () => {
    expect(filterLibrary(games, 'all')).toEqual(games);
  });

  it('keeps only the games on the inserted card under "Ready to play"', () => {
    expect(filterLibrary(games, 'playable').map((entry) => entry.id)).toEqual(['a', 'c']);
  });

  it("preserves main's order — the renderer never sorts", () => {
    expect(filterLibrary(games, 'all').map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });
});
