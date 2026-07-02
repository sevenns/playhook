import { describe, expect, it } from 'vitest';
import { mergeStats } from '../src/main/stats';
import type { Stats } from '../src/shared/types';

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
