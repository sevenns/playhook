// App-wide settings store — settings.json in %APPDATA%/<app>/.
// Kept SEPARATE from PcStore (which is per-game: stats/<id>.json + pending-flush): this is a single
// application-level file, so folding it into PcStore would blur that store's responsibility.
// zod-validated with a safe read (a missing or corrupted file falls back to the default), mirroring
// PcStore's tolerance of untrusted on-disk data.
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import { type AppSettings, type AutoUpdateMode, type LanguageMode } from '../shared/types';
import { readJsonValidated, writeJsonAtomic } from './json-store';

const settingsObject = z.object({
  schemaVersion: z.literal(1),
  // `.default` so a partial/older settings.json missing this field (e.g. a half-written file that lost
  // `autoUpdate` mid-write) still validates instead of failing the WHOLE parse → a full reset to defaults.
  // The value mirrors DEFAULT_SETTINGS. schemaVersion stays strict on purpose (see the note above the class).
  autoUpdate: z.enum(['download', 'download-install', 'off']).default('download-install'),
  // Kept in the schema so an older settings.json that still carries a chosen theme parses (and so the
  // key survives a round trip), but the value is NORMALIZED to 'system' on read: the Settings screen has
  // no theme selector any more, and no window left that reads one: the launcher paints itself from the
  // card's own palette.
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  // Language mirrors theme: `.default('system')` so an older settings.json without the field stays valid
  // (no schemaVersion bump / migration needed).
  language: z.enum(['system', 'en', 'ru']).default('system'),
  allowPrerelease: z.boolean().default(false),
  summonHotkeyEnabled: z.boolean().default(true),
  // Keep the display awake (no screensaver / display-sleep) while the launcher owns the session.
  // `.default(true)` keeps the field valid for an older settings.json written before it existed.
  preventScreensaver: z.boolean().default(true),
  musicVolume: z.number().min(0).max(1).default(0.5),
  sfxVolume: z.number().min(0).max(1).default(1),
  // Stay on screen with no card in instead of hiding to the tray. Defaults ON: the launcher grew its own
  // reasons to be up without a card (the library, the local PC games, the settings), so vanishing to the
  // tray the moment a card is pulled hides a UI that still has something to show. A file written under
  // the old name (alwaysShowEmptyScreen) is carried over by the preprocess below; a file that already has
  // the key keeps whatever the user chose, so this only changes what a FRESH install does.
  keepOpenWithoutCard: z.boolean().default(true),
  // Disable trying silent mode for install-mode installers (they show their wizard instead). `.default(false)`
  // keeps the original silent behaviour for an older settings.json without the field.
  disableSilentInstall: z.boolean().default(false),
  // The appid of Playhook's own non-Steam shortcut (Steam Deck), UNSIGNED 32-bit, or null when no shortcut
  // is registered. This is the ONE persisted representation — the signed on-disk form and the 64-bit
  // rungameid are derived from it (see platform/steam-appid.ts). `.default(null)` migrates an older
  // settings.json without the field (no schemaVersion bump).
  steamAppIdU32: z.number().int().nullable().default(null),
  // Game Mode auto-launch on card insertion (Steam Deck). `.default(true)` keeps the behaviour that
  // shipped before the toggle existed for an older settings.json.
  steamAutoLaunch: z.boolean().default(true),
  // Navigation sound set (folder under audio/ui/). A plain string, not an enum: sets are enumerated
  // dynamically from the bundle and validity (folder exists) is checked at read time in AssetReader.
  // `.default('playhook-abyss')` migrates an older settings.json without the field (no schemaVersion bump).
  soundSet: z.string().default('playhook-abyss'),
  // Default background ambience (file name under audio/ambience/, extension included), or null for none.
  // `.default(…)` migrates an older settings.json without the field (no schemaVersion bump); a track that
  // is no longer bundled just doesn't play (AssetReader checks the file before reading it).
  ambientTrack: z.string().nullable().default('playhook-abyss.mp3'),
  // Use only the global ambience, ignoring a card's own background music. `.default(false)` keeps the
  // "a card's music wins" behaviour for an older settings.json without the field.
  onlyGlobalAmbient: z.boolean().default(false),
});

/**
 * `alwaysShowEmptyScreen` was renamed to `keepOpenWithoutCard` when the screen it was named after went
 * away (the launcher cards replaced it); the SETTING is the same one, so a file written by an older
 * build must keep its value. Without this the `.default(true)` above would swallow the missing key
 * without a trace and force the toggle ON for everyone who had deliberately turned it off.
 *
 * No schemaVersion bump — this is the same in-place style of migration `language`, `steamAppIdU32` and
 * `soundSet` already use.
 */
const settingsSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const record = raw as Record<string, unknown>;
  if (!('alwaysShowEmptyScreen' in record) || 'keepOpenWithoutCard' in record) return raw;
  const migrated: Record<string, unknown> = {
    ...record,
    keepOpenWithoutCard: record['alwaysShowEmptyScreen'],
  };
  delete migrated['alwaysShowEmptyScreen'];
  return migrated;
}, settingsObject);

// Default preserves the pre-settings behaviour (silent download + install on next quit), so the
// first run / a missing file migrates seamlessly to what the app did before this window existed.
export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  autoUpdate: 'download-install',
  theme: 'system',
  language: 'system',
  allowPrerelease: false,
  summonHotkeyEnabled: true,
  preventScreensaver: true,
  musicVolume: 0.5,
  sfxVolume: 1,
  keepOpenWithoutCard: true,
  disableSilentInstall: false,
  steamAppIdU32: null,
  steamAutoLaunch: true,
  soundSet: 'playhook-abyss',
  ambientTrack: 'playhook-abyss.mp3',
  onlyGlobalAmbient: false,
};

export class AppSettingsStore {
  private readonly settingsPath: string;
  // Serializes every WRITE (write/patch/reset) so parallel fire-and-forget callers (e.g. a volume slider
  // firing a burst of patch()) can't interleave read-modify-write and lose updates, and never race on the
  // shared `${settingsPath}.tmp` file. Reads stay OFF the queue (a queued op reads directly — see enqueue).
  private tail: Promise<void> = Promise.resolve();

  /**
   * @param baseDir where settings.json lives (the GUI passes app.getPath('userData')).
   * @param onChange called with the new snapshot after EVERY successful write — write/patch/reset all
   *   funnel through persist(), so a new setter can never forget to notify. Optional: the Game Mode
   *   daemon builds a store with no listener at all.
   */
  constructor(
    private readonly baseDir: string,
    private readonly onChange?: (next: AppSettings) => void,
    /**
     * Called when a write FAILS, for the one thing every caller would otherwise have to notice on its
     * own: a settings change that silently did not stick. Each setter already logs its own failure, but
     * the user is looking at a toggle that flipped back — or, for the language, at a UI that did not
     * change at all — with nothing to explain it. Optional, like `onChange` (the daemon passes neither).
     */
    private readonly onWriteFailed?: (cause: unknown) => void,
  ) {
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

  /**
   * Reads settings; returns the default when the file is missing or corrupted (a warn is logged on
   * corruption). `theme` is normalized to 'system' regardless of what the file holds — see the schema.
   */
  async read(): Promise<AppSettings> {
    const parsed = await readJsonValidated(this.settingsPath, settingsSchema, DEFAULT_SETTINGS);
    return { ...parsed, theme: 'system' };
  }

  /** The actual atomic write — called ONLY from inside a queued op, so it never enqueues (would deadlock). */
  private async persist(next: AppSettings): Promise<void> {
    try {
      await fse.ensureDir(this.baseDir);
      await writeJsonAtomic(this.settingsPath, next);
    } catch (cause) {
      // Reported here rather than at each setter's own catch: every one of them fails the same way and
      // for the same reason, and the user needs telling once, not per setting.
      this.onWriteFailed?.(cause);
      throw cause;
    }
    this.onChange?.(next);
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
