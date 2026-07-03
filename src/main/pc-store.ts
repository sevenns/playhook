// State directory on the PC — the SOURCE OF TRUTH.
// Lives in %APPDATA%/<app>/ and holds: stats/<id>.json (per-game statistics) and
// the pending-flush/<id>/ queue (a deferred PC→SD, if the card was yanked mid-game).
//
// pending-flush takes a SNAPSHOT of the saves from the PC at the moment of enqueueing, so that
// on the next card insertion it tops up exactly that progress, not whatever ends up on the PC later.
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import { type Stats } from '../shared/types';
import { readJsonValidated } from './json-store';

const statsSchema = z.object({
  schemaVersion: z.literal(1),
  totalPlaySeconds: z.number().nonnegative(),
  lastPlayedAt: z.string().nullable(),
  launchCount: z.number().int().nonnegative(),
});

export const DEFAULT_STATS: Stats = {
  schemaVersion: 1,
  totalPlaySeconds: 0,
  lastPlayedAt: null,
  launchCount: 0,
};

/** Validates an untrusted stats payload (PC file or the card copy). null = absent/corrupted. */
export function parseStats(raw: unknown): Stats | null {
  const parsed = statsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const pendingMetaSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  enqueuedAt: z.string(),
});

export interface PendingFlush {
  readonly id: string;
  readonly enqueuedAt: string;
  /** Snapshot directory of the PC saves that needs to be topped up onto the card. */
  readonly savesSnapshotDir: string;
}

export class PcStore {
  private readonly statsDir: string;
  private readonly pendingDir: string;

  constructor(private readonly baseDir: string) {
    this.statsDir = path.join(baseDir, 'stats');
    this.pendingDir = path.join(baseDir, 'pending-flush');
  }

  async init(): Promise<void> {
    await fse.ensureDir(this.statsDir);
    await fse.ensureDir(this.pendingDir);
  }

  private statsPath(id: string): string {
    return path.join(this.statsDir, `${id}.json`);
  }

  /** Reads statistics; returns zeros if the file is missing or corrupted (a warn is logged on corruption). */
  async readStats(id: string): Promise<Stats> {
    return readJsonValidated(this.statsPath(id), statsSchema, DEFAULT_STATS);
  }

  async writeStats(id: string, stats: Stats): Promise<void> {
    await fse.ensureDir(this.statsDir);
    await fse.writeJson(this.statsPath(id), stats, { spaces: 2 });
  }

  private pendingEntryDir(id: string): string {
    return path.join(this.pendingDir, id);
  }

  /**
   * Snapshots the saves from the PC and enqueues a PC→SD for game `id`.
   * Overwrites the previous snapshot for this game, if there was one.
   */
  async enqueuePcToSd(id: string, pcSavePath: string): Promise<void> {
    const entryDir = this.pendingEntryDir(id);
    await fse.remove(entryDir);
    const savesSnapshotDir = path.join(entryDir, 'saves');
    if (await fse.pathExists(pcSavePath)) {
      await fse.copy(pcSavePath, savesSnapshotDir, { preserveTimestamps: false });
    } else {
      await fse.ensureDir(savesSnapshotDir);
    }
    const meta = { schemaVersion: 1 as const, id, enqueuedAt: new Date().toISOString() };
    await fse.writeJson(path.join(entryDir, 'meta.json'), meta, { spaces: 2 });
  }

  /** Returns the deferred flush for game `id`, if it exists and is valid. */
  async getPending(id: string): Promise<PendingFlush | null> {
    const entryDir = this.pendingEntryDir(id);
    const metaPath = path.join(entryDir, 'meta.json');
    try {
      const raw: unknown = await fse.readJson(metaPath);
      const parsed = pendingMetaSchema.safeParse(raw);
      if (!parsed.success) return null;
      return {
        id: parsed.data.id,
        enqueuedAt: parsed.data.enqueuedAt,
        savesSnapshotDir: path.join(entryDir, 'saves'),
      };
    } catch {
      return null;
    }
  }

  async clearPending(id: string): Promise<void> {
    await fse.remove(this.pendingEntryDir(id));
  }
}
