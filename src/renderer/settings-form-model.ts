// Pure (DOM-free, electron-free) declaration of the launcher's Settings screen: AppSettings + the
// environment (steam availability, bundled audio options, version, update status) in, a list of sections
// and rows out. The view renders this and the screen controller navigates it, so everything that decides
// WHAT is on the screen — order, visibility, value mapping — is testable in vitest (the view and the
// controller are DOM code, which the node-environment suite cannot reach). Mirrors the split that
// configure-form-model.ts / configure-form-view.ts already established.
import type { AppSettings, AudioOptions, UpdateStatus } from '../shared/types';
import type { MessageKey } from '../shared/i18n/index';

/** Every toggle row, keyed by the AppSettings field it writes. */
export type ToggleId =
  | 'prerelease'
  | 'summonHotkey'
  | 'preventScreensaver'
  | 'alwaysShowEmptyScreen'
  | 'disableSilentInstall'
  | 'steamAutoLaunch'
  | 'onlyGlobalAmbient';

/** Every dropdown row. */
export type SelectId = 'autoUpdate' | 'language' | 'soundSet' | 'ambientTrack';

/** Every slider row (both are volumes, 0..100 %). */
export type SliderId = 'sfxVolume' | 'musicVolume';

/** Every plain action row (a `.text-button` inside the row). */
export type ActionId = 'reset' | 'close';

/**
 * One dropdown option. Its label is either a translation key (`system`, `No ambience`) or a literal —
 * sound sets and ambience tracks are proper names of bundled files and are never translated.
 */
export type SettingsOption =
  | { readonly value: string; readonly labelKey: MessageKey }
  | { readonly value: string; readonly label: string };

export type SettingsRow =
  | {
      readonly kind: 'toggle';
      readonly id: ToggleId;
      readonly labelKey: MessageKey;
      readonly value: boolean;
      readonly hintKey?: MessageKey;
    }
  | {
      readonly kind: 'select';
      readonly id: SelectId;
      readonly labelKey: MessageKey;
      readonly value: string;
      readonly options: readonly SettingsOption[];
    }
  | {
      readonly kind: 'slider';
      readonly id: SliderId;
      readonly labelKey: MessageKey;
      /** 0..100, rounded — the display unit; the controller divides by 100 before it persists. */
      readonly percent: number;
    }
  | { readonly kind: 'action'; readonly id: ActionId; readonly labelKey: MessageKey }
  | { readonly kind: 'update-status'; readonly status: UpdateStatus };

export interface SettingsSection {
  /** Absent for the closing section: one titled "Other" over a pair of buttons says nothing. */
  readonly titleKey?: MessageKey;
  readonly rows: readonly SettingsRow[];
}

export interface SettingsModel {
  readonly sections: readonly SettingsSection[];
  /** Shown next to the screen title. Empty until `app:version` answers. */
  readonly appVersion: string;
}

/** Everything the model needs beyond AppSettings itself. */
export interface SettingsEnv {
  /** Whether the Steam-shortcut feature exists here (linux + packaged AppImage) — hides its row if not. */
  readonly steamAvailable: boolean;
  /** The bundled sound sets + ambience tracks, to populate the Audio dropdowns. */
  readonly audioOptions: AudioOptions;
  readonly appVersion: string;
  readonly updateStatus: UpdateStatus;
}

/** The percent (0..100) a 0..1 volume is displayed and stepped in. */
export function volumePercent(volume: number): number {
  return Math.round(volume * 100);
}

/**
 * Cosmetic label for a raw set/track name: split on '-', capitalize each word, join with spaces
 * (`dark-souls` → `Dark Souls`). These are proper names of bundled files — not translated. Mirrors the
 * settings window's own prettifyName.
 */
export function prettifyName(raw: string): string {
  return raw
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const AUTO_UPDATE_OPTIONS: readonly SettingsOption[] = [
  { value: 'download-install', labelKey: 'settings.autoDownloadInstall' },
  { value: 'download', labelKey: 'settings.autoDownloadManual' },
  { value: 'off', labelKey: 'settings.autoOff' },
];

const LANGUAGE_OPTIONS: readonly SettingsOption[] = [
  { value: 'system', labelKey: 'settings.languageSystem' },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
];

/** The ambience dropdown: "No ambience" (the empty value ⇄ `null` in AppSettings) plus one option per track. */
function ambientOptions(tracks: readonly string[]): readonly SettingsOption[] {
  return [
    { value: '', labelKey: 'settings.ambientNone' },
    ...tracks.map((track) => ({
      value: track,
      label: prettifyName(track.replace(/\.[^.]+$/, '')),
    })),
  ];
}

function soundSetOptions(sets: readonly string[]): readonly SettingsOption[] {
  return sets.map((name) => ({ value: name, label: prettifyName(name) }));
}

/**
 * The whole screen as data. The row order is the screen order; a row that does not apply here (the Steam
 * Deck auto-launch outside a packaged AppImage) is absent rather than disabled — same rule the settings
 * window followed.
 */
export function buildSettingsModel(settings: AppSettings, env: SettingsEnv): SettingsModel {
  const general: readonly SettingsRow[] = [
    {
      kind: 'toggle',
      id: 'summonHotkey',
      labelKey: 'settings.summonHotkey',
      value: settings.summonHotkeyEnabled,
      hintKey: 'settings.summonHint',
    },
    {
      kind: 'toggle',
      id: 'preventScreensaver',
      labelKey: 'settings.preventScreensaver',
      value: settings.preventScreensaver,
    },
    {
      kind: 'toggle',
      id: 'alwaysShowEmptyScreen',
      labelKey: 'settings.alwaysShowEmpty',
      value: settings.alwaysShowEmptyScreen,
    },
    {
      kind: 'toggle',
      id: 'disableSilentInstall',
      labelKey: 'settings.disableSilentInstall',
      value: settings.disableSilentInstall,
    },
    ...(env.steamAvailable
      ? ([
          {
            kind: 'toggle',
            id: 'steamAutoLaunch',
            labelKey: 'settings.steamAutoLaunch',
            value: settings.steamAutoLaunch,
            hintKey: 'settings.steamAutoLaunchHint',
          },
        ] as const)
      : []),
  ];

  return {
    appVersion: env.appVersion,
    sections: [
      {
        titleKey: 'settings.sectionUpdates',
        rows: [
          { kind: 'update-status', status: env.updateStatus },
          {
            kind: 'select',
            id: 'autoUpdate',
            labelKey: 'settings.sectionAutoUpdate',
            value: settings.autoUpdate,
            options: AUTO_UPDATE_OPTIONS,
          },
          {
            kind: 'toggle',
            id: 'prerelease',
            labelKey: 'settings.prerelease',
            value: settings.allowPrerelease,
          },
        ],
      },
      {
        titleKey: 'settings.sectionLanguage',
        rows: [
          {
            kind: 'select',
            id: 'language',
            labelKey: 'settings.language',
            value: settings.language,
            options: LANGUAGE_OPTIONS,
          },
        ],
      },
      { titleKey: 'settings.sectionGeneral', rows: general },
      {
        titleKey: 'settings.sectionAudio',
        rows: [
          {
            kind: 'select',
            id: 'soundSet',
            labelKey: 'settings.soundSet',
            value: settings.soundSet,
            options: soundSetOptions(env.audioOptions.soundSets),
          },
          {
            kind: 'slider',
            id: 'sfxVolume',
            labelKey: 'settings.soundSetVolume',
            percent: volumePercent(settings.sfxVolume),
          },
          {
            kind: 'select',
            id: 'ambientTrack',
            labelKey: 'settings.ambientTrack',
            value: settings.ambientTrack ?? '',
            options: ambientOptions(env.audioOptions.ambientTracks),
          },
          {
            kind: 'toggle',
            id: 'onlyGlobalAmbient',
            labelKey: 'settings.onlyGlobalAmbient',
            value: settings.onlyGlobalAmbient,
            hintKey: 'settings.onlyGlobalAmbientHint',
          },
          {
            kind: 'slider',
            id: 'musicVolume',
            labelKey: 'settings.ambientVolume',
            percent: volumePercent(settings.musicVolume),
          },
        ],
      },
      {
        // No title: the last section is the screen's action stack — Reset over Close, bottom-aligned
        // like every popup stack, where Close is the default way out for the mouse.
        rows: [
          { kind: 'action', id: 'reset', labelKey: 'settings.reset' },
          { kind: 'action', id: 'close', labelKey: 'launcher.menu.close' },
        ],
      },
    ],
  };
}
