import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeStats, StatsService } from '../src/main/stats';
import { CARD_STATS_FILENAME, type Stats } from '../src/shared/types';
import type { PcStore } from '../src/main/pc-store';

const base: Stats = { schemaVersion: 1, totalPlaySeconds: 0, launchCount: 0, lastPlayedAt: null };

describe('mergeStats', () => {
  it('takes the max per cumulative field (never loses progress)', () => {
    const a: Stats = { ...base, totalPlaySeconds: 100, launchCount: 3 };
    const b: Stats = { ...base, totalPlaySeconds: 250, launchCount: 2 };
    const merged = mergeStats(a, b);
    expect(merged.totalPlaySeconds).toBe(250);
    expect(merged.launchCount).toBe(3);
    expect(merged.schemaVersion).toBe(1);
  });

  it('is commutative for cumulative fields', () => {
    const a: Stats = { ...base, totalPlaySeconds: 100, launchCount: 3 };
    const b: Stats = { ...base, totalPlaySeconds: 250, launchCount: 2 };
    expect(mergeStats(a, b).totalPlaySeconds).toBe(mergeStats(b, a).totalPlaySeconds);
    expect(mergeStats(a, b).launchCount).toBe(mergeStats(b, a).launchCount);
  });

  it('keeps the more recent lastPlayedAt', () => {
    const older: Stats = { ...base, lastPlayedAt: '2026-01-01T00:00:00.000Z' };
    const newer: Stats = { ...base, lastPlayedAt: '2026-06-01T00:00:00.000Z' };
    expect(mergeStats(older, newer).lastPlayedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(mergeStats(newer, older).lastPlayedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('treats null lastPlayedAt as "never" (loses to any real date)', () => {
    const withDate: Stats = { ...base, lastPlayedAt: '2026-01-01T00:00:00.000Z' };
    expect(mergeStats(base, withDate).lastPlayedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(mergeStats(base, base).lastPlayedAt).toBeNull();
  });
});

// A minimal in-memory PcStore — StatsService only touches readStats/writeStats.
function makeStore(): { store: PcStore; map: Map<string, Stats> } {
  const map = new Map<string, Stats>();
  const store = {
    async readStats(id: string): Promise<Stats> {
      return map.get(id) ?? { ...base };
    },
    async writeStats(id: string, stats: Stats): Promise<void> {
      map.set(id, stats);
    },
  } as unknown as PcStore;
  return { store, map };
}

function stats(totalPlaySeconds: number, launchCount: number): Stats {
  return { schemaVersion: 1, totalPlaySeconds, launchCount, lastPlayedAt: null };
}

describe('card stats — per-id map (multi-game cards)', () => {
  let cardRoot: string;
  const cardFile = (): string => join(cardRoot, CARD_STATS_FILENAME);

  beforeEach(() => {
    cardRoot = mkdtempSync(join(tmpdir(), 'playhook-cardstats-'));
  });
  afterEach(() => {
    rmSync(cardRoot, { recursive: true, force: true });
  });

  it('classifies absent / map / legacy / corrupt files', async () => {
    const { store } = makeStore();
    const svc = new StatsService(store);

    expect((await svc.readCardStatsMap(cardRoot)).kind).toBe('empty');

    writeFileSync(cardFile(), JSON.stringify(stats(120, 2))); // old bare-Stats format
    expect((await svc.readCardStatsMap(cardRoot)).kind).toBe('legacy');

    writeFileSync(cardFile(), JSON.stringify({ schemaVersion: 1, games: { a: stats(5, 1) } }));
    const asMap = await svc.readCardStatsMap(cardRoot);
    expect(asMap.kind).toBe('map');

    writeFileSync(cardFile(), '{ not valid json');
    expect((await svc.readCardStatsMap(cardRoot)).kind).toBe('corrupt');
  });

  it('copyToCard writes a per-id map and preserves siblings (isolation)', async () => {
    const { store } = makeStore();
    const svc = new StatsService(store);

    await svc.copyToCard(cardRoot, 'game-a', stats(100, 4));
    await svc.copyToCard(cardRoot, 'game-b', stats(50, 2));

    const written = JSON.parse(readFileSync(cardFile(), 'utf8')) as {
      games: Record<string, Stats>;
    };
    expect(written.games['game-a']?.totalPlaySeconds).toBe(100);
    expect(written.games['game-b']?.totalPlaySeconds).toBe(50);

    // Rewriting B must not disturb A.
    await svc.copyToCard(cardRoot, 'game-b', stats(999, 9));
    const after = JSON.parse(readFileSync(cardFile(), 'utf8')) as { games: Record<string, Stats> };
    expect(after.games['game-a']?.totalPlaySeconds).toBe(100);
    expect(after.games['game-b']?.totalPlaySeconds).toBe(999);
  });

  it('reconcile does NOT leak one game\'s stats into another (no cross-contamination)', async () => {
    const { store } = makeStore();
    const svc = new StatsService(store);
    // Card holds only game A's stats.
    writeFileSync(cardFile(), JSON.stringify({ schemaVersion: 1, games: { 'game-a': stats(300, 6) } }));

    // Reconciling game B (no entry) leaves B at its PC baseline (zero), NOT game A's 300s.
    const reconciledB = await svc.reconcileWithCard('game-b', cardRoot);
    expect(reconciledB.totalPlaySeconds).toBe(0);

    // Game A still reconciles to its own value.
    const reconciledA = await svc.reconcileWithCard('game-a', cardRoot);
    expect(reconciledA.totalPlaySeconds).toBe(300);
  });

  it('migrates a legacy bare-Stats file for a single-game card via the legacy fallback', async () => {
    const { store } = makeStore();
    const svc = new StatsService(store);
    writeFileSync(cardFile(), JSON.stringify(stats(240, 5))); // legacy bare format

    const read = await svc.readCardStatsMap(cardRoot);
    expect(read.kind).toBe('legacy');
    const legacy = read.kind === 'legacy' ? read.stats : null;

    // loadCard would attribute the legacy stats to the sole game; reconcile merges them in.
    const merged = await svc.reconcileWithCard('only-game', cardRoot, legacy);
    expect(merged.totalPlaySeconds).toBe(240);
    // A subsequent copy upgrades the card to the per-id map.
    await svc.copyToCard(cardRoot, 'only-game', merged);
    const written = JSON.parse(readFileSync(cardFile(), 'utf8')) as { games?: Record<string, Stats> };
    expect(written.games?.['only-game']?.totalPlaySeconds).toBe(240);
  });

  it('does NOT clobber a corrupt existing file on copy (best-effort skip)', async () => {
    const { store } = makeStore();
    const svc = new StatsService(store);
    writeFileSync(cardFile(), 'totally broken not json');
    await svc.copyToCard(cardRoot, 'game-a', stats(10, 1));
    // The corrupt file is left untouched (we skip rather than wipe unreadable siblings).
    expect(readFileSync(cardFile(), 'utf8')).toBe('totally broken not json');
  });
});
