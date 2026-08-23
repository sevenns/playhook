import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOsk } from '../../src/renderer/osk';
import { req } from '../../src/renderer/dom';
import { createTranslator } from '../../src/shared/i18n/index';
import type { TextEntrySurface } from '../../src/renderer/game-settings-screen';
import { loadFixture } from './helpers/fixture';
import { fakeAudio, type FakeAudio } from './helpers/fakes';
import { flushAsync } from './helpers/async';

let osk: TextEntrySurface;
let audio: FakeAudio;
let clipboard: string;
let committed: string[];

const keys = (): readonly HTMLButtonElement[] => [
  ...req('osk-keys').querySelectorAll<HTMLButtonElement>('.osk-key'),
];

const rowLabels = (): readonly (readonly string[])[] =>
  [...req('osk-keys').querySelectorAll<HTMLElement>('.osk-row')].map((row) =>
    [...row.querySelectorAll('.osk-key')].map((key) => key.textContent ?? ''),
  );

const focusedKey = (): string | null =>
  req('osk-keys').querySelector('.osk-key.is-focused')?.textContent ?? null;

const field = (): { readonly before: string; readonly after: string } => ({
  before: req('osk-value').textContent ?? '',
  after: req('osk-value-after').textContent ?? '',
});

/** Walks the grid to a key by its label — the gamepad path, without hard-coding row/column numbers. */
function focusKey(label: string): void {
  const target = rowLabels().findIndex((entries) => entries.includes(label));
  if (target === -1) throw new Error(`no key labelled ${label}`);
  for (let step = 0; step < rowLabels().length; step += 1) {
    const at = focusedRow();
    if (at === target) break;
    if (at < target) osk.navDown();
    else osk.navUp();
  }
  const width = rowLabels()[target]?.length ?? 0;
  for (let step = 0; step <= width; step += 1) {
    if (focusedKey() === label) return;
    osk.navRight();
  }
  throw new Error(`could not reach key ${label} in row ${String(target)}`);
}

function focusedRow(): number {
  return [...req('osk-keys').querySelectorAll<HTMLElement>('.osk-row')].findIndex(
    (row) => row.querySelector('.osk-key.is-focused') !== null,
  );
}

function type(text: string): void {
  for (const character of text) {
    focusKey(character);
    osk.navActivate();
  }
}

function open(
  request: { value?: string; mode?: 'text' | 'id' | 'number'; title?: string } = {},
): void {
  osk.open({
    value: request.value ?? '',
    mode: request.mode ?? 'text',
    title: request.title ?? 'Title',
    onDone: (value) => {
      committed.push(value);
    },
  });
}

beforeAll(() => {
  loadFixture();
  audio = fakeAudio();
  osk = createOsk({
    audio,
    getTranslator: () => createTranslator('en'),
    readClipboard: () => Promise.resolve(clipboard),
  });
});

afterEach(() => {
  osk.close();
});

beforeEach(() => {
  audio.reset();
  clipboard = '';
  committed = [];
});

describe('osk opening', () => {
  it('shows the title, the value and the caret at its end', () => {
    open({ value: 'Hades', title: 'Game title' });

    expect(req('osk').classList.contains('is-open')).toBe(true);
    expect(req('osk').getAttribute('aria-hidden')).toBe('false');
    expect(req('osk-title').textContent).toBe('Game title');
    expect(field()).toEqual({ before: 'Hades', after: '' });
  });

  it('starts on the first key of the first row', () => {
    open();

    expect(focusedKey()).toBe('1');
  });

  it('names only the buttons the current mode actually has', () => {
    open({ mode: 'number' });

    expect(req('osk-legend').textContent).toBe('X - delete, RT - done, B - cancel');
  });
});

describe('osk layouts per mode', () => {
  it('offers letters, a shift and three layouts in text mode', () => {
    open({ mode: 'text' });

    const labels = rowLabels().flat();
    expect(labels).toContain('q');
    expect(labels).toContain('Shift');
    expect(labels).toContain('АБВ');
  });

  it('drops shift and cyrillic in id mode', () => {
    open({ mode: 'id' });

    const labels = rowLabels().flat();
    expect(labels).toContain('q');
    expect(labels).not.toContain('Shift');
    expect(labels).toContain('#+=');
  });

  it('offers digits alone in number mode', () => {
    open({ mode: 'number' });

    const labels = rowLabels().flat();
    expect(labels).not.toContain('q');
    expect(labels).not.toContain('Space');
    expect(labels.filter((label) => /^[0-9]$/.test(label))).toHaveLength(10);
  });

  it('switches the layout on a shoulder press and lands the focus back on the layout key', () => {
    open({ mode: 'text' });

    osk.navShoulder?.(1);

    expect(rowLabels().flat()).toContain('й');
    expect(focusedKey()).toBe('#+=');
  });

  it('answers a shoulder press with the dead-end sound when there is nothing to switch to', () => {
    open({ mode: 'number' });

    osk.navShoulder?.(1);

    expect(audio.limits()).toBe(1);
  });
});

describe('osk navigation', () => {
  it('moves the focus class with the grid', () => {
    open();

    osk.navRight();
    expect(focusedKey()).toBe('2');

    osk.navDown();
    expect(focusedRow()).toBe(1);
    expect(keys().filter((key) => key.classList.contains('is-focused'))).toHaveLength(1);
  });

  it('wraps within a row and stops at the top of the grid', () => {
    open();

    osk.navLeft();
    expect(focusedKey()).toBe('0');

    osk.navUp();
    expect(focusedRow()).toBe(0);
    expect(audio.limits()).toBe(1);
  });
});

describe('osk typing', () => {
  it('writes the activated key into the field', () => {
    open();

    type('cat');

    expect(field()).toEqual({ before: 'cat', after: '' });
    expect(audio.played.filter((name) => name === 'typing')).toHaveLength(3);
  });

  it('applies shift to the next character only', () => {
    open();

    osk.navTertiary?.();
    type('H');
    type('i');

    expect(field().before).toBe('Hi');
  });

  it('lower-cases what an id field is given', () => {
    open({ mode: 'id' });

    type('a1');

    expect(field().before).toBe('a1');
    expect(rowLabels().flat()).not.toContain('Shift');
  });

  it('deletes backwards through the secondary button and stops at the start', () => {
    open({ value: 'ab' });

    osk.navSecondary?.();
    expect(field()).toEqual({ before: 'a', after: '' });

    osk.navSecondary?.();
    osk.navSecondary?.();

    expect(field()).toEqual({ before: '', after: '' });
    expect(audio.limits()).toBe(1);
  });

  it('splits the value around the caret and inserts there', () => {
    open({ value: 'ac' });

    focusKey('◀');
    osk.navActivate();
    expect(field()).toEqual({ before: 'a', after: 'c' });

    type('b');

    expect(field()).toEqual({ before: 'ab', after: 'c' });
  });
});

describe('osk clipboard', () => {
  it('inserts the sanitized clipboard once main answers', async () => {
    clipboard = 'Ha\ndes';
    open();

    focusKey('Paste');
    osk.navActivate();
    expect(field().before).toBe('');

    await flushAsync();

    expect(field().before).toBe('Ha des');
  });

  it('filters a paste through the mode of the field', async () => {
    clipboard = 'Hades 2';
    open({ mode: 'id' });

    focusKey('Paste');
    osk.navActivate();
    await flushAsync();

    expect(field().before).toBe('hades2');
  });
});

describe('osk committing', () => {
  it('hands the typed value back and closes', () => {
    open();

    type('ok');
    osk.navCommit?.();

    expect(committed).toEqual(['ok']);
    expect(osk.isOpen()).toBe(false);
    expect(req('osk').classList.contains('is-open')).toBe(false);
    expect(req('osk').getAttribute('aria-hidden')).toBe('true');
  });

  it('commits from the Done key too', () => {
    open({ value: 'x' });

    focusKey('Done');
    osk.navActivate();

    expect(committed).toEqual(['x']);
  });

  it('answers nothing when it is cancelled', () => {
    open({ value: 'x' });

    osk.navBack();

    expect(committed).toEqual([]);
    expect(osk.isOpen()).toBe(false);
  });

  it('answers nothing when the screen under it closes the keyboard', () => {
    open({ value: 'x' });

    osk.close();

    expect(committed).toEqual([]);
    expect(osk.isOpen()).toBe(false);
  });
});

describe('osk physical keyboard', () => {
  const press = (init: KeyboardEventInit): void => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }),
    );
  };

  it('types a character straight through and swallows the event', () => {
    open();

    const event = new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(field().before).toBe('z');
    expect(event.defaultPrevented).toBe(true);
  });

  it('commits on Enter and cancels on Escape', () => {
    open({ value: 'a' });
    press({ key: 'Enter' });
    expect(committed).toEqual(['a']);

    open({ value: 'b' });
    press({ key: 'Escape' });
    expect(committed).toEqual(['a']);
  });

  it('moves the caret with the arrows instead of the key highlight', () => {
    open({ value: 'ab' });
    const before = focusedKey();

    press({ key: 'ArrowLeft' });

    expect(field()).toEqual({ before: 'a', after: 'b' });
    expect(focusedKey()).toBe(before);
  });

  it('ignores a keystroke once the keyboard is closed', () => {
    open({ value: 'a' });
    osk.close();

    press({ key: 'z' });

    expect(field().before).toBe('a');
  });
});
