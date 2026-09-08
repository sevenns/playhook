import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFilePicker } from '../../src/renderer/file-picker';
import { req } from '../../src/renderer/dom';
import { createTranslator } from '../../src/shared/i18n/index';
import type { FilePickerSurface } from '../../src/renderer/game-settings-screen';
import type { ConfigPickKind, ConfigPickResult } from '../../src/shared/types';
import { hoverOver, loadFixture } from './helpers/fixture';
import {
  fakeAudio,
  fakeFilePickerApi,
  type FakeAudio,
  type FakeFilePickerApi,
} from './helpers/fakes';
import { flushAsync } from './helpers/async';
import { installRafHarness } from './helpers/raf';

const TREE = {
  '/card': [
    { name: 'games', kind: 'dir' as const },
    { name: 'game.json', kind: 'file' as const },
  ],
  '/card/games': [
    { name: 'hades', kind: 'dir' as const },
    { name: 'run.exe', kind: 'file' as const },
    { name: 'cover.png', kind: 'file' as const },
  ],
  '/card/games/hades': [{ name: 'hades.exe', kind: 'file' as const }],
};

let picker: FilePickerSurface;
let audio: FakeAudio;
let api: FakeFilePickerApi;
let results: ConfigPickResult[];

const rows = (): readonly string[] =>
  [...req('picker-entries').querySelectorAll('.picker-item')].map((item) => item.textContent ?? '');

const focusedRow = (): string | null =>
  req('picker-entries').querySelector('.picker-item.is-focused')?.textContent ?? null;

const focusedRoot = (): string | null =>
  req('picker-roots').querySelector('.picker-item.is-focused')?.textContent ?? null;

const focusIndex = (): number =>
  [...req('picker-entries').querySelectorAll('.picker-item')].findIndex((item) =>
    item.classList.contains('is-focused'),
  );

async function open(
  request: {
    kind?: ConfigPickKind;
    multi?: boolean;
    current?: string;
    root?: string;
    historyId?: string;
  } = {},
): Promise<void> {
  picker.open({
    root: request.root ?? '/card',
    kind: request.kind ?? 'executable',
    current: request.current ?? '',
    multi: request.multi ?? false,
    ...(request.historyId !== undefined ? { historyId: request.historyId } : {}),
    onDone: (result) => {
      results.push(result);
    },
  });
  await flushAsync();
}

/** Steps down until the named row holds the focus — rows differ per kind, so no index is hard-coded. */
function focusRow(label: string): void {
  const target = rows().indexOf(label);
  if (target === -1) throw new Error(`no row labelled ${label}`);
  for (let step = 0; step < rows().length; step += 1) {
    const at = focusIndex();
    if (at === target) return;
    if (at < target) picker.navDown();
    else picker.navUp();
  }
  throw new Error(`could not reach row ${label}`);
}

beforeEach(() => {
  loadFixture();
  installRafHarness();
  audio = fakeAudio();
  api = fakeFilePickerApi(TREE);
  results = [];
  picker = createFilePicker({ audio, getTranslator: () => createTranslator('en'), api });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('file picker opening', () => {
  it('shows the requested directory once main answers', async () => {
    picker.open({
      root: '/card',
      kind: 'executable',
      current: '',
      multi: false,
      onDone: () => undefined,
    });

    expect(rows()).toEqual([]);

    await flushAsync();

    expect(req('file-picker').classList.contains('is-open')).toBe(true);
    expect(req('picker-title').textContent).toBe('Choose');
    expect(req('picker-path').textContent).toBe('/card');
    expect(rows()).toEqual(['Cancel', 'games', 'game.json']);
  });

  it('lands the focus on the first real entry, past the action rows', async () => {
    await open();

    expect(focusedRow()).toBe('games');
  });

  it('offers "Use this folder" for a directory field only', async () => {
    await open({ kind: 'directory' });

    expect(rows()).toContain('Use this folder');
  });

  it('draws the roots column main travelled with the listing', async () => {
    await open();

    expect(
      [...req('picker-roots').querySelectorAll('.picker-item')].map((item) => item.textContent),
    ).toEqual(['Card']);
  });

  it('shows the failure message in place of a listing it could not read', async () => {
    api = fakeFilePickerApi(TREE, '/nowhere');
    picker = createFilePicker({ audio, getTranslator: () => createTranslator('en'), api });

    await open();

    expect(req('picker-path').textContent).toBe('no such directory: /nowhere');
    expect(rows()).toEqual([]);
  });
});

describe('file picker navigation', () => {
  it('moves the focus class down the column and stops at the end', async () => {
    await open();

    picker.navDown();
    expect(focusedRow()).toBe('game.json');

    picker.navDown();
    expect(focusedRow()).toBe('game.json');
    expect(audio.limits()).toBe(1);
  });

  it('switches columns left and right', async () => {
    await open();

    picker.navLeft();
    expect(focusedRoot()).toBe('Card');
    expect(focusedRow()).toBe(null);

    picker.navRight();
    expect(focusedRoot()).toBe(null);
    expect(focusedRow()).toBe('games');
  });

  it('jumps between the tree and the action rows with Y', async () => {
    await open();

    picker.navTertiary?.();
    expect(focusedRow()).toBe('Cancel');

    picker.navTertiary?.();
    expect(focusedRow()).toBe('games');
  });
});

describe('file picker walking the tree', () => {
  it('redraws the listing and the path on entering a directory', async () => {
    await open();

    picker.navActivate();
    await flushAsync();

    expect(req('picker-path').textContent).toBe('/card/games');
    expect(rows()).toEqual(['Cancel', 'Up one level', 'hades', 'run.exe', 'cover.png']);
    expect(api.listed).toEqual(['/card', '/card/games']);
  });

  it('goes back up a level and puts the focus on the folder it came out of', async () => {
    await open();
    picker.navActivate();
    await flushAsync();

    picker.navBack();
    await flushAsync();

    expect(req('picker-path').textContent).toBe('/card');
    expect(focusedRow()).toBe('games');
  });

  it('answers the dead-end sound at the top of the filesystem', async () => {
    await open();

    picker.navBack();
    await flushAsync();

    expect(audio.limits()).toBe(1);
    expect(api.listed).toEqual(['/card']);
  });
});

describe('file picker choosing', () => {
  it('hands the accepted path back and closes', async () => {
    await open();
    picker.navActivate();
    await flushAsync();
    focusRow('run.exe');

    picker.navActivate();
    await flushAsync();

    expect(api.accepted).toEqual([['/card/games/run.exe']]);
    expect(results).toEqual([{ ok: true, paths: ['/card/games/run.exe'] }]);
    expect(picker.isOpen()).toBe(false);
    expect(req('file-picker').classList.contains('is-open')).toBe(false);
  });

  it('stays open and shows why when main refuses the path', async () => {
    await open();
    api.acceptWith = () => ({ ok: false, message: 'Outside the card' });
    picker.navActivate();
    await flushAsync();
    focusRow('run.exe');

    picker.navActivate();
    await flushAsync();

    expect(req('picker-path').textContent).toBe('Outside the card');
    expect(results).toEqual([]);
    expect(picker.isOpen()).toBe(true);
    expect(audio.limits()).toBe(1);
  });

  it('refuses a file for a folder field', async () => {
    await open({ kind: 'directory' });
    focusRow('game.json');

    picker.navActivate();
    await flushAsync();

    expect(api.accepted).toEqual([]);
    expect(audio.limits()).toBe(1);
  });

  it('picks the directory it is standing in', async () => {
    await open({ kind: 'directory' });
    focusRow('Use this folder');

    picker.navActivate();
    await flushAsync();

    expect(api.accepted).toEqual([['/card']]);
  });

  it('reports a cancellation from the Cancel row', async () => {
    await open();
    focusRow('Cancel');

    picker.navActivate();
    await flushAsync();

    expect(results).toEqual([{ ok: false, cancelled: true }]);
    expect(picker.isOpen()).toBe(false);
  });
});

describe('file picker mouse', () => {
  it('takes the focus on hover once the mouse is awake', async () => {
    await open();
    const target = [...req('picker-entries').querySelectorAll<HTMLElement>('.picker-item')][2];

    if (target === undefined) throw new Error('the picker drew no entries');
    hoverOver(target);

    expect(focusedRow()).toBe('game.json');
  });

  it('ignores hover while the mouse is still asleep', async () => {
    await open();
    const target = [...req('picker-entries').querySelectorAll<HTMLElement>('.picker-item')][2];

    target?.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 300 }),
    );

    expect(focusedRow()).toBe('games');
  });

  it('cancels on a click into the veil', async () => {
    await open();

    req('file-picker').querySelector<HTMLElement>('.picker-veil')?.click();
    await flushAsync();

    expect(results).toEqual([{ ok: false, cancelled: true }]);
    expect(picker.isOpen()).toBe(false);
  });
});

describe('file picker multi-select', () => {
  it('ticks a file with X and marks it in the listing', async () => {
    await open({ kind: 'image', multi: true });
    picker.navActivate();
    await flushAsync();
    focusRow('cover.png');

    picker.navSecondary?.();

    expect(req('picker-entries').querySelectorAll('.is-picked')).toHaveLength(1);
    expect(rows().filter((row) => row === 'cover.png')).toHaveLength(1);
    expect(api.accepted).toEqual([]);
  });

  it('finishes with every ticked file plus the one activated', async () => {
    await open({ kind: 'image', multi: true });
    picker.navActivate();
    await flushAsync();
    focusRow('cover.png');
    picker.navSecondary?.();
    focusRow('run.exe');

    picker.navActivate();
    await flushAsync();

    expect(api.accepted).toEqual([['/card/games/cover.png', '/card/games/run.exe']]);
  });

  it('names the multi-select legend while it is open', async () => {
    await open({ kind: 'image', multi: true });

    expect(req('picker-legend').textContent).toContain('X - tick');
  });

  it('refuses to tick anything in a single-select picker', async () => {
    await open();

    picker.navSecondary?.();

    expect(req('picker-entries').querySelectorAll('.is-picked')).toHaveLength(0);
    expect(audio.limits()).toBe(1);
  });
});

describe('a picker that has to survive a slow main', () => {
  it("routes a HISTORY game's pick to the staging call, not to a root it has not got", async () => {
    await open({ kind: 'image', root: '', historyId: 'hades' });
    focusRow('games');
    picker.navActivate();
    await flushAsync();
    focusRow('cover.png');

    picker.navActivate();
    await flushAsync();

    expect(api.accepted).toEqual([['/card/games/cover.png']]);
    expect(api.viaHistoryId).toEqual(['hades']);
  });

  it('imports once for a double press — the second A is refused while the first is in flight', async () => {
    let release: () => void = () => undefined;
    api.acceptWith = (paths) => ({ ok: true, paths });
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = api.acceptPaths.bind(api);
    api.acceptPaths = async (request) => {
      await slow;
      return original(request);
    };

    await open({ kind: 'image' });
    focusRow('games');
    picker.navActivate();
    await flushAsync();
    focusRow('cover.png');

    picker.navActivate();
    picker.navActivate();
    release();
    await flushAsync();

    expect(api.accepted).toHaveLength(1);
    expect(results).toHaveLength(1);
  });

  it('does not paint a listing that belongs to the visit before this one', async () => {
    // The first open's listing is held back; the picker is reopened for another field meanwhile. The late
    // answer names the OLD root, and painting it would drop that directory over the one on screen.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = api.listDir.bind(api);
    let call = 0;
    api.listDir = async (request) => {
      call += 1;
      if (call === 1) {
        const stale = await original(request);
        await held;
        return stale;
      }
      return await original({ ...request, path: '/card/games' });
    };

    picker.open({
      root: '/card',
      kind: 'executable',
      current: '',
      multi: false,
      onDone: () => undefined,
    });
    await open({ kind: 'image' });
    expect(rows()).toContain('cover.png');

    release();
    await flushAsync();

    expect(rows()).toContain('cover.png');
    expect(rows()).not.toContain('game.json');
  });
});
