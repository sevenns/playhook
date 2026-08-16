// The shove that wakes the mouse: total travel, not distance from the start, and only while the moves
// keep coming. The meter is pure — the test feeds it coordinates and a clock of its own. Distances are
// expressed as fractions of WAKE_TRAVEL_PX so that retuning the threshold cannot quietly make a case
// meaningless (a fixed 150px "drift" stops proving anything the day the threshold moves past it).
import { describe, expect, it } from 'vitest';
import { TRAVEL_RESET_MS, WAKE_TRAVEL_PX, createWakeMeter } from '../src/renderer/mouse-sleep';

const STEP_PX = 10;
/** Moves that add up to `fraction` of the wake threshold. */
const stepsFor = (fraction: number): number => Math.ceil((WAKE_TRAVEL_PX * fraction) / STEP_PX);

interface Run {
  /** Index of the move that woke the meter, or -1 if it stayed asleep. */
  readonly wokeAt: number;
  /** The clock after the run, so a follow-up run can continue from it. */
  readonly endedAt: number;
}

/** Feeds a straight run of `steps` moves `px` apart, `gap` ms between them. */
function run(
  meter: ReturnType<typeof createWakeMeter>,
  steps: number,
  px: number,
  gap: number,
  startAt = 1_000,
): Run {
  let now = startAt;
  let x = 0;
  for (let i = 0; i < steps; i += 1) {
    x += px;
    now += gap;
    if (meter.moved(x, 0, now)) return { wokeAt: i, endedAt: now };
  }
  return { wokeAt: -1, endedAt: now };
}

describe('createWakeMeter', () => {
  it('stays asleep through a drift that never adds up', () => {
    expect(run(createWakeMeter(), stepsFor(0.5), 1, 10).wokeAt).toBe(-1);
  });

  it('wakes once the travel crosses the threshold', () => {
    const woke = run(createWakeMeter(), stepsFor(1.2), STEP_PX, 10).wokeAt;
    expect(woke).toBeGreaterThanOrEqual(0);
    expect((woke + 1) * STEP_PX).toBeGreaterThanOrEqual(WAKE_TRAVEL_PX);
  });

  it('counts the FIRST move as travel-free: it only establishes where the pointer is', () => {
    expect(createWakeMeter().moved(10_000, 10_000, 1_000)).toBe(false);
  });

  it('counts distance travelled, so shaking in place wakes it as well as a straight run', () => {
    const meter = createWakeMeter();
    const swing = 30;
    let now = 1_000;
    let woke = false;
    for (let i = 0; i < stepsFor(1.5) && !woke; i += 1) {
      now += 10;
      woke = meter.moved(i % 2 === 0 ? 0 : swing, 0, now);
    }
    expect(woke).toBe(true);
  });

  it('starts the count over after a pause, so two separate nudges are not one shove', () => {
    const meter = createWakeMeter();
    // Two runs of 60% each: carried over they would wake it, separated by a pause they must not.
    const first = run(meter, stepsFor(0.6), STEP_PX, 10);
    expect(first.wokeAt).toBe(-1);
    expect(run(meter, stepsFor(0.6), STEP_PX, 10, first.endedAt + TRAVEL_RESET_MS + 1).wokeAt).toBe(
      -1,
    );
  });

  it('treats a gap of exactly TRAVEL_RESET_MS as continuous, one millisecond more as a pause', () => {
    expect(
      run(createWakeMeter(), stepsFor(1.2), STEP_PX, TRAVEL_RESET_MS).wokeAt,
    ).toBeGreaterThanOrEqual(0);
    expect(run(createWakeMeter(), stepsFor(1.2), STEP_PX, TRAVEL_RESET_MS + 1).wokeAt).toBe(-1);
  });

  it('reports the wake exactly once, then counts again from zero', () => {
    const meter = createWakeMeter();
    const woke = run(meter, stepsFor(1.2), STEP_PX, 10);
    expect(woke.wokeAt).toBeGreaterThanOrEqual(0);
    // The run continues uninterrupted, but the meter was zeroed by the wake it just reported.
    expect(meter.moved((woke.wokeAt + 2) * STEP_PX, 0, woke.endedAt + 10)).toBe(false);
  });

  it('forgets the travel so far on reset (a pad step landed mid-shove)', () => {
    const meter = createWakeMeter();
    // Same two runs as the pause case, back to back with no pause: only the reset can stop this one.
    const first = run(meter, stepsFor(0.6), STEP_PX, 10);
    expect(first.wokeAt).toBe(-1);
    meter.reset();
    expect(run(meter, stepsFor(0.6), STEP_PX, 10, first.endedAt).wokeAt).toBe(-1);
  });
});
