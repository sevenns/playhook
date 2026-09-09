// The one-shot entrance every list on this launcher plays: its rows arrive from below, in the order they
// are read (@keyframes popup-item-in, staggered by --row-index / --osk-row).
//
// It marks the ROWS, not their container, and that is the whole point. The obvious shape — a class on the
// box for as long as the animation lasts, with a descendant selector under it — turns the class into a
// WINDOW: anything built while it is up matches too, and starts the entrance from zero. Every one of
// these lists rebuilds its contents far more often than it opens (the keyboard rebuilds all of its keys
// on every Shift, and again on every character typed with Shift on; the settings panes rebuild on a
// deferred preview and on the validator coming back), and a rebuild landing inside that window replayed
// the whole entrance — the surface visibly re-arriving a beat after it had already arrived. Marking the
// rows that exist AT THE MOMENT OF ARMING is immune to it: rows made later were not part of the arrival
// and simply appear.
//
// The mark is dropped on a timer rather than on `animationend`: with the stagger, the last row's event is
// the only one that means "all done", and a row removed mid-flight never fires one at all.

export interface Entrance {
  /** Marks the rows present right now so they animate in once. Anything built later stays put. */
  play(): void;
  /** Drops the marks (the surface is closing, or its rows are being replaced wholesale). */
  cancel(): void;
}

/**
 * @param box the container to look for rows in
 * @param selector the rows themselves — must match the `.is-entering` rule in styles.css
 * @param ms how long the whole staggered entrance takes, after which the marks come off
 */
export function createEntrance(box: HTMLElement, selector: string, ms: number): Entrance {
  let timer = 0;

  const rows = (): readonly HTMLElement[] => [...box.querySelectorAll<HTMLElement>(selector)];

  const clear = (): void => {
    for (const row of rows()) row.classList.remove('is-entering');
  };

  return {
    play: (): void => {
      if (timer !== 0) window.clearTimeout(timer);
      // Off and on around a forced reflow: these nodes are often reused across visits, and re-adding a
      // class the element already carries plays nothing at all.
      clear();
      void box.offsetWidth;
      for (const row of rows()) row.classList.add('is-entering');
      timer = window.setTimeout(() => {
        timer = 0;
        clear();
      }, ms);
    },
    cancel: (): void => {
      if (timer !== 0) window.clearTimeout(timer);
      timer = 0;
      clear();
    },
  };
}
