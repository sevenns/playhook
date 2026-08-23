import { vi } from 'vitest';

export interface RafHarness {
  /**
   * Runs exactly `frames` batches of the callbacks queued so far. Never drains the queue: the marquees
   * reschedule themselves while element widths are zero, which they always are without layout.
   */
  readonly flush: (frames?: number) => void;
  /** Advances the faked clock the scroller and the marquees read through `performance.now()`. */
  readonly advance: (ms: number) => void;
  readonly now: () => number;
}

/**
 * `performance` with only `now` replaced. A plain `{ now }` would drop mark/measure/timeOrigin, and
 * copying them off the real object breaks them (their `this` must be the genuine Performance), so the
 * rest is forwarded to it — a future `performance.mark` behaves instead of throwing out of the harness.
 */
function fakeClock(now: () => number): Performance {
  return new Proxy(performance, {
    get: (target, property, receiver) => {
      if (property === 'now') return now;
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (value as (this: Performance, ...args: readonly unknown[]) => unknown).bind(target);
    },
  });
}

/** Deterministic rAF + performance clock, removed by `vi.unstubAllGlobals()` in `afterEach`. */
export function installRafHarness(): RafHarness {
  let queue = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  let now = 0;

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    queue.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    queue.delete(handle);
  });
  vi.stubGlobal(
    'performance',
    fakeClock(() => now),
  );

  return {
    flush: (frames = 1) => {
      for (let frame = 0; frame < frames; frame += 1) {
        const batch = queue;
        queue = new Map();
        for (const callback of batch.values()) callback(now);
      }
    },
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
  };
}
