// The on-screen keyboard's editing rules. They are worth testing on their own because the keyboard is
// the ONLY way to type in this launcher: an off-by-one here is a character the user cannot enter or
// cannot remove, with no <input> anywhere to fall back on.
import { describe, expect, it } from 'vitest';
import {
  caretFromOffset,
  clampCaret,
  deleteAfter,
  deleteBefore,
  insertAt,
  moveCaret,
  sanitize,
  splitAtCaret,
} from '../src/renderer/osk-text';

describe('insertAt', () => {
  it('writes at the caret rather than at the end', () => {
    expect(insertAt({ value: 'Hads', caret: 1 }, 'e')).toEqual({ value: 'Heads', caret: 2 });
  });

  it('leaves the caret after what was inserted, whatever its length', () => {
    expect(insertAt({ value: 'ab', caret: 1 }, 'XYZ')).toEqual({ value: 'aXYZb', caret: 4 });
  });

  it('appends when the caret is at the end, which is the plain typing case', () => {
    expect(insertAt({ value: 'Hade', caret: 4 }, 's')).toEqual({ value: 'Hades', caret: 5 });
  });

  it('does nothing with nothing to insert', () => {
    const state = { value: 'Hades', caret: 2 };
    expect(insertAt(state, '')).toBe(state);
  });
});

describe('deleteBefore / deleteAfter', () => {
  it('backspace takes the character before the caret', () => {
    expect(deleteBefore({ value: 'Heads', caret: 2 })).toEqual({ value: 'Hads', caret: 1 });
  });

  it('backspace at the very start is a no-op, not an underflow', () => {
    const state = { value: 'Hades', caret: 0 };
    expect(deleteBefore(state)).toBe(state);
  });

  it('delete takes the character at the caret and leaves the caret alone', () => {
    expect(deleteAfter({ value: 'Heads', caret: 1 })).toEqual({ value: 'Hads', caret: 1 });
  });

  it('delete at the very end is a no-op', () => {
    const state = { value: 'Hades', caret: 5 };
    expect(deleteAfter(state)).toBe(state);
  });
});

// A caret counted in UTF-16 code units eventually splits a surrogate pair, and a backspace then deletes
// half a character — the value keeps a lone surrogate and renders as a replacement glyph. Game titles
// are exactly where this shows up.
describe('characters outside the basic plane', () => {
  it('treats an astral character as one character everywhere', () => {
    const state = { value: 'a🎮b', caret: 2 };
    expect(splitAtCaret(state)).toEqual({ before: 'a🎮', after: 'b' });
    expect(deleteBefore(state)).toEqual({ value: 'ab', caret: 1 });
    expect(moveCaret({ value: 'a🎮b', caret: 1 }, 1)).toEqual({ value: 'a🎮b', caret: 2 });
  });

  it('inserts a whole astral character, not a half of one', () => {
    expect(insertAt({ value: 'ab', caret: 1 }, '🎮')).toEqual({ value: 'a🎮b', caret: 2 });
  });
});

describe('moveCaret / clampCaret', () => {
  it('stops at both ends instead of wrapping', () => {
    expect(moveCaret({ value: 'ab', caret: 0 }, -1)).toEqual({ value: 'ab', caret: 0 });
    expect(moveCaret({ value: 'ab', caret: 2 }, 1)).toEqual({ value: 'ab', caret: 2 });
  });

  it('returns the same state when it did not move (nothing to repaint)', () => {
    const state = { value: 'ab', caret: 0 };
    expect(moveCaret(state, -1)).toBe(state);
  });

  it('clamps a caret that no longer fits its value', () => {
    expect(clampCaret('ab', 9)).toBe(2);
    expect(clampCaret('ab', -3)).toBe(0);
  });
});

describe('sanitize', () => {
  it('holds an id to the schema, in lower case', () => {
    expect(sanitize('id', 'Hades II')).toBe('hadesii');
    expect(sanitize('id', 'my_game-2.0')).toBe('my_game-2.0');
  });

  it('keeps a number field to digits', () => {
    expect(sanitize('number', '30 сек')).toBe('30');
  });

  it('folds a pasted line break into a space instead of storing it', () => {
    expect(sanitize('text', 'Hades\nII')).toBe('Hades II');
    expect(sanitize('text', 'a\r\nb')).toBe('a b');
  });

  it('drops control characters a paste may carry', () => {
    expect(sanitize('text', 'Ha\u0000des\u200B')).toBe('Hades');
  });

  it('leaves an ordinary title alone, spaces and all', () => {
    expect(sanitize('text', 'Sid Meier’s Civilization VI')).toBe('Sid Meier’s Civilization VI');
  });
});

describe('caretFromOffset', () => {
  const state = { value: 'a🎮bc', caret: 2 }; // before = "a🎮", after = "bc"

  it('maps an offset inside the left half onto a code-point caret', () => {
    expect(caretFromOffset(state, 'before', 0)).toBe(0);
    expect(caretFromOffset(state, 'before', 1)).toBe(1);
    expect(caretFromOffset(state, 'before', 3)).toBe(2); // past the surrogate pair
  });

  it('maps an offset inside the right half past everything on the left', () => {
    expect(caretFromOffset(state, 'after', 0)).toBe(2);
    expect(caretFromOffset(state, 'after', 2)).toBe(4);
  });
});
