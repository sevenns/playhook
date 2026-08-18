// buildSettingsModel — the Settings screen's composition. The view and the screen controller are DOM
// code (vitest runs in plain node, no jsdom), so everything that decides WHAT is on the screen lives
// here and is covered here: section/row order, the Steam row's conditional presence, and the value
// mapping from AppSettings (volumes as percent, a null ambience as the "no ambience" option).
import { describe, it, expect } from 'vitest';
import {
  buildSettingsModel,
  prettifyName,
  volumePercent,
  type SettingsEnv,
  type SettingsRow,
} from '../src/renderer/settings-form-model';
import { DEFAULT_SETTINGS } from '../src/main/app-settings';
import type { AppSettings } from '../src/shared/types';

const env = (overrides: Partial<SettingsEnv> = {}): SettingsEnv => ({
  steamAvailable: false,
  audioOptions: { soundSets: ['winhanced', 'ps5'], ambientTracks: ['deep-space.mp3'] },
  appVersion: '0.8.0',
  updateStatus: { kind: 'idle' },
  ...overrides,
});

const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});

const rowIds = (rows: readonly SettingsRow[]): readonly string[] =>
  rows.map((row) => (row.kind === 'update-status' ? 'update-status' : row.id));

describe('buildSettingsModel — composition', () => {
  it('lays the sections out in screen order', () => {
    const model = buildSettingsModel(settings(), env());
    expect(model.sections.map((section) => section.titleKey)).toEqual([
      'settings.sectionUpdates',
      'settings.sectionLanguage',
      'settings.sectionGeneral',
      'settings.sectionAudio',
      // The action stack closing the screen carries no title — see buildSettingsModel.
      undefined,
    ]);
  });

  it('opens Updates with the status row, then the mode and the beta toggle', () => {
    const model = buildSettingsModel(settings(), env());
    expect(rowIds(model.sections[0]?.rows ?? [])).toEqual([
      'update-status',
      'autoUpdate',
      'prerelease',
    ]);
  });

  it('carries the current update status into the status row', () => {
    const model = buildSettingsModel(
      settings(),
      env({ updateStatus: { kind: 'downloading', percent: 42 } }),
    );
    const row = model.sections[0]?.rows[0];
    expect(row?.kind).toBe('update-status');
    if (row?.kind === 'update-status')
      expect(row.status).toEqual({ kind: 'downloading', percent: 42 });
  });

  it('omits the Steam auto-launch row where the feature does not exist', () => {
    const model = buildSettingsModel(settings(), env({ steamAvailable: false }));
    const general = model.sections.find(
      (section) => section.titleKey === 'settings.sectionGeneral',
    );
    expect(rowIds(general?.rows ?? [])).not.toContain('steamAutoLaunch');
  });

  it('includes it (last in General) where it does', () => {
    const model = buildSettingsModel(settings(), env({ steamAvailable: true }));
    const general = model.sections.find(
      (section) => section.titleKey === 'settings.sectionGeneral',
    );
    expect(rowIds(general?.rows ?? [])).toEqual([
      'summonHotkey',
      'preventScreensaver',
      'keepOpenWithoutCard',
      'disableSilentInstall',
      'steamAutoLaunch',
    ]);
  });

  it('closes with the untitled action stack: reset over close', () => {
    const model = buildSettingsModel(settings(), env());
    const last = model.sections[model.sections.length - 1];
    expect(last?.titleKey).toBeUndefined();
    expect(rowIds(last?.rows ?? [])).toEqual(['reset', 'close']);
  });

  it('carries the app version through', () => {
    expect(buildSettingsModel(settings(), env({ appVersion: '1.2.3' })).appVersion).toBe('1.2.3');
  });
});

describe('buildSettingsModel — value mapping', () => {
  it('shows volumes as whole percents', () => {
    const model = buildSettingsModel(settings({ sfxVolume: 0.35, musicVolume: 1 }), env());
    const audio = model.sections.find((section) => section.titleKey === 'settings.sectionAudio');
    const sfx = audio?.rows.find((row) => row.kind === 'slider' && row.id === 'sfxVolume');
    const music = audio?.rows.find((row) => row.kind === 'slider' && row.id === 'musicVolume');
    expect(sfx?.kind === 'slider' ? sfx.percent : null).toBe(35);
    expect(music?.kind === 'slider' ? music.percent : null).toBe(100);
  });

  it('maps a null ambience onto the "no ambience" option', () => {
    const model = buildSettingsModel(settings({ ambientTrack: null }), env());
    const audio = model.sections.find((section) => section.titleKey === 'settings.sectionAudio');
    const ambient = audio?.rows.find((row) => row.kind === 'select' && row.id === 'ambientTrack');
    expect(ambient?.kind === 'select' ? ambient.value : null).toBe('');
    expect(ambient?.kind === 'select' ? ambient.options[0] : null).toEqual({
      value: '',
      labelKey: 'settings.ambientNone',
    });
  });

  it('offers every bundled sound set, prettified', () => {
    const model = buildSettingsModel(settings(), env());
    const audio = model.sections.find((section) => section.titleKey === 'settings.sectionAudio');
    const soundSet = audio?.rows.find((row) => row.kind === 'select' && row.id === 'soundSet');
    expect(soundSet?.kind === 'select' ? soundSet.options : null).toEqual([
      { value: 'winhanced', label: 'Winhanced' },
      { value: 'ps5', label: 'Ps5' },
    ]);
  });

  it('reflects the toggles from AppSettings', () => {
    const model = buildSettingsModel(
      settings({ allowPrerelease: true, summonHotkeyEnabled: false }),
      env(),
    );
    const prerelease = model.sections[0]?.rows.find((row) => row.kind === 'toggle');
    expect(prerelease?.kind === 'toggle' ? prerelease.value : null).toBe(true);
    const general = model.sections.find(
      (section) => section.titleKey === 'settings.sectionGeneral',
    );
    const summon = general?.rows.find((row) => row.kind === 'toggle' && row.id === 'summonHotkey');
    expect(summon?.kind === 'toggle' ? summon.value : null).toBe(false);
  });
});

describe('helpers', () => {
  it('rounds volumes to whole percents', () => {
    expect(volumePercent(0.505)).toBe(51);
    expect(volumePercent(0)).toBe(0);
  });

  it('prettifies a dashed file name into words', () => {
    expect(prettifyName('steam-big-picture')).toBe('Steam Big Picture');
    expect(prettifyName('ps5')).toBe('Ps5');
  });
});
