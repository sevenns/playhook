// The `limit` latch (sfx-limit.ts): one dead-end sound per series of blocked attempts. The series ends
// on a RELEASE, so the cases below are written with the real repeat cadences of both input devices —
// a test stepping at 110 ms only would miss the 350 ms gap the pad's hold delay opens.
import { describe, expect, it } from 'vitest';
import { LIMIT_IDLE_MS, shouldPlayLimit } from '../src/renderer/sfx-limit';

/** Replays a series of attempts through the same state the AudioController keeps, and counts the sounds. */
function soundsFor(attempts: readonly number[]): number {
  let armed = true;
  let last = Number.NEGATIVE_INFINITY;
  let sounds = 0;
  for (const now of attempts) {
    if (shouldPlayLimit(armed, last, now)) {
      armed = false;
      sounds += 1;
    }
    last = now;
  }
  return sounds;
}

describe('shouldPlayLimit — one sound per hold', () => {
  it('sounds once for a held direction on the gamepad (HOLD_DELAY_MS 350, then NAV_REPEAT_MS 110)', () => {
    expect(soundsFor([0, 350, 460, 570, 680])).toBe(1);
  });

  it('sounds once for a held key on a keyboard with a slow OS repeat delay', () => {
    expect(soundsFor([0, 500, 610, 720])).toBe(1);
  });

  it('sounds again once the input was released (the latch re-armed)', () => {
    let armed = true;
    let last = Number.NEGATIVE_INFINITY;
    expect(shouldPlayLimit(armed, last, 0)).toBe(true);
    armed = false;
    last = 0;
    expect(shouldPlayLimit(armed, last, 110)).toBe(false); // still the same hold
    armed = true; // released
    expect(shouldPlayLimit(armed, last, 200)).toBe(true); // pressed again, well inside the idle window
  });

  it('re-arms itself when a release was missed — an idle gap longer than the threshold', () => {
    expect(shouldPlayLimit(false, 0, LIMIT_IDLE_MS)).toBe(true);
    expect(shouldPlayLimit(false, 0, LIMIT_IDLE_MS - 1)).toBe(false);
  });

  it('keeps a hold silent past the threshold: every attempt pushes the idle window forward', () => {
    // 0 / 350 / 460 / 570 … reaches 1050 ms without a gap ever growing to LIMIT_IDLE_MS.
    const held = [0, 350, ...Array.from({ length: 20 }, (_, i) => 460 + i * 110)];
    expect(soundsFor(held)).toBe(1);
  });
});
