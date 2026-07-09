// AppSettingsStore write-path invariants (plan part S): the promise queue serializes concurrent
// read-modify-writes (a slider burst can't lose updates), flush() drains in-flight writes (awaited before
// an update install), patch() propagates its result/rejection to the caller, the write is atomic, and a
// partial file missing a defaulted field still validates instead of resetting everything to defaults.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppSettingsStore, DEFAULT_SETTINGS } from '../src/main/app-settings';

let baseDir: string;

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-settings-'));
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('AppSettingsStore — write queue', () => {
  it('serializes concurrent patches so no update is lost (no read-modify-write interleave)', async () => {
    const store = new AppSettingsStore(baseDir);
    // Two independent fields patched concurrently. Without the queue both ops read the same base and the
    // second write clobbers the first's field; with it, the second reads the first's result.
    await Promise.all([store.patch({ musicVolume: 0.1 }), store.patch({ sfxVolume: 0.2 })]);
    const settings = await store.read();
    expect(settings.musicVolume).toBe(0.1);
    expect(settings.sfxVolume).toBe(0.2);
  });

  it('applies a burst of patches to the SAME field in call order (last value wins)', async () => {
    const store = new AppSettingsStore(baseDir);
    await Promise.all([0.1, 0.2, 0.3, 0.4].map((v) => store.patch({ musicVolume: v })));
    expect((await store.read()).musicVolume).toBe(0.4);
  });

  it('patch() resolves with the merged settings (result propagation)', async () => {
    const store = new AppSettingsStore(baseDir);
    const next = await store.patch({ theme: 'dark' });
    expect(next.theme).toBe('dark');
    expect(next.schemaVersion).toBe(1);
  });

  it('flush() resolves only after in-flight writes have settled', async () => {
    const store = new AppSettingsStore(baseDir);
    // Fire-and-forget (no await), as the settings handlers do; flush must drain them.
    void store.patch({ theme: 'dark' });
    void store.patch({ language: 'ru' });
    await store.flush();
    const settings = await store.read();
    expect(settings.theme).toBe('dark');
    expect(settings.language).toBe('ru');
  });

  it('flush() on an idle store resolves immediately', async () => {
    const store = new AppSettingsStore(baseDir);
    await expect(store.flush()).resolves.toBeUndefined();
  });
});

describe('AppSettingsStore — atomic write + schema tolerance', () => {
  it('write persists a valid, re-readable JSON file and leaves no temp behind', async () => {
    const store = new AppSettingsStore(baseDir);
    await store.write({ ...DEFAULT_SETTINGS, theme: 'light' });
    expect((await store.read()).theme).toBe('light');
    // The temp file used by the atomic rename must not linger.
    const entries = await fs.readdir(baseDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('a file missing a defaulted field (autoUpdate) still validates instead of resetting to defaults', async () => {
    // Simulate a partial/older settings.json that lost `autoUpdate`: every OTHER field must survive.
    const partial = { ...DEFAULT_SETTINGS, theme: 'dark' as const, musicVolume: 0.25 };
    delete (partial as { autoUpdate?: unknown }).autoUpdate;
    await fs.writeFile(path.join(baseDir, 'settings.json'), JSON.stringify(partial), 'utf8');
    const store = new AppSettingsStore(baseDir);
    const settings = await store.read();
    expect(settings.autoUpdate).toBe(DEFAULT_SETTINGS.autoUpdate); // filled from the schema default
    expect(settings.theme).toBe('dark'); // NOT reset — the whole parse no longer fails
    expect(settings.musicVolume).toBe(0.25);
  });
});
