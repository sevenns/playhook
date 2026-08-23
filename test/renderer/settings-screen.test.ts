import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsScreen, type SettingsScreen } from '../../src/renderer/settings-screen';
import { req } from '../../src/renderer/dom';
import { createTranslator } from '../../src/shared/i18n/index';
import { DEFAULT_SETTINGS } from '../../src/main/app-settings';
import type { AppSettings } from '../../src/shared/types';
import type { SettingsScreenApi } from '../../src/renderer/settings-screen';
import { hoverOver, loadFixture } from './helpers/fixture';
import {
  fakeAudio,
  fakeKeyboard,
  fakeSettingsApi,
  type FakeAudio,
  type FakeKeyboard,
} from './helpers/fakes';
import { installRafHarness, type RafHarness } from './helpers/raf';

/** The dropdown paints, then re-measures its marquee on the next frame — two is what a full open takes. */
const OPEN_FRAMES = 2;

const AUDIO_OPTIONS = {
  soundSets: ['playhook-abyss', 'ps5'],
  ambientTracks: ['deep-space.mp3', 'playhook-abyss.mp3'],
};

let screen: SettingsScreen;
let audio: FakeAudio;
let keyboard: FakeKeyboard;
let api: SettingsScreenApi;
let raf: RafHarness;
let closed: number;

const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});

const sections = (): readonly string[] =>
  [...req('settings-nav').children].map((entry) => entry.textContent ?? '');

const focusedSection = (): string | null =>
  req('settings-nav').querySelector('.is-focused')?.textContent ?? null;

const rows = (): readonly HTMLElement[] => [
  ...req('settings-list').querySelectorAll<HTMLElement>('.setting-row'),
];

const rowLabels = (): readonly string[] =>
  rows().map((row) => row.querySelector('.setting-label')?.textContent ?? '');

const focusedRowLabel = (): string | null =>
  req('settings-list').querySelector('.setting-row.is-focused .setting-label')?.textContent ?? null;

const rowOf = (label: string): HTMLElement => {
  const row = rows().find((entry) => entry.querySelector('.setting-label')?.textContent === label);
  if (row === undefined) throw new Error(`no row labelled ${label}`);
  return row;
};

const valueOf = (label: string): string =>
  rowOf(label).querySelector('.setting-value')?.textContent ?? '';

const isOn = (label: string): boolean =>
  rowOf(label).querySelector('.setting-toggle')?.classList.contains('is-on') ?? false;

const options = (): readonly string[] =>
  [...req('settings-options-list').querySelectorAll('.settings-option')].map(
    (option) => option.textContent ?? '',
  );

const focusedOption = (): string | null =>
  req('settings-options-list').querySelector('.settings-option.is-focused')?.textContent ?? null;

/** Opens the screen the way app.ts does: open(), then the pushed snapshot and environment. */
function openWith(overrides: Partial<AppSettings> = {}): void {
  screen.open();
  screen.applyEnv({ steamAvailable: true, audioOptions: AUDIO_OPTIONS, appVersion: '0.8.0' });
  screen.applySettings(settings(overrides));
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

function focusRow(label: string): void {
  for (let step = 0; step < rows().length; step += 1) {
    if (focusedRowLabel() === label) return;
    screen.navDown();
  }
  throw new Error(`could not reach row ${label}`);
}

beforeEach(() => {
  loadFixture();
  raf = installRafHarness();
  audio = fakeAudio();
  keyboard = fakeKeyboard();
  api = fakeSettingsApi();
  closed = 0;
  screen = createSettingsScreen({
    audio,
    getTranslator: () => createTranslator('en'),
    api,
    keyboard,
    onClosed: () => {
      closed += 1;
    },
    onResetRequested: () => undefined,
  });
});

afterEach(() => {
  screen.close();
  vi.unstubAllGlobals();
});

describe('settings opening', () => {
  it('waits for the first snapshot before drawing anything but the loading line', () => {
    screen.open();

    expect(req('app').dataset['overlay']).toBe('settings');
    expect(req('settings').getAttribute('aria-hidden')).toBe('false');
    expect(req('settings-list').textContent).toBe('Loading...');
  });

  it('draws the column and the first section once the snapshot lands', () => {
    openWith();

    expect(sections()).toEqual([
      'Updates',
      'Language',
      'General',
      'Game metadata',
      'Audio',
      'Reset to defaults',
      'Close',
    ]);
    expect(focusedSection()).toBe('Updates');
    expect(rowLabels()).toContain('Automatic updates');
  });

  it('keeps the focus on the column, not in the pane', () => {
    openWith();

    expect(focusedRowLabel()).toBe(null);
    expect(req('settings-list').classList.contains('is-active')).toBe(false);
  });

  it('shows the version the environment pushed', () => {
    openWith();

    expect(req('settings-version').textContent).toBe('0.8.0');
  });
});

describe('settings section navigation', () => {
  it('replaces the pane with the section the column steps into', () => {
    openWith();

    enterSection('Audio');

    expect(rowLabels()).toEqual([
      'Navigation sounds',
      'Navigation sounds volume',
      'Background ambience',
      'Only global ambience',
      'Ambience volume',
    ]);
    expect(focusedRowLabel()).toBe('Navigation sounds');
    expect(req('settings-list').classList.contains('is-active')).toBe(true);
  });

  it('moves the row focus with the DOM in step and stops at the last row', () => {
    openWith();
    enterSection('Audio');

    screen.navDown();
    expect(focusedRowLabel()).toBe('Navigation sounds volume');

    for (let step = 0; step < 5; step += 1) screen.navDown();

    expect(focusedRowLabel()).toBe('Ambience volume');
    expect(audio.limits()).toBeGreaterThan(0);
  });

  it('hands the focus back to the column on back, keeping the pane drawn', () => {
    openWith();
    enterSection('Audio');

    screen.navBack();

    expect(focusedRowLabel()).toBe(null);
    expect(focusedSection()).toBe('Audio');
    expect(rowLabels()).toContain('Navigation sounds');
  });
});

describe('settings toggles', () => {
  it('flips the checkbox, persists it and repaints the row', () => {
    openWith({ onlyGlobalAmbient: false });
    enterSection('Audio');
    focusRow('Only global ambience');

    screen.navActivate();

    expect(api.setOnlyGlobalAmbient).toHaveBeenCalledWith(true);
    expect(isOn('Only global ambience')).toBe(true);
  });

  it('refuses to step a checkbox sideways', () => {
    openWith({ onlyGlobalAmbient: false });
    enterSection('Audio');
    focusRow('Only global ambience');

    screen.navRight();

    expect(api.setOnlyGlobalAmbient).not.toHaveBeenCalled();
    expect(isOn('Only global ambience')).toBe(false);
  });
});

describe('settings dropdowns', () => {
  it('cycles a value sideways without expanding the list', () => {
    openWith({ soundSet: 'playhook-abyss' });
    enterSection('Audio');
    focusRow('Navigation sounds');

    screen.navRight();

    expect(api.setSoundSet).toHaveBeenCalledWith('ps5');
    expect(valueOf('Navigation sounds')).toBe('Ps5');
    expect(req('settings-options').classList.contains('is-open')).toBe(false);
  });

  it('expands the list focused on the current value', () => {
    openWith({ soundSet: 'ps5' });
    enterSection('Audio');
    focusRow('Navigation sounds');

    screen.navActivate();
    raf.flush(OPEN_FRAMES);

    expect(req('settings-options').classList.contains('is-open')).toBe(true);
    expect(options()).toEqual(['Playhook Abyss', 'Ps5']);
    expect(focusedOption()).toBe('Ps5');
  });

  it('picks the option the focus is on and closes the list', () => {
    openWith({ soundSet: 'ps5' });
    enterSection('Audio');
    focusRow('Navigation sounds');
    screen.navActivate();
    raf.flush(OPEN_FRAMES);

    screen.navUp();
    screen.navActivate();
    raf.flush(OPEN_FRAMES);

    expect(api.setSoundSet).toHaveBeenCalledWith('playhook-abyss');
    expect(valueOf('Navigation sounds')).toBe('Playhook Abyss');
    expect(req('settings-options').classList.contains('is-open')).toBe(false);
  });

  it('leaves the list without changing anything on back', () => {
    openWith({ soundSet: 'ps5' });
    enterSection('Audio');
    focusRow('Navigation sounds');
    screen.navActivate();
    raf.flush(OPEN_FRAMES);

    screen.navBack();
    raf.flush(OPEN_FRAMES);

    expect(req('settings-options').classList.contains('is-open')).toBe(false);
    expect(api.setSoundSet).not.toHaveBeenCalled();
    expect(focusedRowLabel()).toBe('Navigation sounds');
  });
});

describe('settings sliders', () => {
  it('steps the value with left and right and persists each step', () => {
    openWith({ sfxVolume: 0.5 });
    enterSection('Audio');
    focusRow('Navigation sounds volume');
    raf.advance(200);

    screen.navRight();

    expect(valueOf('Navigation sounds volume')).toBe('55%');
    expect(api.setSfxVolume).toHaveBeenCalledWith(0.55);

    raf.advance(200);
    screen.navLeft();

    expect(valueOf('Navigation sounds volume')).toBe('50%');
  });

  it('stops at the ends with the dead-end sound', () => {
    openWith({ sfxVolume: 1 });
    enterSection('Audio');
    focusRow('Navigation sounds volume');

    screen.navRight();

    expect(valueOf('Navigation sounds volume')).toBe('100%');
    expect(audio.limits()).toBe(1);
  });

  it('has nothing for A to press', () => {
    openWith({ sfxVolume: 0.5 });
    enterSection('Audio');
    focusRow('Navigation sounds volume');

    screen.navActivate();

    expect(audio.limits()).toBe(1);
    expect(valueOf('Navigation sounds volume')).toBe('50%');
  });
});

describe('settings text field', () => {
  it('opens the keyboard on the real key and writes back what it commits', () => {
    openWith({ steamGridDbApiKey: 'abcdef1234567890' });
    enterSection('Game metadata');
    focusRow('SteamGridDB API key');

    screen.navActivate();

    expect(keyboard.last().value).toBe('abcdef1234567890');

    keyboard.commit('  fresh-key  ');

    expect(api.setSteamGridDbKey).toHaveBeenCalledWith('fresh-key');
    expect(valueOf('SteamGridDB API key')).toBe('••••••••-key');
  });

  it('routes navigation into the keyboard while it is up', () => {
    openWith();
    enterSection('Game metadata');
    focusRow('SteamGridDB API key');
    screen.navActivate();
    const before = focusedRowLabel();

    screen.navDown();

    expect(focusedRowLabel()).toBe(before);
  });
});

describe('settings mouse', () => {
  it('takes the row focus on hover once the mouse is awake', () => {
    openWith();
    enterSection('Audio');
    const target = rowOf('Background ambience');

    hoverOver(target);

    expect(focusedRowLabel()).toBe('Background ambience');
  });

  it('ignores hover while the mouse is still asleep', () => {
    openWith();
    enterSection('Audio');
    const target = rowOf('Background ambience');

    target.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 300 }),
    );

    expect(focusedRowLabel()).toBe('Navigation sounds');
  });

  it('moves the option focus on hover inside the expanded list', () => {
    openWith({ soundSet: 'playhook-abyss' });
    enterSection('Audio');
    focusRow('Navigation sounds');
    screen.navActivate();
    raf.flush(OPEN_FRAMES);
    const option = [...req('settings-options-list').querySelectorAll('.settings-option')][1];

    if (option === undefined) throw new Error('the dropdown drew no options');
    hoverOver(option);

    expect(focusedOption()).toBe('Ps5');
  });

  it('closes the expanded list on a click into its veil', () => {
    openWith();
    enterSection('Audio');
    focusRow('Navigation sounds');
    screen.navActivate();
    raf.flush(OPEN_FRAMES);

    req('settings-options').querySelector<HTMLElement>('.settings-options-veil')?.click();

    expect(req('settings-options').classList.contains('is-open')).toBe(false);
  });
});

describe('settings closing', () => {
  it('leaves the screen from the column and reports it', () => {
    openWith();

    screen.navBack();

    expect(screen.isOpen()).toBe(false);
    expect(closed).toBe(1);
    expect(req('app').dataset['overlay']).toBeUndefined();
    expect(req('settings').getAttribute('aria-hidden')).toBe('true');
  });

  it('takes the expanded dropdown and the keyboard with it', () => {
    openWith();
    enterSection('Audio');
    focusRow('Navigation sounds');
    screen.navActivate();
    raf.flush(OPEN_FRAMES);

    screen.close();

    expect(req('settings-options').classList.contains('is-open')).toBe(false);
    expect(keyboard.isOpen()).toBe(false);
  });

  it('re-opens on the first section rather than where the last visit ended', () => {
    openWith();
    enterSection('Audio');
    screen.close();

    openWith();

    expect(focusedSection()).toBe('Updates');
    expect(rowLabels()).toContain('Automatic updates');
  });
});
