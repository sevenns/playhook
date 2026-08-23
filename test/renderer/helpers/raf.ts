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
  vi.stubGlobal('performance', { now: () => now });

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
