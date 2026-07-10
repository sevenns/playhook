import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  absoluteToPcSavePath,
  expandPcSavePath,
  manifestJsonSchema,
  resolveInside,
  validateManifestText,
} from '../src/main/manifest';
import { createTranslator } from '../src/shared/i18n/index';

// An English translator makes the translated messages identical to the previous hardcoded English, so
// the assertions below (incl. the `.includes('together')` check) hold unchanged.
const t = createTranslator('en');

// Path helpers are platform-sensitive (path.sep differs), so assertions check the *inside/outside*
// invariant rather than exact separators — the anti-traversal contract is what matters (audit S4).
const root = path.resolve('card-root');

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

describe('resolveInside', () => {
  it('resolves a card-relative path inside the root', () => {
    const resolved = resolveInside(root, path.join('saves', 'game.sav'));
    expect(resolved).not.toBeNull();
    expect(isInside(root, resolved as string)).toBe(true);
  });

  it('rejects parent-traversal with ..', () => {
    expect(resolveInside(root, path.join('..', 'outside.exe'))).toBeNull();
    expect(resolveInside(root, path.join('..', '..', 'etc', 'passwd'))).toBeNull();
  });

  it('rejects absolute paths', () => {
    expect(resolveInside(root, '/etc/passwd')).toBeNull();
  });
});

describe('expandPcSavePath', () => {
  const docs = path.resolve('documents-base');
  const savedAppData = process.env['APPDATA'];

  beforeEach(() => {
    process.env['APPDATA'] = path.resolve('appdata-base');
  });
  afterEach(() => {
    if (savedAppData === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = savedAppData;
  });

  it('expands %DOCUMENTS% to a path inside the documents base', () => {
    const result = expandPcSavePath('%DOCUMENTS%\\Saves\\MyGame', { documents: docs, t });
    expect(result.ok).toBe(true);
    if (result.ok) expect(isInside(docs, result.value)).toBe(true);
  });

  it('expands an allowlisted env prefix (%APPDATA%)', () => {
    const result = expandPcSavePath('%APPDATA%\\MyGame', { documents: docs, t });
    expect(result.ok).toBe(true);
  });

  it('rejects a prefix that is not on the allowlist', () => {
    const result = expandPcSavePath('%WINDIR%\\System32', { documents: docs, t });
    expect(result.ok).toBe(false);
  });

  it('rejects a path with no %PREFIX%', () => {
    const result = expandPcSavePath('C:\\Users\\me\\Saves', { documents: docs, t });
    expect(result.ok).toBe(false);
  });

  it('rejects traversal via ..', () => {
    const result = expandPcSavePath('%DOCUMENTS%\\..\\..\\Windows', { documents: docs, t });
    expect(result.ok).toBe(false);
  });

  it('reports an unavailable prefix when the env var is missing', () => {
    delete process.env['APPDATA'];
    const result = expandPcSavePath('%APPDATA%\\MyGame', { documents: docs, t });
    expect(result.ok).toBe(false);
  });
});

describe('validateManifestText', () => {

  it('rejects JSONC (README-style // comments) as a syntax error', () => {
    const jsonc = '{\n  "schemaVersion": 1, // a comment\n  "id": "x"\n}';
    const result = validateManifestText(jsonc, t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('(root)');
  });

  it('rejects broken JSON', () => {
    const result = validateManifestText('{ not json', t);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-steam manifest with no executable (schema)', () => {
    const result = validateManifestText(JSON.stringify({ schemaVersion: 1, id: 'x', title: 'X' }), t);
    expect(result.ok).toBe(false);
  });

  it('rejects steam mode without watchProcesses (schema)', () => {
    const text = JSON.stringify({ schemaVersion: 1, id: 'x', title: 'X', steam: { appid: 480 } });
    expect(validateManifestText(text, t).ok).toBe(false);
  });

  it('rejects a custom installer that is elevated (schema refine)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      install: { installer: 's/s.exe', type: 'custom', runAsAdmin: true, args: ['{dir}'] },
    });
    expect(validateManifestText(text, t).ok).toBe(false);
  });

  it('rejects executable path traversal (semantic, fs-free)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: '../outside.exe',
    });
    const result = validateManifestText(text, t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'executable')).toBe(true);
  });

  it('rejects an invalid pcSavePath prefix (semantic, fs-free)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      saveOnCard: 'saves',
      pcSavePath: '%WINDIR%/System32',
    });
    const result = validateManifestText(text, t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'pcSavePath')).toBe(true);
  });

  it('rejects a lone saveOnCard without pcSavePath (semantic pairing)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      saveOnCard: 'saves',
    });
    const result = validateManifestText(text, t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes('together'))).toBe(true);
  });

  it('requires a heroImage for every game (editor-only policy)', () => {
    const text = JSON.stringify({ schemaVersion: 1, id: 'x', title: 'X', executable: 'g/g.exe' });
    const result = validateManifestText(text, t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'heroImage')).toBe(true);
  });

  it('accepts a single game object with a hero (bare field paths)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      heroImage: 'hero.jpg',
    });
    expect(validateManifestText(text, t).ok).toBe(true);
  });
});

describe('validateManifestText — multi-game array', () => {
  const game = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    schemaVersion: 1,
    id,
    title: id,
    executable: 'g/g.exe',
    heroImage: 'hero.jpg',
    ...extra,
  });

  it('accepts a non-empty array of valid games', () => {
    const text = JSON.stringify([game('a'), game('b')]);
    expect(validateManifestText(text, t).ok).toBe(true);
  });

  it('rejects an empty array', () => {
    const result = validateManifestText('[]', t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('(root)');
  });

  it('rejects duplicate ids across games', () => {
    const text = JSON.stringify([game('dup'), game('dup')]);
    const result = validateManifestText(text, t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'games.1.id')).toBe(true);
  });

  it('prefixes each element\'s issue path with games.<i>.', () => {
    // Second game is missing its hero → the issue is attributed to games.1.heroImage.
    const text = JSON.stringify([game('a'), game('b', { heroImage: undefined })]);
    const result = validateManifestText(text, t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'games.1.heroImage')).toBe(true);
  });

  it('rejects a top-level that is neither an object nor an array', () => {
    const result = validateManifestText('42', t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('(root)');
  });
});

describe('absoluteToPcSavePath (reverse of expandPcSavePath, for the folder picker)', () => {
  const docs = path.resolve('docs-base');
  const home = path.resolve('home-base');
  const saved = {
    APPDATA: process.env['APPDATA'],
    LOCALAPPDATA: process.env['LOCALAPPDATA'],
    USERPROFILE: process.env['USERPROFILE'],
  };
  const env = { documents: docs, t };

  beforeEach(() => {
    process.env['USERPROFILE'] = home;
    process.env['APPDATA'] = path.join(home, 'AppData', 'Roaming');
    process.env['LOCALAPPDATA'] = path.join(home, 'AppData', 'Local');
  });
  afterEach(() => {
    for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('maps a folder under %DOCUMENTS%', () => {
    expect(absoluteToPcSavePath(path.join(docs, 'MyGame', 'Saves'), env)).toBe('%DOCUMENTS%/MyGame/Saves');
  });

  it('prefers the most specific base (%APPDATA% over %USERPROFILE%)', () => {
    const abs = path.join(home, 'AppData', 'Roaming', 'MyGame');
    expect(absoluteToPcSavePath(abs, env)).toBe('%APPDATA%/MyGame');
  });

  it('maps the base folder itself to the bare prefix', () => {
    expect(absoluteToPcSavePath(path.join(home, 'AppData', 'Local'), env)).toBe('%LOCALAPPDATA%');
  });

  it('returns null for a folder under no known base', () => {
    expect(absoluteToPcSavePath(path.resolve('somewhere', 'else'), env)).toBeNull();
  });
});

interface ObjectSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: ObjectSchema;
}

describe('manifestJsonSchema', () => {
  it('is a oneOf of a game object and a non-empty array of them, exposing the required root fields', () => {
    const schema = manifestJsonSchema() as { oneOf?: ObjectSchema[] };
    expect(Array.isArray(schema.oneOf)).toBe(true);
    const [objectSchema, arraySchema] = schema.oneOf ?? [];
    // First branch: a single game object.
    expect(objectSchema?.type).toBe('object');
    expect(Object.keys(objectSchema?.properties ?? {})).toEqual(
      expect.arrayContaining(['schemaVersion', 'id', 'title']),
    );
    expect(objectSchema?.required).toEqual(expect.arrayContaining(['schemaVersion', 'id', 'title']));
    // Second branch: an array of the same object schema.
    expect(arraySchema?.type).toBe('array');
    expect(arraySchema?.items?.type).toBe('object');
  });
});
