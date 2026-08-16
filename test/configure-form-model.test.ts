import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emptyFormModel,
  formModelToText,
  slugifyId,
  textToFormModel,
  textToGames,
  gamesToText,
  isRawSlot,
  slotsWithNewGame,
  launchModeOf,
  KNOWN_MANIFEST_KEYS,
  type GameFormState,
  type ManifestFormModel,
} from '../src/renderer/configure-form-model';
import { manifestJsonSchema, validateManifestText } from '../src/main/manifest';
import { createTranslator } from '../src/shared/i18n/index';

const t = createTranslator('en');

/** Parses text and returns the ok result, failing the test if the parse was rejected. */
function parseOk(text: string): {
  model: ManifestFormModel;
  rest: Readonly<Record<string, unknown>>;
  corrupt: Readonly<Record<string, unknown>>;
  mixed: boolean;
} {
  const result = textToFormModel(text);
  expect(result.ok, `expected a parseable manifest, got: ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function serialize(text: string): string {
  const { model, rest, corrupt } = parseOk(text);
  return formModelToText(model, rest, corrupt);
}

describe('textToFormModel — parse errors', () => {
  it('rejects syntactically invalid JSON', () => {
    expect(textToFormModel('{ not json').ok).toBe(false);
  });

  it('rejects a non-object top-level (the form cannot represent it)', () => {
    expect(textToFormModel('[1, 2, 3]').ok).toBe(false);
    expect(textToFormModel('42').ok).toBe(false);
  });
});

// One manifest per launch mode, with the schema defaults spelled out — the shapes the form must round-trip
// losslessly. (These were the starter templates before the Templates tab was removed; the form is now the
// only authoring surface, so they live here as fixtures.)
const LAUNCH_MODE_FIXTURES = {
  executable: JSON.stringify(
    {
      schemaVersion: 1,
      id: 'my-game',
      title: 'My Game',
      executable: 'game/game.exe',
      args: [],
      runAsAdmin: false,
      heroImage: 'assets/hero.jpg',
      saveOnCard: 'saves',
      pcSavePath: '%APPDATA%/My Game',
      launchTimeoutSec: 30,
    },
    null,
    2,
  ),
  installer: JSON.stringify(
    {
      schemaVersion: 1,
      id: 'my-game',
      title: 'My Game',
      executable: 'MyGame/MyGame.exe',
      install: { installer: 'setup/setup.exe', type: 'nsis', runAsAdmin: false, args: [] },
      heroImage: 'assets/hero.jpg',
      launchTimeoutSec: 30,
    },
    null,
    2,
  ),
  steam: JSON.stringify(
    {
      schemaVersion: 1,
      id: 'my-game',
      title: 'My Game',
      steam: { appid: 480 },
      watchProcesses: ['mygame.exe'],
      launchTimeoutSec: 120,
      heroImage: 'assets/hero.jpg',
    },
    null,
    2,
  ),
  // The 4th shape: executable mode with "move game to PC" on. `install.installer` is the game DIRECTORY,
  // and `executable` is relative to it — not to the card root.
  copy: JSON.stringify(
    {
      schemaVersion: 1,
      id: 'my-game',
      title: 'My Game',
      executable: 'bin/MyGame.exe',
      install: { installer: 'Games/MyGame', type: 'copy' },
      heroImage: 'assets/hero.jpg',
    },
    null,
    2,
  ),
};

describe('round-trip on the three launch-mode shapes', () => {
  it('serializes each into a VALID, minimal manifest', () => {
    for (const [name, fixture] of Object.entries(LAUNCH_MODE_FIXTURES)) {
      const text = serialize(fixture);
      const validation = validateManifestText(text, t);
      expect(validation.ok, `${name} → serialized must validate: ${JSON.stringify(validation)}`).toBe(true);
    }
  });

  it('is idempotent (the normalized text is a fixed point of parse∘serialize)', () => {
    for (const [name, fixture] of Object.entries(LAUNCH_MODE_FIXTURES)) {
      const once = serialize(fixture);
      const twice = serialize(once);
      expect(twice, `${name} normalization must be stable`).toBe(once);
    }
  });

  it('omits fields equal to their schema default (args/runAsAdmin/launchTimeoutSec 30)', () => {
    const text = serialize(LAUNCH_MODE_FIXTURES.executable);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('args');
    expect(parsed).not.toHaveProperty('runAsAdmin');
    expect(parsed).not.toHaveProperty('launchTimeoutSec');
  });
});

describe('copy install type ("move game to PC" — a checkbox inside Executable mode)', () => {
  it('parses into EXECUTABLE mode with the checkbox on, not into Installer mode', () => {
    const { model } = parseOk(LAUNCH_MODE_FIXTURES.copy);
    expect(launchModeOf(model)).toBe('executable');
    expect(model.copyToPc).toBe(true);
    expect(model.copyInstall.installer).toBe('Games/MyGame');
    expect(model.copyInstall.type).toBe('copy');
    // The installer slot stays pristine — a copy block is not an installer.
    expect(model.install.installer).toBe('');
    expect(model.install.type).toBe('nsis');
  });

  it('round-trips back to install.type copy', () => {
    const parsed = JSON.parse(serialize(LAUNCH_MODE_FIXTURES.copy)) as Record<string, unknown>;
    expect(parsed['install']).toEqual({ installer: 'Games/MyGame', type: 'copy' });
  });

  it('emits no install block when the checkbox is off, even with a source typed in', () => {
    const { model, rest, corrupt } = parseOk(LAUNCH_MODE_FIXTURES.copy);
    const off: ManifestFormModel = { ...model, copyToPc: false };
    const parsed = JSON.parse(formModelToText(off, rest, corrupt)) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('install');
  });

  it('keeps unknown keys inside the copy block across the round-trip (the block has its own rest)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'bin/game.exe',
      heroImage: 'hero.jpg',
      install: { installer: 'Games/X', type: 'copy', futureField: 42 },
    });
    const parsed = JSON.parse(serialize(text)) as { install?: Record<string, unknown> };
    expect(parsed.install?.['futureField']).toBe(42);
  });

  it('keeps the two install slots independent (switching modes loses neither side)', () => {
    // Start from an installer manifest, then turn on the copy checkbox in executable mode: the installer
    // slot must survive untouched, and the emitted block must be the COPY one.
    const { model, rest, corrupt } = parseOk(LAUNCH_MODE_FIXTURES.installer);
    expect(model.install.installer).toBe('setup/setup.exe');
    const switched: ManifestFormModel = {
      ...model,
      launchMode: 'executable',
      copyToPc: true,
      copyInstall: { ...model.copyInstall, installer: 'Games/MyGame' },
    };
    const parsed = JSON.parse(formModelToText(switched, rest, corrupt)) as {
      install?: Record<string, unknown>;
    };
    expect(parsed.install).toEqual({ installer: 'Games/MyGame', type: 'copy' });
    // Switching back re-emits the installer slot, with its original value.
    const back: ManifestFormModel = { ...switched, launchMode: 'installer' };
    const backParsed = JSON.parse(formModelToText(back, rest, corrupt)) as {
      install?: Record<string, unknown>;
    };
    expect(backParsed.install?.['installer']).toBe('setup/setup.exe');
    expect(backParsed.install?.['type']).toBe('nsis');
  });

  it('treats an install block with an unknown type as corrupt (not as a copy)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'bin/game.exe',
      heroImage: 'hero.jpg',
      install: { installer: 'setup.exe', type: 'msi' },
    });
    const { model, corrupt } = parseOk(text);
    expect(corrupt).toHaveProperty('install');
    expect(model.copyToPc).toBe(false);
    expect(launchModeOf(model)).toBe('installer');
  });
});

describe('winetricks round-trip (game + installer prefix provisioning — Р7b)', () => {
  it('parses top-level and install.winetricks into the model', () => {
    const text =
      '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":"h.jpg",' +
      '"winetricks":["d3dx9","vcrun2010"],' +
      '"install":{"installer":"s/s.exe","type":"inno","winetricks":["mfc42"]}}';
    const { model } = parseOk(text);
    expect(model.winetricks).toEqual(['d3dx9', 'vcrun2010']);
    expect(model.install.winetricks).toEqual(['mfc42']);
  });

  it('serializes both back losslessly into a VALID manifest', () => {
    const text =
      '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":"h.jpg",' +
      '"winetricks":["d3dx9"],' +
      '"install":{"installer":"s/s.exe","type":"inno","winetricks":["mfc42","gdiplus"]}}';
    const out = serialize(text);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['winetricks']).toEqual(['d3dx9']);
    expect((parsed['install'] as Record<string, unknown>)['winetricks']).toEqual(['mfc42', 'gdiplus']);
    expect(validateManifestText(out, t).ok).toBe(true);
  });

  it('omits empty winetricks arrays (default) from the serialized manifest', () => {
    const text = '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":"h.jpg"}';
    const parsed = JSON.parse(serialize(text)) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('winetricks');
  });

  it('accepts a key=value winetricks setting (e.g. vd=1920x1080) as a valid entry', () => {
    const text =
      '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":"h.jpg","winetricks":["vd=1920x1080"]}';
    const { model } = parseOk(text);
    expect(model.winetricks).toEqual(['vd=1920x1080']);
    expect(validateManifestText(serialize(text), t).ok).toBe(true);
  });

  it('round-trips umuGameId (Steam appid / UMU_ID) and omits it when empty', () => {
    const withId =
      '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":"h.jpg","umuGameId":"umu-nfsu2"}';
    const { model } = parseOk(withId);
    expect(model.umuGameId).toBe('umu-nfsu2');
    const parsed = JSON.parse(serialize(withId)) as Record<string, unknown>;
    expect(parsed['umuGameId']).toBe('umu-nfsu2');
    expect(validateManifestText(serialize(withId), t).ok).toBe(true);

    const without = '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":"h.jpg"}';
    expect(JSON.parse(serialize(without))).not.toHaveProperty('umuGameId');
  });
});

describe('killTimeoutSec round-trip (force-close wait)', () => {
  const withKill = (value: number): string =>
    `{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":"h.jpg","killTimeoutSec":${value}}`;

  it('preserves a custom killTimeoutSec and keeps the text valid', () => {
    const text = serialize(withKill(120));
    expect(JSON.parse(text)).toHaveProperty('killTimeoutSec', 120);
    expect(validateManifestText(text, t).ok).toBe(true);
  });

  it('omits killTimeoutSec when it equals the schema default of 60', () => {
    const parsed = JSON.parse(serialize(withKill(60))) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('killTimeoutSec');
  });

  it('round-trips a non-numeric killTimeoutSec verbatim as a corrupt value (error stays visible)', () => {
    const text = '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","killTimeoutSec":"soon"}';
    expect(JSON.parse(serialize(text))).toHaveProperty('killTimeoutSec', 'soon');
  });
});

describe('unknown keys survive the round-trip (rest)', () => {
  it('preserves an unknown TOP-LEVEL key', () => {
    const text = serialize('{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","future":42}');
    expect(JSON.parse(text)).toHaveProperty('future', 42);
  });

  // `sounds` is no longer a manifest key: the form has no field for it, so it rides the top-level `rest`
  // and is written back verbatim. That is what keeps an old card's block from being silently wiped by a
  // re-save from Configure.
  it('preserves a whole `sounds` block as an unknown top-level key', () => {
    const src =
      '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","sounds":{"play":"p.wav","custom":7}}';
    const parsed = JSON.parse(serialize(src)) as { sounds?: Record<string, unknown> };
    expect(parsed.sounds).toEqual({ play: 'p.wav', custom: 7 });
  });
});

describe('corrupt known keys are kept verbatim until edited', () => {
  it('writes a wrong-typed known field back raw (so validation still fails)', () => {
    const src = '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","args":"oops"}';
    const { model, rest, corrupt } = parseOk(src);
    expect(corrupt).toHaveProperty('args', 'oops');
    expect(model.args).toEqual([]); // the model field stays empty
    const text = formModelToText(model, rest, corrupt);
    expect(JSON.parse(text)).toHaveProperty('args', 'oops'); // verbatim
    expect(validateManifestText(text, t).ok).toBe(false); // error preserved → Save blocked
  });
});

describe('heroImage string ↔ array', () => {
  it('collapses a single-element array to a string', () => {
    const text = serialize('{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":["a.png"]}');
    expect(JSON.parse(text)).toHaveProperty('heroImage', 'a.png');
  });

  it('keeps several images as an array', () => {
    const text = serialize(
      '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":["a.png","b.png"]}',
    );
    expect(JSON.parse(text)).toHaveProperty('heroImage', ['a.png', 'b.png']);
  });
});

describe('gridImage (carousel card)', () => {
  it('round-trips through the model', () => {
    const src =
      '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":"h.jpg","gridImage":"art/grid.jpg"}';
    const { model } = parseOk(src);
    expect(model.gridImage).toBe('art/grid.jpg');
    expect(JSON.parse(serialize(src))).toHaveProperty('gridImage', 'art/grid.jpg');
  });

  it('is omitted when empty', () => {
    const text = serialize('{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","heroImage":"h.jpg"}');
    expect(JSON.parse(text)).not.toHaveProperty('gridImage');
  });

  it('keeps a wrong-typed value verbatim (corrupt round-trip)', () => {
    const src = '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","gridImage":5}';
    const { corrupt } = parseOk(src);
    expect(corrupt).toHaveProperty('gridImage', 5);
    expect(JSON.parse(serialize(src))).toHaveProperty('gridImage', 5);
  });
});

describe('launch mode', () => {
  it('resolves steam > install > executable for a mixed manifest and flags mixed', () => {
    const result = parseOk(
      '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","steam":{"appid":10},"watchProcesses":["g.exe"]}',
    );
    expect(launchModeOf(result.model)).toBe('steam');
    expect(result.mixed).toBe(true);
  });

  it('does not leak hidden-mode fields into the serialized text', () => {
    const base = parseOk(LAUNCH_MODE_FIXTURES.steam);
    // A steam-mode model that still carries an executable typed under another mode must NOT emit it.
    const model: ManifestFormModel = { ...base.model, launchMode: 'steam', executable: 'ghost.exe' };
    const parsed = JSON.parse(formModelToText(model, {}, {})) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('executable');
    expect(parsed).toHaveProperty('steam');
  });
});

describe('pc mode (a local game on this PC)', () => {
  // Native, absolute path: the PC library never travels, and CI runs this suite on Windows too.
  const exe = path.join(path.resolve(path.sep), 'Games', 'Hades', 'Hades.exe');
  const pcText = JSON.stringify({
    schemaVersion: 1,
    id: 'hades',
    title: 'Hades',
    pc: { executable: exe },
    heroImage: 'assets/hero.jpg',
    watchProcesses: ['Hades.exe'],
  });

  it('parses into pc mode without spilling the block into `rest`', () => {
    const result = parseOk(pcText);
    expect(launchModeOf(result.model)).toBe('pc');
    expect(result.model.pc.executable).toBe(exe);
    expect(result.rest).toEqual({});
    expect(result.corrupt).toEqual({});
  });

  it('round-trips into a manifest the PC-source validator accepts', () => {
    const text = serialize(pcText);
    expect(validateManifestText(text, t, 'pc').ok).toBe(true);
    expect(serialize(text)).toBe(text); // idempotent
  });

  it('does not emit the card-relative executable or an install block', () => {
    const base = parseOk(pcText);
    const model: ManifestFormModel = {
      ...base.model,
      executable: 'ghost.exe',
      copyToPc: true,
    };
    const parsed = JSON.parse(formModelToText(model, {}, {})) as Record<string, unknown>;
    expect(parsed).toHaveProperty('pc');
    expect(parsed).not.toHaveProperty('executable');
    expect(parsed).not.toHaveProperty('install');
  });

  it('keeps args/runAsAdmin/watchProcesses, which a local game may use like any other', () => {
    const model: ManifestFormModel = {
      ...parseOk(pcText).model,
      args: ['-windowed'],
      runAsAdmin: true,
    };
    const parsed = JSON.parse(formModelToText(model, {}, {})) as Record<string, unknown>;
    expect(parsed['args']).toEqual(['-windowed']);
    expect(parsed['runAsAdmin']).toBe(true);
    expect(parsed['watchProcesses']).toEqual(['Hades.exe']);
  });

  it('switching a parsed pc game to another mode drops the block (modes are exclusive)', () => {
    const model: ManifestFormModel = {
      ...parseOk(pcText).model,
      launchMode: 'executable',
      executable: 'g/g.exe',
    };
    const parsed = JSON.parse(formModelToText(model, {}, {})) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('pc');
    expect(parsed['executable']).toBe('g/g.exe');
  });

  it('emptyFormModel("pc") starts a blank library in pc mode', () => {
    expect(launchModeOf(emptyFormModel('pc'))).toBe('pc');
    expect(launchModeOf(emptyFormModel())).toBe('executable');
  });

  it('serializes an EMPTY game list as [] (the PC library was emptied)', () => {
    expect(gamesToText([])).toBe('[]\n');
  });
});

describe('steam mode in the PC library (a Steam game installed on this PC)', () => {
  const steamText = JSON.stringify({
    schemaVersion: 1,
    id: 'hades',
    title: 'Hades',
    steam: { appid: 1145360 },
    watchProcesses: ['Hades.exe'],
    heroImage: 'assets/hero.jpg',
    pcSavePath: '%APPDATA%/Hades',
  });

  it('round-trips into a manifest the PC-source validator accepts', () => {
    const result = parseOk(steamText);
    expect(launchModeOf(result.model)).toBe('steam');
    const text = serialize(steamText);
    expect(validateManifestText(text, t, 'pc').ok).toBe(true);
    expect(serialize(text)).toBe(text); // idempotent
  });

  it('keeps pcSavePath — the save backup a local Steam game gets from the library', () => {
    const parsed = JSON.parse(serialize(steamText)) as Record<string, unknown>;
    expect(parsed['pcSavePath']).toBe('%APPDATA%/Hades');
    expect(parsed).not.toHaveProperty('saveOnCard');
  });

  // The counterpart of the rule above, and the reason `saveOnCard` may NOT be gated by launch mode: on a
  // CARD a Steam game's save sync is exactly `saveOnCard` + `pcSavePath`. Suppressing it for steam mode
  // would silently break every existing Steam card. The PC library is kept clean by the form instead (it
  // hides the field and clears the slot when the edited root is the library — see FormView.setSource).
  it('still emits saveOnCard for a CARD steam game', () => {
    const cardSteam = JSON.stringify({
      schemaVersion: 1,
      id: 'hades',
      title: 'Hades',
      steam: { appid: 1145360 },
      watchProcesses: ['Hades.exe'],
      heroImage: 'assets/hero.jpg',
      saveOnCard: 'saves/hades',
      pcSavePath: '%APPDATA%/Hades',
    });
    const parsed = JSON.parse(serialize(cardSteam)) as Record<string, unknown>;
    expect(parsed['saveOnCard']).toBe('saves/hades');
    expect(validateManifestText(serialize(cardSteam), t, 'card').ok).toBe(true);
  });
});

describe('multi-game wrapper (textToGames / gamesToText)', () => {
  const gameText = (id: string): string =>
    `{"schemaVersion":1,"id":"${id}","title":"${id}","executable":"g.exe","heroImage":"h.jpg"}`;

  /** Reparses parse results into serializable game states (as configure.ts's slots do). */
  function slots(text: string): GameFormState[] {
    const parsed = textToGames(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    return parsed.games.map((g) => {
      expect(g.ok).toBe(true);
      if (!g.ok) throw new Error('unreachable');
      return { model: g.model, rest: g.rest, corrupt: g.corrupt };
    });
  }

  it('parses a single object into a one-element (non-array) list', () => {
    const parsed = textToGames(gameText('solo'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.isArray).toBe(false);
      expect(parsed.games).toHaveLength(1);
    }
  });

  it('parses a non-empty array into one result per game', () => {
    const parsed = textToGames(`[${gameText('a')},${gameText('b')}]`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.isArray).toBe(true);
      expect(parsed.games).toHaveLength(2);
    }
  });

  it('rejects a syntax error and an empty array', () => {
    expect(textToGames('{ not json').ok).toBe(false);
    expect(textToGames('[]').ok).toBe(false);
    expect(textToGames('42').ok).toBe(false);
  });

  it('serializes one game as an OBJECT, several as an ARRAY (decision 2)', () => {
    const oneText = gamesToText(slots(gameText('solo')));
    expect(Array.isArray(JSON.parse(oneText))).toBe(false);

    const manyText = gamesToText(slots(`[${gameText('a')},${gameText('b')}]`));
    const many = JSON.parse(manyText) as unknown;
    expect(Array.isArray(many)).toBe(true);
    expect(many).toHaveLength(2);
  });

  it('round-trips an array losslessly and the result validates', () => {
    const source = `[${gameText('a')},${gameText('b')}]`;
    const text = gamesToText(slots(source));
    expect(validateManifestText(text, t).ok).toBe(true);
    const reparsed = textToGames(text);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.games.map((g) => (g.ok ? g.model.id : ''))).toEqual(['a', 'b']);
  });

  it('keeps a non-object array element as a non-ok result (caller stays on JSON)', () => {
    const parsed = textToGames(`[${gameText('a')}, 42]`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.games[0]?.ok).toBe(true);
      expect(parsed.games[1]?.ok).toBe(false);
    }
  });

  // The per-game editor makes this reachable: readManifests SKIPS a game that does not resolve, the rest
  // of the card stays playable, and the user edits one of them. Saving must not take the broken neighbour
  // with it — hence the raw slot (see the plan, Р2).
  it('writes an unrepresentable neighbour back VERBATIM instead of dropping it', () => {
    const source = `[${gameText('a')}, ["not", "a game"]]`;
    const parsed = textToGames(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');

    const rebuilt: GameFormState[] = parsed.games.map((game, index) => {
      if (!game.ok) return { raw: parsed.values[index] };
      return { model: game.model, rest: game.rest, corrupt: game.corrupt };
    });
    // The editable slot even changes, exactly as a real edit would.
    const first = rebuilt[0];
    if (first === undefined || !('model' in first)) throw new Error('unreachable');
    rebuilt[0] = { ...first, model: { ...first.model, title: 'Renamed' } };

    const out = JSON.parse(gamesToText(rebuilt)) as unknown;
    expect(Array.isArray(out)).toBe(true);
    const games = out as readonly Record<string, unknown>[];
    expect(games).toHaveLength(2);
    expect(games[0]?.title).toBe('Renamed');
    expect(games[1]).toEqual(['not', 'a game']);
  });
});

// Adding a game to a root the launcher has never written to is the case the multi-game wrapper alone
// cannot express: `textToGames` rejects an empty list, so a blank card would look like a broken file.
describe('slotsWithNewGame (the Add-game screen\'s starting point)', () => {
  const gameText = (id: string): string =>
    `{"schemaVersion":1,"id":"${id}","title":"${id}","executable":"g.exe","heroImage":"h.jpg"}`;

  it('starts a root with NO game.json on a single blank slot', () => {
    const result = slotsWithNewGame(null, 'pc');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.slots).toHaveLength(1);
    expect(result.index).toBe(0);
    const slot = result.slots[0];
    if (slot === undefined || isRawSlot(slot)) throw new Error('unreachable');
    expect(slot.model.launchMode).toBe('pc');
    expect(slot.model.id).toBe('');
  });

  it('treats an empty file the same way (nothing to carry over)', () => {
    const result = slotsWithNewGame('   ', 'executable');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.slots).toHaveLength(1);
  });

  it('appends the new game AFTER a single-object manifest', () => {
    const result = slotsWithNewGame(gameText('hades'), 'executable');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.slots).toHaveLength(2);
    expect(result.index).toBe(1);
    const first = result.slots[0];
    if (first === undefined || isRawSlot(first)) throw new Error('unreachable');
    expect(first.model.id).toBe('hades');
  });

  it('appends the new game AFTER an array manifest', () => {
    const result = slotsWithNewGame(`[${gameText('a')},${gameText('b')}]`, 'executable');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.slots).toHaveLength(3);
    expect(result.index).toBe(2);
  });

  // The neighbour a naive rewrite destroys: an element the form cannot represent is carried verbatim.
  it('keeps a slot the form cannot represent, verbatim', () => {
    const result = slotsWithNewGame(`[${gameText('a')},42]`, 'executable');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const raw = result.slots[1];
    if (raw === undefined || !isRawSlot(raw)) throw new Error('unreachable');
    expect(raw.raw).toBe(42);
    expect(JSON.parse(gamesToText(result.slots.slice(0, 2)))).toEqual([
      expect.objectContaining({ id: 'a' }),
      42,
    ]);
  });

  it('reports an unreadable manifest rather than starting from a blank one', () => {
    expect(slotsWithNewGame('{ not json', 'executable').ok).toBe(false);
  });
});

describe('drift guard: form keys vs the zod schema', () => {
  it('KNOWN_MANIFEST_KEYS equals the manifest JSON Schema properties', () => {
    // The schema is a oneOf [ objectSchema, arrayOf(objectSchema) ]; the game object's properties are the
    // first branch (see manifestJsonSchema).
    const schema = manifestJsonSchema() as {
      oneOf?: Array<{ properties?: Record<string, unknown> }>;
    };
    const objectSchema = schema.oneOf?.[0];
    const schemaKeys = new Set(Object.keys(objectSchema?.properties ?? {}));
    expect(schemaKeys).toEqual(new Set(KNOWN_MANIFEST_KEYS));
  });
});

describe('slugifyId', () => {
  const ID_RE = /^[A-Za-z0-9._-]+$/; // the manifest id schema regex

  it('slugifies the canonical example', () => {
    expect(slugifyId('Clair Obscur: Expedition 33')).toBe('clair-obscur-expedition-33');
  });

  it('lowercases, collapses runs of punctuation/space, and trims dashes', () => {
    expect(slugifyId('  The   Witcher 3: Wild Hunt!  ')).toBe('the-witcher-3-wild-hunt');
    expect(slugifyId('A---B__C')).toBe('a-b-c');
  });

  it('strips accents to plain latin (é → e)', () => {
    expect(slugifyId('Café Society')).toBe('cafe-society');
  });

  it('returns empty for a name with no latin/digit characters (all-Cyrillic)', () => {
    expect(slugifyId('Ведьмак')).toBe('');
  });

  it('produces a schema-valid id or empty for a range of names', () => {
    for (const name of ['Portal 2', 'HELLO', 'x', '  spaced  ', 'Ori & the Blind Forest']) {
      const id = slugifyId(name);
      if (id !== '') expect(id).toMatch(ID_RE);
    }
  });
});
