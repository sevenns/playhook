// The carousel's layout invariant: the selected card's left edge is the anchor and never moves, whichever
// card is selected — which is exactly what makes the strip offset linear in the index.
import { describe, expect, it } from 'vitest';
import {
  CARD_W,
  FAN_MAX,
  GAP,
  STEP,
  cardLeft,
  clampIndex,
  fanIndex,
  isNearViewport,
  isWithinWindow,
  stripOffset,
  VISIBLE_CARDS,
} from '../src/renderer/carousel-geometry';

describe('stripOffset', () => {
  it('does not shift the strip for the first card', () => {
    expect(stripOffset(0)).toBe(0);
  });

  it('advances by one card + gap per index', () => {
    expect(STEP).toBe(CARD_W + GAP);
    // 90 (card) + 16 (gap) — the step measured off the mockup, where consecutive unselected cards sit
    // at x=202/308/414.
    expect(stripOffset(1)).toBe(-106);
    expect(stripOffset(3)).toBe(-318);
  });

  it('is linear — the step between neighbours never depends on where you are', () => {
    for (let i = 0; i < 40; i += 1) {
      expect(stripOffset(i) - stripOffset(i + 1)).toBe(STEP);
    }
  });
});

describe('cardLeft (the anchor invariant)', () => {
  it('puts the SELECTED card at the anchor, for an arbitrary index', () => {
    for (const selected of [0, 1, 7, 39]) {
      expect(cardLeft(selected, selected)).toBe(0);
    }
  });

  it('places neighbours symmetrically around the anchor', () => {
    expect(cardLeft(4, 5)).toBe(-STEP);
    expect(cardLeft(6, 5)).toBe(STEP);
  });

  it('sends the cards left of the selection off to negative x (they leave the screen edge)', () => {
    expect(cardLeft(0, 10)).toBe(-10 * STEP);
  });
});

describe('clampIndex', () => {
  it('does not wrap around the ends', () => {
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(3, 3)).toBe(2);
    expect(clampIndex(1, 3)).toBe(1);
  });

  it('returns 0 for an empty list', () => {
    expect(clampIndex(5, 0)).toBe(0);
  });
});

describe('fanIndex', () => {
  it('starts the fan at the selection itself', () => {
    expect(fanIndex(5, 5)).toBe(0);
  });

  it('counts outwards, both ways alike', () => {
    expect(fanIndex(4, 5)).toBe(1);
    expect(fanIndex(6, 5)).toBe(1);
    expect(fanIndex(8, 5)).toBe(3);
  });

  it('caps the stagger, so a long history does not keep fading in for seconds', () => {
    expect(fanIndex(39, 0)).toBe(FAN_MAX);
    expect(fanIndex(0, 39)).toBe(FAN_MAX);
  });
});

describe('isNearViewport', () => {
  it('covers a window around the selection on both sides', () => {
    expect(isNearViewport(5, 5)).toBe(true);
    expect(isNearViewport(0, 12)).toBe(true);
    expect(isNearViewport(25, 12)).toBe(false);
  });
});

describe('isWithinWindow (how many cards the row shows)', () => {
  it('shows the selected card and the eight after it', () => {
    expect(VISIBLE_CARDS).toBe(9);
    expect(isWithinWindow(0, 0)).toBe(true);
    expect(isWithinWindow(8, 0)).toBe(true);
    expect(isWithinWindow(9, 0)).toBe(false);
    expect(isWithinWindow(39, 0)).toBe(false);
  });

  it('moves with the selection — one flip right brings exactly one card in', () => {
    expect(isWithinWindow(9, 0)).toBe(false);
    expect(isWithinWindow(9, 1)).toBe(true);
    expect(isWithinWindow(10, 1)).toBe(false);
  });

  it('leaves everything BEHIND the selection alone (the strip slides those off screen itself)', () => {
    expect(isWithinWindow(0, 20)).toBe(true);
    expect(isWithinWindow(19, 20)).toBe(true);
  });

  it('never hides anything in a list that fits the window', () => {
    for (let selected = 0; selected < VISIBLE_CARDS; selected += 1) {
      for (let index = 0; index < VISIBLE_CARDS; index += 1) {
        expect(isWithinWindow(index, selected)).toBe(true);
      }
    }
  });
});
