import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { req } from '../../src/renderer/dom';
import type { Palette } from '../../src/renderer/dominant-color';
import { loadFixture } from './helpers/fixture';

// The palette computation decodes an image on a canvas — nothing happy-dom can do. Each call is answered
// by hand, so a test can decide WHEN a computation finishes relative to the swaps around it.
const pending: { url: string; resolve: (palette: Palette | null) => void }[] = [];
vi.mock('../../src/renderer/dominant-color.js', () => ({
  computePalette: (url: string) =>
    new Promise<Palette | null>((resolve) => {
      pending.push({ url, resolve });
    }),
}));

const { createHeroController } = await import('../../src/renderer/hero');

const A = 'data:image/png;base64,AAAA';
const B = 'data:image/png;base64,BBBB';
const RED: Palette = { d1: 'rgb(200 20 20)', d2: 'rgb(90 10 10)' };
const BLUE: Palette = { d1: 'rgb(20 20 200)', d2: 'rgb(10 10 90)' };

let hasGame = true;

function finish(url: string, palette: Palette): void {
  const index = pending.findIndex((entry) => entry.url === url);
  expect(index, `a palette computation for ${url}`).toBeGreaterThanOrEqual(0);
  const [entry] = pending.splice(index, 1);
  entry?.resolve(palette);
}

/** Answers every computation still open for `url` — there may be none, which is fine. */
function finishAll(url: string, palette: Palette): void {
  for (const entry of pending.filter((candidate) => candidate.url === url)) {
    pending.splice(pending.indexOf(entry), 1);
    entry.resolve(palette);
  }
}

const d1 = (): string => req('app').style.getPropertyValue('--d1');

beforeEach(() => {
  loadFixture();
  vi.useFakeTimers();
  pending.length = 0;
  hasGame = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hero palette', () => {
  it("computes the next game's colours from ITS picture, whatever was cached under the way there", async () => {
    const hero = createHeroController({ hasGameOnScreen: () => hasGame });

    // Game A on screen, its palette computed and applied.
    hero.applyBrowseAssets({ images: [A] });
    await vi.advanceTimersByTimeAsync(0);
    finish(A, RED);
    await vi.advanceTimersByTimeAsync(0);
    expect(d1()).toBe(RED.d1);

    // Main moves the cursor to game B: the browse INFO lands first and the screen re-renders — still with
    // A's picture, because B's hero payload is debounced behind it.
    hero.repaint();
    await vi.advanceTimersByTimeAsync(0);

    // B's picture arrives and the cross-fade to it is scheduled; whatever the repaint may have started
    // for A's picture comes back only now, after the cache was dropped for the new payload.
    hero.applyBrowseAssets({ images: [B] });
    finishAll(A, RED);
    await vi.advanceTimersByTimeAsync(1000);

    // B is on screen, and its OWN picture must be what the colours are computed from.
    expect(req('app').querySelector('.hero-layer.is-active')?.getAttribute('style')).toContain(B);
    finish(B, BLUE);
    await vi.advanceTimersByTimeAsync(0);
    expect(d1()).toBe(BLUE.d1);
  });

  it("reuses a picture's colours when the same picture comes round again", async () => {
    const hero = createHeroController({ hasGameOnScreen: () => hasGame });
    hero.applyBrowseAssets({ images: [A, B] });
    await vi.advanceTimersByTimeAsync(0);
    finish(A, RED);
    await vi.advanceTimersByTimeAsync(0);

    hero.repaint();
    await vi.advanceTimersByTimeAsync(0);

    expect(pending).toHaveLength(0);
    expect(d1()).toBe(RED.d1);
  });
});
