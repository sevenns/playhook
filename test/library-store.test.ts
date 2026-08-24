// The history store's data-touching half: byte caps, the lazy thumbnail (and its fallbacks), the
// unchanged-card shortcut, hero ORDER, and the index write. Importable in plain Node because `electron`
// is aliased to test/stubs/electron.ts (whose nativeImage stub decodes a trivial "IMG WxH" text format).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryStore } from '../src/main/library-store';
import type { ResolvedManifest, Stats } from '../src/shared/types';

const NO_STATS: Stats = {
  schemaVersion: 1,
  totalPlaySeconds: 0,
  lastPlayedAt: null,
  launchCount: 0,
};

let baseDir: string;
let cardRoot: string;
let statsById: Map<string, Stats>;

function store(): LibraryStore {
  return new LibraryStore({
    baseDir,
    readStats: (id) => Promise.resolve(statsById.get(id) ?? NO_STATS),
  });
}

/** Writes a file on the "card" and returns its absolute path. `size` pads it to that many bytes. */
async function card(relative: string, content = 'IMG 800x1200', size?: number): Promise<string> {
  const full = path.join(cardRoot, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const padded = size === undefined ? content : content.padEnd(size, '.');
  await fs.writeFile(full, padded);
  return full;
}

function manifest(id: string, overrides: Partial<ResolvedManifest> = {}): ResolvedManifest {
  return {
    raw: {
      schemaVersion: 1,
      id,
      title: id.toUpperCase(),
      args: [],
      runAsAdmin: false,
      launchTimeoutSec: 30,
      killTimeoutSec: 60,
      winetricks: [],
    },
    root: cardRoot,
    source: 'card',
    executablePath: path.join(cardRoot, 'g.exe'),
    cwd: cardRoot,
    ...overrides,
  };
}

async function readIndex(): Promise<{
  entries: Array<{
    id: string;
    title: string;
    hero: string[];
    grid?: string;
    music?: string;
    sourceSig?: string;
    savedAt: string;
    lastSeenAt: string | null;
    launchCount: number;
    sourceKind?: 'card' | 'pc';
    cardSlotHash?: string;
    configuredAt: string | null;
    collisionResolvedAt: string | null;
  }>;
}> {
  const raw = await fs.readFile(path.join(baseDir, 'library', 'index.json'), 'utf8');
  return JSON.parse(raw) as never;
}

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-library-'));
  cardRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-card-'));
  statsById = new Map();
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
  await fs.rm(cardRoot, { recursive: true, force: true });
});

describe('saveFromCard', () => {
  it('copies grid/hero/music and records them in the index', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', {
        gridImagePath: await card('art/grid.png'),
        heroImagePaths: [await card('art/h0.jpg'), await card('art/h1.jpg')],
        backgroundMusicPath: await card('audio/theme.mp3', 'music'),
      }),
    ]);

    const gameDir = path.join(baseDir, 'library', 'a');
    expect((await fs.readdir(gameDir)).sort()).toEqual([
      'grid.png',
      'hero-0.jpg',
      'hero-1.jpg',
      'music.mp3',
    ]);
    const index = await readIndex();
    expect(index.entries[0]?.hero).toEqual(['hero-0.jpg', 'hero-1.jpg']);
    expect(index.entries[0]?.grid).toBe('grid.png');
  });

  it('keeps the hero order of the manifest (the renderer keys its palette cache by position)', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', {
        heroImagePaths: [await card('z.jpg'), await card('a.jpg'), await card('m.jpg')],
      }),
    ]);
    const assets = await library.readBrowseAssets('a');
    // hero-0 came from z.jpg, hero-1 from a.jpg, hero-2 from m.jpg — the order of the manifest, not of
    // the file names.
    expect(assets.hero?.images).toHaveLength(3);
    expect((await readIndex()).entries[0]?.hero).toEqual([
      'hero-0.jpg',
      'hero-1.jpg',
      'hero-2.jpg',
    ]);
  });

  it('falls back to the first heroImage when the card has no gridImage', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([manifest('a', { heroImagePaths: [await card('h.jpg')] })]);
    expect((await readIndex()).entries[0]?.grid).toBe('grid.jpg');
  });

  it('skips an asset over its byte cap but still records the game', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', {
        gridImagePath: await card('art/grid.jpg'),
        backgroundMusicPath: await card('audio/huge.mp3', 'music', 9 * 1024 * 1024),
      }),
    ]);
    const entry = (await readIndex()).entries[0];
    expect(entry?.grid).toBe('grid.jpg');
    expect(entry?.music).toBeUndefined();
    expect(await fs.readdir(path.join(baseDir, 'library', 'a'))).toEqual(['grid.jpg']);
  });

  it('re-encodes an oversized IMAGE instead of dropping it', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', {
        heroImagePaths: [await card('art/hero.png', 'IMG 3840x2160', 12 * 1024 * 1024)],
      }),
    ]);
    const entry = (await readIndex()).entries[0];
    // Kept, not skipped — and stored as a JPEG, whatever the source extension was.
    expect(entry?.hero).toEqual(['hero-0.jpg']);
    const written = await fs.readFile(path.join(baseDir, 'library', 'a', 'hero-0.jpg'), 'utf8');
    // The stub encodes its size into the bytes: scaled down to the first step, not left at 2160p.
    expect(written).toBe('JPEG 3840x1440 q85');
  });

  it('still skips an oversized image it cannot decode (no re-encode possible)', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', {
        gridImagePath: await card('art/grid.jpg'),
        heroImagePaths: [await card('art/hero.webp', 'RIFFWEBP', 12 * 1024 * 1024)],
      }),
    ]);
    const entry = (await readIndex()).entries[0];
    expect(entry?.hero).toEqual([]);
    expect(entry?.grid).toBe('grid.jpg');
  });

  // The carousel orders the history by "when was this game last available", so the stamp has to move on
  // an insert that copies nothing — unlike savedAt, which marks the last real re-copy (it is the artwork
  // revision the renderer caches by).
  it('stamps lastSeenAt on every insert, including the one that re-copies nothing', async () => {
    const gridPath = await card('art/grid.jpg');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const first = store();
      await first.init();
      await first.saveFromCard([manifest('a', { gridImagePath: gridPath })]);
      expect((await readIndex()).entries[0]?.lastSeenAt).toBe('2026-01-01T00:00:00.000Z');

      vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'));
      const second = store();
      await second.init();
      await second.saveFromCard([manifest('a', { gridImagePath: gridPath })]);
      const entry = (await readIndex()).entries[0];
      expect(entry?.lastSeenAt).toBe('2026-02-02T00:00:00.000Z');
      expect(entry?.savedAt).toBe('2026-01-01T00:00:00.000Z'); // nothing was re-copied
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-copy an unchanged card, but refreshes the cached stats', async () => {
    const gridPath = await card('art/grid.jpg');
    const first = store();
    await first.init();
    await first.saveFromCard([manifest('a', { gridImagePath: gridPath })]);
    const sigBefore = (await readIndex()).entries[0]?.sourceSig;
    const copiedAt = (await fs.stat(path.join(baseDir, 'library', 'a', 'grid.jpg'))).mtimeMs;

    statsById.set('a', {
      schemaVersion: 1,
      totalPlaySeconds: 60,
      lastPlayedAt: '2026-08-01T00:00:00.000Z',
      launchCount: 3,
    });
    const second = store();
    await second.init();
    await second.saveFromCard([manifest('a', { gridImagePath: gridPath })]);

    const entry = (await readIndex()).entries[0];
    expect(entry?.sourceSig).toBe(sigBefore);
    expect(entry?.launchCount).toBe(3);
    expect((await fs.stat(path.join(baseDir, 'library', 'a', 'grid.jpg'))).mtimeMs).toBe(copiedAt);
  });

  it('re-copies when the card art changed, bumps savedAt and leaves no orphan of the old cover', async () => {
    const first = store();
    await first.init();
    await first.saveFromCard([manifest('a', { gridImagePath: await card('art/grid.png') })]);
    const before = (await readIndex()).entries[0];
    // The lazily-built thumbnail exists too — it must not survive a cover change.
    await first.readGridThumb('a');
    expect(await fs.readdir(path.join(baseDir, 'library', 'a'))).toContain('grid-thumb.png');

    // The author swapped the cover for a differently-named file (Configure → Save & Apply).
    const second = store();
    await second.init();
    await second.saveFromCard([manifest('a', { gridImagePath: await card('art/cover.jpg') })]);

    const after = (await readIndex()).entries[0];
    expect(after?.grid).toBe('grid.jpg');
    expect(after?.sourceSig).not.toBe(before?.sourceSig);
    // savedAt is the artwork revision the renderer keys its cover cache by — it MUST move.
    expect(after?.savedAt).not.toBe(before?.savedAt);
    expect(await fs.readdir(path.join(baseDir, 'library', 'a'))).toEqual(['grid.jpg']);
  });

  it('re-copies when only a hero image changed (the signature covers every asset)', async () => {
    const grid = await card('art/grid.jpg');
    const first = store();
    await first.init();
    await first.saveFromCard([
      manifest('a', { gridImagePath: grid, heroImagePaths: [await card('art/h0.jpg', 'IMG 1x1')] }),
    ]);
    const before = (await readIndex()).entries[0];

    const second = store();
    await second.init();
    await second.saveFromCard([
      manifest('a', { gridImagePath: grid, heroImagePaths: [await card('art/h1.jpg', 'IMG 2x2')] }),
    ]);
    const after = (await readIndex()).entries[0];
    expect(after?.sourceSig).not.toBe(before?.sourceSig);
    expect(after?.savedAt).not.toBe(before?.savedAt);
  });

  it('writes one index entry per game, sequentially (no lost update)', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', { gridImagePath: await card('a.jpg') }),
      manifest('b', { gridImagePath: await card('b.jpg') }),
      manifest('c', { gridImagePath: await card('c.jpg') }),
    ]);
    expect((await readIndex()).entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('survives a game whose assets vanished mid-copy (card yanked)', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('gone', { gridImagePath: path.join(cardRoot, 'missing.jpg') }),
      manifest('ok', { gridImagePath: await card('ok.jpg') }),
    ]);
    const entries = await readIndex();
    expect(entries.entries.map((e) => e.id)).toEqual(['gone', 'ok']);
    expect(entries.entries[0]?.grid).toBeUndefined();
    expect(entries.entries[1]?.grid).toBe('grid.jpg');
  });
});

describe('readGridThumb', () => {
  it('downscales once and caches the thumbnail on disk', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', { gridImagePath: await card('grid.jpg', 'IMG 800x1200') }),
    ]);

    const first = await library.readGridThumb('a');
    expect(first).toMatch(/^data:image\/jpeg;base64,/);
    expect(await fs.readdir(path.join(baseDir, 'library', 'a'))).toContain('grid-thumb.jpg');
    // The cached file is what the second call serves — identical bytes, no second encode.
    expect(await library.readGridThumb('a')).toBe(first);
  });

  it('keeps a PNG a PNG (toJPEG would flatten its alpha to black)', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', { gridImagePath: await card('grid.png', 'IMG 800x1200') }),
    ]);
    expect(await library.readGridThumb('a')).toMatch(/^data:image\/png;base64,/);
    expect(await fs.readdir(path.join(baseDir, 'library', 'a'))).toContain('grid-thumb.png');
  });

  it('serves the raw file when the image cannot be decoded (webp/gif/avif)', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', { gridImagePath: await card('grid.webp', 'not-an-image') }),
    ]);
    const url = await library.readGridThumb('a');
    expect(url).toMatch(/^data:image\/webp;base64,/);
    expect(await fs.readdir(path.join(baseDir, 'library', 'a'))).not.toContain('grid-thumb.jpg');
  });

  it('serves the raw file when the image is already small enough', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', { gridImagePath: await card('grid.jpg', 'IMG 136x204') }),
    ]);
    const url = await library.readGridThumb('a');
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    expect(await fs.readdir(path.join(baseDir, 'library', 'a'))).not.toContain('grid-thumb.jpg');
  });

  it('returns null for a game that was never copied in', async () => {
    const library = store();
    await library.init();
    expect(await library.readGridThumb('nobody')).toBeNull();
  });
});

describe('init — cached stats vs their authority', () => {
  it('re-syncs launchCount/lastPlayedAt from the stats service', async () => {
    const first = store();
    await first.init();
    await first.saveFromCard([manifest('a', { gridImagePath: await card('a.jpg') })]);
    expect((await readIndex()).entries[0]?.launchCount).toBe(0);

    statsById.set('a', {
      schemaVersion: 1,
      totalPlaySeconds: 10,
      lastPlayedAt: '2026-08-09T00:00:00.000Z',
      launchCount: 5,
    });
    const second = store();
    await second.init();
    expect((await readIndex()).entries[0]?.launchCount).toBe(5);
    expect(second.entry('a')?.lastPlayedAt).toBe('2026-08-09T00:00:00.000Z');
  });
});

describe('entriesForCarousel', () => {
  it('lists the inserted card first, then everything seen before (played or not)', async () => {
    const library = store();
    await library.init();
    statsById.set('played', {
      schemaVersion: 1,
      totalPlaySeconds: 1,
      lastPlayedAt: '2026-01-01T00:00:00.000Z',
      launchCount: 1,
    });
    await library.saveFromCard([
      manifest('played', { gridImagePath: await card('p.jpg') }),
      manifest('orphan', { gridImagePath: await card('o.jpg') }),
    ]);
    await library.saveFromCard([manifest('card', { gridImagePath: await card('c.jpg') })]);
    // `orphan` was never launched, but it WAS available on this device — and it shared the insert with
    // `played`, so the tie falls to the title.
    expect(library.entriesForCarousel(['card']).map((e) => e.id)).toEqual([
      'card',
      'orphan',
      'played',
    ]);
  });
});

describe('forget (the user removing a game from the history)', () => {
  it('drops the record and the copied artwork, leaving the other games alone', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([
      manifest('a', { gridImagePath: await card('a.jpg') }),
      manifest('b', { gridImagePath: await card('b.jpg') }),
    ]);

    expect(await library.forget('a')).toBe(true);
    expect(library.entry('a')).toBeNull();
    expect((await readIndex()).entries.map((e) => e.id)).toEqual(['b']);
    await expect(fs.stat(path.join(baseDir, 'library', 'a'))).rejects.toThrow();
    // The neighbour keeps both its record and its files — this removes one game, not the catalogue.
    expect(library.entry('b')).not.toBeNull();
    expect(await fs.readdir(path.join(baseDir, 'library', 'b'))).toEqual(['grid.jpg']);
  });

  it('reports an unknown id instead of rewriting the index for nothing', async () => {
    const library = store();
    await library.init();
    await library.saveFromCard([manifest('a', { gridImagePath: await card('a.jpg') })]);
    expect(await library.forget('nope')).toBe(false);
    expect((await readIndex()).entries.map((e) => e.id)).toEqual(['a']);
  });

  it('brings the game back with its old playtime when the card returns', async () => {
    const library = store();
    await library.init();
    statsById.set('a', {
      schemaVersion: 1,
      totalPlaySeconds: 3600,
      lastPlayedAt: '2026-01-01T00:00:00.000Z',
      launchCount: 7,
    });
    await library.saveFromCard([manifest('a', { gridImagePath: await card('a.jpg') })]);
    await library.forget('a');
    // forget() never touches stats/<id>.json — the store reads the same authority again on re-insert.
    await library.saveFromCard([manifest('a', { gridImagePath: await card('a.jpg') })]);
    expect(library.entry('a')?.launchCount).toBe(7);
  });
});

// ── Configuring a game from the history ─────────────────────────────────────────────────────────────
// The two-file split is what the whole feature rests on: the insertion path owns `card-slot.json` and may
// never touch `game.json` / `staged/`, so a failed apply cannot cost the user their edits.

const SLOT = { id: 'a', title: 'A', executable: 'g.exe', description: 'kept' };

async function libraryFile(id: string, ...rest: readonly string[]): Promise<string> {
  return fs.readFile(path.join(baseDir, 'library', id, ...rest), 'utf8');
}

function exists(id: string, ...rest: readonly string[]): Promise<boolean> {
  return fs
    .access(path.join(baseDir, 'library', id, ...rest))
    .then(() => true)
    .catch(() => false);
}

describe('the card snapshot', () => {
  it('is written on a fresh copy and hashed into the record', async () => {
    await card('art/grid.png');
    const library = store();
    await library.init();
    await library.saveFromCard(
      [manifest('a', { gridImagePath: path.join(cardRoot, 'art/grid.png') })],
      new Map([['a', SLOT]]),
    );
    expect(JSON.parse(await libraryFile('a', 'card-slot.json')) as unknown).toEqual(SLOT);
    const [entry] = (await readIndex()).entries;
    expect(entry?.cardSlotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.sourceKind).toBe('card');
    expect(entry?.configuredAt).toBeNull();
  });

  it('is refreshed by the shortcut branch too — a slot can move while the artwork does not', async () => {
    const grid = await card('art/grid.png');
    const library = store();
    await library.init();
    const games = [manifest('a', { gridImagePath: grid })];
    await library.saveFromCard(games, new Map([['a', SLOT]]));
    const first = (await readIndex()).entries[0]?.cardSlotHash;

    const moved = { ...SLOT, args: ['-windowed'] };
    await library.saveFromCard(games, new Map([['a', moved]]));
    expect(JSON.parse(await libraryFile('a', 'card-slot.json')) as unknown).toEqual(moved);
    expect((await readIndex()).entries[0]?.cardSlotHash).not.toBe(first);
  });

  it('is NOT written for a PC-library game — its slot speaks another dialect', async () => {
    const grid = await card('art/grid.png');
    const library = store();
    await library.init();
    await library.saveFromCard(
      [manifest('a', { source: 'pc', gridImagePath: grid })],
      new Map([['a', SLOT]]),
    );
    expect(await exists('a', 'card-slot.json')).toBe(false);
    const [entry] = (await readIndex()).entries;
    expect(entry?.cardSlotHash).toBeUndefined();
    expect(entry?.sourceKind).toBe('pc');
  });

  it('survives a re-copy of the artwork, together with the edits and everything staged', async () => {
    const grid = await card('art/grid.png');
    const library = store();
    await library.init();
    await library.saveFromCard([manifest('a', { gridImagePath: grid })], new Map([['a', SLOT]]));
    await library.saveEdits('a', JSON.stringify({ ...SLOT, title: 'Mine' }), 'Mine');
    const picked = await card('picked/обложка.png');
    await library.importStagedAsset('a', picked, 'image', ['png']);

    await card('art/grid.png', 'IMG 900x1300');
    await library.saveFromCard([manifest('a', { gridImagePath: grid })], new Map([['a', SLOT]]));

    expect(await exists('a', 'game.json')).toBe(true);
    expect(await library.stagedFiles('a')).toEqual(['asset.png']);
    const [entry] = (await readIndex()).entries;
    expect(entry?.configuredAt).not.toBeNull();
    expect(entry?.title).toBe('Mine');
  });
});

describe('edits made with no card in', () => {
  async function seeded(): Promise<LibraryStore> {
    const grid = await card('art/grid.png');
    const library = store();
    await library.init();
    await library.saveFromCard([manifest('a', { gridImagePath: grid })], new Map([['a', SLOT]]));
    return library;
  }

  it('reads back the snapshot until the first save, then the edits', async () => {
    const library = await seeded();
    expect(JSON.parse((await library.storedManifestText('a')) ?? '') as unknown).toEqual(SLOT);

    const edited = { ...SLOT, title: 'Mine' };
    await library.saveEdits('a', JSON.stringify(edited), 'Mine');
    expect(JSON.parse((await library.storedManifestText('a')) ?? '') as unknown).toEqual(edited);
    expect(JSON.parse(await libraryFile('a', 'card-slot.json')) as unknown).toEqual(SLOT);
  });

  it('stamps configuredAt and the new title on the record', async () => {
    const library = await seeded();
    await library.saveEdits('a', JSON.stringify({ ...SLOT, title: 'Mine' }), 'Mine');
    const [entry] = (await readIndex()).entries;
    expect(entry?.configuredAt).not.toBeNull();
    expect(entry?.title).toBe('Mine');
  });

  it('drops the edits and the staged originals, keeping the snapshot', async () => {
    const library = await seeded();
    await library.saveEdits('a', JSON.stringify({ ...SLOT, title: 'Mine' }), 'Mine');
    await library.importStagedAsset('a', await card('picked/hero.png'), 'image', ['png']);

    await library.dropEdits('a');
    expect(await exists('a', 'game.json')).toBe(false);
    expect(await library.stagedFiles('a')).toEqual([]);
    expect(await exists('a', 'card-slot.json')).toBe(true);
    expect((await readIndex()).entries[0]?.configuredAt).toBeNull();
  });

  it('is wiped entirely by forget, snapshot included', async () => {
    const library = await seeded();
    await library.saveEdits('a', JSON.stringify({ ...SLOT, title: 'Mine' }), 'Mine');
    await library.importStagedAsset('a', await card('picked/hero.png'), 'image', ['png']);

    expect(await library.forget('a')).toBe(true);
    expect(await exists('a')).toBe(false);
  });
});

describe('staging an asset for a card that is not in', () => {
  async function seeded(): Promise<LibraryStore> {
    const library = store();
    await library.init();
    await library.saveFromCard([manifest('a')], new Map([['a', SLOT]]));
    return library;
  }

  it('keeps the extension of a non-Latin name and de-duplicates collisions', async () => {
    const library = await seeded();
    expect(await library.importStagedAsset('a', await card('p1/обложка.png'), 'image', ['png'])).toBe(
      'asset.png',
    );
    expect(await library.importStagedAsset('a', await card('p2/обложка.png'), 'image', ['png'])).toBe(
      'asset-2.png',
    );
  });

  it('refuses a wrong extension, a symlink and anything past the cap', async () => {
    const library = await seeded();
    const wrong = await card('p/key.pem');
    await expect(library.importStagedAsset('a', wrong, 'image', ['png'])).rejects.toThrow(
      /not a image extension/,
    );
    const link = path.join(cardRoot, 'link.png');
    await fs.symlink(await card('p/real.png'), link);
    await expect(library.importStagedAsset('a', link, 'image', ['png'])).rejects.toThrow(
      /symbolic link/,
    );
    const huge = await card('p/huge.png', 'IMG', 33 * 1024 * 1024);
    await expect(library.importStagedAsset('a', huge, 'image', ['png'])).rejects.toThrow(
      /larger than/,
    );
  });
});

describe('the fields the insert path does not own', () => {
  async function seeded(): Promise<{ library: LibraryStore; grid: string }> {
    const grid = await card('art/grid.png');
    const library = store();
    await library.init();
    await library.saveFromCard([manifest('a', { gridImagePath: grid })], new Map([['a', SLOT]]));
    return { library, grid };
  }

  it('carries an answered collision dialog and the source through a full re-copy', async () => {
    const { library, grid } = await seeded();
    await library.markCollisionResolved('a');

    // New artwork bytes → the shortcut misses and the record is rebuilt from scratch, which is exactly
    // where an optional field goes missing without the types noticing.
    await card('art/grid.png', 'IMG 900x1300');
    await library.saveFromCard([manifest('a', { gridImagePath: grid })], new Map([['a', SLOT]]));

    const [entry] = (await readIndex()).entries;
    expect(entry?.collisionResolvedAt).not.toBeNull();
    expect(entry?.sourceKind).toBe('card');
  });

  it('forgets an answer once the local side of the collision is gone', async () => {
    const { library } = await seeded();
    await library.markCollisionResolved('a');

    await library.clearCollisionAnswers(['something-else']);
    expect((await readIndex()).entries[0]?.collisionResolvedAt).toBeNull();
  });

  it('keeps the answer while the local game is still there', async () => {
    const { library } = await seeded();
    await library.markCollisionResolved('a');

    await library.clearCollisionAnswers(['a']);
    expect((await readIndex()).entries[0]?.collisionResolvedAt).not.toBeNull();
  });

  it('takes a rename made from the history without re-copying the artwork', async () => {
    const { library, grid } = await seeded();
    const savedAt = (await readIndex()).entries[0]?.savedAt;
    await library.saveEdits('a', JSON.stringify({ ...SLOT, title: 'Mine' }), 'Mine');

    // The card is unchanged; only the record's title differs, because the rename has not reached the
    // card yet. Judged against the record it would read as a foreign card — a warning plus a full,
    // pointless re-copy on every single insert.
    await library.saveFromCard([manifest('a', { gridImagePath: grid })], new Map([['a', SLOT]]));

    const [entry] = (await readIndex()).entries;
    expect(entry?.savedAt).toBe(savedAt);
    expect(entry?.title).toBe('Mine');
  });
});
