// The insertion-time sync: which side wins, what may never be written to a card, and the guards that sit
// in front of the first byte. The LibraryStore is the real one (it is fs-only here); the card is a temp
// directory standing in for the media.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTranslator } from '../src/shared/i18n';
import { LibraryStore } from '../src/main/library-store';
import {
  commitHistorySync,
  rollbackHistorySync,
  syncHistoryConfig,
} from '../src/main/history-sync';
import type { HistorySyncResult } from '../src/main/history-sync';
import type { Stats } from '../src/shared/types';
import type { ResolvedManifest } from '../src/main/manifest-types';

const NO_STATS: Stats = { schemaVersion: 1, totalPlaySeconds: 0, lastPlayedAt: null, launchCount: 0 };
const t = createTranslator('en');

let baseDir: string;
let cardRoot: string;
let library: LibraryStore;

const slot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  id: 'a',
  title: 'Alpha',
  executable: 'game.exe',
  ...overrides,
});

async function writeCard(value: unknown): Promise<void> {
  await fs.writeFile(path.join(cardRoot, 'game.json'), JSON.stringify(value, null, 2));
}

async function readCard(): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(cardRoot, 'game.json'), 'utf8')) as unknown;
}

function manifest(id: string, overrides: Partial<ResolvedManifest> = {}): ResolvedManifest {
  return {
    raw: {
      schemaVersion: 1,
      id,
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

/** Puts the game in the history with the card's slot snapshotted, as a first insertion would. */
async function seed(cardSlot: Record<string, unknown> = slot()): Promise<void> {
  await writeCard(cardSlot);
  await fs.writeFile(path.join(cardRoot, 'game.exe'), 'EXE');
  await library.init();
  await library.saveFromCard([manifest('a')], new Map([['a', cardSlot]]));
}

/**
 * One insertion's worth of the sync: the card write, then the history-side commit the caller runs once the
 * card has read back (see game-controller.ts loadCardBody). Split in the source, so it is split here too — the tests
 * that care about the SPLIT call the two halves themselves.
 */
const sync = async (): Promise<HistorySyncResult> => {
  const result = await syncHistoryConfig(cardRoot, { library, t });
  await commitHistorySync(result, library);
  return result;
};

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-hs-lib-'));
  cardRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-hs-card-'));
  library = new LibraryStore({ baseDir, readStats: () => Promise.resolve(NO_STATS) });
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
  await fs.rm(cardRoot, { recursive: true, force: true });
});

describe('a card with nothing pending', () => {
  it('is left exactly as it was', async () => {
    await seed();
    const before = await readCard();
    const result = await sync();
    expect(result.applied).toEqual([]);
    expect(result.discarded).toEqual([]);
    expect(result.textBefore).toBeNull();
    expect(await readCard()).toEqual(before);
  });
});

describe('edits waiting for their card', () => {
  it('are written onto it when the card itself has not moved', async () => {
    await seed();
    await library.saveEdits('a', JSON.stringify(slot({ title: 'Mine' })), 'Mine');

    const result = await sync();
    expect(result.applied).toEqual(['Mine']);
    expect(await readCard()).toEqual(slot({ title: 'Mine' }));
    expect(library.entry('a')?.configuredAt).toBeNull();
    expect(await library.storedManifestText('a')).toContain('Mine');
  });

  it('keep the neighbours of a multi-game card untouched', async () => {
    const other = slot({ id: 'b', title: 'Beta', executable: 'b.exe' });
    await seed();
    await writeCard([slot(), other]);
    await library.saveEdits('a', JSON.stringify(slot({ title: 'Mine' })), 'Mine');

    await sync();
    expect(await readCard()).toEqual([slot({ title: 'Mine' }), other]);
  });

  it('lose to a card that was edited later, and are dropped', async () => {
    await seed();
    await library.saveEdits('a', JSON.stringify(slot({ title: 'Mine' })), 'Mine');
    await writeCard(slot({ title: 'Edited elsewhere' }));

    const result = await sync();
    expect(result.applied).toEqual([]);
    expect(result.discarded).toEqual(['Mine']);
    expect(await readCard()).toEqual(slot({ title: 'Edited elsewhere' }));
    expect(library.entry('a')?.configuredAt).toBeNull();
  });

  it('are refused by a FOREIGN card carrying another game under the same id', async () => {
    await seed();
    await library.saveEdits('a', JSON.stringify(slot({ title: 'Mine' })), 'Mine');
    // Another card, same id, different game — and its slot must be left completely alone.
    const foreign = slot({ title: 'Somebody else', executable: 'other.exe' });
    await writeCard(foreign);
    await fs.writeFile(path.join(cardRoot, 'other.exe'), 'EXE');

    const result = await sync();
    expect(result.applied).toEqual([]);
    expect(result.discarded).toEqual(['Mine']);
    expect(await readCard()).toEqual(foreign);
  });

  it('ARE applied when only the title changed — the guard reads the pristine snapshot', async () => {
    await seed();
    await library.saveEdits('a', JSON.stringify(slot({ title: 'Renamed' })), 'Renamed');
    const first = await sync();
    expect(first.applied).toEqual(['Renamed']);

    // …and a second insertion of the very same card is a no-op, not a "foreign card" refusal.
    await library.saveFromCard([manifest('a')], first.slots);
    await library.saveEdits('a', JSON.stringify(slot({ title: 'Renamed twice' })), 'Renamed twice');
    expect((await sync()).applied).toEqual(['Renamed twice']);
  });

  it('are applied to a LEGACY card whose own manifest fails the editor gates', async () => {
    // No heroImage: launchable, but rejected by the editor's stricter validation. The edit must be judged
    // against that baseline, not against the gates — otherwise such a card can never be configured.
    await seed();
    await library.saveEdits('a', JSON.stringify(slot({ args: ['-windowed'] })), 'Alpha');

    const result = await sync();
    expect(result.applied).toEqual(['Alpha']);
    expect(await readCard()).toEqual(slot({ args: ['-windowed'] }));
  });

  it('are refused when they name an executable the card does not have', async () => {
    await seed();
    await library.saveEdits('a', JSON.stringify(slot({ executable: 'gone.exe' })), 'Alpha');

    const result = await sync();
    expect(result.discarded).toEqual(['Alpha']);
    expect(await readCard()).toEqual(slot());
  });

  it('are refused when they would make the manifest invalid', async () => {
    await seed();
    await library.saveEdits('a', JSON.stringify(slot({ id: '' })), 'Alpha');

    const result = await sync();
    expect(result.discarded).toEqual(['Alpha']);
    expect(await readCard()).toEqual(slot());
  });

  it('are NOT judged by `executable` in install mode — it names a file on the PC, not on the card', async () => {
    // install.type other than `copy` resolves `executable` against the install directory (manifest.ts
    // resolveInstall). Measuring it against the card root refuses every such slot — and a refusal here
    // deletes the user's edits, so a single retitled installer game would lose them on every insertion.
    const installer = slot({ install: { type: 'inno', installer: 'setup.exe' }, executable: 'bin/game.exe' });
    await seed(installer);
    await fs.writeFile(path.join(cardRoot, 'setup.exe'), 'EXE');
    await library.saveEdits('a', JSON.stringify({ ...installer, title: 'Mine' }), 'Mine');

    const result = await sync();
    expect(result.applied).toEqual(['Mine']);
    expect(result.discarded).toEqual([]);
    expect(library.entry('a')?.configuredAt).toBeNull();
  });

  it('stop asking to be applied when the edit turns out to match the card already', async () => {
    // The write happens (the text is identical, which is not the same as "nothing was applied"), and the
    // edits MUST still be dropped: `configuredAt` is what says "there is something pending", and leaving
    // it set replays the same no-op apply on every future insertion of this card.
    await seed();
    await library.saveEdits('a', JSON.stringify(slot()), 'Alpha');

    const result = await sync();
    expect(result.applied).toEqual(['Alpha']);
    expect(library.entry('a')?.configuredAt).toBeNull();
    expect(await library.readEditedSlot('a')).toBeNull();
  });
});

describe('a card that stops reading after the sync rewrote it', () => {
  it('gets its own text back, and the edits stay pending', async () => {
    await seed();
    await library.saveEdits('a', JSON.stringify(slot({ title: 'Mine' })), 'Mine');

    const written = await syncHistoryConfig(cardRoot, { library, t });
    expect(written.textBefore).not.toBeNull();

    // …the caller's readManifests then fails, so it undoes the write instead of committing it.
    const reverted = await rollbackHistorySync(cardRoot, written);
    expect(reverted).not.toBeNull();
    await commitHistorySync(reverted ?? written, library);

    expect(await readCard()).toEqual(slot());
    // The whole point: the user's work is still here, and still flagged for the next insertion.
    expect(await library.readEditedSlot('a')).toEqual(slot({ title: 'Mine' }));
    expect(library.entry('a')?.configuredAt).not.toBeNull();
  });

  it('reports nothing as applied, so the user is not told about a write that was undone', async () => {
    await seed();
    await library.saveEdits('a', JSON.stringify(slot({ title: 'Mine' })), 'Mine');

    const written = await syncHistoryConfig(cardRoot, { library, t });
    const reverted = await rollbackHistorySync(cardRoot, written);
    expect(reverted?.applied).toEqual([]);
    expect(reverted?.textBefore).toBeNull();
    expect(reverted?.slots).toEqual(written.slotsBefore);
  });
});

describe('assets staged while the card was away', () => {
  async function stageCover(): Promise<void> {
    const picked = path.join(baseDir, 'обложка.png');
    await fs.writeFile(picked, 'COVER');
    const name = await library.importStagedAsset('a', picked, 'image', ['png']);
    await library.saveEdits('a', JSON.stringify(slot({ gridImage: `assets/${name}` })), 'Alpha');
  }

  it('are copied onto the card and pointed at by the applied slot', async () => {
    await seed();
    await stageCover();

    const result = await sync();
    expect(result.applied).toEqual(['Alpha']);
    expect(await readCard()).toEqual(slot({ gridImage: 'assets/asset.png' }));
    expect(await fs.readFile(path.join(cardRoot, 'assets', 'asset.png'), 'utf8')).toBe('COVER');
    expect(await library.stagedFiles('a')).toEqual([]);
  });

  it('do not pile up duplicates when an interrupted apply is retried', async () => {
    await seed();
    await stageCover();
    // The previous attempt got as far as the file and then died before the manifest was written.
    await fs.mkdir(path.join(cardRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(cardRoot, 'assets', 'asset.png'), 'COVER');

    await sync();
    expect(await fs.readdir(path.join(cardRoot, 'assets'))).toEqual(['asset.png']);
  });

  it('leave the card untouched when a copy fails, and keep the edits for next time', async () => {
    await seed();
    await stageCover();
    // The card cannot take the file: `assets` is a FILE there, so nothing can be written inside it.
    await fs.writeFile(path.join(cardRoot, 'assets'), 'NOT A DIRECTORY');

    const result = await sync();
    expect(result.applied).toEqual([]);
    expect(result.discarded).toEqual([]);
    expect(await readCard()).toEqual(slot());
    expect(library.entry('a')?.configuredAt).not.toBeNull();
  });

  it('step aside for a DIFFERENT file already on the card under that name', async () => {
    await seed();
    await stageCover();
    await fs.mkdir(path.join(cardRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(cardRoot, 'assets', 'asset.png'), 'SOMETHING ELSE');

    await sync();
    expect(await readCard()).toEqual(slot({ gridImage: 'assets/asset-2.png' }));
    expect(await fs.readFile(path.join(cardRoot, 'assets', 'asset.png'), 'utf8')).toBe(
      'SOMETHING ELSE',
    );
    expect(await fs.readFile(path.join(cardRoot, 'assets', 'asset-2.png'), 'utf8')).toBe('COVER');
  });
});
