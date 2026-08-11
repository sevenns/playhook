// Hold-to-repeat on the horizontal d-pad: a tap is one move, a held direction starts flipping through
// the carousel after a delay. The timing lives in a closure driven by requestAnimationFrame, so the test
// fakes the pad, the clock and the frame loop and steps them by hand.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAV_REPEAT_MS, createGamepadController } from '../src/renderer/gamepad';

const DPAD_LEFT = 14;

interface Harness {
  readonly press: (index: number, down: boolean) => void;
  readonly tick: (ms: number) => void;
  readonly moves: () => number;
  readonly setPaused: (paused: boolean) => void;
}

function harness(): Harness {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
  const pad = { buttons, axes: [0, 0] };
  let frame: (() => void) | null = null;
  let now = 0;
  let left = 0;

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
    onUp: noop,
    onDown: noop,
    onA: noop,
    onB: noop,
  });
  controller.start();

  return {
    press: (index, down) => {
      const button = buttons[index];
      if (button !== undefined) button.pressed = down;
    },
    tick: (ms) => {
      now += ms;
      frame?.();
    },
    moves: () => left,
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
