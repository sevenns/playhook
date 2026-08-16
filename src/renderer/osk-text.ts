// The on-screen keyboard's text state, as pure functions: a value and a caret inside it, plus the rule
// for what each field mode will accept at all. DOM-free and electron-free, so the editing itself is
// unit-testable while osk.ts keeps only the keys, the focus and the painting.
//
// The caret is counted in CODE POINTS, not in UTF-16 code units. A game's title is the one field here
// that routinely holds something outside the basic plane — an emoji in a name, a composed character —
// and a caret counted in code units eventually lands between the halves of a surrogate pair, where a
// backspace deletes half a character and leaves a replacement glyph behind. Every function below goes
// through `charsOf`, which is the only place that decides what "one character" means.

/** A field mode, mirrored from osk.ts (kept here so this module imports nothing). */
export type TextMode = 'text' | 'id' | 'number';

export interface TextState {
  readonly value: string;
  /** Where the next character goes, in code points: 0 is before the first, length is after the last. */
  readonly caret: number;
}

/** The value split the way the caret sees it. */
export function charsOf(value: string): readonly string[] {
  return [...value];
}

/** Keeps a caret inside its value — used wherever a caret and a value could disagree. */
export function clampCaret(value: string, caret: number): number {
  return Math.min(Math.max(0, Math.trunc(caret)), charsOf(value).length);
}

/**
 * What a mode will accept, applied to everything that can put text into a field: a key press, the
 * physical keyboard and a paste.
 *
 * `id` is the manifest's own key for the game on disk, so it is held to what the schema accepts and
 * lower-cased (two ids differing only in case would be two games on this PC — a distinction nobody
 * means to draw). Every mode drops control characters and folds a newline into a space: these fields
 * are single-line, and a pasted line break would otherwise be stored verbatim in the manifest.
 */
export function sanitize(mode: TextMode, text: string): string {
  const flat = text.replace(/[\t\n\r]+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '');
  if (mode === 'id') return flat.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (mode === 'number') return flat.replace(/[^0-9-]/g, '');
  return flat;
}

/** Inserts text AT the caret and leaves the caret after what was inserted. */
export function insertAt(state: TextState, text: string): TextState {
  if (text === '') return state;
  const chars = charsOf(state.value);
  const at = clampCaret(state.value, state.caret);
  const added = charsOf(text);
  return {
    value: [...chars.slice(0, at), ...added, ...chars.slice(at)].join(''),
    caret: at + added.length,
  };
}

/** Deletes the character BEFORE the caret (Backspace). At the very start there is nothing to delete. */
export function deleteBefore(state: TextState): TextState {
  const chars = charsOf(state.value);
  const at = clampCaret(state.value, state.caret);
  if (at === 0) return state;
  return {
    value: [...chars.slice(0, at - 1), ...chars.slice(at)].join(''),
    caret: at - 1,
  };
}

/** Deletes the character AT the caret (Delete). At the very end there is nothing to delete. */
export function deleteAfter(state: TextState): TextState {
  const chars = charsOf(state.value);
  const at = clampCaret(state.value, state.caret);
  if (at >= chars.length) return state;
  return {
    value: [...chars.slice(0, at), ...chars.slice(at + 1)].join(''),
    caret: at,
  };
}

/** Steps the caret, stopping at either end rather than wrapping — text has ends, and they mean something. */
export function moveCaret(state: TextState, delta: number): TextState {
  const at = clampCaret(state.value, state.caret + delta);
  return at === state.caret ? state : { value: state.value, caret: at };
}

/** The two halves the field draws: what is before the caret, and what is after it. */
export function splitAtCaret(state: TextState): {
  readonly before: string;
  readonly after: string;
} {
  const chars = charsOf(state.value);
  const at = clampCaret(state.value, state.caret);
  return { before: chars.slice(0, at).join(''), after: chars.slice(at).join('') };
}

/**
 * Turns an offset the DOM reports into a caret. The DOM counts UTF-16 code units inside whichever half
 * was clicked, and the halves are exactly what the field renders — so a click resolves against the text
 * the user actually pointed at, and the conversion to code points happens once, here.
 */
export function caretFromOffset(
  state: TextState,
  half: 'before' | 'after',
  offsetInHalf: number,
): number {
  const { before, after } = splitAtCaret(state);
  const at = Math.max(0, Math.trunc(offsetInHalf));
  if (half === 'before') return charsOf(before.slice(0, at)).length;
  return charsOf(before).length + charsOf(after.slice(0, at)).length;
}
