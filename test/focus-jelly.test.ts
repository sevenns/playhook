// The focus body's geometry: the box it wraps, the contour it walks and the squeeze it makes on the way
// to the next cover. The renderer only feeds these numbers to a canvas, so a contour that clipped the
// cover's corners — or a squeeze that never came back to 1 — would only ever show up on a Deck.
import { describe, expect, it } from 'vitest';
import { JELLY, jellyBoxOf, outlinePoint, pinchScale, type JellyBox } from '../src/renderer/focus-jelly';

const box = (over: Partial<JellyBox> = {}): JellyBox => ({ x: 0, y: 0, w: 200, h: 300, r: 20, ...over });

describe('jellyBoxOf', () => {
  it('pushes the cover out by the stand-off on every side', () => {
    const b = jellyBoxOf(100, 50, 200, 300, 12, 1);
    expect(b.x).toBe(100 - JELLY.inset);
    expect(b.y).toBe(50 - JELLY.inset);
    expect(b.w).toBe(200 + 2 * JELLY.inset);
    expect(b.h).toBe(300 + 2 * JELLY.inset);
  });

  it('grows the radius by the same distance — the body echoes the cover, it does not just allude to it', () => {
    expect(jellyBoxOf(0, 0, 200, 300, 12, 1).r).toBe(12 + JELLY.inset);
  });

  it('stays concentric with the cover it wraps', () => {
    const b = jellyBoxOf(340, 120, 200, 300, 12, 1);
    expect(b.x + b.w / 2).toBeCloseTo(340 + 100);
    expect(b.y + b.h / 2).toBeCloseTo(120 + 150);
  });

  it('scales the stand-off with --px, but never the measured offset', () => {
    const b = jellyBoxOf(500, 300, 200, 300, 12, 0.7);
    expect(b.x).toBeCloseTo(500 - JELLY.inset * 0.7);
    expect(b.w).toBeCloseTo(200 + 2 * JELLY.inset * 0.7);
  });
});

describe('outlinePoint', () => {
  it('stays on the box — never outside it, never short of it', () => {
    const b = box();
    for (let i = 0; i < 200; i += 1) {
      const [x, y] = outlinePoint(b, i / 200);
      expect(x).toBeGreaterThanOrEqual(b.x - 1e-9);
      expect(x).toBeLessThanOrEqual(b.x + b.w + 1e-9);
      expect(y).toBeGreaterThanOrEqual(b.y - 1e-9);
      expect(y).toBeLessThanOrEqual(b.y + b.h + 1e-9);
    }
  });

  it('touches all four edges — a contour that missed one would not be the cover\'s shape', () => {
    const b = box();
    let top = false;
    let right = false;
    let bottom = false;
    let left = false;
    for (let i = 0; i < 400; i += 1) {
      const [x, y] = outlinePoint(b, i / 400);
      if (Math.abs(y - b.y) < 1e-6) top = true;
      if (Math.abs(x - (b.x + b.w)) < 1e-6) right = true;
      if (Math.abs(y - (b.y + b.h)) < 1e-6) bottom = true;
      if (Math.abs(x - b.x) < 1e-6) left = true;
    }
    expect([top, right, bottom, left]).toEqual([true, true, true, true]);
  });

  it('rounds the corners by exactly the radius', () => {
    const b = box({ r: 20 });
    // The far corner of the box is outside the body by r*(1 - 1/√2) on each axis; the nearest contour
    // point to it must sit on the corner's arc, i.e. exactly r away from that arc's centre.
    const centre = { x: b.x + b.w - b.r, y: b.y + b.r };
    let nearest = Infinity;
    for (let i = 0; i < 400; i += 1) {
      const [x, y] = outlinePoint(b, i / 400);
      if (x <= centre.x || y >= centre.y) continue; // only the quarter beyond the corner's centre
      nearest = Math.min(nearest, Math.abs(Math.hypot(x - centre.x, y - centre.y) - b.r));
    }
    expect(nearest).toBeLessThan(1e-6);
  });

  it('gives every corner points of its own — the reason it walks by arc length', () => {
    const b = box({ w: 200, h: 300, r: 28 });
    // A point is IN a corner when both of its coordinates are past the straight part of their edge.
    const corners = [0, 0, 0, 0];
    for (let i = 0; i < JELLY.points; i += 1) {
      const [x, y] = outlinePoint(b, i / JELLY.points);
      const inCornerX = x < b.x + b.r || x > b.x + b.w - b.r;
      const inCornerY = y < b.y + b.r || y > b.y + b.h - b.r;
      if (!inCornerX || !inCornerY) continue;
      const right = x > b.x + b.w / 2 ? 1 : 0;
      const low = y > b.y + b.h / 2 ? 2 : 0;
      const at = right + low;
      corners[at] = (corners[at] ?? 0) + 1;
    }
    expect(corners.filter((count) => count > 0)).toHaveLength(4);
  });

  it('wraps: t and t+1 are the same place, and t=0 is the top edge', () => {
    const b = box();
    expect(outlinePoint(b, 1.25)).toEqual(outlinePoint(b, 0.25));
    expect(outlinePoint(b, -0.25)).toEqual(outlinePoint(b, 0.75));
    expect(outlinePoint(b, 0)[1]).toBe(b.y);
  });

  it('survives a radius larger than the box — it clamps instead of turning inside out', () => {
    const b = box({ w: 100, h: 100, r: 900 });
    for (let i = 0; i < 50; i += 1) {
      const [x, y] = outlinePoint(b, i / 50);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('handles a square corner (radius 0) without dividing by it', () => {
    const b = box({ r: 0 });
    const [x, y] = outlinePoint(b, 0.25);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
  });
});

describe('pinchScale', () => {
  it('is a bell: full size at both ends, tightest half way', () => {
    expect(pinchScale(0)).toBeCloseTo(1);
    expect(pinchScale(1)).toBeCloseTo(1);
    expect(pinchScale(0.5)).toBeCloseTo(JELLY.pinch);
  });

  it('never overshoots past the floor or past full size', () => {
    for (let i = 0; i <= 100; i += 1) {
      const k = pinchScale(i / 100);
      expect(k).toBeGreaterThanOrEqual(JELLY.pinch - 1e-9);
      expect(k).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('clamps a progress that ran past the move — a finished trip is not a second squeeze', () => {
    expect(pinchScale(1.7)).toBeCloseTo(1);
    expect(pinchScale(-3)).toBeCloseTo(1);
  });

  it('a floor of 1 means no squeeze at all', () => {
    expect(pinchScale(0.5, 1)).toBeCloseTo(1);
  });
});
