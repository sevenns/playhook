// The marquee of an expanded list (the Settings dropdown, the Customize column menu): every option whose
// label does not fit is marked clipped (a soft fade at the cut), and the FOCUSED one scrolls, so a long
// label reads at one pace whatever its length. Lifted from the 0.6 "Select game" picker's
// updateSelectGameMarquee: same measurement, same constant speed. An overflowing label is laid out from
// its start (flex alignment gives way to overflow), so it slides LEFT to reveal its end — hence the
// negative shift. The labels in the column menu are paths and file names, so most of them will not fit —
// cutting them would leave the user choosing between three items that all read the same.
import { pxUnit } from './screen-scroller.js';

/** Marquee speed for a clipped option label, in DESIGN px per second. */
const MARQUEE_SPEED_PX_PER_S = 60;

/**
 * Measures `buttons()` and starts / stops the marquee on each. A thunk rather than an array: a window that
 * hasn't laid out yet (or isn't painting) reports zero widths — measuring against that would mark every
 * label as fitting — so the pass tries again on the next frame, and by then the list may be another one
 * or gone. Whatever the thunk answers then is what is measured; an empty list ends the retry.
 */
export function updateMarquee(buttons: () => readonly HTMLElement[]): void {
  const list = buttons();
  const first = list[0]?.querySelector<HTMLElement>('.settings-option-clip');
  if (first !== null && first !== undefined && first.clientWidth === 0) {
    requestAnimationFrame(() => updateMarquee(buttons));
    return;
  }
  for (const button of list) {
    const clip = button.querySelector<HTMLElement>('.settings-option-clip');
    const text = button.querySelector<HTMLElement>('.settings-option-text');
    if (clip === null || text === null) continue;
    const overflow = text.scrollWidth - clip.clientWidth;
    const clipped = overflow > 1;
    button.classList.toggle('is-clipped', clipped);
    if (clipped && button.classList.contains('is-focused')) {
      text.style.setProperty('--marquee-shift', `${-overflow}px`);
      text.style.setProperty(
        '--marquee-duration',
        `${Math.max(2, overflow / (MARQUEE_SPEED_PX_PER_S * pxUnit()))}s`,
      );
      button.classList.add('is-scrolling');
    } else {
      button.classList.remove('is-scrolling');
      text.style.removeProperty('--marquee-shift');
      text.style.removeProperty('--marquee-duration');
    }
  }
}
