import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGameSettingsScreen,
  type GameSettingsConfirm,
  type GameSettingsScreen,
  type GameSettingsScreenApi,
} from '../../src/renderer/game-settings-screen';
import { req } from '../../src/renderer/dom';
import { createTranslator } from '../../src/shared/i18n/index';
import { loadFixture } from './helpers/fixture';
import {
  fakeAudio,
  fakeGameSettingsApi,
  fakeKeyboard,
  fakeOnlinePicker,
  fakePicker,
  type FakeAudio,
  type FakeKeyboard,
  type FakePicker,
} from './helpers/fakes';
import { flushAsync } from './helpers/async';
import { installRafHarness, type RafHarness } from './helpers/raf';

const HADES = { schemaVersion: 1, id: 'hades', title: 'Hades', executable: 'Hades.exe' };
const BASTION = { schemaVersion: 1, id: 'bastion', title: 'Bastion', executable: 'Bastion.exe' };

/** The manifest exactly as the form serializes it back, so an untouched screen is not dirty. */
const manifest = (games: readonly unknown[]): string =>
  `${JSON.stringify(games.length === 1 ? games[0] : games, null, 2)}\n`;

const READ_OK = {
  ok: true,
  root: 'E:\\',
  source: 'card',
  signature: 'a|b',
  text: manifest([HADES, BASTION]),
  platform: 'windows',
} as const;

const ROOT_OK = {
  ok: true,
  root: 'E:\\',
  source: 'card',
  signature: 'a|b',
  hasManifest: false,
  text: '',
  platform: 'windows',
} as const;

const CARD = {
  root: 'E:\\',
  label: 'Card',
  kind: 'card',
  signature: 'a|b',
  hasManifest: false,
  isActive: true,
} as const;

/** A menu paints, then re-measures its marquee on the next frame — two is what a full open takes. */
const OPEN_FRAMES = 2;

let screen: GameSettingsScreen;
/** Every instance this test made, so `afterEach` closes what exists rather than a leftover from before. */
const live: GameSettingsScreen[] = [];
let audio: FakeAudio;
let keyboard: FakeKeyboard;
let picker: FakePicker;
let api: GameSettingsScreenApi;
let raf: RafHarness;
let confirms: { readonly kind: GameSettingsConfirm; readonly title?: string }[];
let errors: string[];
let notes: string[];
let closed: number;

const sections = (): readonly string[] =>
  [...req('game-settings-nav').children].map((entry) => entry.textContent ?? '');

const focusedSection = (): string | null =>
  req('game-settings-nav').querySelector('.is-focused')?.textContent ?? null;

const rows = (): readonly HTMLElement[] => [
  ...req('game-settings-list').querySelectorAll<HTMLElement>('.setting-row'),
];

const rowLabels = (): readonly string[] =>
  rows().map((row) => row.querySelector('.setting-label')?.textContent ?? '');

const focusedRowLabel = (): string | null =>
  req('game-settings-list').querySelector('.setting-row.is-focused .setting-label')?.textContent ??
  null;

const rowOf = (label: string): HTMLElement => {
  const row = rows().find((entry) => entry.querySelector('.setting-label')?.textContent === label);
  if (row === undefined) throw new Error(`no row labelled ${label}`);
  return row;
};

const valueOf = (label: string): string =>
  rowOf(label).querySelector('.setting-value')?.textContent ?? '';

const menuEntries = (): readonly string[] =>
  [...req('game-settings-options-list').querySelectorAll('.settings-option')].map(
    (entry) => entry.textContent ?? '',
  );

const status = (): string => req('game-settings-status').textContent ?? '';

function createScreen(overrides: Partial<GameSettingsScreenApi> = {}): void {
  api = fakeGameSettingsApi({ read: vi.fn(() => Promise.resolve(READ_OK)), ...overrides });
  const instance = createGameSettingsScreen({
    audio,
    getTranslator: () => createTranslator('en'),
    api,
    keyboard,
    picker,
    onlinePicker: fakeOnlinePicker(),
    onClosed: () => {
      closed += 1;
    },
    onConfirmRequested: (kind, options) => {
      confirms.push({ kind, ...(options?.title !== undefined ? { title: options.title } : {}) });
    },
    isBusy: () => false,
    onAdded: () => undefined,
    notify: (text) => {
      notes.push(text);
    },
    showError: (text) => {
      errors.push(text);
    },
  });
  live.push(instance);
  screen = instance;
}

async function open(overrides: Partial<GameSettingsScreenApi> = {}): Promise<void> {
  createScreen(overrides);
  screen.open('hades');
  await flushAsync();
}

/** The same screen opened for a game whose card is not in (see history-config.ts). */
async function openFromHistory(overrides: Partial<GameSettingsScreenApi> = {}): Promise<void> {
  createScreen({
    readHistory: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        id: 'hades',
        text: manifest([HADES]),
        platform: 'windows' as const,
      }),
    ),
    ...overrides,
  });
  screen.openFromHistory('hades');
  await flushAsync();
}

/** Moves the column onto a section and steps into its pane. */
function enterSection(title: string): void {
  for (let step = 0; step < sections().length; step += 1) {
    if (focusedSection() === title) break;
    screen.navDown();
  }
  if (focusedSection() !== title) throw new Error(`no section named ${title}`);
  screen.navActivate();
}

function focusColumn(title: string): void {
  if (focusedRowLabel() !== null) screen.navBack();
  for (let step = 0; step < sections().length; step += 1) {
    if (focusedSection() === title) return;
    screen.navDown();
  }
  throw new Error(`no column entry named ${title}`);
}

function focusRow(label: string): void {
  for (let step = 0; step < rows().length; step += 1) {
    if (focusedRowLabel() === label) return;
    screen.navDown();
  }
  throw new Error(`could not reach row ${label}`);
}

function focusMenuEntry(label: string): void {
  for (let step = 0; step < menuEntries().length; step += 1) {
    const focused = req('game-settings-options-list').querySelector('.settings-option.is-focused');
    if (focused?.textContent === label) return;
    screen.navDown();
  }
  throw new Error(`could not reach menu entry ${label}`);
}

beforeEach(() => {
  loadFixture();
  raf = installRafHarness();
  audio = fakeAudio();
  keyboard = fakeKeyboard();
  picker = fakePicker();
  confirms = [];
  errors = [];
  notes = [];
  closed = 0;
});

afterEach(() => {
  for (const instance of live) instance.close();
  live.length = 0;
  vi.unstubAllGlobals();
});

describe('customize screen opening', () => {
  it('shows the loading line until the manifest read lands', () => {
    createScreen();

    screen.open('hades');

    expect(req('app').dataset['overlay']).toBe('game-settings');
    expect(req('game-settings-list').textContent).toBe('Reading the manifest...');
    expect(rows()).toHaveLength(0);
  });

  it('draws the column and the first section once the manifest arrives', async () => {
    await open();

    expect(req('game-settings-title').textContent).toBe('Customize');
    expect(req('game-settings-heading').textContent).toBe('Hades');
    expect(sections()).toContain('Basics');
    expect(rowLabels()).toContain('Title');
    expect(valueOf('Title')).toBe('Hades');
  });

  it('reports a manifest it could not read instead of an empty form', async () => {
    await open({
      read: vi.fn(() => Promise.resolve({ ok: false, message: 'Card removed' } as const)),
    });

    expect(req('game-settings-list').textContent).toContain('Card removed');
    expect(rows()).toHaveLength(0);
  });

  it('opens an empty form in add mode without reading a game', async () => {
    createScreen({
      sources: vi.fn(() => Promise.resolve([CARD])),
      readRoot: vi.fn(() => Promise.resolve(ROOT_OK)),
    });

    screen.openNew();
    await flushAsync();

    expect(req('game-settings-title').textContent).toBe('Add game');
    expect(api.read).not.toHaveBeenCalled();
    expect(valueOf('Title')).toBe('not set');
    expect(rowOf('Title').querySelector('.setting-value')?.classList.contains('is-empty')).toBe(
      true,
    );
  });
});

describe('customize screen navigation', () => {
  it('replaces the pane with the section the column steps into', async () => {
    await open();

    enterSection('Artwork');

    expect(rowLabels()).toEqual(['Backgrounds', 'Card artwork']);
    expect(req('game-settings-list').classList.contains('is-active')).toBe(true);
  });

  it('moves the row focus in step with the DOM', async () => {
    await open();
    enterSection('Basics');

    screen.navDown();

    expect(focusedRowLabel()).toBe('Id');
    expect(req('game-settings-list').querySelectorAll('.setting-row.is-focused')).toHaveLength(1);
  });

  it('hands the focus back to the column on back', async () => {
    await open();
    enterSection('Basics');

    screen.navBack();

    expect(focusedRowLabel()).toBe(null);
    expect(focusedSection()).toBe('Basics');
  });
});

describe('customize screen text fields', () => {
  it('opens the keyboard on the field value and writes back what it commits', async () => {
    await open();
    enterSection('Basics');
    focusRow('Title');

    screen.navActivate();

    expect(keyboard.last().value).toBe('Hades');
    expect(keyboard.last().title).toBe('Title');
    expect(keyboard.last().mode).toBe('text');

    keyboard.commit('Hades II');
    await flushAsync();

    expect(valueOf('Title')).toBe('Hades II');
    expect(screen.isDirty()).toBe(true);
  });

  it('asks for the id in the mode the manifest schema accepts', async () => {
    await open();
    enterSection('Basics');
    focusRow('Id');

    screen.navActivate();

    expect(keyboard.last().mode).toBe('id');
  });

  it('leaves the form untouched when the keyboard is cancelled', async () => {
    await open();
    enterSection('Basics');
    focusRow('Title');
    screen.navActivate();

    keyboard.cancel();
    await flushAsync();

    expect(valueOf('Title')).toBe('Hades');
    expect(screen.isDirty()).toBe(false);
  });
});

describe('customize screen file picking', () => {
  it('browses from a path row and writes the picked path into it', async () => {
    await open();
    enterSection('Launch');
    focusRow('Executable');

    screen.navActivate();
    raf.flush(OPEN_FRAMES);
    expect(menuEntries()).toContain('Browse...');

    focusMenuEntry('Browse...');
    screen.navActivate();
    await flushAsync();

    expect(picker.last().kind).toBe('executable');
    expect(picker.last().multi).toBe(false);

    picker.done({ ok: true, paths: ['bin/Hades.exe'] });
    await flushAsync();

    expect(valueOf('Executable')).toBe('bin/Hades.exe');
    expect(req('game-settings-options').classList.contains('is-open')).toBe(false);
  });

  it('shows the reason main refused a path and keeps the form as it was', async () => {
    await open();
    enterSection('Launch');
    focusRow('Executable');
    screen.navActivate();
    raf.flush(OPEN_FRAMES);
    focusMenuEntry('Browse...');
    screen.navActivate();
    await flushAsync();

    picker.done({ ok: false, message: 'Outside the card' });
    await flushAsync();

    expect(errors).toEqual(['Outside the card']);
    expect(valueOf('Executable')).toBe('Hades.exe');
  });

  it('changes nothing when the browse is cancelled', async () => {
    await open();
    enterSection('Launch');
    focusRow('Executable');
    screen.navActivate();
    raf.flush(OPEN_FRAMES);
    focusMenuEntry('Browse...');
    screen.navActivate();
    await flushAsync();

    picker.done({ ok: false, cancelled: true });
    await flushAsync();

    expect(errors).toEqual([]);
    expect(screen.isDirty()).toBe(false);
  });
});

describe('customize screen saving', () => {
  it('says what is in flight and reports the result through the plate', async () => {
    await open();
    enterSection('Basics');
    focusRow('Title');
    screen.navActivate();
    keyboard.commit('Hades II');
    await flushAsync();

    focusColumn('Save');
    screen.navActivate();

    expect(status()).toContain('Saving...');

    await flushAsync();

    expect(api.save).toHaveBeenCalled();
    expect(notes).toEqual(['Saved and applied.']);
    expect(status()).toBe('');
    expect(screen.isDirty()).toBe(false);
  });

  it('holds a failed save in the error popup and clears the status line', async () => {
    await open({
      save: vi.fn(() => Promise.resolve({ saved: false, message: 'Card is read-only' } as const)),
    });
    enterSection('Basics');
    focusRow('Title');
    screen.navActivate();
    keyboard.commit('Hades II');
    await flushAsync();

    focusColumn('Save');
    screen.navActivate();
    await flushAsync();

    expect(errors).toEqual(['Card is read-only']);
    expect(status()).toBe('');
    expect(screen.isDirty()).toBe(true);
  });
});

describe('customize screen confirmations', () => {
  it('asks before deleting and writes the manifest without the game once it is answered', async () => {
    await open();
    focusColumn('Delete game');

    screen.navActivate();

    expect(confirms).toEqual([{ kind: 'delete' }]);
    expect(api.save).not.toHaveBeenCalled();

    screen.confirmAccepted('delete');
    await flushAsync();

    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({ root: 'E:\\', signature: 'a|b', text: manifest([BASTION]) }),
    );
    expect(screen.isOpen()).toBe(false);
    expect(closed).toBe(1);
  });

  it('drops the history record only when that is what was answered', async () => {
    await open();
    focusColumn('Delete game');
    screen.navActivate();

    screen.confirmAccepted('delete-history');
    await flushAsync();

    expect(api.forgetHistory).toHaveBeenCalledWith('hades');
  });

  it('asks before leaving with unsaved edits and closes once that is answered', async () => {
    await open();
    enterSection('Basics');
    focusRow('Title');
    screen.navActivate();
    keyboard.commit('Hades II');
    await flushAsync();
    screen.navBack();

    screen.navBack();

    expect(confirms).toEqual([{ kind: 'discard' }]);
    expect(screen.isOpen()).toBe(true);

    screen.confirmAccepted('discard');

    expect(screen.isOpen()).toBe(false);
    expect(closed).toBe(1);
  });

  it('puts the form back as it was read when a reset is answered', async () => {
    await open();
    enterSection('Basics');
    focusRow('Title');
    screen.navActivate();
    keyboard.commit('Hades II');
    await flushAsync();

    screen.confirmAccepted('reset');
    await flushAsync();

    expect(valueOf('Title')).toBe('Hades');
    expect(screen.isDirty()).toBe(false);
  });
});

describe('customize screen closing', () => {
  it('leaves without asking when nothing was edited', async () => {
    await open();

    screen.navBack();

    expect(confirms).toEqual([]);
    expect(screen.isOpen()).toBe(false);
    expect(req('app').dataset['overlay']).toBeUndefined();
  });

  it('takes its open menu and the keyboard with it', async () => {
    await open();
    enterSection('Launch');
    focusRow('Executable');
    screen.navActivate();
    raf.flush(OPEN_FRAMES);

    screen.close();

    expect(req('game-settings-options').classList.contains('is-open')).toBe(false);
    expect(keyboard.isOpen()).toBe(false);
  });
});

describe('customize screen for a game from the history', () => {
  it('reads the stored manifest instead of a card and shows the game', async () => {
    await openFromHistory();

    expect(api.readHistory).toHaveBeenCalledWith('hades');
    expect(api.read).not.toHaveBeenCalled();
    expect(screen.isOpen()).toBe(true);
    enterSection('Basics');
    expect(valueOf('Title')).toBe('Hades');
  });

  it('refuses to open a game the history has nothing stored for', async () => {
    await openFromHistory({
      readHistory: vi.fn(() => Promise.resolve({ ok: false as const, message: 'No settings stored' })),
    });

    expect(rowLabels()).toEqual([]);
    expect(req('game-settings-list').textContent).toContain('No settings stored');
  });

  it('shows a card-bound field with its value but refuses to open it', async () => {
    await openFromHistory();

    enterSection('Launch');
    expect(valueOf('Executable')).toBe('Hades.exe');
    expect(rowOf('Executable').classList.contains('is-disabled')).toBe(true);

    focusRow('Executable');
    screen.navActivate();
    raf.flush(OPEN_FRAMES);

    expect(req('game-settings-options').classList.contains('is-open')).toBe(false);
  });

  it('leaves the artwork rows editable — they are the point of the feature', async () => {
    await openFromHistory();

    enterSection('Artwork');
    expect(rowOf('Card artwork').classList.contains('is-disabled')).toBe(false);
  });

  it('stages a picked file through the history instead of measuring it against a card', async () => {
    await openFromHistory();
    enterSection('Artwork');
    focusRow('Card artwork');
    screen.navActivate();
    raf.flush(OPEN_FRAMES);
    focusMenuEntry('Browse...');
    screen.navActivate();
    await flushAsync();

    expect(picker.last().historyId).toBe('hades');
    picker.done({ ok: true, paths: ['assets/cover.png'] });
    await flushAsync();

    // An artwork row draws a thumbnail rather than its path, so the value it holds is read off the form.
    expect(screen.isDirty()).toBe(true);
    expect(api.historyAssetPreview).toHaveBeenCalledWith('hades', 'assets/cover.png');
  });

  it('saves through the history channel, and reports it as waiting for the card', async () => {
    await openFromHistory();
    enterSection('Basics');
    focusRow('Title');
    screen.navActivate();
    keyboard.commit('Hades (mine)');
    await flushAsync();

    focusColumn('Save');
    screen.navActivate();
    await flushAsync();

    const saved = vi.mocked(api.saveHistory).mock.calls[0]?.[0];
    expect(saved?.id).toBe('hades');
    expect(saved?.text).toContain('Hades (mine)');
    expect(api.save).not.toHaveBeenCalled();
    expect(screen.isDirty()).toBe(false);
  });

  it('stays open when the card shows up mid-edit rather than discarding the edits', async () => {
    await openFromHistory();
    enterSection('Basics');
    focusRow('Title');
    screen.navActivate();
    keyboard.commit('Hades (mine)');
    await flushAsync();

    screen.applyBrowse({
      id: 'hades',
      title: 'Hades',
      active: true,
      stats: { schemaVersion: 1, totalPlaySeconds: 0, lastPlayedAt: null, launchCount: 0 },
    });

    expect(screen.isOpen()).toBe(true);
    expect(screen.isDirty()).toBe(true);
  });

  it('offers neither Delete nor Move to card — both act on a card that is not here', async () => {
    await openFromHistory();

    expect(sections()).not.toContain('Delete game');
    expect(sections()).not.toContain('Move to card...');
  });
});
