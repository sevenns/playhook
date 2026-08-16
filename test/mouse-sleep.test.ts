// The shove that wakes the mouse: total travel, not distance from the start, and only while the moves
// keep coming. The meter is pure — the test feeds it coordinates and a clock of its own.
import { describe, expect, it } from 'vitest';
import { TRAVEL_RESET_MS, WAKE_TRAVEL_PX, createWakeMeter } from '../src/renderer/mouse-sleep';

/** Feeds a straight run of `steps` moves `px` apart, `gap` ms between them; returns when it woke, or -1. */
function run(
  meter: ReturnType<typeof createWakeMeter>,
  steps: number,
  px: number,
  gap: number,
  startAt = 1_000,
): number {
  let now = startAt;
  let x = 0;
  for (let i = 0; i < steps; i += 1) {
    x += px;
    now += gap;
    if (meter.moved(x, 0, now)) return i;
  }
  return -1;
}

describe('createWakeMeter', () => {
  it('stays asleep through a drift that never adds up', () => {
    expect(run(createWakeMeter(), 40, 2, 10)).toBe(-1);
  });

  it('wakes once the travel crosses the threshold', () => {
    const woke = run(createWakeMeter(), 40, 10, 10);
    expect(woke).toBeGreaterThanOrEqual(0);
    expect((woke + 1) * 10).toBeGreaterThanOrEqual(WAKE_TRAVEL_PX);
  });

  it('counts the FIRST move as travel-free: it only establishes where the pointer is', () => {
    const meter = createWakeMeter();
    expect(meter.moved(10_000, 10_000, 1_000)).toBe(false);
  });

  it('counts distance travelled, so shaking in place wakes it as well as a straight run', () => {
    const meter = createWakeMeter();
    let now = 1_000;
    let woke = false;
    for (let i = 0; i < 40 && !woke; i += 1) {
      now += 10;
      woke = meter.moved(i % 2 === 0 ? 0 : 30, 0, now);
    }
    expect(woke).toBe(true);
  });

  it('starts the count over after a pause, so two separate nudges are not one shove', () => {
    const meter = createWakeMeter();
    // Half the distance, a pause, then half again: with the count carried over this would wake.
    expect(run(meter, 7, 10, 10, 1_000)).toBe(-1);
    expect(run(meter, 7, 10, 10, 5_000)).toBe(-1);
  });

  it('treats a gap of exactly TRAVEL_RESET_MS as continuous, one millisecond more as a pause', () => {
    expect(run(createWakeMeter(), 40, 10, TRAVEL_RESET_MS)).toBeGreaterThanOrEqual(0);
    expect(run(createWakeMeter(), 40, 10, TRAVEL_RESET_MS + 1)).toBe(-1);
  });

  it('reports the wake exactly once, then counts again from zero', () => {
    const meter = createWakeMeter();
    const first = run(meter, 40, 10, 10);
    expect(first).toBeGreaterThanOrEqual(0);
    // The next move continues the same run, but the meter was zeroed by the wake.
    expect(meter.moved((first + 2) * 10, 0, 1_000 + (first + 2) * 10)).toBe(false);
  });

  it('forgets the travel so far on reset (the mouse went back to sleep mid-shove)', () => {
    const meter = createWakeMeter();
    expect(run(meter, 7, 10, 10)).toBe(-1);
    meter.reset();
    expect(run(meter, 7, 10, 10, 1_100)).toBe(-1);
  });
});
