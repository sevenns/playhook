// The rule behind the `limit` sound: it marks a dead end (a press that changed nothing), and a dead end
// held down is still ONE dead end. So the sound is latched — it fires once per series of blocked attempts,
// and the series ends when the user RELEASES the input, not when a timer expires. controls.ts re-arms the
// latch where it already detects the end of a hold (onDirectionsReleased for the pad, keyup for the
// keyboard); this module is the pure decision behind it, unit-tested without a DOM.

/**
 * Safety net for a release that never arrives — the window loses focus mid-hold and the keyup goes to
 * whoever took it (the same hazard controls.ts covers with its flip watchdog). A gap this long between
 * two attempts re-arms the latch on its own.
 *
 * It cannot be the main mechanism, and it has to sit above every repeat cadence in the app: the pad's
 * HOLD_DELAY_MS is 350, and the keyboard's first repeat comes after an OS-configured 250-500 ms. A
 * threshold below those would split one hold into two sounds 350 ms apart, which is worse than one; a
 * deliberate re-tap is heard because of the release, not because of this number.
 */
export const LIMIT_IDLE_MS = 700;

/**
 * Whether this blocked attempt should sound. True when the latch is armed (the previous series ended
 * with a release), or when enough idle time has passed that a release must have been missed.
 * Pure — unit-tested.
 */
export function shouldPlayLimit(armed: boolean, lastAttemptAt: number, now: number): boolean {
  return armed || now - lastAttemptAt >= LIMIT_IDLE_MS;
}
