// What the Customize screen SHOWS, decided in one pure function. The visibility rules are the whole
// point of testing it: a field that is hidden when it should not be is a field the user cannot edit at
// all now that the JSON tab is gone, and a field shown for the wrong launch mode produces a manifest the
// validator rejects.
import { describe, expect, it } from 'vitest';
import {
  emptyFormModel,
  formModelToText,
  type ManifestFormModel,
} from '../src/renderer/configure-form-model';
import { validateManifestText } from '../src/main/manifest';
import { createTranslator } from '../src/shared/i18n/index';
import {
  buildGameSettingsModel,
  carryFormAcrossSources,
  carryFormToCard,
  defaultLaunchMode,
  draftModeFor,
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
  move: false,
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
  canMove: false,
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
  it('offers a card the three card modes and a local library its three (incl. the draft)', () => {
    expect(launchModesFor('card')).toEqual(['executable', 'installer', 'steam']);
    expect(launchModesFor('pc')).toEqual(['pc', 'steam', 'none']);
  });

  it('starts a blank form in the only mode its source would validate — never the draft', () => {
    expect(defaultLaunchMode('card')).toBe('executable');
    expect(defaultLaunchMode('pc')).toBe('pc');
  });
});

describe('draftModeFor', () => {
  it('reinterprets a launch-block-less PC-library form as the draft mode', () => {
    expect(draftModeFor(emptyFormModel(), 'pc')).toBe('none');
  });

  it('leaves a launch-block-less CARD form alone (a genuinely blank card form)', () => {
    expect(draftModeFor(emptyFormModel(), 'card')).toBe('executable');
  });

  it('leaves the mode alone once any of the four launch blocks is filled in (pc)', () => {
    expect(
      draftModeFor({ ...emptyFormModel(), pc: { executable: 'C:\\g.exe', rest: {} } }, 'pc'),
    ).toBe('executable');
  });

  it('leaves the mode alone once any of the four launch blocks is filled in (steam)', () => {
    expect(draftModeFor({ ...emptyFormModel(), steam: { appid: '480', rest: {} } }, 'pc')).toBe(
      'executable',
    );
  });

  it('leaves the mode alone once any of the four launch blocks is filled in (executable)', () => {
    expect(draftModeFor({ ...emptyFormModel(), executable: 'g/g.exe' }, 'pc')).toBe('executable');
  });

  it('leaves the mode alone once any of the four launch blocks is filled in (install / copyToPc)', () => {
    expect(
      draftModeFor({ ...emptyFormModel(), copyToPc: true }, 'pc'),
    ).toBe('executable');
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

  // The id addresses BOTH halves of a move (which slot leaves the PC library, which stats/saves follow the
  // game), so it must not be editable while one is pending — main refuses a move that renames.
  it('hides the id row while a move is pending, and shows it otherwise', () => {
    expect(ids(model({}, { source: 'pc', move: false }))).toContain('id');
    expect(ids(model({}, { source: 'pc', move: true }))).not.toContain('id');
  });

  it('drops the id-changed warning along with the row during a move', () => {
    const built = ids(
      model({ id: 'renamed' }, { source: 'pc', move: true, loadedId: 'hades' }),
    );
    expect(built).not.toContain('note.idChanged');
  });

  it('offers "Find online" in the action column, directly above Save', () => {
    const actions = ids(model({})).filter(
      (id) => id === 'find-online' || id === 'save' || id === 'close',
    );
    // In the trailing column with the screen's other actions — the flow fills fields across three
    // sections, so it belongs to the game rather than to Basics, where it first lived.
    expect(actions.slice(0, 2)).toEqual(['find-online', 'save']);
  });

  it('keeps "Find online" out of Basics, where the title field is', () => {
    const basics = model({}).sections[0];
    expect(basics?.rows.map((row) => row.id)).not.toContain('find-online');
  });

  it('offers it while adding a game too — a new game is exactly what has nothing filled in yet', () => {
    expect(ids(model({}, { mode: 'add' }))).toContain('find-online');
  });

  it('labels Save as the move action and drops Discard while a move is pending', () => {
    const built = model({}, { source: 'pc', move: true, dirty: true });
    expect(ids(built)).not.toContain('reset');
    const save = row(built, 'save');
    expect(save !== undefined && 'label' in save && 'key' in save.label ? save.label.key : '').toBe(
      'gameSettings.moveToCard',
    );
  });

  it('none mode (the PC-library draft): hides every launch-method field, keeps args and the rest', () => {
    const built = ids(model({ launchMode: 'none' }, { source: 'pc' }));
    expect(built).not.toContain('executable');
    expect(built).not.toContain('pc.executable');
    expect(built).not.toContain('install.installer');
    expect(built).not.toContain('steam.appid');
    expect(built).not.toContain('runAsAdmin');
    expect(built).not.toContain('copyToPc');
    expect(built).toContain('args');
    expect(built).toContain('watchProcesses');
    expect(built).toContain('heroImage');
    expect(built).toContain('pcSavePath');
    expect(built).toContain('winetricks');
    expect(built).toContain('umuGameId');
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

  it('maps an issue INSIDE a value onto the row that owns it', () => {
    // The validator names the offending element ("dd" in the watched-process list), not the field —
    // and the field is the only thing the user can be sent to.
    const built = model(
      { watchProcesses: ['dd'] },
      { issues: new Map([['watchProcesses.0', 'must be a .exe name']]) },
    );
    const list = row(built, 'watchProcesses');
    if (list?.kind !== 'list') throw new Error('unreachable');
    expect(list.error).toBe('must be a .exe name');
  });

  it('prefers the row that owns a path exactly over one that merely contains it', () => {
    const built = model(
      { launchMode: 'installer', install: { ...emptyFormModel().install, args: ['a'] } },
      {
        issues: new Map([
          ['install.args', 'expected array'],
          ['install.args.0', 'must be a string'],
        ]),
      },
    );
    const args = row(built, 'install.args');
    if (args?.kind !== 'list') throw new Error('unreachable');
    expect(args.error).toBe('expected array');
  });

  it('hides Delete when the environment says it cannot run, and shows it otherwise', () => {
    expect(ids(model({}, { canDelete: false }))).not.toContain('delete');
    expect(ids(model({}, { canDelete: true }))).toContain('delete');
  });

  it('shows "Move to card…" only when the environment says it may run, placed above Delete', () => {
    expect(ids(model({}, { canMove: false, canDelete: true }))).not.toContain('move-to-card');
    const built = ids(model({}, { canMove: true, canDelete: true }));
    expect(built).toContain('move-to-card');
    expect(built.indexOf('move-to-card')).toBeLessThan(built.indexOf('delete'));
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

  // What the SCREEN is called ("Add game" vs "Customize") is not the model's to say — it follows `mode`,
  // which the controller already has, and it lives in its own element (see .settings-title in index.html).
  // The model only names the GAME, which has no name yet while one is being added.
  it('names the game, which is nothing yet, and labels the source as the picker does', () => {
    const built = model({}, addEnv);
    expect(built.title).toBe('');
    expect(built.source).toEqual({ text: 'E:\\ — 3 games' });
  });

  it('leaves Customize exactly as it was', () => {
    const built = model({});
    expect(ids(built)).not.toContain('source');
    expect(ids(built)).toContain('reset');
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

  it('drops the draft mode when moving a PC-library draft to a card (a card cannot be one)', () => {
    expect(carryFormAcrossSources(filled({ launchMode: 'none' }), 'card').launchMode).toBe(
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

// Moving a REAL local game onto a card (Р2.2) — unlike carryFormAcrossSources (a half-filled ADD form
// with nothing of the old root's to keep), this carries actual game data across, including art/music,
// whose paths become the deterministic destination names (see asset-move-names.ts).
describe('carryFormToCard', () => {
  const pcGame = (over: Partial<ManifestFormModel> = {}): ManifestFormModel => ({
    ...emptyFormModel('pc'),
    id: 'hades',
    title: 'Hades',
    pc: { executable: 'C:\\Games\\Hades\\Hades.exe', rest: {} },
    args: ['-windowed'],
    runAsAdmin: true,
    watchProcesses: ['hades.exe'],
    heroImage: ['assets/hero-1.jpg', 'assets/hero-2.png'],
    gridImage: 'assets/grid.jpg',
    backgroundMusic: 'assets/theme.ogg',
    saveOnCard: '', // forbidden in the pc dialect — never set to begin with
    pcSavePath: '%APPDATA%/Hades',
    launchTimeoutSec: '45',
    killTimeoutSec: '90',
    winetricks: ['corefonts'],
    umuGameId: '1145360',
    ...over,
  });

  it('keeps the name, the launch-adjacent fields and the timings', () => {
    const moved = carryFormToCard(pcGame());
    expect(moved.id).toBe('hades');
    expect(moved.title).toBe('Hades');
    expect(moved.args).toEqual(['-windowed']);
    expect(moved.runAsAdmin).toBe(true);
    expect(moved.watchProcesses).toEqual(['hades.exe']);
    expect(moved.launchTimeoutSec).toBe('45');
    expect(moved.killTimeoutSec).toBe('90');
    expect(moved.winetricks).toEqual(['corefonts']);
    expect(moved.umuGameId).toBe('1145360');
  });

  it('rewrites art/music to the deterministic destination names, in order', () => {
    const moved = carryFormToCard(pcGame());
    expect(moved.heroImage).toEqual(['assets/hades-hero-1.jpg', 'assets/hades-hero-2.png']);
    expect(moved.gridImage).toBe('assets/hades-grid.jpg');
    expect(moved.backgroundMusic).toBe('assets/hades-music.ogg');
  });

  it('drops pc.executable, saveOnCard and any install/copyToPc', () => {
    const moved = carryFormToCard(
      pcGame({ copyToPc: true, copyInstall: { installer: 'x', type: 'copy', runAsAdmin: false, args: [], winetricks: [], rest: {} } }),
    );
    expect(moved.pc.executable).toBe('');
    expect(moved.saveOnCard).toBe('');
    expect(moved.copyToPc).toBe(false);
    expect(moved.copyInstall.installer).toBe('');
    expect(moved.install.installer).toBe('');
  });

  it('pcSavePath: a %PREFIX% string survives (already card-shaped), an absolute one does not', () => {
    expect(carryFormToCard(pcGame({ pcSavePath: '%APPDATA%/Hades' })).pcSavePath).toBe(
      '%APPDATA%/Hades',
    );
    expect(
      carryFormToCard(pcGame({ pcSavePath: 'C:\\Games\\Hades\\Saves' })).pcSavePath,
    ).toBe('');
  });

  it('launchMode: steam survives, pc/none become executable', () => {
    expect(carryFormToCard(pcGame({ launchMode: 'pc' })).launchMode).toBe('executable');
    expect(carryFormToCard(pcGame({ launchMode: 'none' })).launchMode).toBe('executable');
    const steam = pcGame({ launchMode: 'steam', steam: { appid: '1145360', rest: {} } });
    const moved = carryFormToCard(steam);
    expect(moved.launchMode).toBe('steam');
    expect(moved.steam.appid).toBe('1145360');
  });

  it('leaves art/music empty when the source game has none', () => {
    const moved = carryFormToCard(
      pcGame({ heroImage: [], gridImage: '', backgroundMusic: '' }),
    );
    expect(moved.heroImage).toEqual([]);
    expect(moved.gridImage).toBe('');
    expect(moved.backgroundMusic).toBe('');
  });

  it('produces a manifest the CARD validator accepts once executable + saveOnCard/pcSavePath are filled in', () => {
    const t = createTranslator('en');
    const moved: ManifestFormModel = {
      ...carryFormToCard(pcGame()),
      executable: 'Hades/Hades.exe',
      saveOnCard: 'saves',
      pcSavePath: '%APPDATA%/Hades',
    };
    const text = formModelToText(moved, {}, {});
    expect(validateManifestText(text, t, 'card').ok).toBe(true);
  });

  it('rejects an absolute pcSavePath carried straight over (the card allowlist still rules there)', () => {
    const t = createTranslator('en');
    const moved: ManifestFormModel = {
      ...carryFormToCard(pcGame()),
      executable: 'Hades/Hades.exe',
      saveOnCard: 'saves',
      // pcGame()'s pcSavePath was carried over via `{...carryFormToCard(...)}`? No — carryFormToCard
      // resets it to '', so simulate the mistake of typing the absolute PC-side value back in by hand.
      pcSavePath: 'C:\\Users\\me\\AppData\\Roaming\\Hades',
    };
    const text = formModelToText(moved, {}, {});
    const result = validateManifestText(text, t, 'card');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.path === 'pcSavePath')).toBe(true);
  });
});
