// State directory on the PC — the SOURCE OF TRUTH.
// Lives in %APPDATA%/<app>/ and holds: stats/<id>.json (per-game statistics) and
// the pending-flush/<id>/ queue (a deferred PC→SD, if the card was yanked mid-game).
//
// pending-flush takes a SNAPSHOT of the saves from the PC at the moment of enqueueing, so that
// on the next card insertion it tops up exactly that progress, not whatever ends up on the PC later.
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import { type ResolvedManifest, type Stats } from '../shared/types';
import { readJsonValidated, writeJsonAtomic } from './json-store';
import { type SyncState } from './save-sync';
import { log } from './logger';
import { describe } from './util';

// Exported so stats.ts can build the per-id card-stats map schema (v2) on top of the same single-game
// shape — one source of truth for what a valid Stats record is.
export const statsSchema = z.object({
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

// The per-side last-sync baseline for a game (paths+mtime snapshots). Kept separate from stats: it is
// sync bookkeeping, not user-facing data. A record of relPath→mtimeMs per side plus a timestamp.
const treeSnapshotSchema = z.record(z.string(), z.number());
const syncStateSchema = z.object({
  card: treeSnapshotSchema,
  pc: treeSnapshotSchema,
  syncedAt: z.number(),
});

/**
 * Which pairing a sync baseline describes: `card` — the inserted card ↔ the PC save folder (the original
 * and only slot); `pc` — a local game's own backup in the PC library ↔ that same folder. See syncStatePath.
 */
export type SyncSlot = 'card' | 'pc';

/**
 * Whether a game may RECEIVE a deferred PC→SD flush (the snapshot taken when a card was yanked mid-game).
 *
 * The `source` half is the load-bearing one. A local game has a `saveOnCardPath` too — its backup inside
 * the PC library — so the plain "has a card side?" test would happily pour a snapshot meant for the real
 * card into that backup and then clear the queue, silently destroying the progress the next card
 * insertion was supposed to receive. A pending snapshot belongs to a CARD, and only a card may take it.
 */
export function acceptsPendingFlush(
  manifest: Pick<ResolvedManifest, 'source' | 'saveOnCardPath'>,
): boolean {
  return manifest.source === 'card' && manifest.saveOnCardPath !== undefined;
}

export class PcStore {
  private readonly statsDir: string;
  private readonly pendingDir: string;
  private readonly syncStateDir: string;

  constructor(private readonly baseDir: string) {
    this.statsDir = path.join(baseDir, 'stats');
    this.pendingDir = path.join(baseDir, 'pending-flush');
    this.syncStateDir = path.join(baseDir, 'sync-state');
  }

  async init(): Promise<void> {
    await fse.ensureDir(this.statsDir);
    await fse.ensureDir(this.pendingDir);
    await fse.ensureDir(this.syncStateDir);
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
    // Atomic temp→rename (same rename semantics as settings): a process kill mid-write leaves the old
    // valid stats file rather than a truncated one that readJsonValidated would warn-and-reset to zeros.
    await writeJsonAtomic(this.statsPath(id), stats);
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
      await fse.copy(pcSavePath, savesSnapshotDir, { preserveTimestamps: true });
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

  /**
   * Where a game's last-sync baseline lives, per SLOT. A game can be synced against two different
   * partners — the card it came on, and (for a local game) the backup Playhook keeps — and each pair has
   * its own history: sharing one baseline would make every sync look like "the other side changed",
   * i.e. a permanent false conflict resolved by LWW.
   *
   * The PC slot is a SUBDIRECTORY rather than a `<id>.pc.json` suffix on purpose: `id` may contain dots
   * (manifest.ts), so a card game called `hades.pc` would otherwise collide with the PC slot of `hades`.
   */
  private syncStatePath(id: string, slot: SyncSlot): string {
    return slot === 'pc'
      ? path.join(this.syncStateDir, 'pc', `${id}.json`)
      : path.join(this.syncStateDir, `${id}.json`);
  }

  /** Whether a CARD baseline exists for this game — i.e. whether a card carrying it was ever synced here. */
  async hasCardSyncState(id: string): Promise<boolean> {
    return fse.pathExists(this.syncStatePath(id, 'card'));
  }

  /**
   * Reads the last-sync baseline for game `id`. Returns null when it's missing (normal first run / after
   * an update → the caller falls back to the deterministic phase direction) or corrupted (logged, then
   * treated as absent so a damaged file can't wedge sync — the next successful sync rewrites it).
   */
  async readSyncState(id: string, slot: SyncSlot = 'card'): Promise<SyncState | null> {
    let raw: unknown;
    try {
      raw = await fse.readJson(this.syncStatePath(id, slot));
    } catch (cause) {
      // ENOENT is the expected first-run case → silent; anything else is a real read anomaly → warn.
      if (cause instanceof Error && (cause as { code?: unknown }).code !== 'ENOENT') {
        log.warn(`[sync-state] failed to read baseline for "${id}":`, cause);
      }
      return null;
    }
    const parsed = syncStateSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn(`[sync-state] baseline for "${id}" failed validation, ignoring:`, parsed.error.message);
      return null;
    }
    return parsed.data;
  }

  async writeSyncState(id: string, state: SyncState, slot: SyncSlot = 'card'): Promise<void> {
    const target = this.syncStatePath(id, slot);
    await fse.ensureDir(path.dirname(target));
    await writeJsonAtomic(target, state);
  }

  /**
   * Drops a game's sync baseline. Used when a local game moves to a card (Р2.5): its `pc` baseline
   * partnered the PC-library backup with the local save folder, and that pairing no longer exists once
   * the game leaves the library — keeping it would read as a stale baseline and could report a false
   * conflict if the game is ever moved back to the PC. Silent on an already-absent file (the normal case
   * for a game whose saves were never synced).
   */
  async removeSyncState(id: string, slot: SyncSlot = 'card'): Promise<void> {
    try {
      await fse.remove(this.syncStatePath(id, slot));
    } catch (cause) {
      log.warn(`[sync-state] failed to remove the "${slot}" baseline for "${id}":`, describe(cause));
    }
  }
}
