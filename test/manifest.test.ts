import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  expandPcSavePath,
  manifestJsonSchema,
  resolveInside,
  validateManifestText,
} from '../src/main/manifest';
import { MANIFEST_TEMPLATES } from '../src/main/manifest-templates';

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
    const result = expandPcSavePath('%DOCUMENTS%\\Saves\\MyGame', { documents: docs });
    expect(result.ok).toBe(true);
    if (result.ok) expect(isInside(docs, result.value)).toBe(true);
  });

  it('expands an allowlisted env prefix (%APPDATA%)', () => {
    const result = expandPcSavePath('%APPDATA%\\MyGame', { documents: docs });
    expect(result.ok).toBe(true);
  });

  it('rejects a prefix that is not on the allowlist', () => {
    const result = expandPcSavePath('%WINDIR%\\System32', { documents: docs });
    expect(result.ok).toBe(false);
  });

  it('rejects a path with no %PREFIX%', () => {
    const result = expandPcSavePath('C:\\Users\\me\\Saves', { documents: docs });
    expect(result.ok).toBe(false);
  });

  it('rejects traversal via ..', () => {
    const result = expandPcSavePath('%DOCUMENTS%\\..\\..\\Windows', { documents: docs });
    expect(result.ok).toBe(false);
  });

  it('reports an unavailable prefix when the env var is missing', () => {
    delete process.env['APPDATA'];
    const result = expandPcSavePath('%APPDATA%\\MyGame', { documents: docs });
    expect(result.ok).toBe(false);
  });
});

describe('validateManifestText', () => {
  it('accepts all three starter templates (also catches JSONC/trailing-comment leftovers)', () => {
    for (const [name, text] of Object.entries(MANIFEST_TEMPLATES)) {
      const result = validateManifestText(text);
      expect(result.ok, `${name} template should be valid: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('rejects JSONC (README-style // comments) as a syntax error', () => {
    const jsonc = '{\n  "schemaVersion": 1, // a comment\n  "id": "x"\n}';
    const result = validateManifestText(jsonc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('(root)');
  });

  it('rejects broken JSON', () => {
    const result = validateManifestText('{ not json');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-steam manifest with no executable (schema)', () => {
    const result = validateManifestText(JSON.stringify({ schemaVersion: 1, id: 'x', title: 'X' }));
    expect(result.ok).toBe(false);
  });

  it('rejects steam mode without watchProcesses (schema)', () => {
    const text = JSON.stringify({ schemaVersion: 1, id: 'x', title: 'X', steam: { appid: 480 } });
    expect(validateManifestText(text).ok).toBe(false);
  });

  it('rejects a custom installer that is elevated (schema refine)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: 'g/g.exe',
      install: { installer: 's/s.exe', type: 'custom', runAsAdmin: true, args: ['{dir}'] },
    });
    expect(validateManifestText(text).ok).toBe(false);
  });

  it('rejects executable path traversal (semantic, fs-free)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      executable: '../outside.exe',
    });
    const result = validateManifestText(text);
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
    const result = validateManifestText(text);
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
    const result = validateManifestText(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes('together'))).toBe(true);
  });
});

describe('manifestJsonSchema', () => {
  it('converts without throwing and exposes the required root fields', () => {
    const schema = manifestJsonSchema() as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['schemaVersion', 'id', 'title']),
    );
    expect(schema.required).toEqual(expect.arrayContaining(['schemaVersion', 'id', 'title']));
  });
});
