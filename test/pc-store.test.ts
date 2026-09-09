// PcStore's sync-state slots: a game can be synced against a card AND against the local backup Playhook
// keeps for it, and each pairing needs its own baseline — sharing one is what would turn every second
// sync into a false conflict resolved by last-write-wins.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PcStore, acceptsPendingFlush } from '../src/main/pc-store';
import type { SyncState } from '../src/main/save-sync';

let baseDir: string;
let store: PcStore;

const state = (file: string, mtime: number): SyncState => ({
  card: { [file]: mtime },
  pc: { [file]: mtime },
  syncedAt: mtime,
});

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-store-'));
  store = new PcStore(baseDir);
  await store.init();
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('PcStore sync-state slots', () => {
  it('defaults to the card slot (existing callers are unchanged)', async () => {
    await store.writeSyncState('hades', state('slot1.sav', 111));
    expect(await store.readSyncState('hades')).toEqual(state('slot1.sav', 111));
    expect(await store.readSyncState('hades', 'card')).toEqual(state('slot1.sav', 111));
  });

  it('keeps the two slots independent — neither write clobbers the other', async () => {
    await store.writeSyncState('hades', state('card.sav', 111), 'card');
    await store.writeSyncState('hades', state('local.sav', 222), 'pc');

    expect(await store.readSyncState('hades', 'card')).toEqual(state('card.sav', 111));
    expect(await store.readSyncState('hades', 'pc')).toEqual(state('local.sav', 222));
  });

  it('does not confuse an id containing a dot with the other slot', async () => {
    // `id` allows dots, so a `<id>.pc.json` suffix would make the card game `hades.pc` and the PC slot of
    // `hades` the same file. The slots live in separate directories for exactly this reason.
    await store.writeSyncState('hades', state('local.sav', 1), 'pc');
    await store.writeSyncState('hades.pc', state('card.sav', 2), 'card');

    expect(await store.readSyncState('hades', 'pc')).toEqual(state('local.sav', 1));
    expect(await store.readSyncState('hades.pc', 'card')).toEqual(state('card.sav', 2));
  });

  it('reports a missing baseline as null, per slot', async () => {
    await store.writeSyncState('hades', state('card.sav', 111), 'card');
    expect(await store.readSyncState('hades', 'pc')).toBeNull();
    expect(await store.readSyncState('unknown', 'card')).toBeNull();
  });

  it('acceptsPendingFlush refuses a LOCAL game, even though it has a save-backup path', () => {
    // The regression this guards: a pending snapshot is progress promised to a CARD. A local game also
    // has a `saveOnCardPath` (its backup in the PC library), so a source-blind check would pour the
    // snapshot in there and clear the queue — the card would never receive it.
    const backup = path.join(baseDir, 'pc-games', 'saves', 'hades');
    expect(acceptsPendingFlush({ source: 'pc', saveOnCardPath: backup })).toBe(false);
    expect(acceptsPendingFlush({ source: 'card', saveOnCardPath: backup })).toBe(true);
    expect(acceptsPendingFlush({ source: 'card' })).toBe(false);
  });

  it('hasCardSyncState tells whether a card carrying this game was ever synced here', async () => {
    // This is the gate for queueing a local game's progress for a card (see queueLocalProgressForCard):
    // without it, every local session would leave a third copy of the saves behind forever.
    expect(await store.hasCardSyncState('hades')).toBe(false);
    await store.writeSyncState('hades', state('local.sav', 1), 'pc');
    expect(await store.hasCardSyncState('hades')).toBe(false);
    await store.writeSyncState('hades', state('card.sav', 2), 'card');
    expect(await store.hasCardSyncState('hades')).toBe(true);
  });
});
