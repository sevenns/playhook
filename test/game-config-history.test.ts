// The Customize screen's backend for a game whose card is NOT in: what it may read, what it refuses to
// store, and where a thumbnail comes from when the only copy of an asset is the history's own.
//
// The handlers are driven through the service's own methods (as game-move-transaction.test.ts does):
// the ipcMain wiring is one line each and is what test/ipc-channels.test.ts guards.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameConfigService } from '../src/main/game-config';
import { LibraryStore } from '../src/main/library-store';
import { PcLibraryStore } from '../src/main/pc-library';
import { createTranslator } from '../src/shared/i18n/index';
import type {
  ConfigSaveResult,
  HistoryConfigReadResult,
  ManifestSource,
  ResolvedManifest,
  Stats,
} from '../src/shared/types';

const NO_STATS: Stats = { schemaVersion: 1, totalPlaySeconds: 0, lastPlayedAt: null, launchCount: 0 };
const t = createTranslator('en');

let dir: string;
let cardRoot: string;
let library: LibraryStore;
let available: { readonly root: string; readonly source: ManifestSource } | null;
let cardLoading: boolean;
let refreshed: number;
let service: GameConfigService;

const slot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  id: 'a',
  title: 'Alpha',
  executable: 'game.exe',
  ...overrides,
});

function manifest(overrides: Partial<ResolvedManifest> = {}): ResolvedManifest {
  return {
    raw: {
      schemaVersion: 1,
      id: 'a',
      title: 'Alpha',
      args: [],
      runAsAdmin: false,
      launchTimeoutSec: 30,
      killTimeoutSec: 60,
      winetricks: [],
    },
    root: cardRoot,
    source: 'card',
    executablePath: path.join(cardRoot, 'game.exe'),
    cwd: cardRoot,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-gch-'));
  cardRoot = path.join(dir, 'card');
  await fs.mkdir(cardRoot, { recursive: true });
  available = null;
  cardLoading = false;
  refreshed = 0;
  library = new LibraryStore({ baseDir: dir, readStats: () => Promise.resolve(NO_STATS) });
  await library.init();
  service = new GameConfigService({
    getActiveRoot: () => null,
    reloadManifest: () => Promise.resolve({ ok: true as const }),
    pcLibrary: new PcLibraryStore({ baseDir: dir }),
    reloadPcLibrary: () => Promise.resolve({ ok: true as const }),
    getTranslator: () => t,
    toManifestPcSavePath: () => null,
    findGameSource: () => available,
    notify: () => undefined,
    resolveManifest: () => null,
    findPcManifest: () => null,
    isBusy: () => false,
    library,
    isCardLoading: () => cardLoading,
    refreshLibrary: () => {
      refreshed += 1;
    },
    pcStore: { removeSyncState: () => Promise.resolve() },
    savePathResolver: {
      resolvePcSavePath: () => Promise.resolve({ path: '', containerExists: false }),
    },
  });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Puts the game in the history with a snapshot, as a first insertion would. */
async function seed(cardSlot: Record<string, unknown> = slot()): Promise<void> {
  await library.saveFromCard([manifest()], new Map([['a', cardSlot]]));
}

const read = (id: string): Promise<HistoryConfigReadResult> => service.readHistoryGame(id);
const save = (id: string, text: string): Promise<ConfigSaveResult> =>
  service.saveHistoryGame({ id, text });

describe('reading a history game', () => {
  it('answers with the snapshot, and with the edits once there are any', async () => {
    await seed();
    const first = await read('a');
    expect(first.ok && (JSON.parse(first.text) as unknown)).toEqual(slot());

    await save('a', JSON.stringify(slot({ title: 'Mine' })));
    const second = await read('a');
    expect(second.ok && (JSON.parse(second.text) as unknown)).toEqual(slot({ title: 'Mine' }));
  });

  it('refuses a game that is available right now', async () => {
    await seed();
    available = { root: cardRoot, source: 'card' };
    const result = await read('a');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('available');
  });

  it('refuses a game the history has never snapshotted', async () => {
    expect((await read('nope')).ok).toBe(false);
  });
});

describe('saving a history game', () => {
  it('stores the edits, stamps the record and refreshes the row', async () => {
    await seed();
    expect(await save('a', JSON.stringify(slot({ title: 'Mine' })))).toEqual({
      saved: true,
      applied: 'deferred',
    });
    expect(library.entry('a')?.configuredAt).not.toBeNull();
    expect(library.entry('a')?.title).toBe('Mine');
    expect(refreshed).toBe(1);
  });

  it('refuses while the game is available, and while a card is being read', async () => {
    await seed();
    available = { root: cardRoot, source: 'card' };
    expect((await save('a', JSON.stringify(slot()))).saved).toBe(false);

    available = null;
    cardLoading = true;
    expect((await save('a', JSON.stringify(slot()))).saved).toBe(false);
    expect(library.entry('a')?.configuredAt).toBeNull();
  });

  it('accepts an edit to a LEGACY snapshot that fails the editor gates on its own', async () => {
    // No heroImage anywhere: the baseline already fails that gate, so the edit must not be judged by it.
    await seed();
    expect((await save('a', JSON.stringify(slot({ args: ['-windowed'] })))).saved).toBe(true);
  });

  it('refuses an edit that introduces a NEW problem', async () => {
    await seed();
    const result = await save('a', JSON.stringify(slot({ executable: '../escape.exe' })));
    expect(result.saved).toBe(false);
    expect(library.entry('a')?.configuredAt).toBeNull();
  });
});

describe('staging assets for a history game', () => {
  it('answers with the card-relative path the slot must name', async () => {
    await seed();
    const picked = path.join(dir, 'обложка.png');
    await fs.writeFile(picked, 'IMG');
    expect(
      await service.acceptHistoryPaths({ id: 'a', kind: 'image', paths: [picked] }),
    ).toEqual({ ok: true, paths: ['assets/asset.png'] });
  });

  it('refuses a kind that names a file on the card there is no card for', async () => {
    await seed();
    const result = await service.acceptHistoryPaths({
      id: 'a',
      kind: 'executable',
      paths: [path.join(dir, 'game.exe')],
    });
    expect(result.ok).toBe(false);
  });
});

describe('thumbnails for a history game', () => {
  const preview = (ref: string): Promise<string | null> =>
    service.historyAssetPreview('a', ref);

  it('reads a staged file directly', async () => {
    await seed();
    const picked = path.join(dir, 'cover.png');
    await fs.writeFile(picked, 'IMG 4x4');
    await service.acceptHistoryPaths({ id: 'a', kind: 'image', paths: [picked] });
    expect(await preview('assets/cover.png')).toMatch(/^data:image\/png;base64,/);
  });

  it('falls back to the history copy for an asset that is only on the card', async () => {
    await fs.mkdir(path.join(cardRoot, 'art'), { recursive: true });
    await fs.writeFile(path.join(cardRoot, 'art', 'cover.png'), 'IMG 4x4');
    await fs.writeFile(path.join(cardRoot, 'art', 'bg.png'), 'IMG 4x4');
    const cardSlot = slot({ gridImage: 'art/cover.png', heroImage: ['art/bg.png'] });
    await library.saveFromCard(
      [
        manifest({
          gridImagePath: path.join(cardRoot, 'art', 'cover.png'),
          heroImagePaths: [path.join(cardRoot, 'art', 'bg.png')],
        }),
      ],
      new Map([['a', cardSlot]]),
    );
    expect(await preview('art/cover.png')).toMatch(/^data:image\/png;base64,/);
    expect(await preview('art/bg.png')).toMatch(/^data:image\/png;base64,/);
  });

  it('answers null for an asset the history has no copy of — the row stays editable', async () => {
    await seed();
    expect(await preview('art/never-copied.png')).toBeNull();
  });
});
