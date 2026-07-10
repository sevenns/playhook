import { describe, expect, it } from 'vitest';
import {
  formModelToText,
  textToFormModel,
  textToGames,
  gamesToText,
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

  it('preserves an unknown key NESTED inside sounds', () => {
    const src =
      '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","sounds":{"play":"p.wav","custom":7}}';
    const parsed = JSON.parse(serialize(src)) as { sounds?: Record<string, unknown> };
    expect(parsed.sounds).toMatchObject({ play: 'p.wav', custom: 7 });
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

  it('marks the whole sounds block corrupt when a slot has the wrong type', () => {
    const src =
      '{"schemaVersion":1,"id":"g","title":"G","executable":"g.exe","sounds":{"play":5}}';
    const { corrupt } = parseOk(src);
    expect(corrupt).toHaveProperty('sounds');
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
