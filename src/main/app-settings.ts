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
import { readJsonValidated } from './json-store';

const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  autoUpdate: z.enum(['download', 'download-install', 'off']),
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
};

export class AppSettingsStore {
  private readonly settingsPath: string;

  constructor(private readonly baseDir: string) {
    this.settingsPath = path.join(baseDir, 'settings.json');
  }

  /** Reads settings; returns the default when the file is missing or corrupted (a warn is logged on corruption). */
  async read(): Promise<AppSettings> {
    return readJsonValidated(this.settingsPath, settingsSchema, DEFAULT_SETTINGS);
  }

  async write(next: AppSettings): Promise<void> {
    await fse.ensureDir(this.baseDir);
    await fse.writeJson(this.settingsPath, next, { spaces: 2 });
  }

  /** Merges a partial change into the current settings and persists the result. */
  async patch(partial: Partial<Omit<AppSettings, 'schemaVersion'>>): Promise<AppSettings> {
    const current = await this.read();
    const next: AppSettings = { ...current, ...partial };
    await this.write(next);
    return next;
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

  /** Overwrites the file with the defaults and returns them. */
  async reset(): Promise<AppSettings> {
    await this.write(DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }
}
