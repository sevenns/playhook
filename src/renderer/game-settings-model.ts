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
import {
  movedGridAssetPath,
  movedHeroAssetPath,
  movedMusicAssetPath,
} from '../shared/asset-move-names';
import { emptyFormModel } from './configure-form-model';
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
  | 'source'
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
   * What the screen is CALLED, when it is not the default "Customize" — add mode names itself instead.
   * The heading is the model's to decide for the same reason the rows are: the controller would
   * otherwise write a second copy of the same condition into the DOM.
   */
  readonly headingKey?: MessageKey;
  /**
   * Where the manifest came from, for the header line beside the title. It used to be a row of its own,
   * which put a read-only fact in the middle of the editable ones; up in the header it answers "whose
   * file am I editing?" at a glance, which is the only question it was ever there to answer.
   */
  readonly source: RowLabel;
}

/** Everything the model needs beyond the form state itself. */
export interface GameSettingsEnv {
  /**
   * What the screen is doing with this form: editing a game that exists (`edit`), or creating one
   * (`add`). An explicit discriminant rather than "sources is non-empty": the mode decides the heading,
   * the Save wording, whether Discard/Delete exist and whether the source row is there at all, and
   * inferring all of that from the length of a list reads like a puzzle.
   */
  readonly mode: 'edit' | 'add';
  /** A "Move to card…" target has been chosen (Р2.2) — Save is labelled and routed for a move instead of
   * an ordinary edit; Reset/Delete make no sense mid-move and are left out by the screen's own canDelete. */
  readonly move: boolean;
  /** Where a NEW game may go — the roots offered by the source row. Empty in edit mode (no such row). */
  readonly sources: readonly CoreOption[];
  /**
   * The label of the chosen source, for the header line. Null in edit mode, where the header falls back
   * to the root itself — a candidate's label ("E:\\ — 3 games") only exists while the list is loaded.
   */
  readonly sourceLabel: string | null;
  /** Which dialect this manifest speaks — it decides the launch modes on offer. */
  readonly source: ManifestSource;
  /** Whether the launcher runs on Windows — see the Linux section below, and GameConfigReadResult. */
  readonly windows: boolean;
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

/**
 * The launch modes a source allows. A card cannot host a `pc` game (or the `none` draft state — a card
 * is portable and must stay resolvable on its own, see the plan's assumption 3); a local game is only
 * ever one, but may also be a draft with none configured yet (Р1).
 */
export function launchModesFor(source: ManifestSource): readonly LaunchMode[] {
  return source === 'pc' ? ['pc', 'steam', 'none'] : ['executable', 'installer', 'steam'];
}

/** The mode a blank form of this source starts in — the only one that would validate. A fresh local
 * game defaults to `pc`, not the `none` draft state — leaving it unconfigured is something the user
 * chooses, not the form's starting point. */
export function defaultLaunchMode(source: ManifestSource): LaunchMode {
  return source === 'pc' ? 'pc' : 'executable';
}

/**
 * The mode a freshly-parsed EXISTING manifest should actually show, correcting for what
 * `textToFormModel` cannot know (it has no `source`): given a PC-library manifest with none of the four
 * launch blocks, it defaults `launchMode` to `'executable'` — indistinguishable, from the form alone,
 * from a genuinely blank CARD form (where `'executable'` is exactly right). The screen calls this right
 * after `textToFormModel`/`textToGames` and uses its result instead of `model.launchMode`.
 */
export function draftModeFor(model: ManifestFormModel, source: ManifestSource): LaunchMode {
  const hasAnyLaunchBlock =
    model.pc.executable !== '' ||
    model.steam.appid !== '' ||
    model.executable !== '' ||
    model.install.installer !== '' ||
    model.copyToPc ||
    model.copyInstall.installer !== '';
  return source === 'pc' && !hasAnyLaunchBlock ? 'none' : model.launchMode;
}

const LAUNCH_MODE_LABEL: Readonly<Record<LaunchMode, MessageKey>> = {
  executable: 'gameSettings.modeExecutable',
  installer: 'gameSettings.modeInstaller',
  steam: 'gameSettings.modeSteam',
  pc: 'gameSettings.modePc',
  none: 'gameSettings.modeNone',
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

/**
 * The manifest paths a row owns, for mapping a validator issue onto it.
 *
 * Matched by prefix as well as exactly, because the validator names the exact spot INSIDE a value and a
 * row owns the whole value: a bad process name comes back as `watchProcesses.0`, one bad launch argument
 * as `install.args.2`. The row that holds the list is where the user goes to fix either of them, so an
 * issue one level in has to land on it — otherwise the screen refuses to save over a problem it never
 * points at.
 */
function issueOf(
  issues: ReadonlyMap<string, string>,
  ...paths: readonly string[]
): string | undefined {
  for (const path of paths) {
    const message = issues.get(path);
    if (message !== undefined) return message;
  }
  // Second pass, so an exact owner always wins over one that merely contains the path.
  for (const path of paths) {
    const inside = `${path}.`;
    for (const [candidate, message] of issues) {
      if (candidate.startsWith(inside)) return message;
    }
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

  const basics: GameSettingsRow[] = [];
  // Add mode asks WHERE first: every path below is read against that root, and the launch modes on offer
  // come from it. It is a row rather than a wizard step — the screen already knows how to show a select,
  // and reading order is enough to say "this one first".
  if (env.mode === 'add') {
    basics.push({
      kind: 'select',
      id: 'source',
      label: { key: 'gameSettings.source' },
      value: env.root,
      options: env.sources,
      hint: { key: 'gameSettings.sourceHint' },
    });
  }
  basics.push({
    kind: 'text',
    id: 'title',
    label: { key: 'gameSettings.title' },
    value: form.title,
    placeholder: { key: 'gameSettings.notSet' },
    ...error('title'),
  });
  // Absent while a move is pending: the id is what BOTH halves of the move are addressed by (which slot
  // leaves the PC library, which stats/saves follow the game), so a move that also renames would orphan
  // all of it — see the plan's assumption 4, and the matching refusal in GameConfigService.moveToCard.
  // Renaming stays available as an ordinary edit, before or after the move.
  if (!env.move) {
    basics.push({
      kind: 'text',
      id: 'id',
      label: { key: 'gameSettings.id' },
      value: form.id,
      placeholder: { key: 'gameSettings.notSet' },
      ...error('id'),
    });
    // The id is the key of everything this PC remembers about the game; changing it orphans all of it.
    if (env.loadedId !== '' && form.id !== env.loadedId) {
      basics.push({
        kind: 'note',
        id: 'note.idChanged',
        text: { key: 'gameSettings.idChangedWarning' },
        tone: 'warning',
      });
    }
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
    ...(mode === 'none' ? { hint: { key: 'gameSettings.modeNoneHint' as const } } : {}),
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
    // What `executable` is RELATIVE TO depends on whether anything gets installed or copied first, and
    // saying "relative to the card root" in the other two cases is simply false: with an install block
    // present — an installer, or the copy checkbox — the manifest resolves it under the install
    // directory (manifest.ts, `<installDir>/<executable>`), which holds what was installed or copied.
    const executableHint: MessageKey =
      mode === 'installer'
        ? 'gameSettings.executableInstallHint'
        : form.copyToPc
          ? 'gameSettings.executableCopyHint'
          : 'gameSettings.executableHint';
    launch.push({
      kind: 'path',
      id: 'executable',
      label: { key: 'gameSettings.executable' },
      value: form.executable,
      placeholder: { key: 'gameSettings.notSet' },
      hint: { key: executableHint },
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
  }
  // runAsAdmin elevates a specific executable — meaningless before one is chosen, unlike `args`, which
  // the user may legitimately want to pre-fill ahead of picking a launch method.
  if (mode !== 'steam' && mode !== 'none') {
    launch.push({
      kind: 'toggle',
      id: 'runAsAdmin',
      label: { key: 'gameSettings.runAsAdmin' },
      value: form.runAsAdmin,
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

  // Where the game writes first, then where that gets copied — the order the progress itself travels in.
  const saves: GameSettingsRow[] = [
    {
      kind: 'path',
      id: 'pcSavePath',
      label: { key: 'gameSettings.pcSavePath' },
      value: form.pcSavePath,
      placeholder: { key: 'gameSettings.notSet' },
      ...error('pcSavePath'),
    },
  ];
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
      hint: { key: 'gameSettings.launchTimeoutHint' },
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
      hint: { key: 'gameSettings.killTimeoutHint' },
      ...error('killTimeoutSec'),
    },
  ];

  // The Proton fields, in a section of their own rather than mixed into Advanced: they are a different
  // subject, and on a Windows PC-library game they are not even a subject — see `windows` in the env.
  const linux: GameSettingsRow[] = [
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
    linux.push({
      kind: 'list',
      id: 'install.winetricks',
      label: { key: 'gameSettings.installWinetricks' },
      items: form.install.winetricks,
      max: 0,
      placeholder: { key: 'gameSettings.listEmpty' },
      ...error('install.winetricks'),
    });
  }
  linux.push({
    kind: 'text',
    id: 'umuGameId',
    label: { key: 'gameSettings.umuGameId' },
    value: form.umuGameId,
    placeholder: { key: 'gameSettings.umuGameIdAuto' },
    hint: { key: 'gameSettings.umuGameIdHint' },
    ...error('umuGameId'),
  });
  /** A game installed on a Windows PC is never run through Proton, so it has no Linux side at all. */
  const showsLinux = !(isPcSource && env.windows);

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
    label: {
      key: env.move
        ? 'gameSettings.moveToCard'
        : env.mode === 'add'
          ? 'gameSettings.add'
          : 'gameSettings.save',
    },
    disabled: !env.canSave || !env.dirty,
  });
  // "Discard edits" re-reads the manifest to get the game back as it was — in add mode there is no such
  // game, and mid-move it would drop the very thing being set up (Back/cancel-move is that path instead).
  if (env.mode === 'edit' && !env.move) {
    actions.push({
      kind: 'action',
      id: 'reset',
      label: { key: 'gameSettings.reset' },
      disabled: !env.dirty,
    });
  }
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
    ...(env.mode === 'add' ? { headingKey: 'gameSettings.addTitle' as const } : {}),
    // The candidate's own label when there is one ("E:\\ — 3 games"), so the header says the same thing
    // the source row does; a bare mountpoint is what it falls back to, as in edit mode.
    source:
      env.sourceLabel !== null
        ? { text: env.sourceLabel }
        : isPcSource
          ? { key: 'gameConfig.thisPc' }
          : { text: env.root },
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
      ...(showsLinux ? [{ titleKey: 'gameSettings.sectionLinux' as const, rows: linux }] : []),
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

/**
 * Whether anything in the form would be LOST by moving the new game to another source — the paths and the
 * install block below. It is what decides whether switching the source asks first: a form where only the
 * name has been typed has nothing to lose, and a confirm there is a question about nothing.
 */
export function hasSourceBoundValues(form: ManifestFormModel): boolean {
  return (
    form.executable !== '' ||
    form.pc.executable !== '' ||
    form.install.installer !== '' ||
    form.install.args.length > 0 ||
    form.install.winetricks.length > 0 ||
    form.install.runAsAdmin ||
    form.copyToPc ||
    form.copyInstall.installer !== '' ||
    form.heroImage.length > 0 ||
    form.gridImage !== '' ||
    form.backgroundMusic !== '' ||
    form.saveOnCard !== '' ||
    form.pcSavePath !== ''
  );
}

/**
 * Moves a half-filled ADD form to another source. What survives is what the source has no say over — the
 * name, the arguments, the timeouts, the Steam appid, the Linux fields; what goes is everything measured
 * against the old root or meaningless on the new one:
 *
 *  • the executables and the artwork/music paths — relative to a root that is not this one any more
 *    (a card path on this PC, or the reverse, points at nothing);
 *  • the whole install block and "move to PC" — an installer is something a CARD carries;
 *  • `saveOnCard`, which the PC library forbids outright, and `pcSavePath`, which is a `%PREFIX%/…`
 *    string for a card game and an absolute host path for a local one;
 *  • the launch mode, but ONLY when the new source does not allow it — in practice `steam` is the one
 *    mode that survives the move in either direction.
 *
 * Wiping the lot would be simpler, and would mean re-typing the title on a gamepad keyboard because a
 * radio button was changed.
 */
/**
 * Moves a LOADED PC-library form onto a card (Р2.2 — the pure half of "Move to card…"). Unlike
 * `carryFormAcrossSources` (which starts a NEW, half-filled ADD form and has nothing of the old root's to
 * keep), this carries a REAL game's data across: everything the card dialect can express survives,
 * including the artwork/music, whose paths become the DETERMINISTIC names the game gets on the
 * destination (see asset-move-names.ts) — main copies the actual files under those same names, so the
 * renderer never has to wait for a copy to finish before it can show a valid target manifest.
 *
 * What is dropped: `pc.executable` (an absolute path is forbidden on a card), `pcSavePath` (a %PREFIX%
 * string on a card vs. an absolute/lone value in the library — different enough that re-typing it is
 * safer than guessing), `saveOnCard`/install/copyToPc (meaningless coming FROM a source with none of
 * them). `launchMode`: `steam` survives (an appid names a game, not a place on disk); `pc`/`none` becomes
 * `executable` — the user fills in the card-relative path themselves, which is the whole point of the
 * screen staying open after the target is chosen.
 */
export function carryFormToCard(form: ManifestFormModel): ManifestFormModel {
  return {
    ...emptyFormModel(form.launchMode === 'steam' ? 'steam' : 'executable'),
    id: form.id,
    title: form.title,
    args: form.args,
    runAsAdmin: form.runAsAdmin,
    watchProcesses: form.watchProcesses,
    heroImage: form.heroImage.map((source, index) => movedHeroAssetPath(form.id, index, source)),
    gridImage: form.gridImage === '' ? '' : movedGridAssetPath(form.id, form.gridImage),
    backgroundMusic:
      form.backgroundMusic === '' ? '' : movedMusicAssetPath(form.id, form.backgroundMusic),
    launchTimeoutSec: form.launchTimeoutSec,
    killTimeoutSec: form.killTimeoutSec,
    winetricks: form.winetricks,
    umuGameId: form.umuGameId,
    steam: form.steam,
  };
}

export function carryFormAcrossSources(
  form: ManifestFormModel,
  next: ManifestSource,
): ManifestFormModel {
  const blank = emptyFormModel(defaultLaunchMode(next));
  const launchMode = launchModesFor(next).includes(form.launchMode)
    ? form.launchMode
    : defaultLaunchMode(next);
  return {
    ...blank,
    launchMode,
    id: form.id,
    title: form.title,
    args: form.args,
    runAsAdmin: form.runAsAdmin,
    watchProcesses: form.watchProcesses,
    launchTimeoutSec: form.launchTimeoutSec,
    killTimeoutSec: form.killTimeoutSec,
    winetricks: form.winetricks,
    umuGameId: form.umuGameId,
    steam: form.steam,
  };
}
