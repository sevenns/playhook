// What the Customize screen SHOWS, decided in one pure function. The visibility rules are the whole
// point of testing it: a field that is hidden when it should not be is a field the user cannot edit at
// all now that the JSON tab is gone, and a field shown for the wrong launch mode produces a manifest the
// validator rejects.
import { describe, expect, it } from 'vitest';
import { emptyFormModel, type ManifestFormModel } from '../src/renderer/configure-form-model';
import {
  buildGameSettingsModel,
  carryFormAcrossSources,
  defaultLaunchMode,
  hasSourceBoundValues,
  launchModesFor,
  pickKindFor,
  withInstallType,
  type GameRowId,
  type GameSettingsEnv,
  type GameSettingsModel,
} from '../src/renderer/game-settings-model';

const baseEnv: GameSettingsEnv = {
  mode: 'edit',
  sources: [],
  sourceLabel: null,
  source: 'card',
  windows: false,
  root: 'E:\\',
  loadedId: 'hades',
  mixed: false,
  issues: new Map(),
  otherIssues: [],
  status: null,
  canSave: true,
  dirty: false,
  canDelete: true,
};

function model(
  form: Partial<ManifestFormModel>,
  env: Partial<GameSettingsEnv> = {},
): GameSettingsModel {
  return buildGameSettingsModel(
    { ...emptyFormModel(), id: 'hades', ...form },
    { ...baseEnv, ...env },
  );
}

function ids(built: GameSettingsModel): readonly GameRowId[] {
  return built.sections.flatMap((section) => section.rows.map((row) => row.id));
}

function row(built: GameSettingsModel, id: GameRowId) {
  return built.sections.flatMap((section) => section.rows).find((candidate) => candidate.id === id);
}

describe('launchModesFor / defaultLaunchMode', () => {
  it('offers a card the three card modes and a local library only its two', () => {
    expect(launchModesFor('card')).toEqual(['executable', 'installer', 'steam']);
    expect(launchModesFor('pc')).toEqual(['pc', 'steam']);
  });

  it('starts a blank form in the only mode its source would validate', () => {
    expect(defaultLaunchMode('card')).toBe('executable');
    expect(defaultLaunchMode('pc')).toBe('pc');
  });
});

describe('field visibility per launch mode', () => {
  it('executable mode: the card executable, no installer block', () => {
    const built = ids(model({ launchMode: 'executable' }));
    expect(built).toContain('executable');
    expect(built).toContain('copyToPc');
    expect(built).not.toContain('install.installer');
    expect(built).not.toContain('steam.appid');
    expect(built).not.toContain('pc.executable');
  });

  it('installer mode: the installer block, and no "move to PC" checkbox', () => {
    const built = ids(model({ launchMode: 'installer' }));
    expect(built).toContain('install.installer');
    expect(built).toContain('install.type');
    expect(built).toContain('install.args');
    expect(built).toContain('install.winetricks');
    expect(built).not.toContain('copyToPc');
  });

  it('steam mode drops everything that describes a local launch', () => {
    const built = ids(model({ launchMode: 'steam' }));
    expect(built).toContain('steam.appid');
    expect(built).not.toContain('args');
    expect(built).not.toContain('runAsAdmin');
    expect(built).not.toContain('executable');
  });

  it('pc mode names an absolute executable and keeps the launch options', () => {
    const built = ids(model({ launchMode: 'pc' }, { source: 'pc' }));
    expect(built).toContain('pc.executable');
    expect(built).toContain('args');
    expect(built).not.toContain('executable');
  });

  it('shows the copy directory only while "move game to PC" is on', () => {
    expect(ids(model({ launchMode: 'executable', copyToPc: false }))).not.toContain(
      'copyInstall.installer',
    );
    expect(ids(model({ launchMode: 'executable', copyToPc: true }))).toContain(
      'copyInstall.installer',
    );
  });

  it('offers the card save folder only for a card (a local game has no card to copy to)', () => {
    expect(ids(model({}))).toContain('saveOnCard');
    expect(ids(model({ launchMode: 'pc' }, { source: 'pc' }))).not.toContain('saveOnCard');
  });
});

describe('the rules that are not visibility', () => {
  it('forces install.runAsAdmin off and inert for a custom installer', () => {
    const custom = withInstallType(
      {
        ...emptyFormModel('installer'),
        install: { ...emptyFormModel().install, runAsAdmin: true },
      },
      'custom',
    );
    const built = model({ ...custom, launchMode: 'installer' });
    const toggle = row(built, 'install.runAsAdmin');
    expect(toggle?.kind).toBe('toggle');
    if (toggle?.kind !== 'toggle') throw new Error('unreachable');
    expect(toggle.value).toBe(false);
    expect(toggle.disabled).toBe(true);
  });

  it('caps the hero list at the card format limit', () => {
    const built = model({ heroImage: ['a.jpg'] });
    const hero = row(built, 'heroImage');
    if (hero?.kind !== 'list') throw new Error('unreachable');
    expect(hero.max).toBe(3);
  });

  it('warns only once the id actually differs from the one it was read with', () => {
    expect(ids(model({ id: 'hades' }))).not.toContain('note.idChanged');
    expect(ids(model({ id: 'hades-2' }))).toContain('note.idChanged');
  });

  it('shows the mixed-modes banner from the environment, not from the form', () => {
    expect(ids(model({}, { mixed: true }))).toContain('note.mixed');
    expect(ids(model({}, { mixed: false }))).not.toContain('note.mixed');
  });

  it('maps a validator issue onto the row that owns the path', () => {
    const built = model({}, { issues: new Map([['title', 'is required']]) });
    const title = row(built, 'title');
    if (title?.kind !== 'text') throw new Error('unreachable');
    expect(title.error).toBe('is required');
  });

  it('hides Delete when the environment says it cannot run, and shows it otherwise', () => {
    expect(ids(model({}, { canDelete: false }))).not.toContain('delete');
    expect(ids(model({}, { canDelete: true }))).toContain('delete');
  });

  it('disables Save with nothing to save, and while the validator is unhappy', () => {
    const clean = row(model({}, { dirty: false, canSave: true }), 'save');
    if (clean?.kind !== 'action') throw new Error('unreachable');
    expect(clean.disabled).toBe(true);

    const invalid = row(model({}, { dirty: true, canSave: false }), 'save');
    if (invalid?.kind !== 'action') throw new Error('unreachable');
    expect(invalid.disabled).toBe(true);

    const ready = row(model({}, { dirty: true, canSave: true }), 'save');
    if (ready?.kind !== 'action') throw new Error('unreachable');
    expect(ready.disabled).toBe(false);
  });

  // The source is a header line, not a row: it is read-only, and among thirty editable rows a fact you
  // cannot change reads as a control that refuses to work.
  it('names the source in the header rather than as a row', () => {
    expect(model({}).source).toEqual({ text: 'E:\\' });
    expect(model({ launchMode: 'pc' }, { source: 'pc' }).source).toEqual({
      key: 'gameConfig.thisPc',
    });
    expect(ids(model({}))).not.toContain('source');
  });

  // schemaVersion is always 1 and cannot be anything else — a row for it is a row that does nothing.
  it('does not show the manifest version at all', () => {
    expect(ids(model({}))).not.toContain('schemaVersion');
  });
});

// The SAME builder, asked to describe a game that does not exist yet. What separates the two modes is
// small and easy to get wrong in one direction only: a source row leaking into Customize would put an
// editable "move this game elsewhere" control on a screen that cannot honour it.
describe('add mode', () => {
  const addEnv: Partial<GameSettingsEnv> = {
    mode: 'add',
    sources: [
      { value: 'E:\\', label: 'E:\\ — 3 games' },
      { value: '/pc', label: 'This PC — no games yet' },
    ],
    sourceLabel: 'E:\\ — 3 games',
  };

  it('asks where the game goes FIRST, before anything measured against that answer', () => {
    const first = ids(model({}, addEnv))[0];
    expect(first).toBe('source');
  });

  it('offers the roots it was given, and marks the current one', () => {
    const built = row(model({}, addEnv), 'source');
    if (built?.kind !== 'select') throw new Error('unreachable');
    expect(built.value).toBe('E:\\');
    expect(built.options).toHaveLength(2);
  });

  it('names the button Add, and drops the actions a non-existent game has no use for', () => {
    const built = model({}, { ...addEnv, dirty: true, canSave: true, canDelete: false });
    const save = row(built, 'save');
    if (save?.kind !== 'action') throw new Error('unreachable');
    expect(save.label).toEqual({ key: 'gameSettings.add' });
    expect(ids(built)).not.toContain('reset');
    expect(ids(built)).not.toContain('delete');
    // Close stays: without it the screen could not be left with a mouse.
    expect(ids(built)).toContain('close');
  });

  it('titles the screen after what it does, and labels the source as the picker does', () => {
    const built = model({}, addEnv);
    expect(built.headingKey).toBe('gameSettings.addTitle');
    expect(built.source).toEqual({ text: 'E:\\ — 3 games' });
  });

  it('leaves Customize exactly as it was', () => {
    const built = model({});
    expect(ids(built)).not.toContain('source');
    expect(ids(built)).toContain('reset');
    expect(built.headingKey).toBeUndefined();
  });
});

describe('the Linux section', () => {
  // The Proton fields describe how a game is run under Wine. A card is read on the Deck too, whatever
  // machine it is being edited on, so it keeps them everywhere; a game installed on a Windows PC is only
  // ever launched natively, and there they describe nothing.
  it('is kept for a card on either platform', () => {
    expect(ids(model({}, { source: 'card', windows: true }))).toContain('umuGameId');
    expect(ids(model({}, { source: 'card', windows: false }))).toContain('umuGameId');
  });

  it('is kept for a local game on Linux', () => {
    const built = model({ launchMode: 'pc' }, { source: 'pc', windows: false });
    expect(ids(built)).toContain('umuGameId');
    expect(ids(built)).toContain('winetricks');
  });

  it('is dropped for a local game on Windows', () => {
    const built = model({ launchMode: 'pc' }, { source: 'pc', windows: true });
    expect(ids(built)).not.toContain('umuGameId');
    expect(ids(built)).not.toContain('winetricks');
  });
});

describe('pickKindFor', () => {
  it('sends each path field to the browse it needs', () => {
    expect(pickKindFor('executable', 'executable', 'card')).toBe('executable');
    expect(pickKindFor('install.installer', 'installer', 'card')).toBe('installer');
    expect(pickKindFor('copyInstall.installer', 'executable', 'card')).toBe('directory');
    expect(pickKindFor('heroImage', 'executable', 'card')).toBe('image');
    expect(pickKindFor('backgroundMusic', 'executable', 'card')).toBe('audio');
    expect(pickKindFor('saveOnCard', 'executable', 'card')).toBe('directory');
    expect(pickKindFor('pc.executable', 'pc', 'pc')).toBe('pc-executable');
  });

  // The one that depends on the mode: a LOCAL game's saves are an ordinary host folder, but a local
  // STEAM game's live inside Steam's Proton prefix, which only the %PREFIX% form can name.
  it('picks the save-path flavour from the launch mode, not from the source alone', () => {
    expect(pickKindFor('pcSavePath', 'pc', 'pc')).toBe('pc-save-local');
    expect(pickKindFor('pcSavePath', 'steam', 'pc')).toBe('pc-save');
    expect(pickKindFor('pcSavePath', 'executable', 'card')).toBe('pc-save');
  });

  it('has nothing to browse for a field that is not a path', () => {
    expect(pickKindFor('title', 'executable', 'card')).toBeNull();
    expect(pickKindFor('args', 'executable', 'card')).toBeNull();
  });
});

// What a half-filled Add form loses when the user changes their mind about WHERE the game goes. The rule
// is easy to let drift away from the validator's: a field kept across the move points at a root that no
// longer holds it, and the failure shows up as a validation error the user cannot explain.
describe('carryFormAcrossSources / hasSourceBoundValues', () => {
  const filled = (over: Partial<ManifestFormModel> = {}): ManifestFormModel => ({
    ...emptyFormModel('executable'),
    id: 'hades',
    title: 'Hades',
    executable: 'game/hades.exe',
    args: ['-windowed'],
    runAsAdmin: true,
    watchProcesses: ['hades.exe'],
    heroImage: ['art/hero.jpg'],
    gridImage: 'art/grid.jpg',
    backgroundMusic: 'music/theme.mp3',
    saveOnCard: 'saves',
    pcSavePath: '%APPDATA%/Hades',
    launchTimeoutSec: '45',
    killTimeoutSec: '90',
    winetricks: ['corefonts'],
    umuGameId: '1145360',
    ...over,
  });

  it('keeps the name and everything the root has no say over', () => {
    const moved = carryFormAcrossSources(filled(), 'pc');
    expect(moved.title).toBe('Hades');
    expect(moved.id).toBe('hades');
    expect(moved.args).toEqual(['-windowed']);
    expect(moved.runAsAdmin).toBe(true);
    expect(moved.watchProcesses).toEqual(['hades.exe']);
    expect(moved.launchTimeoutSec).toBe('45');
    expect(moved.killTimeoutSec).toBe('90');
    expect(moved.winetricks).toEqual(['corefonts']);
    expect(moved.umuGameId).toBe('1145360');
  });

  it('drops every path and the whole install block — they were measured against the old root', () => {
    const moved = carryFormAcrossSources(
      filled({
        launchMode: 'installer',
        install: {
          installer: 'setup.exe',
          type: 'inno',
          runAsAdmin: true,
          args: ['/S'],
          winetricks: [],
          rest: {},
        },
      }),
      'pc',
    );
    expect(moved.executable).toBe('');
    expect(moved.pc.executable).toBe('');
    expect(moved.install.installer).toBe('');
    expect(moved.install.args).toEqual([]);
    expect(moved.copyToPc).toBe(false);
    expect(moved.copyInstall.installer).toBe('');
    expect(moved.heroImage).toEqual([]);
    expect(moved.gridImage).toBe('');
    expect(moved.backgroundMusic).toBe('');
    expect(moved.saveOnCard).toBe('');
    expect(moved.pcSavePath).toBe('');
  });

  it('moves the launch mode only when the new source will not have it', () => {
    expect(carryFormAcrossSources(filled(), 'pc').launchMode).toBe('pc');
    expect(carryFormAcrossSources(filled({ launchMode: 'pc' }), 'card').launchMode).toBe(
      'executable',
    );
  });

  // Steam is the one mode both sources accept — and its appid names a game, not a place on a disk.
  it('lets a Steam game travel in either direction, appid included', () => {
    const steam = filled({ launchMode: 'steam', steam: { appid: '1145360', rest: {} } });
    const toPc = carryFormAcrossSources(steam, 'pc');
    expect(toPc.launchMode).toBe('steam');
    expect(toPc.steam.appid).toBe('1145360');
    const backToCard = carryFormAcrossSources(toPc, 'card');
    expect(backToCard.launchMode).toBe('steam');
    expect(backToCard.steam.appid).toBe('1145360');
  });

  it('asks before the move only when the move would cost something', () => {
    expect(hasSourceBoundValues(emptyFormModel('executable'))).toBe(false);
    expect(
      hasSourceBoundValues({ ...emptyFormModel('executable'), title: 'Hades', id: 'hades' }),
    ).toBe(false);
    expect(hasSourceBoundValues(filled())).toBe(true);
    expect(
      hasSourceBoundValues({ ...emptyFormModel('executable'), heroImage: ['art/hero.jpg'] }),
    ).toBe(true);
  });
});
