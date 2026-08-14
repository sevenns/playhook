// The PC library's data-touching half: how an absent/empty/broken game.json is graded, asset import
// (sanitizing + de-duplication) and the orphan sweep that must never touch save backups.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PcLibraryStore } from '../src/main/pc-library';
import { createTranslator } from '../src/shared/i18n/index';

const env = { documents: path.resolve('documents'), t: createTranslator('en') };
const resolveInstallDir = (): null => null;

let baseDir: string;
let library: PcLibraryStore;

// pc paths are NATIVE (the library never travels between machines) and CI runs on Windows too, so an
// absolute path is built from the platform root rather than written as a `/games/...` literal.
const exe = path.join(path.resolve(path.sep), 'Games', 'Hades', 'Hades.exe');

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-userdata-'));
  library = new PcLibraryStore({ baseDir });
  await library.init();
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

async function writeManifest(value: unknown): Promise<void> {
  await fs.writeFile(path.join(library.root, 'game.json'), JSON.stringify(value));
}

const pcGame = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  id: 'hades',
  title: 'Hades',
  pc: { executable: exe },
  ...extra,
});

describe('PcLibraryStore.init', () => {
  it('creates the library skeleton but no game.json (an absent file means "no games yet")', async () => {
    expect(await fs.stat(path.join(library.root, 'assets')).then(() => true)).toBe(true);
    expect(await library.hasManifest()).toBe(false);
  });
});

describe('PcLibraryStore.read', () => {
  it('reports an empty, intact library when there is no game.json', async () => {
    expect(await library.read(env, resolveInstallDir)).toEqual({ manifests: [], intact: true });
  });

  it('reports an empty, intact library for an empty array', async () => {
    await writeManifest([]);
    expect(await library.read(env, resolveInstallDir)).toEqual({ manifests: [], intact: true });
  });

  it('reads local games', async () => {
    await writeManifest([pcGame(), pcGame({ id: 'celeste', title: 'Celeste' })]);
    const read = await library.read(env, resolveInstallDir);
    expect(read.intact).toBe(true);
    expect(read.manifests.map((m) => m.raw.id)).toEqual(['hades', 'celeste']);
    expect(read.manifests[0]?.source).toBe('pc');
  });

  it('flags a BROKEN game.json as not intact instead of throwing', async () => {
    await fs.writeFile(path.join(library.root, 'game.json'), '{ not json');
    const read = await library.read(env, resolveInstallDir);
    expect(read).toEqual({ manifests: [], intact: false });
  });
});

describe('PcLibraryStore.importAsset', () => {
  let source: string;

  beforeEach(async () => {
    source = path.join(baseDir, 'hero image.jpg');
    await fs.writeFile(source, 'IMG');
  });

  it('copies the file into assets/ and returns a root-relative path with forward slashes', async () => {
    const relative = await library.importAsset(source);
    expect(relative).toBe('assets/hero-image.jpg');
    expect(await fs.readFile(path.join(library.root, 'assets', 'hero-image.jpg'), 'utf8')).toBe('IMG');
  });

  it('de-duplicates a colliding name instead of overwriting the first game\'s artwork', async () => {
    const other = path.join(baseDir, 'other', 'hero image.jpg');
    await fs.mkdir(path.dirname(other), { recursive: true });
    await fs.writeFile(other, 'OTHER');

    expect(await library.importAsset(source)).toBe('assets/hero-image.jpg');
    expect(await library.importAsset(other)).toBe('assets/hero-image-2.jpg');
    expect(await fs.readFile(path.join(library.root, 'assets', 'hero-image.jpg'), 'utf8')).toBe('IMG');
    expect(await fs.readFile(path.join(library.root, 'assets', 'hero-image-2.jpg'), 'utf8')).toBe('OTHER');
  });

  it('sanitizes a name that would escape or hide (traversal, leading dots)', async () => {
    const nasty = path.join(baseDir, '..hidden .jpg');
    await fs.writeFile(nasty, 'IMG');
    const relative = await library.importAsset(nasty);
    expect(relative.startsWith('assets/')).toBe(true);
    expect(relative).not.toContain('..');
  });
});

describe('PcLibraryStore.gcOrphans', () => {
  it('removes unreferenced assets and keeps the referenced ones', async () => {
    const kept = await library.importAsset(await file('keep.jpg'));
    await library.importAsset(await file('drop.jpg'));

    await library.gcOrphans([kept]);

    expect(await fs.readdir(path.join(library.root, 'assets'))).toEqual(['keep.jpg']);
  });

  it('never touches the save backups', async () => {
    const saves = library.savesDir('hades');
    await fs.mkdir(saves, { recursive: true });
    await fs.writeFile(path.join(saves, 'slot1.sav'), 'PROGRESS');

    await library.gcOrphans([]);

    expect(await fs.readFile(path.join(saves, 'slot1.sav'), 'utf8')).toBe('PROGRESS');
  });

  async function file(name: string): Promise<string> {
    const full = path.join(baseDir, name);
    await fs.writeFile(full, 'IMG');
    return full;
  }
});

describe('PcLibraryStore.removeManifest', () => {
  it('drops game.json — how "the last local game was deleted" is spelled', async () => {
    await writeManifest([pcGame()]);
    expect(await library.hasManifest()).toBe(true);
    await library.removeManifest();
    expect(await library.hasManifest()).toBe(false);
  });
});
