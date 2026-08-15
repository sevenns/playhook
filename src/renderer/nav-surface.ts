// The six navigation primitives, as a contract. Every surface of the launcher that can hold the focus
// implements it — the Settings screen, the Customize screen, and the surfaces that open ON TOP of
// Customize (the on-screen keyboard, the file picker). controls.ts routes into one of them; a screen with
// its own stack routes further into whichever of its surfaces is on top.
//
// It is a type, not a base class, precisely so a screen can satisfy it while owning its state however it
// likes: the point is that `left` means the same thing everywhere the user presses it.
export interface NavSurface {
  isOpen(): boolean;
  navUp(): void;
  navDown(): void;
  /** `repeat` marks a hold auto-repeat: a held direction must not walk out through several levels. */
  navLeft(repeat?: boolean): void;
  navRight(): void;
  navActivate(): void;
  navBack(): void;
  /**
   * X, and Y. Optional because only the on-screen keyboard has a use for a second and third action
   * (Backspace and Shift) — every other surface leaves the buttons alone, and controls.ts keeps its own
   * meaning for Y (the strip ⇄ bar swap) whenever no surface claims one.
   */
  navSecondary?(): void;
  navTertiary?(): void;
  /** LB / RB (-1 / +1) — the keyboard's layout switch. Same rule: unclaimed means unchanged. */
  navShoulder?(direction: -1 | 1): void;
  /** Re-renders every label for the current translator, keeping the focus and the scroll position. */
  relocalize(): void;
}
