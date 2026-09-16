// A write that runs at most once per window and ALWAYS once more after the last push — the shape a
// volume slider needs: a drag or a held arrow fires many steps a second, main must not be asked to
// persist every one, and the final position must never be the one that was skipped.

export interface TrailingThrottle<T> {
  /** Writes now if the window has passed since the last write; otherwise holds `value` for later. */
  push(value: T): void;
  /** Writes `value` immediately, dropping whatever was held. */
  writeNow(value: T): void;
  /** Writes the held value, if there is one. Call it before the surface goes away. */
  flush(): void;
  cancel(): void;
}

export function createTrailingThrottle<T>(
  windowMs: number,
  write: (value: T) => void,
  now: () => number = () => performance.now(),
): TrailingThrottle<T> {
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let held: { readonly value: T; readonly timer: ReturnType<typeof setTimeout> } | null = null;

  function cancel(): void {
    if (held === null) return;
    clearTimeout(held.timer);
    held = null;
  }

  function writeNow(value: T): void {
    cancel();
    lastWriteAt = now();
    write(value);
  }

  function flush(): void {
    if (held === null) return;
    writeNow(held.value);
  }

  return {
    push: (value) => {
      if (now() - lastWriteAt >= windowMs) {
        writeNow(value);
        return;
      }
      cancel();
      held = { value, timer: setTimeout(flush, windowMs) };
    },
    writeNow,
    flush,
    cancel,
  };
}
