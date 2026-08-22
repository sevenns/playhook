import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  absoluteToPcSavePath,
  expandPcSavePath,
  manifestJsonSchema,
  readManifests,
  resolveInside,
  stripCopySourcePrefix,
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

  it('normalizes Windows backslash separators (Р12)', () => {
    // A Windows-authored `"bin\\game.exe"` must resolve INSIDE the root on Linux too, where `\` is not a
    // separator — the normalization turns it into `bin/game.exe` before resolving.
    const resolved = resolveInside(root, 'bin\\game.exe');
    expect(resolved).not.toBeNull();
    expect(isInside(root, resolved as string)).toBe(true);
    // Same target as the forward-slash form → identical resolution on every platform.
    expect(resolved).toBe(resolveInside(root, 'bin/game.exe'));
  });

  it('still rejects traversal written with backslashes (Р12)', () => {
    expect(resolveInside(root, '..\\outside.exe')).toBeNull();
  });
});

describe('stripCopySourcePrefix (copy mode: executable relative to the copied dir)', () => {
  it('trims a leading <source>/ from a card-root-relative executable', () => {
    expect(stripCopySourcePrefix('game/game.exe', 'game')).toBe('game.exe');
    expect(stripCopySourcePrefix('Games/MyGame/bin/game.exe', 'Games/MyGame')).toBe('bin/game.exe');
  });

  it('leaves an executable already relative to the copied dir untouched', () => {
    expect(stripCopySourcePrefix('game.exe', 'game')).toBe('game.exe');
    expect(stripCopySourcePrefix('bin/game.exe', 'Games/MyGame')).toBe('bin/game.exe');
  });

  it('normalizes Windows backslashes on both sides (Р12)', () => {
    expect(stripCopySourcePrefix('game\\game.exe', 'game')).toBe('game.exe');
    expect(stripCopySourcePrefix('Games\\MyGame\\bin\\game.exe', 'Games\\MyGame')).toBe(
      'bin/game.exe',
    );
  });

  it('tolerates a trailing slash on the source', () => {
    expect(stripCopySourcePrefix('game/game.exe', 'game/')).toBe('game.exe');
  });

  it('does not trim a same-named prefix that is not a full path segment', () => {
    // source `game`, executable `gameplay/x.exe` — `gameplay` is not the `game` segment.
    expect(stripCopySourcePrefix('gameplay/x.exe', 'game')).toBe('gameplay/x.exe');
  });

  it('is a no-op with an empty source', () => {
    expect(stripCopySourcePrefix('game/game.exe', '')).toBe('game/game.exe');
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

  it('rejects a non-steam CARD manifest with no executable (semantic — the schema no longer requires it, to allow the PC-library draft state)', () => {
    const result = validateManifestText(
      JSON.stringify({ schemaVersion: 1, id: 'x', title: 'X' }),
      t,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === 'executable')).toBe(true);
      // heroRequired fires in the same pass now that the schema itself no longer short-circuits.
      expect(result.issues.some((i) => i.path === 'heroImage')).toBe(true);
    }
  });

  // The description is fetched online and written by the form; nothing reads it back yet. What matters
  // now is that a bad one can never cost the user a playable game — see the `.catch(undefined)` in the
  // schema, and the same tolerance the manifest already shows towards unknown keys.
  it('accepts a manifest carrying a localized description', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      heroImage: 'a/hero.jpg',
      description: { en: 'A game.', ru: 'Игра.' },
    });
    expect(validateManifestText(text, t).ok).toBe(true);
  });

  it('does not reject a manifest whose description is malformed — it is dropped instead', () => {
    for (const description of ['just a string', 42, { en: 'a'.repeat(5000) }, { en: 7 }]) {
      const text = JSON.stringify({
        schemaVersion: 1,
        id: 'x',
        title: 'X',
        executable: 'g/g.exe',
        heroImage: 'a/hero.jpg',
        description,
      });
      expect(validateManifestText(text, t).ok, JSON.stringify(description)).toBe(true);
    }
  });

  it('accepts the facts stored for a future library view', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      heroImage: 'a/hero.jpg',
      genres: ['Action', 'Roguelike'],
      releaseDate: '2020-09-17',
      platforms: ['windows', 'linux'],
    });
    expect(validateManifestText(text, t).ok).toBe(true);
  });

  it('drops a malformed genre list / date / platform rather than rejecting the game', () => {
    const cases: readonly Record<string, unknown>[] = [
      { genres: 'Action' },
      { genres: [1, 2] },
      { releaseDate: 'Coming soon' },
      { platforms: ['amiga'] },
      { platforms: 'windows' },
    ];
    for (const extra of cases) {
      const text = JSON.stringify({
        schemaVersion: 1,
        id: 'x',
        title: 'X',
        executable: 'g/g.exe',
        heroImage: 'a/hero.jpg',
        ...extra,
      });
      expect(validateManifestText(text, t).ok, JSON.stringify(extra)).toBe(true);
    }
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

  it('accepts install.type "copy" (move game to PC — the installer field is the game directory)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'bin/game.exe',
      heroImage: 'hero.jpg',
      install: { installer: 'Games/Witcher', type: 'copy' },
    });
    expect(validateManifestText(text, t).ok).toBe(true);
  });

  it('rejects install.args with type "copy" (nothing is launched — schema refine)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'bin/game.exe',
      install: { installer: 'Games/Witcher', type: 'copy', args: ['/S'] },
    });
    const result = validateManifestText(text, t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'install.args')).toBe(true);
  });

  it('rejects install.runAsAdmin with type "copy" (no process to elevate — schema refine)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'bin/game.exe',
      install: { installer: 'Games/Witcher', type: 'copy', runAsAdmin: true },
    });
    const result = validateManifestText(text, t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'install.runAsAdmin')).toBe(true);
  });

  it('ACCEPTS install.winetricks with type "copy" (the prefix is provisioned before the copy)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'bin/game.exe',
      heroImage: 'hero.jpg',
      install: { installer: 'Games/Witcher', type: 'copy', winetricks: ['dotnet48'] },
    });
    expect(validateManifestText(text, t).ok).toBe(true);
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

  it("prefixes each element's issue path with games.<i>.", () => {
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
    expect(absoluteToPcSavePath(path.join(docs, 'MyGame', 'Saves'), env)).toBe(
      '%DOCUMENTS%/MyGame/Saves',
    );
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
    expect(objectSchema?.required).toEqual(
      expect.arrayContaining(['schemaVersion', 'id', 'title']),
    );
    // Second branch: an array of the same object schema.
    expect(arraySchema?.type).toBe('array');
    expect(arraySchema?.items?.type).toBe('object');
  });

  // The schema is GENERATED from the zod schema, so `copy` needs no hand-editing here — this guards that
  // generation (a hand-maintained enum drifting from zod would leave the editor red on a valid manifest).
  it('carries the install.type enum incl. "copy", straight from the zod schema', () => {
    const schema = manifestJsonSchema() as { oneOf?: ObjectSchema[] };
    const json = JSON.stringify(schema.oneOf?.[0]?.properties?.['install'] ?? {});
    for (const type of ['nsis', 'inno', 'custom', 'copy']) {
      expect(json).toContain(`"${type}"`);
    }
  });
});

// ── gridImage + the hero cap (carousel feature) ──────────────────────────────
// The runtime/editor split: `validateManifestText` (the editor's Save gate) is STRICT about a 4th hero
// image, while `readManifests` stays lenient — it truncates and keeps the card readable. Both halves are
// asserted, because enforcing the cap in the schema instead would make an existing 4-hero card unloadable.

describe('validateManifestText — gridImage', () => {
  const game = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      heroImage: 'hero.jpg',
      ...extra,
    });

  it('accepts a card-relative gridImage', () => {
    expect(validateManifestText(game({ gridImage: 'art/grid.jpg' }), t).ok).toBe(true);
  });

  it('accepts a manifest WITHOUT gridImage (the field is optional)', () => {
    expect(validateManifestText(game({}), t).ok).toBe(true);
  });

  it('rejects gridImage path traversal', () => {
    const result = validateManifestText(game({ gridImage: '../../etc/passwd' }), t);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'gridImage')).toBe(true);
  });

  it('rejects a 4th heroImage (editor-only cap)', () => {
    const result = validateManifestText(
      game({ heroImage: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'] }),
      t,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'heroImage')).toBe(true);
  });

  it('accepts exactly three heroImages', () => {
    expect(validateManifestText(game({ heroImage: ['a.jpg', 'b.jpg', 'c.jpg'] }), t).ok).toBe(true);
  });
});

describe('readManifests — gridImage + hero truncation (runtime is lenient)', () => {
  const env = { documents: path.resolve('documents'), t };
  const resolveInstallDir = (): null => null;
  let cardRoot: string;

  beforeEach(async () => {
    cardRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-card-'));
    await fs.mkdir(path.join(cardRoot, 'g'), { recursive: true });
    await fs.writeFile(path.join(cardRoot, 'g', 'g.exe'), '');
  });

  afterEach(async () => {
    await fs.rm(cardRoot, { recursive: true, force: true });
  });

  const write = async (game: Record<string, unknown>): Promise<void> => {
    await fs.writeFile(path.join(cardRoot, 'game.json'), JSON.stringify(game));
  };

  it('keeps the first three heroImages IN ORDER and still loads the card', async () => {
    await write({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      heroImage: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
    });
    const result = await readManifests(cardRoot, env, resolveInstallDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.manifests[0]?.heroImagePaths ?? [];
    expect(paths).toEqual([
      path.join(cardRoot, 'a.jpg'),
      path.join(cardRoot, 'b.jpg'),
      path.join(cardRoot, 'c.jpg'),
    ]);
  });

  it('resolves gridImage inside the card root', async () => {
    await write({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      gridImage: 'art/grid.jpg',
    });
    const result = await readManifests(cardRoot, env, resolveInstallDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifests[0]?.gridImagePath).toBe(path.join(cardRoot, 'art', 'grid.jpg'));
  });

  it('leaves gridImagePath undefined when the field is absent', async () => {
    await write({ schemaVersion: 1, id: 'x', title: 'X', executable: 'g/g.exe' });
    const result = await readManifests(cardRoot, env, resolveInstallDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifests[0]?.gridImagePath).toBeUndefined();
  });

  // The card-supplied UI sounds were dropped from the product. An old card still carries the block, and
  // it must load exactly as before: zod strips the unknown key (the schema is not strict) and nothing of
  // it reaches the resolved manifest.
  it('loads a card whose game.json still carries a `sounds` block, ignoring it', async () => {
    await write({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      sounds: { play: 'audio/play.wav', navigate: '../outside.wav' },
    });
    const result = await readManifests(cardRoot, env, resolveInstallDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = result.manifests[0];
    expect(manifest?.raw.id).toBe('x');
    expect(manifest).not.toHaveProperty('soundPaths');
    expect(manifest?.raw).not.toHaveProperty('sounds');
  });

  it('rejects a gridImage escaping the card root', async () => {
    await write({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      gridImage: '../../etc/passwd',
    });
    const result = await readManifests(cardRoot, env, resolveInstallDir);
    expect(result.ok).toBe(false);
  });
});

// ── PC mode (local games) ────────────────────────────────────────────────────
// The whole feature rests on one asymmetry: a `pc` block (and an absolute path) is legal ONLY when the
// manifest was read from the PC library. These tests pin both directions of that, plus the "a missing
// game keeps its card" rule that lets a deleted game stay in the library.
// Every path here is built with path.join/os.tmpdir: pc paths are NATIVE (the library never travels) and
// CI runs the suite on Windows too, where a `/games/x.exe` literal is not absolute.

describe('validateManifestText — pc mode', () => {
  const exe = path.join(path.resolve(path.sep), 'Games', 'Hades', 'Hades.exe');
  const pcGame = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      schemaVersion: 1,
      id: 'hades',
      title: 'Hades',
      pc: { executable: exe },
      heroImage: 'assets/hero.jpg',
      ...extra,
    });

  it('accepts a pc-mode game for source "pc"', () => {
    expect(validateManifestText(pcGame(), t, 'pc').ok).toBe(true);
  });

  it('rejects a pc block on a card', () => {
    const result = validateManifestText(pcGame(), t, 'card');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'pc')).toBe(true);
  });

  it('rejects a card-dialect executable in the PC library (B1 — no fifth launch mode)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      heroImage: 'assets/hero.jpg',
    });
    const result = validateManifestText(text, t, 'pc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'executable')).toBe(true);
  });

  it('accepts a draft with no launch method configured yet', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      heroImage: 'assets/hero.jpg',
    });
    expect(validateManifestText(text, t, 'pc').ok).toBe(true);
  });

  it('rejects a relative pc.executable', () => {
    const result = validateManifestText(pcGame({ pc: { executable: 'games/hades.exe' } }), t, 'pc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'pc.executable')).toBe(true);
  });

  it('rejects pc together with steam / install / executable / saveOnCard (schema)', () => {
    expect(validateManifestText(pcGame({ steam: { appid: 480 } }), t, 'pc').ok).toBe(false);
    expect(
      validateManifestText(pcGame({ install: { installer: 's.exe', type: 'nsis' } }), t, 'pc').ok,
    ).toBe(false);
    expect(validateManifestText(pcGame({ executable: 'g/g.exe' }), t, 'pc').ok).toBe(false);
    expect(validateManifestText(pcGame({ saveOnCard: 'saves' }), t, 'pc').ok).toBe(false);
  });

  it('accepts a lone pcSavePath (the backup side is supplied by the app)', () => {
    const abs = path.join(path.resolve(path.sep), 'Games', 'Hades', 'Saves');
    expect(validateManifestText(pcGame({ pcSavePath: abs }), t, 'pc').ok).toBe(true);
    expect(validateManifestText(pcGame({ pcSavePath: '%DOCUMENTS%/Hades' }), t, 'pc').ok).toBe(
      true,
    );
  });

  it('rejects an absolute pcSavePath on a CARD (the allowlist still rules there)', () => {
    const abs = path.join(path.resolve(path.sep), 'Games', 'Hades', 'Saves');
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      heroImage: 'hero.jpg',
      saveOnCard: 'saves',
      pcSavePath: abs,
    });
    const result = validateManifestText(text, t, 'card');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'pcSavePath')).toBe(true);
  });

  it('accepts an empty array for source "pc" (the library has no games left)', () => {
    expect(validateManifestText('[]', t, 'pc').ok).toBe(true);
    expect(validateManifestText('[]', t, 'card').ok).toBe(false);
  });
});

describe('validateManifestText — a STEAM game in the PC library', () => {
  const steamGame = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      schemaVersion: 1,
      id: 'hades',
      title: 'Hades',
      steam: { appid: 1145360 },
      watchProcesses: ['Hades.exe'],
      heroImage: 'assets/hero.jpg',
      ...extra,
    });

  it('accepts a steam game as the second mode the library allows', () => {
    expect(validateManifestText(steamGame(), t, 'pc').ok).toBe(true);
  });

  it('still rejects a card-dialect executable in the PC library, even with steam-shaped fields absent', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      heroImage: 'assets/hero.jpg',
    });
    const result = validateManifestText(text, t, 'pc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'executable')).toBe(true);
  });

  it('rejects saveOnCard for a LOCAL steam game (the library keeps the backup itself)', () => {
    const result = validateManifestText(steamGame({ saveOnCard: 'saves' }), t, 'pc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'saveOnCard')).toBe(true);
    // …while the very same manifest is the normal spelling on a card.
    expect(
      validateManifestText(
        steamGame({ saveOnCard: 'saves', pcSavePath: '%APPDATA%/Hades' }),
        t,
        'card',
      ).ok,
    ).toBe(true);
  });

  it('accepts a %PREFIX% pcSavePath (a Proton game keeps its saves inside the prefix)', () => {
    expect(validateManifestText(steamGame({ pcSavePath: '%APPDATA%/Hades' }), t, 'pc').ok).toBe(
      true,
    );
  });
});

describe('readManifests — pc source', () => {
  const env = { documents: path.resolve('documents'), t };
  const resolveInstallDir = (): null => null;
  let pcRoot: string;
  const exe = path.join(path.resolve(path.sep), 'Games', 'Hades', 'Hades.exe');

  beforeEach(async () => {
    pcRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-pc-'));
  });

  afterEach(async () => {
    await fs.rm(pcRoot, { recursive: true, force: true });
  });

  const write = async (value: unknown): Promise<void> => {
    await fs.writeFile(path.join(pcRoot, 'game.json'), JSON.stringify(value));
  };

  const pcGame = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    schemaVersion: 1,
    id: 'hades',
    title: 'Hades',
    pc: { executable: exe },
    ...extra,
  });

  it('resolves a pc game whose executable does NOT exist (it stays in the library)', async () => {
    await write(pcGame());
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = result.manifests[0];
    expect(manifest?.source).toBe('pc');
    expect(manifest?.executablePath).toBe(exe);
    expect(manifest?.cwd).toBe(path.dirname(exe));
  });

  it('marks a card manifest with source "card"', async () => {
    const cardRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-card-'));
    await fs.mkdir(path.join(cardRoot, 'g'), { recursive: true });
    await fs.writeFile(path.join(cardRoot, 'g', 'g.exe'), '');
    await fs.writeFile(
      path.join(cardRoot, 'game.json'),
      JSON.stringify({ schemaVersion: 1, id: 'x', title: 'X', executable: 'g/g.exe' }),
    );
    const result = await readManifests(cardRoot, env, resolveInstallDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifests[0]?.source).toBe('card');
    await fs.rm(cardRoot, { recursive: true, force: true });
  });

  it('substitutes saveOnCardPath under the library root when pcSavePath is set', async () => {
    const saves = path.join(path.resolve(path.sep), 'Games', 'Hades', 'Saves');
    await write(pcGame({ pcSavePath: saves }));
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifests[0]?.saveOnCardPath).toBe(path.join(pcRoot, 'saves', 'hades'));
    expect(result.manifests[0]?.pcSavePath).toBe(saves);
  });

  it('leaves saveOnCardPath undefined when the game declares no pcSavePath', async () => {
    await write(pcGame());
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifests[0]?.saveOnCardPath).toBeUndefined();
  });

  it('rejects a relative pc.executable', async () => {
    await write(pcGame({ pc: { executable: 'games/hades.exe' } }));
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifests).toEqual([]);
  });

  it('rejects a pc block read from a card root', async () => {
    await write(pcGame());
    const result = await readManifests(pcRoot, env, resolveInstallDir);
    expect(result.ok).toBe(false);
  });

  it('rejects a card-shaped manifest read from the PC library', async () => {
    await write({ schemaVersion: 1, id: 'x', title: 'X', executable: 'g/g.exe' });
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifests).toEqual([]);
  });

  it('rejects an install block in the PC library, even without executable (B1)', async () => {
    await write({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      install: { installer: 's.exe', type: 'nsis' },
    });
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifests).toEqual([]);
  });

  it('resolves a draft PC game with no launch method and marks it unconfigured', async () => {
    await write({ schemaVersion: 1, id: 'x', title: 'X', heroImage: 'assets/hero.jpg' });
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = result.manifests[0];
    expect(manifest?.unconfigured).toBe(true);
    expect(manifest?.executablePath).toBe('');
    expect(manifest?.cwd).toBe('');
  });

  it('treats a missing game.json as an empty library', async () => {
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifests).toEqual([]);
  });

  it('treats an empty array as an empty library (fatal on a card)', async () => {
    await write([]);
    const pcResult = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(pcResult.ok).toBe(true);
    if (pcResult.ok) expect(pcResult.manifests).toEqual([]);
    expect((await readManifests(pcRoot, env, resolveInstallDir)).ok).toBe(false);
  });

  it('resolves a local STEAM game (no executable of its own — steam:// does the launching)', async () => {
    await write({
      schemaVersion: 1,
      id: 'hades',
      title: 'Hades',
      steam: { appid: 1145360 },
      watchProcesses: ['Hades.exe'],
    });
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = result.manifests[0];
    expect(manifest?.source).toBe('pc');
    expect(manifest?.steam).toEqual({ appid: 1145360 });
    expect(manifest?.executablePath).toBe('');
  });

  it('gives a local steam game the same library-side save backup as a pc game', async () => {
    await write({
      schemaVersion: 1,
      id: 'hades',
      title: 'Hades',
      steam: { appid: 1145360 },
      watchProcesses: ['Hades.exe'],
      pcSavePath: '%APPDATA%/Hades',
    });
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifests[0]?.saveOnCardPath).toBe(path.join(pcRoot, 'saves', 'hades'));
    }
  });

  it('drops a local steam game that names a saveOnCard', async () => {
    await write({
      schemaVersion: 1,
      id: 'hades',
      title: 'Hades',
      steam: { appid: 1145360 },
      watchProcesses: ['Hades.exe'],
      saveOnCard: 'saves',
      pcSavePath: '%APPDATA%/Hades',
    });
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifests).toEqual([]);
  });

  it('reads several local games from an array', async () => {
    await write([pcGame(), pcGame({ id: 'celeste', title: 'Celeste' })]);
    const result = await readManifests(pcRoot, env, resolveInstallDir, { source: 'pc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifests.map((m) => m.raw.id)).toEqual(['hades', 'celeste']);
  });
});
