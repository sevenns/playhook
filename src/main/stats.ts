// Playtime tracking.
// "One card, many PCs": the card's stats.json is the TRAVELING canonical record, and the per-PC
// PcStore is a working mirror. On insertion the two are reconciled (merged) so the card carries a
// single unified total across machines. The card write stays best-effort: the card may be yanked,
// so losing a write isn't critical and must not crash the flow.
import path from 'node:path';
import fse from 'fs-extra';
import { CARD_STATS_FILENAME, type Stats } from '../shared/types';
import { parseStats, type PcStore } from './pc-store';
import { writeFileAtomic } from './save-sync';
import { log } from './logger';

/** Returns the later of two ISO timestamps (null = "never", loses to any real date). */
function latestDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Field-wise merge of two stats records (pure). The card is physically a single device used
 * sequentially across PCs, so it always carries the latest cumulative totals — taking the max
 * per field never loses progress and never double-counts (the PC mirror already equals the card
 * baseline plus the current session). lastPlayedAt = the more recent timestamp.
 */
export function mergeStats(a: Stats, b: Stats): Stats {
  return {
    schemaVersion: 1,
    totalPlaySeconds: Math.max(a.totalPlaySeconds, b.totalPlaySeconds),
    launchCount: Math.max(a.launchCount, b.launchCount),
    lastPlayedAt: latestDate(a.lastPlayedAt, b.lastPlayedAt),
  };
}

export class StatsService {
  constructor(private readonly store: PcStore) {}

  async read(id: string): Promise<Stats> {
    return this.store.readStats(id);
  }

  /** Reads the (untrusted) stats copy from the card root; null if absent or corrupted. */
  async readCardStats(cardRoot: string): Promise<Stats | null> {
    try {
      const raw: unknown = await fse.readJson(path.join(cardRoot, CARD_STATS_FILENAME));
      return parseStats(raw);
    } catch {
      return null;
    }
  }

  /**
   * Reconciles the card's traveling stats with the local PC mirror on insertion: merges them,
   * persists the result to the PC store (the working baseline for this session) and returns it.
   * If the card has no stats yet (fresh card), the local PC value is kept as-is (bootstrap).
   */
  async reconcileWithCard(id: string, cardRoot: string): Promise<Stats> {
    const pc = await this.store.readStats(id);
    const card = await this.readCardStats(cardRoot);
    log.info(
      `[stats] reconcile id=${id} pc=${pc.totalPlaySeconds}s/${pc.launchCount} ` +
        `card=${card === null ? 'none' : `${card.totalPlaySeconds}s/${card.launchCount}`}`,
    );
    if (card === null) return pc;
    const merged = mergeStats(pc, card);
    await this.store.writeStats(id, merged);
    return merged;
  }

  /** Records a finished session: += time, ++launches, lastPlayedAt = now. Writes to the PC. */
  async recordPlay(id: string, playSeconds: number): Promise<Stats> {
    const previous = await this.store.readStats(id);
    const delta = Math.max(0, Math.round(playSeconds));
    const next: Stats = {
      schemaVersion: 1,
      totalPlaySeconds: previous.totalPlaySeconds + delta,
      lastPlayedAt: new Date().toISOString(),
      launchCount: previous.launchCount + 1,
    };
    await this.store.writeStats(id, next);
    return next;
  }

  /** Best-effort copy of the statistics to the card root. Errors are only logged. */
  async copyToCard(cardRoot: string, stats: Stats): Promise<void> {
    const target = path.join(cardRoot, CARD_STATS_FILENAME);
    try {
      await writeFileAtomic(target, JSON.stringify(stats, null, 2));
      log.info(`[stats] wrote card copy → "${target}"`);
    } catch (cause) {
      log.error(`[stats] FAILED to write card copy → "${target}":`, cause);
    }
  }
}
