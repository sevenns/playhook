// App-wide settings store — settings.json in %APPDATA%/<app>/.
// Kept SEPARATE from PcStore (which is per-game: stats/<id>.json + pending-flush): this is a single
// application-level file, so folding it into PcStore would blur that store's responsibility.
// zod-validated with a safe read (a missing or corrupted file falls back to the default), mirroring
// PcStore's tolerance of untrusted on-disk data.
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import {
  type AppSettings,
  type AutoUpdateMode,
  type LanguageMode,
  type ThemeMode,
} from '../shared/types';
import { readJsonValidated, writeJsonAtomic } from './json-store';

const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  // `.default` so a partial/older settings.json missing this field (e.g. a half-written file that lost
  // `autoUpdate` mid-write) still validates instead of failing the WHOLE parse → a full reset to defaults.
  // The value mirrors DEFAULT_SETTINGS. schemaVersion stays strict on purpose (see the note above the class).
  autoUpdate: z.enum(['download', 'download-install', 'off']).default('download-install'),
  // `.default` makes an older settings.json (written before a field existed) migrate seamlessly: a file
  // missing the field parses fine and keeps its other values.
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  // Language mirrors theme: `.default('system')` so an older settings.json without the field stays valid
  // (no schemaVersion bump / migration needed).
  language: z.enum(['system', 'en', 'ru']).default('system'),
  allowPrerelease: z.boolean().default(false),
  summonHotkeyEnabled: z.boolean().default(true),
  musicVolume: z.number().min(0).max(1).default(0.5),
  sfxVolume: z.number().min(0).max(1).default(1),
  // File name of the custom Empty-screen wallpaper in userData, or null for the bundled default.
  // `.default(null)` migrates an older settings.json without the field (no schemaVersion bump).
  customWallpaper: z.string().nullable().default(null),
  // Keep the empty "no card" screen visible instead of hiding to the tray. `.default(false)` keeps the
  // original background-app behaviour for an older settings.json without the field.
  alwaysShowEmptyScreen: z.boolean().default(false),
});

// Default preserves the pre-settings behaviour (silent download + install on next quit), so the
// first run / a missing file migrates seamlessly to what the app did before this window existed.
export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  autoUpdate: 'download-install',
  theme: 'system',
  language: 'system',
  allowPrerelease: false,
  summonHotkeyEnabled: true,
  musicVolume: 0.5,
  sfxVolume: 1,
  customWallpaper: null,
  alwaysShowEmptyScreen: false,
};

export class AppSettingsStore {
  private readonly settingsPath: string;
  // Serializes every WRITE (write/patch/reset) so parallel fire-and-forget callers (e.g. a volume slider
  // firing a burst of patch()) can't interleave read-modify-write and lose updates, and never race on the
  // shared `${settingsPath}.tmp` file. Reads stay OFF the queue (a queued op reads directly — see enqueue).
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly baseDir: string) {
    this.settingsPath = path.join(baseDir, 'settings.json');
  }

  /**
   * Runs `op` after the current write chain drains, then chains the next writer behind it. The caller
   * gets `op`'s real result/rejection (used by setVolume awaiting `next`, the wallpaper flow, etc.); the
   * chain TAIL swallows rejections separately so one failed write can't poison every later enqueue.
   */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.tail.then(op);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Reads settings; returns the default when the file is missing or corrupted (a warn is logged on corruption). */
  async read(): Promise<AppSettings> {
    return readJsonValidated(this.settingsPath, settingsSchema, DEFAULT_SETTINGS);
  }

  /** The actual atomic write — called ONLY from inside a queued op, so it never enqueues (would deadlock). */
  private async persist(next: AppSettings): Promise<void> {
    await fse.ensureDir(this.baseDir);
    await writeJsonAtomic(this.settingsPath, next);
  }

  write(next: AppSettings): Promise<void> {
    return this.enqueue(() => this.persist(next));
  }

  /** Merges a partial change into the current settings and persists the result (read-modify-write, queued). */
  patch(partial: Partial<Omit<AppSettings, 'schemaVersion'>>): Promise<AppSettings> {
    // The whole read-modify-write runs as ONE queued op so concurrent patches can't interleave; the read
    // is direct (not enqueue) — enqueuing it here would wait on the very op it runs inside → deadlock.
    return this.enqueue(async () => {
      const current = await this.read();
      const next: AppSettings = { ...current, ...partial };
      await this.persist(next);
      return next;
    });
  }

  setAutoUpdate(mode: AutoUpdateMode): Promise<AppSettings> {
    return this.patch({ autoUpdate: mode });
  }

  setTheme(mode: ThemeMode): Promise<AppSettings> {
    return this.patch({ theme: mode });
  }

  setLanguage(mode: LanguageMode): Promise<AppSettings> {
    return this.patch({ language: mode });
  }

  /** Overwrites the file with the defaults and returns them (queued, like every other write). */
  reset(): Promise<AppSettings> {
    return this.enqueue(async () => {
      await this.persist(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    });
  }

  /**
   * Resolves once every queued write in flight has settled. Awaited by UpdaterService.install() before
   * quitAndInstall so an in-flight settings write isn't torn apart mid-write by the process exit (the
   * root cause of settings loss after an update). Never rejects — the tail already swallows rejections.
   */
  flush(): Promise<void> {
    return this.tail;
  }
}
