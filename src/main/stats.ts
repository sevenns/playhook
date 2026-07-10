// Playtime tracking.
// "One card, many PCs": the card's stats.json is the TRAVELING canonical record, and the per-PC
// PcStore is a working mirror. On insertion the two are reconciled (merged) so the card carries a
// single unified total across machines. The card write stays best-effort: the card may be yanked,
// so losing a write isn't critical and must not crash the flow.
//
// Multi-game cards: a card can carry SEVERAL games, so the card copy is a MAP keyed by game id
// (`{ schemaVersion, games: { "<id>": Stats } }`) — one file, many games, no cross-contamination. The
// pre-multi-game format was a bare Stats object (a single game per card); it is still read and migrated
// (see readCardStatsMap → CardStatsRead.kind === 'legacy'), but attribution is the caller's decision
// (loadCard), which alone knows how many games the card carries.
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import { CARD_STATS_FILENAME, type Stats } from '../shared/types';
import { parseStats, statsSchema, type PcStore } from './pc-store';
import { writeFileAtomic } from './save-sync';
import { log } from './logger';
import { describe } from './util';

// The per-id card-stats map (v2). Built on the shared single-game statsSchema so "a valid Stats record"
// has one definition. `games` is a record id→Stats; `schemaVersion` distinguishes it from a bare v1 file.
const cardStatsMapSchema = z.object({
  schemaVersion: z.literal(1),
  games: z.record(z.string(), statsSchema),
});

/**
 * Outcome of reading the card's stats file (untrusted). Four cases the caller must tell apart:
 * `empty` (no file → start from an empty map), `map` (the current per-id format), `legacy` (the old
 * bare-Stats single-game format → migration/attribution is loadCard's call), and `corrupt` (a file that
 * EXISTS but can't be parsed → must NOT be treated as empty, or a best-effort write would wipe siblings).
 */
export type CardStatsRead =
  | { readonly kind: 'empty' }
  | { readonly kind: 'map'; readonly games: Record<string, Stats> }
  | { readonly kind: 'legacy'; readonly stats: Stats }
  | { readonly kind: 'corrupt' };

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

  /**
   * Reads the (untrusted) card stats file and classifies it (empty / per-id map / legacy bare-Stats /
   * corrupt). A missing file is the benign first-run case (`empty`); a present-but-unparseable file is
   * `corrupt` and logged — never silently treated as empty (that would let a best-effort copyToCard wipe
   * other games' stats). The caller (loadCard) decides how to attribute a `legacy` file, since only it
   * knows how many games the card carries.
   */
  async readCardStatsMap(cardRoot: string): Promise<CardStatsRead> {
    let raw: unknown;
    try {
      raw = await fse.readJson(path.join(cardRoot, CARD_STATS_FILENAME));
    } catch (cause) {
      if (cause instanceof Error && (cause as { code?: unknown }).code === 'ENOENT') {
        return { kind: 'empty' };
      }
      log.warn(`[stats] failed to read card stats at "${cardRoot}":`, describe(cause));
      return { kind: 'corrupt' };
    }
    const asMap = cardStatsMapSchema.safeParse(raw);
    if (asMap.success) return { kind: 'map', games: { ...asMap.data.games } };
    const asLegacy = parseStats(raw);
    if (asLegacy !== null) return { kind: 'legacy', stats: asLegacy };
    log.warn(`[stats] card stats at "${cardRoot}" is present but invalid — ignoring`);
    return { kind: 'corrupt' };
  }

  /** Reads a single game's traveling stats from the card map; null when there is no entry for `id`
   * (absent / corrupt / legacy — legacy attribution is loadCard's decision, not this method's). */
  async readCardStats(cardRoot: string, id: string): Promise<Stats | null> {
    const read = await this.readCardStatsMap(cardRoot);
    return read.kind === 'map' ? (read.games[id] ?? null) : null;
  }

  /**
   * Reconciles the card's traveling stats with the local PC mirror on insertion: merges them,
   * persists the result to the PC store (the working baseline for this session) and returns it.
   * If the card has no stats yet (fresh card), the local PC value is kept as-is (bootstrap).
   *
   * `legacyFallback` covers the one-game migration: when the card holds an old bare-Stats file and the
   * caller (loadCard) has determined it belongs to THIS game (single-game card), it passes those stats
   * so the legacy playtime is merged in. It is used only when the per-id map has no entry for `id`.
   */
  async reconcileWithCard(
    id: string,
    cardRoot: string,
    legacyFallback: Stats | null = null,
  ): Promise<Stats> {
    const pc = await this.store.readStats(id);
    const card = (await this.readCardStats(cardRoot, id)) ?? legacyFallback;
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

  /**
   * Best-effort copy of one game's statistics to the card root, read-modify-write on the per-id map so
   * sibling games' entries are preserved. If the existing file is corrupt we SKIP the write rather than
   * clobber stats we couldn't read (traveling stats are best-effort anyway — the PC mirror is the source
   * of truth). A legacy bare-Stats file is superseded by the map on the first write (the legacy value was
   * already attributed/merged upstream in loadCard when unambiguous). Errors are only logged.
   */
  async copyToCard(cardRoot: string, id: string, stats: Stats): Promise<void> {
    const target = path.join(cardRoot, CARD_STATS_FILENAME);
    try {
      const read = await this.readCardStatsMap(cardRoot);
      if (read.kind === 'corrupt') {
        log.warn(
          `[stats] card stats at "${cardRoot}" unreadable — skipping card copy for id=${id} to avoid clobbering siblings`,
        );
        return;
      }
      const games: Record<string, Stats> = read.kind === 'map' ? { ...read.games } : {};
      games[id] = stats;
      const map = { schemaVersion: 1 as const, games };
      await writeFileAtomic(target, JSON.stringify(map, null, 2));
      log.info(`[stats] wrote card copy id=${id} → "${target}"`);
    } catch (cause) {
      log.error(`[stats] FAILED to write card copy id=${id} → "${target}":`, cause);
    }
  }
}
