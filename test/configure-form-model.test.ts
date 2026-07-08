import { describe, expect, it } from 'vitest';
import {
  formModelToText,
  textToFormModel,
  launchModeOf,
  KNOWN_MANIFEST_KEYS,
  type ManifestFormModel,
} from '../src/renderer/configure-form-model';
import { manifestJsonSchema, validateManifestText } from '../src/main/manifest';
import { MANIFEST_TEMPLATES } from '../src/main/manifest-templates';
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

describe('round-trip on the three starter templates', () => {
  it('serializes each template into a VALID, minimal manifest', () => {
    for (const [name, template] of Object.entries(MANIFEST_TEMPLATES)) {
      const text = serialize(template);
      const validation = validateManifestText(text, t);
      expect(validation.ok, `${name} → serialized must validate: ${JSON.stringify(validation)}`).toBe(true);
    }
  });

  it('is idempotent (the normalized text is a fixed point of parse∘serialize)', () => {
    for (const [name, template] of Object.entries(MANIFEST_TEMPLATES)) {
      const once = serialize(template);
      const twice = serialize(once);
      expect(twice, `${name} normalization must be stable`).toBe(once);
    }
  });

  it('omits fields equal to their schema default (args/runAsAdmin/launchTimeoutSec 30)', () => {
    const text = serialize(MANIFEST_TEMPLATES.executable);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('args');
    expect(parsed).not.toHaveProperty('runAsAdmin');
    expect(parsed).not.toHaveProperty('launchTimeoutSec');
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
    const base = parseOk(MANIFEST_TEMPLATES.steam);
    // A steam-mode model that still carries an executable typed under another mode must NOT emit it.
    const model: ManifestFormModel = { ...base.model, launchMode: 'steam', executable: 'ghost.exe' };
    const parsed = JSON.parse(formModelToText(model, {}, {})) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('executable');
    expect(parsed).toHaveProperty('steam');
  });
});

describe('drift guard: form keys vs the zod schema', () => {
  it('KNOWN_MANIFEST_KEYS equals the manifest JSON Schema properties', () => {
    const schema = manifestJsonSchema() as { properties?: Record<string, unknown> };
    const schemaKeys = new Set(Object.keys(schema.properties ?? {}));
    expect(schemaKeys).toEqual(new Set(KNOWN_MANIFEST_KEYS));
  });
});
