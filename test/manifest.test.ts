import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandPcSavePath, resolveInside } from '../src/main/manifest';

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
