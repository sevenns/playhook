// AppSettingsStore write-path invariants (plan part S): the promise queue serializes concurrent
// read-modify-writes (a slider burst can't lose updates), flush() drains in-flight writes (awaited before
// an update install), patch() propagates its result/rejection to the caller, the write is atomic, and a
// partial file missing a defaulted field still validates instead of resetting everything to defaults.
// Plus the two rules the Settings-screen move added: `theme` is normalized to 'system' on read, and every
// write notifies the onChange listener (that push is what the screen renders from).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppSettingsStore, DEFAULT_SETTINGS } from '../src/main/app-settings';
import type { AppSettings } from '../src/shared/types';

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
    const next = await store.patch({ musicVolume: 0.75 });
    expect(next.musicVolume).toBe(0.75);
    expect(next.schemaVersion).toBe(1);
  });

  it('flush() resolves only after in-flight writes have settled', async () => {
    const store = new AppSettingsStore(baseDir);
    // Fire-and-forget (no await), as the settings handlers do; flush must drain them.
    void store.patch({ musicVolume: 0.3 });
    void store.patch({ language: 'ru' });
    await store.flush();
    const settings = await store.read();
    expect(settings.musicVolume).toBe(0.3);
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
    await store.write({ ...DEFAULT_SETTINGS, musicVolume: 0.42 });
    expect((await store.read()).musicVolume).toBe(0.42);
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
    expect(settings.musicVolume).toBe(0.25); // NOT reset — the whole parse no longer fails
  });

  it('drops an unknown key from an older file instead of failing the parse', async () => {
    // `customWallpaper` shipped in 0.7 and was removed with the Settings-screen move; a settings.json
    // still carrying it must read fine (the schema is a plain z.object — unknown keys are stripped).
    const legacy = { ...DEFAULT_SETTINGS, customWallpaper: 'wallpaper-custom.png', musicVolume: 0.15 };
    await fs.writeFile(path.join(baseDir, 'settings.json'), JSON.stringify(legacy), 'utf8');
    const settings = await new AppSettingsStore(baseDir).read();
    expect(settings.musicVolume).toBe(0.15);
    expect('customWallpaper' in settings).toBe(false);
  });

  // `alwaysShowEmptyScreen` became `keepOpenWithoutCard` when the empty screen went away. Nothing else
  // catches this: the schema's `.default(false)` swallows the missing key without a word, so a file
  // written by an older build would silently switch the toggle back off for everyone who turned it on.
  it('carries an older alwaysShowEmptyScreen over to keepOpenWithoutCard', async () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_SETTINGS, alwaysShowEmptyScreen: true };
    delete legacy['keepOpenWithoutCard'];
    await fs.writeFile(path.join(baseDir, 'settings.json'), JSON.stringify(legacy), 'utf8');
    const settings = await new AppSettingsStore(baseDir).read();
    expect(settings.keepOpenWithoutCard).toBe(true);
    expect('alwaysShowEmptyScreen' in settings).toBe(false);
  });

  it('lets the new key win when a file somehow carries both', async () => {
    const both: Record<string, unknown> = {
      ...DEFAULT_SETTINGS,
      keepOpenWithoutCard: false,
      alwaysShowEmptyScreen: true,
    };
    await fs.writeFile(path.join(baseDir, 'settings.json'), JSON.stringify(both), 'utf8');
    expect((await new AppSettingsStore(baseDir).read()).keepOpenWithoutCard).toBe(false);
  });
});

describe('AppSettingsStore — theme normalization', () => {
  it('reads back `system` even when the file says `dark` (the selector is gone)', async () => {
    const stored = { ...DEFAULT_SETTINGS, theme: 'dark' as const };
    await fs.writeFile(path.join(baseDir, 'settings.json'), JSON.stringify(stored), 'utf8');
    expect((await new AppSettingsStore(baseDir).read()).theme).toBe('system');
  });

  it('normalizes it for patch() results too, so no caller can resurrect the old value', async () => {
    const stored = { ...DEFAULT_SETTINGS, theme: 'light' as const };
    await fs.writeFile(path.join(baseDir, 'settings.json'), JSON.stringify(stored), 'utf8');
    const store = new AppSettingsStore(baseDir);
    expect((await store.patch({ musicVolume: 0.6 })).theme).toBe('system');
  });
});

describe('AppSettingsStore — onChange', () => {
  it('fires on write, patch and reset — every path through persist()', async () => {
    const seen: AppSettings[] = [];
    const store = new AppSettingsStore(baseDir, (next) => seen.push(next));
    await store.write({ ...DEFAULT_SETTINGS, musicVolume: 0.2 });
    await store.patch({ sfxVolume: 0.4 });
    await store.reset();
    expect(seen.map((s) => [s.musicVolume, s.sfxVolume])).toEqual([
      [0.2, DEFAULT_SETTINGS.sfxVolume],
      [0.2, 0.4],
      [DEFAULT_SETTINGS.musicVolume, DEFAULT_SETTINGS.sfxVolume],
    ]);
  });

  it('is optional — a store built without it (the daemon) writes fine', async () => {
    const store = new AppSettingsStore(baseDir);
    await expect(store.patch({ sfxVolume: 0.5 })).resolves.toMatchObject({ sfxVolume: 0.5 });
  });
});
