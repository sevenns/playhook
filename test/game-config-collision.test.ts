// One game in two places — the inserted card and this PC's own library — and the answer that puts the
// local game's look on the card. What must NOT travel is as much of the point as what does: the card's
// launch, install block and save wiring are the only ones that work there.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergePresentation } from '../src/main/history-config';
import { createTranslator } from '../src/shared/i18n/index';
import type { DriveCandidate, Stats } from '../src/shared/types';
import type { ResolvedManifest } from '../src/main/manifest-types';

// The service asks the drive layer whether a root may be written to; there are no removable drives in a
// test run, so the card stands in as the one candidate (as game-move-transaction.test.ts does).
const hooks = vi.hoisted(() => ({ cards: [] as DriveCandidate[] }));

vi.mock('../src/main/drive-watcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/drive-watcher')>();
  return {
    ...actual,
    listDriveCandidates: (): Promise<readonly DriveCandidate[]> => Promise.resolve(hooks.cards),
  };
});

const { GameConfigService } = await import('../src/main/game-config');
const { LibraryStore } = await import('../src/main/library-store');
const { PcLibraryStore } = await import('../src/main/pc-library');

describe('mergePresentation', () => {
  const card = {
    id: 'hades',
    title: 'Hades',
    executable: 'Hades.exe',
    install: { installer: 'setup.exe', type: 'inno' },
    saveOnCard: 'saves/hades',
    pcSavePath: '%APPDATA%/Hades',
    gridImage: 'art/card-cover.png',
  };

  it('takes the name and the artwork, and nothing else', () => {
    const merged = mergePresentation(card, {
      title: 'Hades (mine)',
      gridImage: 'assets/hades-grid.png',
      heroImage: ['assets/hades-hero-1.jpg'],
      backgroundMusic: 'assets/hades-music.mp3',
    });
    expect(merged).toEqual({
      ...card,
      title: 'Hades (mine)',
      gridImage: 'assets/hades-grid.png',
      heroImage: ['assets/hades-hero-1.jpg'],
      backgroundMusic: 'assets/hades-music.mp3',
    });
  });

  it('leaves a field the local game does not fill exactly as the card had it', () => {
    expect(mergePresentation(card, { title: 'Mine' })).toEqual({ ...card, title: 'Mine' });
    expect(mergePresentation(card, { heroImage: [] })).toEqual(card);
  });
});

// ── The whole answer, against real files ────────────────────────────────────────────────────────────

const NO_STATS: Stats = { schemaVersion: 1, totalPlaySeconds: 0, lastPlayedAt: null, launchCount: 0 };
const t = createTranslator('en');

let dir: string;
let cardRoot: string;
let service: InstanceType<typeof GameConfigService>;
let local: ResolvedManifest | null;
let reloaded: number;

const cardSlot = {
  schemaVersion: 1,
  id: 'hades',
  title: 'Hades',
  executable: 'Hades.exe',
};

/** A local game as the PC library resolves it — absolute asset paths, `pc` source. */
function pcManifest(overrides: Partial<ResolvedManifest> = {}): ResolvedManifest {
  return {
    raw: {
      schemaVersion: 1,
      id: 'hades',
      title: 'Hades (mine)',
      args: [],
      runAsAdmin: false,
      launchTimeoutSec: 30,
      killTimeoutSec: 60,
      winetricks: [],
    },
    root: path.join(dir, 'pc-games'),
    source: 'pc',
    executablePath: path.join(dir, 'Hades', 'Hades.exe'),
    cwd: path.join(dir, 'Hades'),
    gridImagePath: path.join(dir, 'pc-games', 'assets', 'cover.png'),
    heroImagePaths: [path.join(dir, 'pc-games', 'assets', 'bg.png')],
    ...overrides,
  };
}

async function readCard(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(cardRoot, 'game.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function signature(): Promise<string> {
  const answer = await service.signatureFor(cardRoot);
  if (answer === null) throw new Error('the card has no signature');
  return answer;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-collision-'));
  cardRoot = path.join(dir, 'card');
  await fs.mkdir(path.join(cardRoot), { recursive: true });
  await fs.writeFile(path.join(cardRoot, 'game.json'), JSON.stringify(cardSlot, null, 2));
  await fs.writeFile(path.join(cardRoot, 'Hades.exe'), 'EXE');
  await fs.mkdir(path.join(dir, 'pc-games', 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'pc-games', 'assets', 'cover.png'), 'IMG 4x4');
  await fs.writeFile(path.join(dir, 'pc-games', 'assets', 'bg.png'), 'IMG 8x8');
  local = pcManifest();
  reloaded = 0;
  hooks.cards = [
    {
      root: cardRoot,
      kind: 'card',
      label: 'card',
      signature: '',
      hasManifest: true,
      isActive: true,
    },
  ];
  service = new GameConfigService({
    // Every root is allowed here: the drive enumeration is what candidates() does, and it is stubbed out
    // by pointing the "PC library" at a real directory and treating the card as the active root.
    getActiveRoot: () => cardRoot,
    reloadManifest: () => {
      reloaded += 1;
      return Promise.resolve({ ok: true as const });
    },
    pcLibrary: new PcLibraryStore({ baseDir: dir }),
    reloadPcLibrary: () => Promise.resolve({ ok: true as const }),
    getTranslator: () => t,
    findGameSource: () => null,
    notify: () => undefined,
    findPcManifest: () => local,
    library: new LibraryStore({ baseDir: dir, readStats: () => Promise.resolve(NO_STATS) }),
    isCardLoading: () => false,
    refreshLibrary: () => undefined,
  });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('merging a local game onto the card that shadows it', () => {
  it('copies the artwork over and rewrites only the presentation', async () => {
    const result = await service.mergeCollision({
      id: 'hades',
      choice: 'merge',
      root: cardRoot,
      signature: await signature(),
    });

    expect(result.saved).toBe(true);
    expect(reloaded).toBe(1);
    expect(await readCard()).toEqual({
      ...cardSlot,
      title: 'Hades (mine)',
      gridImage: 'assets/hades-grid.png',
      heroImage: ['assets/hades-hero-1.png'],
    });
    expect(await fs.readFile(path.join(cardRoot, 'assets', 'hades-grid.png'), 'utf8')).toBe('IMG 4x4');
    expect(await fs.readFile(path.join(cardRoot, 'assets', 'hades-hero-1.png'), 'utf8')).toBe('IMG 8x8');
  });

  it('refuses when the card was pulled or swapped while the question was up', async () => {
    const result = await service.mergeCollision({
      id: 'hades',
      choice: 'merge',
      root: cardRoot,
      signature: 'a signature from another card',
    });

    expect(result.saved).toBe(false);
    expect(await readCard()).toEqual(cardSlot);
  });

  it('works on a LEGACY card whose own manifest fails the editor gates', async () => {
    // The card has no heroImage of its own and the merge does not add one — a raw verdict would refuse
    // it over a problem that predates the user entirely.
    local = pcManifest({ heroImagePaths: undefined });

    const result = await service.mergeCollision({
      id: 'hades',
      choice: 'merge',
      root: cardRoot,
      signature: await signature(),
    });

    expect(result.saved).toBe(true);
    expect((await readCard())['title']).toBe('Hades (mine)');
  });

  it('refuses a game the PC library does not have', async () => {
    local = null;
    const result = await service.mergeCollision({
      id: 'hades',
      choice: 'merge',
      root: cardRoot,
      signature: await signature(),
    });
    expect(result.saved).toBe(false);
  });
});
