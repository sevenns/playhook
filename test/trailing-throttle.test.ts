import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrailingThrottle } from '../src/renderer/trailing-throttle';

let clock = 0;
let written: number[];

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1000;
  written = [];
});

afterEach(() => {
  vi.useRealTimers();
});

function throttle(): ReturnType<typeof createTrailingThrottle<number>> {
  return createTrailingThrottle<number>(
    150,
    (value) => written.push(value),
    () => clock,
  );
}

function tick(ms: number): void {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

describe('trailing throttle', () => {
  it('writes the first push at once and a skipped one after the window', () => {
    const t = throttle();
    t.push(1);
    tick(100);
    t.push(2);

    expect(written).toEqual([1]);

    tick(150);

    expect(written).toEqual([1, 2]);
  });

  it('lets a newer on-time push supersede the held one', () => {
    const t = throttle();
    t.push(1);
    tick(100);
    t.push(2);
    tick(100);
    t.push(3);

    expect(written).toEqual([1, 3]);

    tick(500);

    expect(written).toEqual([1, 3]);
  });

  it('writes nothing more when the last push was on time', () => {
    const t = throttle();
    t.push(1);
    tick(200);
    t.push(2);
    tick(500);

    expect(written).toEqual([1, 2]);
  });

  it('flush writes what is held and is a no-op otherwise', () => {
    const t = throttle();
    t.push(1);
    tick(10);
    t.push(2);
    t.flush();
    t.flush();

    expect(written).toEqual([1, 2]);

    tick(500);

    expect(written).toEqual([1, 2]);
  });

  it('writeNow drops the held value and restarts the window', () => {
    const t = throttle();
    t.push(1);
    tick(10);
    t.push(2);
    t.writeNow(9);
    tick(10);
    t.push(3);

    expect(written).toEqual([1, 9]);

    tick(150);

    expect(written).toEqual([1, 9, 3]);
  });

  it('cancel forgets the held value', () => {
    const t = throttle();
    t.push(1);
    tick(10);
    t.push(2);
    t.cancel();
    tick(500);

    expect(written).toEqual([1]);
  });
});
