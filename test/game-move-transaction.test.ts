// GameConfigService.moveToCard end to end: the transaction itself, not the pure helpers game-move.test.ts
// covers. Everything risky about a move lives in the ORDER of its steps and in its two levels of rollback
// — a copy that lands on the card, a card manifest that is written and then has to be taken back — and
// none of that is reachable except by driving the whole sequence, so that is what happens here.
//
// Two modules are mocked, both for reasons of environment rather than of design:
//  • drive-watcher's `listDriveCandidates` enumerates the machine's REAL removable drives, which no test
//    can have; the temp dir standing in for a card is declared to be one.
//  • json-store's `writeFileAtomicEnsuringDir` is the only way to make a write fail ON PURPOSE and on
//    every platform. Making the file read-only would not do it: the atomic write's own fallback exists
//    precisely to survive that (see json-store.ts replaceInPlace), and on Windows it does.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DriveCandidate,
  type GameMoveRequest,
  type NotificationInput,
  type ResolvedManifest,
} from '../src/shared/types';
import { createTranslator } from '../src/shared/i18n/index';

const hooks = vi.hoisted(() => ({
  failWrite: (_filePath: string): boolean => false,
  cards: [] as DriveCandidate[],
}));

vi.mock('../src/main/json-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/json-store')>();
  return {
    ...actual,
    writeFileAtomicEnsuringDir: async (filePath: string, data: string | Buffer): Promise<void> => {
      if (hooks.failWrite(filePath)) throw new Error('write refused by the test');
      await actual.writeFileAtomicEnsuringDir(filePath, data);
    },
  };
});

vi.mock('../src/main/drive-watcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/drive-watcher')>();
  return {
    ...actual,
    listDriveCandidates: (): Promise<readonly DriveCandidate[]> => Promise.resolve(hooks.cards),
  };
});

const { GameConfigService } = await import('../src/main/game-config');
const { PcLibraryStore } = await import('../src/main/pc-library');
const { describeManifestContent } = await import('../src/main/drive-watcher');
const { readManifests } = await import('../src/main/manifest');

const t = createTranslator('en');

interface Harness {
  readonly service: InstanceType<typeof GameConfigService>;
  readonly pcRoot: string;
  readonly cardRoot: string;
  readonly liveSaves: string;
  readonly notifications: NotificationInput[];
  readonly removedSyncStates: string[];
  readonly request: GameMoveRequest;
}

let dir: string;
let harness: Harness;

/** The two-game PC library the move starts from: `hades` (art, music, saves — the one that moves) and
 * `keeper` (which must survive untouched, and keeps the post-move library from being an empty list). */
async function seedPcLibrary(root: string, liveSaves: string): Promise<void> {
  await fse.ensureDir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets', 'hades-bg.png'), 'hero-bytes');
  await fs.writeFile(path.join(root, 'assets', 'hades-tile.png'), 'grid-bytes');
  await fs.writeFile(path.join(root, 'assets', 'hades-theme.mp3'), 'music-bytes');
  await fs.writeFile(path.join(root, 'assets', 'keeper-bg.png'), 'keeper-hero');
  await fse.ensureDir(path.join(root, 'games'));
  await fs.writeFile(path.join(root, 'games', 'Hades.exe'), 'exe');
  await fs.writeFile(path.join(root, 'games', 'Keeper.exe'), 'exe');
  await fse.ensureDir(liveSaves);
  await fs.writeFile(path.join(liveSaves, 'slot1.sav'), 'live-save');
  await fs.writeFile(
    path.join(root, 'game.json'),
    `${JSON.stringify(
      [
        {
          schemaVersion: 1,
          id: 'hades',
          title: 'Hades',
          pc: { executable: path.join(root, 'games', 'Hades.exe') },
          heroImage: 'assets/hades-bg.png',
          gridImage: 'assets/hades-tile.png',
          backgroundMusic: 'assets/hades-theme.mp3',
          pcSavePath: liveSaves,
        },
        {
          schemaVersion: 1,
          id: 'keeper',
          title: 'Keeper',
          pc: { executable: path.join(root, 'games', 'Keeper.exe') },
          heroImage: 'assets/keeper-bg.png',
        },
      ],
      null,
      2,
    )}\n`,
  );
}

/** The card as it stands BEFORE the move: one unrelated game, whose slot every assertion below expects to
 * come through the transaction byte for byte. */
async function seedCard(root: string): Promise<void> {
  await fse.ensureDir(path.join(root, 'other'));
  await fs.writeFile(path.join(root, 'other', 'Other.exe'), 'exe');
  await fse.ensureDir(path.join(root, 'hades'));
  await fs.writeFile(path.join(root, 'hades', 'Hades.exe'), 'exe');
  await fs.writeFile(path.join(root, 'game.json'), `${JSON.stringify(cardGameOther(), null, 2)}\n`);
}

function cardGameOther(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'other',
    title: 'Other',
    executable: path.posix.join('other', 'Other.exe'),
    heroImage: 'assets/other-hero.png',
  };
}

/** The moved game's slot as the RENDERER builds it (carryFormToCard): card-relative paths under the
 * deterministic names from asset-move-names.ts. */
function cardGameHades(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'hades',
    title: 'Hades',
    executable: path.posix.join('hades', 'Hades.exe'),
    heroImage: 'assets/hades-hero-1.png',
    gridImage: 'assets/hades-grid.png',
    backgroundMusic: 'assets/hades-music.mp3',
    saveOnCard: 'saves/hades',
    pcSavePath: '%APPDATA%/Hades',
    ...overrides,
  };
}

async function signatureOf(root: string): Promise<string> {
  const file = path.join(root, 'game.json');
  const { signature } = await describeManifestContent(file, await fse.pathExists(file), t, '');
  return signature;
}

async function resolvedPcManifest(pcRoot: string, id: string): Promise<ResolvedManifest> {
  const read = await readManifests(
    pcRoot,
    { documents: path.join(dir, 'documents'), t },
    () => null,
    {
      source: 'pc',
    },
  );
  if (!read.ok) throw new Error(`the seeded PC library did not resolve: ${read.message}`);
  const found = read.manifests.find((manifest) => manifest.raw.id === id);
  if (found === undefined) throw new Error(`the seeded PC library has no game "${id}"`);
  return found;
}

async function buildHarness(toText: string): Promise<Harness> {
  const pcLibrary = new PcLibraryStore({ baseDir: dir });
  const pcRoot = pcLibrary.root;
  const cardRoot = path.join(dir, 'card');
  const liveSaves = path.join(dir, 'live-saves');
  await fse.ensureDir(cardRoot);
  await seedPcLibrary(pcRoot, liveSaves);
  await seedCard(cardRoot);

  hooks.cards = [
    {
      root: cardRoot,
      kind: 'card',
      label: 'card',
      signature: '',
      hasManifest: true,
      isActive: false,
    },
  ];

  const notifications: NotificationInput[] = [];
  const removedSyncStates: string[] = [];
  const manifest = await resolvedPcManifest(pcRoot, 'hades');

  const service = new GameConfigService({
    getActiveRoot: () => null,
    reloadManifest: () => Promise.resolve({ ok: true as const }),
    pcLibrary,
    reloadPcLibrary: () => Promise.resolve({ ok: true as const }),
    getTranslator: () => t,
    toManifestPcSavePath: () => null,
    findGameSource: () => ({ root: pcRoot, source: 'pc' as const }),
    notify: (input) => notifications.push(input),
    resolveManifest: (id) => (id === 'hades' ? manifest : null),
    isBusy: () => false,
    pcStore: {
      removeSyncState: (id: string) => {
        removedSyncStates.push(id);
        return Promise.resolve();
      },
    },
    savePathResolver: {
      resolvePcSavePath: () => Promise.resolve({ path: liveSaves, containerExists: true }),
    },
  });

  return {
    service,
    pcRoot,
    cardRoot,
    liveSaves,
    notifications,
    removedSyncStates,
    request: {
      id: 'hades',
      fromId: 'hades',
      fromRoot: pcRoot,
      fromSignature: await signatureOf(pcRoot),
      toRoot: cardRoot,
      toSignature: await signatureOf(cardRoot),
      toText,
    },
  };
}

function toTextWith(hades: Record<string, unknown> = cardGameHades()): string {
  return `${JSON.stringify([cardGameOther(), hades], null, 2)}\n`;
}

async function libraryIds(pcRoot: string): Promise<readonly string[]> {
  const parsed: unknown = await fse.readJson(path.join(pcRoot, 'game.json'));
  const games: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return games.map((game) => String((game as { readonly id?: unknown }).id));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-move-'));
  hooks.failWrite = () => false;
  harness = await buildHarness(toTextWith());
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('moveToCard — the happy path', () => {
  it('copies the art and music under the names the renderer already wrote into the target text', async () => {
    const result = await harness.service.moveToCard(harness.request);
    expect(result).toEqual({ moved: true, applied: 'deferred' });
    expect(
      await fs.readFile(path.join(harness.cardRoot, 'assets', 'hades-hero-1.png'), 'utf8'),
    ).toBe('hero-bytes');
    expect(await fs.readFile(path.join(harness.cardRoot, 'assets', 'hades-grid.png'), 'utf8')).toBe(
      'grid-bytes',
    );
    expect(
      await fs.readFile(path.join(harness.cardRoot, 'assets', 'hades-music.mp3'), 'utf8'),
    ).toBe('music-bytes');
  });

  it('copies the saves from the LIVE location, not the library backup', async () => {
    // The backup carries different bytes on purpose: whichever one lands on the card is identifiable.
    await fse.ensureDir(path.join(harness.pcRoot, 'saves', 'hades'));
    await fs.writeFile(path.join(harness.pcRoot, 'saves', 'hades', 'slot1.sav'), 'stale-backup');
    await harness.service.moveToCard(harness.request);
    expect(
      await fs.readFile(path.join(harness.cardRoot, 'saves', 'hades', 'slot1.sav'), 'utf8'),
    ).toBe('live-save');
  });

  it('writes the target text verbatim and removes the game from the library, keeping its neighbour', async () => {
    await harness.service.moveToCard(harness.request);
    expect(await fs.readFile(path.join(harness.cardRoot, 'game.json'), 'utf8')).toBe(
      harness.request.toText,
    );
    expect(await libraryIds(harness.pcRoot)).toEqual(['keeper']);
  });

  it('drops the now-meaningless sync baseline', async () => {
    await harness.service.moveToCard(harness.request);
    expect(harness.removedSyncStates).toEqual(['hades']);
  });

  it('notifies that the move will apply when the card becomes active', async () => {
    await harness.service.moveToCard(harness.request);
    expect(harness.notifications).toEqual([{ kind: 'game-moved-deferred', gameTitle: 'Hades' }]);
  });
});

describe('moveToCard — refusals that write nothing', () => {
  it('refuses a move that would also rename the game', async () => {
    const result = await harness.service.moveToCard({ ...harness.request, id: 'hades-2' });
    expect(result).toEqual({ moved: false, message: t('gameConfig.moveIdChanged') });
    expect(await libraryIds(harness.pcRoot)).toEqual(['hades', 'keeper']);
    expect(await fse.pathExists(path.join(harness.cardRoot, 'assets'))).toBe(false);
  });

  it('refuses when the game is no longer in the library at all', async () => {
    const result = await harness.service.moveToCard({
      ...harness.request,
      id: 'ghost',
      fromId: 'ghost',
    });
    expect(result.moved).toBe(false);
    expect(await libraryIds(harness.pcRoot)).toEqual(['hades', 'keeper']);
  });

  it("refuses when the game's own files are not on the card yet", async () => {
    await fse.remove(path.join(harness.cardRoot, 'hades'));
    const result = await harness.service.moveToCard(harness.request);
    expect(result).toEqual({ moved: false, message: t('gameConfig.moveFilesNotOnCard') });
    expect(await libraryIds(harness.pcRoot)).toEqual(['hades', 'keeper']);
  });

  // Installer mode is reachable because the form stays open after the target is chosen and offers every
  // mode a card allows. There `executable` names a path INSIDE the installed game, so checking it against
  // the card would reject the move forever — the installer is what has to be there.
  it('checks the INSTALLER on the card in install mode, not the executable', async () => {
    await fs.writeFile(path.join(harness.cardRoot, 'setup.exe'), 'installer');
    const installMode = cardGameHades({
      executable: 'Hades.exe',
      install: { installer: 'setup.exe', type: 'nsis' },
    });
    harness = await buildHarness(toTextWith(installMode));
    await fs.writeFile(path.join(harness.cardRoot, 'setup.exe'), 'installer');
    const result = await harness.service.moveToCard(harness.request);
    expect(result).toEqual({ moved: true, applied: 'deferred' });
  });

  it('names the missing file when an asset is gone from the PC', async () => {
    await fse.remove(path.join(harness.pcRoot, 'assets', 'hades-tile.png'));
    const result = await harness.service.moveToCard(harness.request);
    expect(result.moved).toBe(false);
    expect(result.moved === false ? result.message : '').toContain('hades-tile.png');
    // The hero copied before the grid failed must be gone again.
    expect(await fse.pathExists(path.join(harness.cardRoot, 'assets', 'hades-hero-1.png'))).toBe(
      false,
    );
    expect(await libraryIds(harness.pcRoot)).toEqual(['hades', 'keeper']);
  });
});

describe('moveToCard — rollback', () => {
  it('undoes every copy when the card manifest cannot be written', async () => {
    hooks.failWrite = (filePath) => filePath.startsWith(harness.cardRoot);
    const result = await harness.service.moveToCard(harness.request);
    expect(result.moved).toBe(false);
    expect(await fse.pathExists(path.join(harness.cardRoot, 'assets', 'hades-hero-1.png'))).toBe(
      false,
    );
    expect(await fse.pathExists(path.join(harness.cardRoot, 'saves', 'hades'))).toBe(false);
    expect(await fs.readFile(path.join(harness.cardRoot, 'game.json'), 'utf8')).toBe(
      `${JSON.stringify(cardGameOther(), null, 2)}\n`,
    );
    expect(await libraryIds(harness.pcRoot)).toEqual(['hades', 'keeper']);
  });

  it('puts the card back and undoes the copies when the library write fails', async () => {
    hooks.failWrite = (filePath) => filePath.startsWith(harness.pcRoot);
    const result = await harness.service.moveToCard(harness.request);
    expect(result.moved).toBe(false);
    expect(await fs.readFile(path.join(harness.cardRoot, 'game.json'), 'utf8')).toBe(
      `${JSON.stringify(cardGameOther(), null, 2)}\n`,
    );
    expect(await fse.pathExists(path.join(harness.cardRoot, 'assets', 'hades-hero-1.png'))).toBe(
      false,
    );
    expect(await libraryIds(harness.pcRoot)).toEqual(['hades', 'keeper']);
    expect(harness.removedSyncStates).toEqual([]);
  });

  // The worst branch there is: the card is written, the library write fails, and putting the card back
  // fails too. The game then exists in BOTH places — a defined outcome — which is only true if the card's
  // copy is whole. Undoing the copies here would leave the card's game.json naming art and saves that are
  // not there, and report success while doing it.
  it('keeps the card copy intact when the library write AND the card rollback both fail', async () => {
    let cardWrites = 0;
    hooks.failWrite = (filePath) => {
      if (filePath.startsWith(harness.pcRoot)) return true;
      if (!filePath.startsWith(harness.cardRoot)) return false;
      cardWrites += 1;
      return cardWrites > 1;
    };
    const result = await harness.service.moveToCard(harness.request);

    expect(result).toEqual({ moved: true, applied: 'deferred' });
    expect(await fs.readFile(path.join(harness.cardRoot, 'game.json'), 'utf8')).toBe(
      harness.request.toText,
    );
    expect(
      await fs.readFile(path.join(harness.cardRoot, 'assets', 'hades-hero-1.png'), 'utf8'),
    ).toBe('hero-bytes');
    expect(await fs.readFile(path.join(harness.cardRoot, 'assets', 'hades-grid.png'), 'utf8')).toBe(
      'grid-bytes',
    );
    expect(
      await fs.readFile(path.join(harness.cardRoot, 'assets', 'hades-music.mp3'), 'utf8'),
    ).toBe('music-bytes');
    expect(
      await fs.readFile(path.join(harness.cardRoot, 'saves', 'hades', 'slot1.sav'), 'utf8'),
    ).toBe('live-save');
    // Still in the library too — that IS the duplicate — so its baseline must survive with it.
    expect(await libraryIds(harness.pcRoot)).toEqual(['hades', 'keeper']);
    expect(harness.removedSyncStates).toEqual([]);
    expect(harness.notifications).toContainEqual({
      kind: 'game-move-duplicate',
      gameTitle: 'Hades',
    });
  });
});

describe('moveToCard — saves already on the card', () => {
  it('leaves a non-empty save folder alone and says so', async () => {
    await fse.ensureDir(path.join(harness.cardRoot, 'saves', 'hades'));
    await fs.writeFile(path.join(harness.cardRoot, 'saves', 'hades', 'slot1.sav'), 'card-save');
    const result = await harness.service.moveToCard(harness.request);
    expect(result).toEqual({ moved: true, applied: 'deferred' });
    expect(
      await fs.readFile(path.join(harness.cardRoot, 'saves', 'hades', 'slot1.sav'), 'utf8'),
    ).toBe('card-save');
    expect(harness.notifications).toContainEqual({
      kind: 'game-move-save-skipped',
      gameTitle: 'Hades',
    });
  });
});
