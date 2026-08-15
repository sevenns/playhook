// Pure (DOM-free, electron-free) declaration of the launcher's Customize screen: one game's form state
// plus its environment in, a list of sections and rows out. The same split settings-form-model.ts
// established — everything that decides WHAT is on screen (order, visibility, which launch modes this
// source allows, which field a Browse belongs to) is testable in vitest, while the DOM and the navigation
// stay in the view and the controller.
//
// The form state itself is NOT redefined here: it is `ManifestFormModel` from configure-form-model.ts,
// the same pure text ⇄ model bridge the Configure window used, with its `rest` / `corrupt` escape hatches
// intact. This module only decides how that state is PRESENTED.
import { MAX_HERO_IMAGES, type ConfigPickKind, type ManifestSource } from '../shared/types';
import type { MessageKey } from '../shared/i18n/index';
import type { InstallType, LaunchMode, ManifestFormModel } from './configure-form-model';
import type {
  RowLabel,
  CoreActionRow,
  CoreListRow,
  CoreNoteRow,
  CoreNumberRow,
  CoreOption,
  CorePathRow,
  CoreSelectRow,
  CoreStaticRow,
  CoreTextRow,
  CoreToggleRow,
} from './row-view-core';

/**
 * Every row of this screen, named by the manifest path it edits (or by what it is, for the ones that edit
 * nothing). The dotted names are deliberate: they are the same paths the validator reports issues under,
 * so mapping an issue onto a row is a lookup rather than a translation table.
 */
export type GameRowId =
  | 'title'
  | 'id'
  | 'launchMode'
  | 'pc.executable'
  | 'executable'
  | 'args'
  | 'runAsAdmin'
  | 'copyToPc'
  | 'copyInstall.installer'
  | 'install.installer'
  | 'install.type'
  | 'install.runAsAdmin'
  | 'install.args'
  | 'install.winetricks'
  | 'steam.appid'
  | 'watchProcesses'
  | 'heroImage'
  | 'gridImage'
  | 'saveOnCard'
  | 'pcSavePath'
  | 'backgroundMusic'
  | 'launchTimeoutSec'
  | 'killTimeoutSec'
  | 'winetricks'
  | 'umuGameId'
  | 'note.mixed'
  | 'note.idChanged'
  | 'note.otherIssues'
  | 'note.cannotSave'
  | 'note.status'
  | 'save'
  | 'reset'
  | 'delete'
  | 'close';

export type GameSettingsRow =
  | CoreTextRow<GameRowId>
  | CoreNumberRow<GameRowId>
  | CorePathRow<GameRowId>
  | CoreListRow<GameRowId>
  | CoreSelectRow<GameRowId>
  | CoreStaticRow<GameRowId>
  | CoreNoteRow<GameRowId>
  | CoreActionRow<GameRowId>
  | CoreToggleRow<GameRowId>;

export interface GameSettingsSection {
  readonly titleKey?: MessageKey;
  readonly rows: readonly GameSettingsRow[];
}

export interface GameSettingsModel {
  readonly sections: readonly GameSettingsSection[];
  /** Shown beside the screen title — the game's own name, so the screen says whose settings these are. */
  readonly title: string;
  /**
   * Where the manifest came from, for the header line beside the title. It used to be a row of its own,
   * which put a read-only fact in the middle of the editable ones; up in the header it answers "whose
   * file am I editing?" at a glance, which is the only question it was ever there to answer.
   */
  readonly source: RowLabel;
}

/** Everything the model needs beyond the form state itself. */
export interface GameSettingsEnv {
  /** Which dialect this manifest speaks — it decides the launch modes on offer. */
  readonly source: ManifestSource;
  /** The root the manifest was read from, shown as the game's origin (a mountpoint, or "This PC"). */
  readonly root: string;
  /**
   * The id the game was READ with. A change orphans everything keyed by it on this PC — the play stats,
   * the save backups, the history record — so the screen warns before the save rather than after.
   */
  readonly loadedId: string;
  /** The source file carried blocks for more than one launch mode; saving drops the others. */
  readonly mixed: boolean;
  /** This game's validation problems, by the field path the validator reported (already localized). */
  readonly issues: ReadonlyMap<string, string>;
  /** Problems in OTHER games of a multi-game file, already worded for display (see the plan, Э4). */
  readonly otherIssues: readonly string[];
  /** A status line under the actions: what the last save did, or why Save is unavailable. */
  readonly status: string | null;
  /** Whether Save may run at all (the validator is happy about OUR slot). */
  readonly canSave: boolean;
  /** Whether there is anything to save or discard. */
  readonly dirty: boolean;
  /**
   * Whether Delete is offered: hidden while the game is running/installing (the launcher would be left
   * holding a manifest the file no longer has) and for the LAST game on a card (which would leave the
   * card without a manifest at all — the rule the Configure window already enforced).
   */
  readonly canDelete: boolean;
}

/** The launch modes a source allows. A card cannot host a `pc` game; a local game is only ever one. */
export function launchModesFor(source: ManifestSource): readonly LaunchMode[] {
  return source === 'pc' ? ['pc', 'steam'] : ['executable', 'installer', 'steam'];
}

/** The mode a blank form of this source starts in — the only one that would validate. */
export function defaultLaunchMode(source: ManifestSource): LaunchMode {
  return source === 'pc' ? 'pc' : 'executable';
}

const LAUNCH_MODE_LABEL: Readonly<Record<LaunchMode, MessageKey>> = {
  executable: 'gameSettings.modeExecutable',
  installer: 'gameSettings.modeInstaller',
  steam: 'gameSettings.modeSteam',
  pc: 'gameSettings.modePc',
};

const INSTALL_TYPE_OPTIONS: readonly CoreOption[] = [
  { value: 'nsis', labelKey: 'gameSettings.installNsis' },
  { value: 'inno', labelKey: 'gameSettings.installInno' },
  { value: 'custom', labelKey: 'gameSettings.installCustom' },
];

/**
 * Which Browse a row opens, if any. Derived rather than stored on the row because two of them depend on
 * the CURRENT launch mode: a local game's save folder is an ordinary host directory (`pc-save-local`),
 * while a local Steam game's lives inside Steam's Proton prefix and only the `%PREFIX%` form can name it
 * (`pc-save`) — see ConfigPickKind.
 */
export function pickKindFor(
  id: GameRowId,
  mode: LaunchMode,
  source: ManifestSource,
): ConfigPickKind | null {
  switch (id) {
    case 'executable':
      return 'executable';
    case 'pc.executable':
      return 'pc-executable';
    case 'install.installer':
      return 'installer';
    case 'copyInstall.installer':
      return 'directory';
    case 'heroImage':
    case 'gridImage':
      return 'image';
    case 'backgroundMusic':
      return 'audio';
    case 'saveOnCard':
      return 'directory';
    case 'pcSavePath':
      return source === 'pc' && mode === 'pc' ? 'pc-save-local' : 'pc-save';
    default:
      return null;
  }
}

/** The manifest paths a row owns, for mapping a validator issue onto it. */
function issueOf(
  issues: ReadonlyMap<string, string>,
  ...paths: readonly string[]
): string | undefined {
  for (const path of paths) {
    const message = issues.get(path);
    if (message !== undefined) return message;
  }
  return undefined;
}

/**
 * The whole screen as data. A row that does not apply to the current launch mode is ABSENT rather than
 * disabled — the same rule the Settings model follows, and the same one the Configure form followed with
 * its hidden sections. The state behind a hidden row is not lost: it lives on in the form model until
 * serialization (see ManifestFormModel), so switching modes and back restores what was typed.
 */
export function buildGameSettingsModel(
  form: ManifestFormModel,
  env: GameSettingsEnv,
): GameSettingsModel {
  const mode = form.launchMode;
  const isPcSource = env.source === 'pc';
  const error = (...paths: readonly string[]): { readonly error?: string } => {
    const message = issueOf(env.issues, ...paths);
    return message === undefined ? {} : { error: message };
  };

  const basics: GameSettingsRow[] = [
    {
      kind: 'text',
      id: 'title',
      label: { key: 'gameSettings.title' },
      value: form.title,
      placeholder: { key: 'gameSettings.notSet' },
      ...error('title'),
    },
    {
      kind: 'text',
      id: 'id',
      label: { key: 'gameSettings.id' },
      value: form.id,
      placeholder: { key: 'gameSettings.notSet' },
      hint: { key: 'gameSettings.idHint' },
      ...error('id'),
    },
  ];
  // The id is the key of everything this PC remembers about the game; changing it orphans all of it.
  if (env.loadedId !== '' && form.id !== env.loadedId) {
    basics.push({
      kind: 'note',
      id: 'note.idChanged',
      text: { key: 'gameSettings.idChangedWarning' },
      tone: 'warning',
    });
  }

  const launch: GameSettingsRow[] = [];
  if (env.mixed) {
    launch.push({
      kind: 'note',
      id: 'note.mixed',
      text: { key: 'gameSettings.mixedLaunchModes' },
      tone: 'warning',
    });
  }
  launch.push({
    kind: 'select',
    id: 'launchMode',
    label: { key: 'gameSettings.launchMode' },
    value: mode,
    options: launchModesFor(env.source).map((candidate) => ({
      value: candidate,
      labelKey: LAUNCH_MODE_LABEL[candidate],
    })),
  });
  if (mode === 'pc') {
    launch.push({
      kind: 'path',
      id: 'pc.executable',
      label: { key: 'gameSettings.pcExecutable' },
      value: form.pc.executable,
      placeholder: { key: 'gameSettings.notSet' },
      ...error('pc.executable', 'pc'),
    });
  }
  if (mode === 'executable' || mode === 'installer') {
    launch.push({
      kind: 'path',
      id: 'executable',
      label: { key: 'gameSettings.executable' },
      value: form.executable,
      placeholder: { key: 'gameSettings.notSet' },
      hint: { key: 'gameSettings.executableHint' },
      ...error('executable'),
    });
  }
  if (mode !== 'steam') {
    launch.push({
      kind: 'list',
      id: 'args',
      label: { key: 'gameSettings.args' },
      items: form.args,
      max: 0,
      placeholder: { key: 'gameSettings.listEmpty' },
      ...error('args'),
    });
    launch.push({
      kind: 'toggle',
      id: 'runAsAdmin',
      label: { key: 'gameSettings.runAsAdmin' },
      value: form.runAsAdmin,
      hint: { key: 'gameSettings.runAsAdminHint' },
      ...error('runAsAdmin'),
    });
  }
  if (mode === 'executable') {
    launch.push({
      kind: 'toggle',
      id: 'copyToPc',
      label: { key: 'gameSettings.copyToPc' },
      value: form.copyToPc,
      hint: { key: 'gameSettings.copyToPcHint' },
    });
    if (form.copyToPc) {
      launch.push({
        kind: 'path',
        id: 'copyInstall.installer',
        label: { key: 'gameSettings.copyDirectory' },
        value: form.copyInstall.installer,
        placeholder: { key: 'gameSettings.notSet' },
        hint: { key: 'gameSettings.copyDirectoryHint' },
        ...error('install.installer', 'install'),
      });
    }
  }
  if (mode === 'installer') {
    launch.push({
      kind: 'path',
      id: 'install.installer',
      label: { key: 'gameSettings.installer' },
      value: form.install.installer,
      placeholder: { key: 'gameSettings.notSet' },
      ...error('install.installer'),
    });
    launch.push({
      kind: 'select',
      id: 'install.type',
      label: { key: 'gameSettings.installType' },
      value: form.install.type,
      options: INSTALL_TYPE_OPTIONS,
      ...error('install.type'),
    });
    // A `custom` installer is run by the user, not by us, so elevation is not ours to ask for: the
    // manifest's own superRefine rejects the pair, and the form must not be able to produce it.
    launch.push({
      kind: 'toggle',
      id: 'install.runAsAdmin',
      label: { key: 'gameSettings.installRunAsAdmin' },
      value: form.install.type === 'custom' ? false : form.install.runAsAdmin,
      disabled: form.install.type === 'custom',
      ...(form.install.type === 'custom'
        ? { hint: { key: 'gameSettings.installCustomHint' } }
        : {}),
      ...error('install.runAsAdmin'),
    } satisfies GameSettingsRow);
    launch.push({
      kind: 'list',
      id: 'install.args',
      label: { key: 'gameSettings.installArgs' },
      items: form.install.args,
      max: 0,
      placeholder: { key: 'gameSettings.listEmpty' },
      ...error('install.args'),
    });
  }
  if (mode === 'steam') {
    launch.push({
      kind: 'number',
      id: 'steam.appid',
      label: { key: 'gameSettings.steamAppid' },
      value: form.steam.appid,
      placeholder: { key: 'gameSettings.notSet' },
      step: 1,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      hint: { key: 'gameSettings.steamAppidHint' },
      ...error('steam.appid', 'steam'),
    });
  }
  launch.push({
    kind: 'list',
    id: 'watchProcesses',
    label: { key: 'gameSettings.watchProcesses' },
    items: form.watchProcesses,
    max: 0,
    placeholder: { key: 'gameSettings.listEmpty' },
    hint: { key: 'gameSettings.watchProcessesHint' },
    ...error('watchProcesses'),
  });

  const images: GameSettingsRow[] = [
    {
      kind: 'list',
      id: 'heroImage',
      label: { key: 'gameSettings.heroImage' },
      items: form.heroImage,
      max: MAX_HERO_IMAGES,
      placeholder: { key: 'gameSettings.listEmpty' },
      preview: 'wide',
      hint: { key: 'gameSettings.heroImageHint' },
      ...error('heroImage'),
    },
    {
      kind: 'path',
      id: 'gridImage',
      label: { key: 'gameSettings.gridImage' },
      value: form.gridImage,
      placeholder: { key: 'gameSettings.gridImageAuto' },
      preview: 'portrait',
      ...error('gridImage'),
    },
  ];

  const saves: GameSettingsRow[] = [];
  if (!isPcSource) {
    saves.push({
      kind: 'path',
      id: 'saveOnCard',
      label: { key: 'gameSettings.saveOnCard' },
      value: form.saveOnCard,
      placeholder: { key: 'gameSettings.notSet' },
      hint: { key: 'gameSettings.saveOnCardHint' },
      ...error('saveOnCard'),
    });
  }
  saves.push({
    kind: 'path',
    id: 'pcSavePath',
    label: { key: 'gameSettings.pcSavePath' },
    value: form.pcSavePath,
    placeholder: { key: 'gameSettings.notSet' },
    hint: { key: 'gameSettings.pcSavePathHint' },
    ...error('pcSavePath'),
  });

  const advanced: GameSettingsRow[] = [
    {
      kind: 'number',
      id: 'launchTimeoutSec',
      label: { key: 'gameSettings.launchTimeout' },
      value: form.launchTimeoutSec,
      placeholder: { key: 'gameSettings.defaultSeconds30' },
      step: 5,
      min: 1,
      max: 3600,
      ...error('launchTimeoutSec'),
    },
    {
      kind: 'number',
      id: 'killTimeoutSec',
      label: { key: 'gameSettings.killTimeout' },
      value: form.killTimeoutSec,
      placeholder: { key: 'gameSettings.defaultSeconds60' },
      step: 5,
      min: 1,
      max: 3600,
      ...error('killTimeoutSec'),
    },
    {
      kind: 'list',
      id: 'winetricks',
      label: { key: 'gameSettings.winetricks' },
      items: form.winetricks,
      max: 0,
      placeholder: { key: 'gameSettings.listEmpty' },
      hint: { key: 'gameSettings.winetricksHint' },
      ...error('winetricks'),
    },
  ];
  if (mode === 'installer') {
    advanced.push({
      kind: 'list',
      id: 'install.winetricks',
      label: { key: 'gameSettings.installWinetricks' },
      items: form.install.winetricks,
      max: 0,
      placeholder: { key: 'gameSettings.listEmpty' },
      ...error('install.winetricks'),
    });
  }
  advanced.push({
    kind: 'text',
    id: 'umuGameId',
    label: { key: 'gameSettings.umuGameId' },
    value: form.umuGameId,
    placeholder: { key: 'gameSettings.umuGameIdAuto' },
    hint: { key: 'gameSettings.umuGameIdHint' },
    ...error('umuGameId'),
  });

  const actions: GameSettingsRow[] = [];
  // A multi-game file's OTHER games are named but not editable from here — the user still has to know
  // the file is not clean, because that is what a red status after Save would otherwise be about.
  for (const message of env.otherIssues) {
    actions.push({ kind: 'note', id: 'note.otherIssues', text: { text: message }, tone: 'error' });
  }
  if (env.status !== null) {
    actions.push({ kind: 'note', id: 'note.status', text: { text: env.status }, tone: 'info' });
  }
  // Why Save is inert, said next to the button. Without this the button is simply dead, and the reason
  // may well be a row that has scrolled off the top of a thirty-field form.
  if (!env.canSave && env.dirty) {
    actions.push({
      kind: 'note',
      id: 'note.cannotSave',
      text: { key: 'gameSettings.cannotSave' },
      tone: 'error',
    });
  }
  actions.push({
    kind: 'action',
    id: 'save',
    label: { key: 'gameSettings.save' },
    disabled: !env.canSave || !env.dirty,
  });
  actions.push({
    kind: 'action',
    id: 'reset',
    label: { key: 'gameSettings.reset' },
    disabled: !env.dirty,
  });
  if (env.canDelete) {
    actions.push({
      kind: 'action',
      id: 'delete',
      label: { key: 'gameSettings.delete' },
      danger: true,
    });
  }
  actions.push({ kind: 'action', id: 'close', label: { key: 'launcher.menu.close' } });

  return {
    title: form.title,
    source: isPcSource ? { key: 'gameConfig.thisPc' } : { text: env.root },
    sections: [
      { titleKey: 'gameSettings.sectionBasics', rows: basics },
      { titleKey: 'gameSettings.sectionLaunch', rows: launch },
      { titleKey: 'gameSettings.sectionImages', rows: images },
      { titleKey: 'gameSettings.sectionSaves', rows: saves },
      {
        titleKey: 'gameSettings.sectionAudio',
        rows: [
          {
            kind: 'path',
            id: 'backgroundMusic',
            label: { key: 'gameSettings.backgroundMusic' },
            value: form.backgroundMusic,
            placeholder: { key: 'gameSettings.musicNone' },
            ...error('backgroundMusic'),
          },
        ],
      },
      { titleKey: 'gameSettings.sectionAdvanced', rows: advanced },
      // No title: the last section is the screen's action stack, like the Settings screen's.
      { rows: actions },
    ],
  };
}

/** Applies a new launch mode to the form state. The hidden modes' fields are kept — see the model note. */
export function withLaunchMode(form: ManifestFormModel, mode: LaunchMode): ManifestFormModel {
  return { ...form, launchMode: mode };
}

/** Applies a new installer family, forcing off the elevation `custom` may not carry. */
export function withInstallType(form: ManifestFormModel, type: InstallType): ManifestFormModel {
  const runAsAdmin = type === 'custom' ? false : form.install.runAsAdmin;
  return { ...form, install: { ...form.install, type, runAsAdmin } };
}
