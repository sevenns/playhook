// NotificationsStore invariants: schema defaults (an older/partial file migrates instead of resetting),
// a corrupted file falls back to an empty inbox with a warn breadcrumb, the write queue serializes
// concurrent read-modify-writes (two installs finishing at once must not clobber each other), and the
// update-dedup marker survives a round trip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../src/main/logger';
import { addNotification } from '../src/main/notifications-model';
import { EMPTY_NOTIFICATIONS, NotificationsStore } from '../src/main/notifications-store';
import type { AppNotification } from '../src/shared/types';

let baseDir: string;

function installed(id: string, at: number): AppNotification {
  return { id, at, read: false, kind: 'game-installed', gameId: `g-${id}`, gameTitle: `Game ${id}` };
}

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-notifications-'));
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('NotificationsStore — schema tolerance', () => {
  it('reads an empty inbox when the file does not exist yet (first run, silent)', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(await new NotificationsStore(baseDir).read()).toEqual(EMPTY_NOTIFICATIONS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('fills the defaulted fields of a file written before they existed', async () => {
    await fs.writeFile(
      path.join(baseDir, 'notifications.json'),
      JSON.stringify({ schemaVersion: 1 }),
      'utf8',
    );
    const file = await new NotificationsStore(baseDir).read();
    expect(file.items).toEqual([]);
    expect(file.lastNotifiedUpdateVersion).toBeNull();
  });

  it('falls back to an empty inbox AND warns when the file is corrupted', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await fs.writeFile(path.join(baseDir, 'notifications.json'), '{ this is not json', 'utf8');
    expect(await new NotificationsStore(baseDir).read()).toEqual(EMPTY_NOTIFICATIONS);
    expect(warn).toHaveBeenCalled();
  });

  it('rejects a file whose entries are not valid notifications rather than serving junk to the UI', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await fs.writeFile(
      path.join(baseDir, 'notifications.json'),
      JSON.stringify({ schemaVersion: 1, items: [{ kind: 'nonsense' }] }),
      'utf8',
    );
    expect((await new NotificationsStore(baseDir).read()).items).toEqual([]);
  });
});

describe('NotificationsStore — write queue', () => {
  it('serializes concurrent updates so neither notification is lost', async () => {
    const store = new NotificationsStore(baseDir);
    await Promise.all([
      store.update((current) => ({ ...current, items: addNotification(current.items, installed('a', 1)) })),
      store.update((current) => ({ ...current, items: addNotification(current.items, installed('b', 2)) })),
    ]);
    expect((await store.read()).items.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('update() resolves with what was actually written', async () => {
    const store = new NotificationsStore(baseDir);
    const next = await store.update((current) => ({ ...current, lastNotifiedUpdateVersion: '0.9.0' }));
    expect(next.lastNotifiedUpdateVersion).toBe('0.9.0');
  });

  it('flush() drains fire-and-forget writes, and resolves at once on an idle store', async () => {
    const store = new NotificationsStore(baseDir);
    void store.update((current) => ({ ...current, items: addNotification(current.items, installed('a', 1)) }));
    void store.update((current) => ({ ...current, lastNotifiedUpdateVersion: '1.0.0' }));
    await store.flush();
    const file = await store.read();
    expect(file.items).toHaveLength(1);
    expect(file.lastNotifiedUpdateVersion).toBe('1.0.0');
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it('writes atomically and leaves no temp file behind', async () => {
    const store = new NotificationsStore(baseDir);
    await store.update((current) => ({ ...current, items: addNotification(current.items, installed('a', 1)) }));
    const entries = await fs.readdir(baseDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });
});

describe('NotificationsStore — round trip', () => {
  it('keeps the dedup marker and the inbox across a re-read', async () => {
    const store = new NotificationsStore(baseDir);
    await store.update((current) => ({
      ...current,
      items: addNotification(current.items, installed('a', 42)),
      lastNotifiedUpdateVersion: '0.8.1',
    }));
    const file = await new NotificationsStore(baseDir).read();
    expect(file.lastNotifiedUpdateVersion).toBe('0.8.1');
    expect(file.items[0]).toMatchObject({ id: 'a', at: 42, kind: 'game-installed', read: false });
  });
});
