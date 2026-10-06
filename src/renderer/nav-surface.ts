// The six navigation primitives, as a contract. Every surface of the launcher that can hold the focus
// implements it — the Settings screen, the Customize screen, and the surfaces that open ON TOP of
// Customize (the on-screen keyboard, the file picker). controls.ts routes into one of them; a screen with
// its own stack routes further into whichever of its surfaces is on top.
//
// It is a type, not a base class, precisely so a screen can satisfy it while owning its state however it
// likes: the point is that `left` means the same thing everywhere the user presses it.
//
// The two surfaces that open on top of a SCREEN and hand a value back (the keyboard, the file picker) are
// contracts here too, so their implementations depend on this module and not on the screen that uses them.
import type { ConfigPickKind, ConfigPickResult } from '../shared/types.js';
export interface NavSurface {
  isOpen(): boolean;
  /** `repeat` marks a hold auto-repeat, exactly as it does for navLeft — surfaces that have no use for
   *  it simply take no parameter. */
  navUp(repeat?: boolean): void;
  navDown(repeat?: boolean): void;
  /** `repeat` marks a hold auto-repeat: a held direction must not walk out through several levels. */
  navLeft(repeat?: boolean): void;
  navRight(repeat?: boolean): void;
  navActivate(): void;
  navBack(): void;
  /**
   * X, and Y. Optional because only the on-screen keyboard has a use for a second and third action
   * (Backspace and Shift) — every other surface leaves the buttons alone, and controls.ts keeps its own
   * meaning for Y (the strip ⇄ bar swap) whenever no surface claims one.
   *
   * `repeat` marks a press produced by holding X rather than a fresh one, exactly as it does for the
   * directions: the keyboard keeps deleting through a hold, and skips the sound while it does.
   */
  navSecondary?(repeat?: boolean): void;
  navTertiary?(): void;
  /** LB / RB (-1 / +1) — the keyboard's layout switch. Same rule: unclaimed means unchanged. */
  navShoulder?(direction: -1 | 1): void;
  /** RT — "commit what I typed". Only the keyboard claims it; A on the Done key does the same thing. */
  navCommit?(): void;
  /** Re-renders every label for the current translator, keeping the focus and the scroll position. */
  relocalize(): void;
}

/** A surface that opens ON TOP of the screen and hands a value back when it is done. */
export interface TextEntrySurface extends NavSurface {
  open(request: {
    readonly value: string;
    readonly mode: 'text' | 'id' | 'number';
    readonly title: string;
    readonly onDone: (value: string) => void;
  }): void;
  /**
   * Dismisses the keyboard without committing. Called when a SCREEN closes under it: the keyboard is not
   * inside any screen (see #osk in index.html), so nothing else would take it off the display — it would
   * stay up over the carousel, still holding the focus of a screen that is gone.
   */
  close(): void;
}

export interface FilePickerSurface extends NavSurface {
  open(request: {
    /** Where picked paths are measured from. Empty for a history game — there is no card to measure
     * against, and `historyId` names where the file is copied to instead. */
    readonly root: string;
    readonly kind: ConfigPickKind;
    readonly current: string;
    readonly multi: boolean;
    /** The root-relative sub-directory this field is measured from, when it has one (see baseFor). */
    readonly base?: string;
    /**
     * Set when the screen is editing a game from the HISTORY: what is picked is copied into that game's
     * staging directory on this PC (the card it is for is not in), and the field stores the path the
     * file will have on the card once the edits are applied.
     */
    readonly historyId?: string;
    readonly onDone: (result: ConfigPickResult) => void;
  }): void;
}
