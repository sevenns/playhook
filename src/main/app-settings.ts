// App-wide settings store — settings.json in %APPDATA%/<app>/.
// Kept SEPARATE from PcStore (which is per-game: stats/<id>.json + pending-flush): this is a single
// application-level file, so folding it into PcStore would blur that store's responsibility.
// zod-validated with a safe read (a missing or corrupted file falls back to the default), mirroring
// PcStore's tolerance of untrusted on-disk data.
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import { type AppSettings, type AutoUpdateMode } from '../shared/types';

const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  autoUpdate: z.enum(['download', 'download-install', 'off']),
});

// Default preserves the pre-settings behaviour (silent download + install on next quit), so the
// first run / a missing file migrates seamlessly to what the app did before this window existed.
export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  autoUpdate: 'download-install',
};

export class AppSettingsStore {
  private readonly settingsPath: string;

  constructor(private readonly baseDir: string) {
    this.settingsPath = path.join(baseDir, 'settings.json');
  }

  /** Reads settings; returns the default when the file is missing or corrupted. */
  async read(): Promise<AppSettings> {
    try {
      const raw: unknown = await fse.readJson(this.settingsPath);
      const parsed = settingsSchema.safeParse(raw);
      return parsed.success ? parsed.data : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  async write(next: AppSettings): Promise<void> {
    await fse.ensureDir(this.baseDir);
    await fse.writeJson(this.settingsPath, next, { spaces: 2 });
  }

  /** Persists a new auto-update mode, keeping the rest of the settings intact. */
  async setAutoUpdate(mode: AutoUpdateMode): Promise<AppSettings> {
    const current = await this.read();
    const next: AppSettings = { ...current, autoUpdate: mode };
    await this.write(next);
    return next;
  }
}
