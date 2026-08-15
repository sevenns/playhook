// Hold-to-repeat on the horizontal d-pad: a tap is one move, a held direction starts flipping through
// the carousel after a delay. The timing lives in a closure driven by requestAnimationFrame, so the test
// fakes the pad, the clock and the frame loop and steps them by hand.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAV_REPEAT_MS, createGamepadController } from '../src/renderer/gamepad';

const DPAD_LEFT = 14;

interface Harness {
  readonly press: (index: number, down: boolean) => void;
  /** Sets the left stick's Y axis (+down / -up, standard mapping). */
  readonly stickY: (value: number) => void;
  readonly tick: (ms: number) => void;
  readonly moves: () => number;
  readonly verticalMoves: () => { up: number; down: number };
  readonly releases: () => number;
  readonly setPaused: (paused: boolean) => void;
}

function harness(): Harness {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
  const pad = { buttons, axes: [0, 0] };
  let frame: (() => void) | null = null;
  let now = 0;
  let left = 0;
  let up = 0;
  let down = 0;
  let releases = 0;

  vi.stubGlobal('navigator', { getGamepads: () => [pad] });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frame = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('performance', { now: () => now });

  const noop = (): void => undefined;
  const controller = createGamepadController({
    onLeft: () => {
      left += 1;
    },
    onRight: noop,
    onUp: () => {
      up += 1;
    },
    onDown: () => {
      down += 1;
    },
    onA: noop,
    onB: noop,
    onY: noop,
    onDirectionsReleased: () => {
      releases += 1;
    },
  });
  controller.start();

  return {
    press: (index, isDown) => {
      const button = buttons[index];
      if (button !== undefined) button.pressed = isDown;
    },
    stickY: (value) => {
      pad.axes[1] = value;
    },
    tick: (ms) => {
      now += ms;
      frame?.();
    },
    moves: () => left,
    verticalMoves: () => ({ up, down }),
    releases: () => releases,
    setPaused: (paused) => controller.setPaused(paused),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gamepad hold-to-repeat', () => {
  it('fires once on the press edge and not again while the delay runs', () => {
    const pad = harness();
    pad.press(DPAD_LEFT, true);
    pad.tick(16);
    expect(pad.moves()).toBe(1);
    for (let elapsed = 0; elapsed < 300; elapsed += 16) pad.tick(16);
    expect(pad.moves()).toBe(1);
  });

  it('repeats at the nav cadence once the direction has been held long enough', () => {
    const pad = harness();
    pad.press(DPAD_LEFT, true);
    pad.tick(16);
    pad.tick(400); // past the hold delay
    expect(pad.moves()).toBe(2);
    pad.tick(NAV_REPEAT_MS);
    expect(pad.moves()).toBe(3);
    pad.tick(NAV_REPEAT_MS - 10); // too soon for the next one
    expect(pad.moves()).toBe(3);
  });

  it('treats a release as a reset — the next press is a single move again', () => {
    const pad = harness();
    pad.press(DPAD_LEFT, true);
    pad.tick(16);
    pad.tick(400);
    expect(pad.moves()).toBe(2);
    pad.press(DPAD_LEFT, false);
    pad.tick(16);
    pad.press(DPAD_LEFT, true);
    pad.tick(16);
    expect(pad.moves()).toBe(3);
    pad.tick(100); // still inside the fresh delay
    expect(pad.moves()).toBe(3);
  });

  it('does not burst when resuming onto a direction that was already held', () => {
    const pad = harness();
    pad.setPaused(true);
    pad.press(DPAD_LEFT, true);
    pad.tick(16);
    pad.tick(1000); // held down for a second while the launcher was backgrounded
    expect(pad.moves()).toBe(0);
    pad.setPaused(false);
    pad.tick(16);
    expect(pad.moves()).toBe(0); // no phantom edge…
    pad.tick(400);
    expect(pad.moves()).toBe(1); // …and the delay is counted from the resume
  });
});

// Holding a direction is a STATE for some consumers, not a stream of presses: the hero background stops
// swapping for as long as the strip is flipping (see hero.setFlipping). That needs a release edge.
describe('gamepad direction release', () => {
  it('reports the release once, not on every idle frame', () => {
    const pad = harness();
    pad.press(DPAD_LEFT, true);
    pad.tick(16);
    expect(pad.releases()).toBe(0);
    pad.press(DPAD_LEFT, false);
    pad.tick(16);
    expect(pad.releases()).toBe(1);
    pad.tick(16);
    pad.tick(16);
    expect(pad.releases()).toBe(1);
  });

  it('waits for the LAST direction before calling it a release', () => {
    const pad = harness();
    const DPAD_RIGHT = 15;
    pad.press(DPAD_LEFT, true);
    pad.stickY(1); // and down at the same time
    pad.tick(16);
    pad.press(DPAD_LEFT, false);
    pad.tick(16);
    expect(pad.releases()).toBe(0); // down is still held
    pad.stickY(0);
    pad.tick(16);
    expect(pad.releases()).toBe(1);
    pad.press(DPAD_RIGHT, true); // a fresh hold reports its own release later
    pad.tick(16);
    pad.press(DPAD_RIGHT, false);
    pad.tick(16);
    expect(pad.releases()).toBe(2);
  });

  it('reports the release even while paused — a backgrounded launcher holds nothing', () => {
    const pad = harness();
    pad.press(DPAD_LEFT, true);
    pad.tick(16);
    pad.setPaused(true);
    pad.press(DPAD_LEFT, false);
    pad.tick(16);
    expect(pad.releases()).toBe(1);
  });
});

// A thumbstick springs back through centre and overshoots past the deadzone on the far side. Read
// literally that is a press the other way — one step down, then an instant step back up, which is
// exactly the "it jumped and came back" stutter. The guard is time-based and stick-only.
describe('gamepad stick spring-back', () => {
  it('ignores the overshoot that follows releasing the stick', () => {
    const pad = harness();
    pad.stickY(1); // pushed down
    pad.tick(16);
    expect(pad.verticalMoves()).toEqual({ up: 0, down: 1 });
    pad.stickY(0); // released
    pad.tick(16);
    pad.stickY(-0.7); // the spring overshoots past the deadzone the other way
    pad.tick(16);
    expect(pad.verticalMoves()).toEqual({ up: 0, down: 1 });
  });

  it('still accepts a deliberate reversal once the stick has settled', () => {
    const pad = harness();
    pad.stickY(1);
    pad.tick(16);
    pad.stickY(0);
    pad.tick(16); // the frame that SEES the release and starts the settle clock
    pad.tick(200); // …which then runs out
    pad.stickY(-1);
    pad.tick(16);
    expect(pad.verticalMoves()).toEqual({ up: 1, down: 1 });
  });

  it('never gates the d-pad, which has no spring to bounce back', () => {
    const pad = harness();
    const DPAD_UP = 12;
    const DPAD_DOWN = 13;
    pad.press(DPAD_DOWN, true);
    pad.tick(16);
    pad.press(DPAD_DOWN, false);
    pad.tick(16);
    pad.press(DPAD_UP, true); // an immediate reversal on the d-pad is honest input
    pad.tick(16);
    expect(pad.verticalMoves()).toEqual({ up: 1, down: 1 });
  });
});
