// The history index's rules (ordering / eviction / upsert) — the pure half of the carousel feature.
// Everything here is fs-free by construction (see src/main/library-index.ts).
import { describe, expect, it } from 'vitest';
import {
  EMPTY_LIBRARY_INDEX,
  evictBeyond,
  orderForCarousel,
  removeEntry,
  upsertEntry,
  type LibraryEntryRecord,
  type LibraryIndex,
} from '../src/main/library-index';

function entry(id: string, overrides: Partial<LibraryEntryRecord> = {}): LibraryEntryRecord {
  return {
    id,
    title: id.toUpperCase(),
    hero: [],
    savedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
    launchCount: 1,
    lastPlayedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function indexOf(...entries: readonly LibraryEntryRecord[]): LibraryIndex {
  return { schemaVersion: 1, entries };
}

describe('upsertEntry', () => {
  it('appends a new record', () => {
    const { index, replacedForeign } = upsertEntry(EMPTY_LIBRARY_INDEX, entry('a'));
    expect(index.entries.map((e) => e.id)).toEqual(['a']);
    expect(replacedForeign).toBe(false);
  });

  it('replaces in place, keeping the position (idempotent for an unchanged record)', () => {
    const before = indexOf(entry('a'), entry('b'), entry('c'));
    const { index, replacedForeign } = upsertEntry(before, entry('b', { launchCount: 7 }));
    expect(index.entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(index.entries[1]?.launchCount).toBe(7);
    expect(replacedForeign).toBe(false);
  });

  it('flags a replacement that carries a different title (an id collision between two cards)', () => {
    const before = indexOf(entry('a', { title: 'Alpha' }));
    const { replacedForeign } = upsertEntry(before, entry('a', { title: 'Another game' }));
    expect(replacedForeign).toBe(true);
  });

  it('does NOT flag changed asset bytes under the same title (the author edited their own card)', () => {
    const before = indexOf(entry('a', { title: 'Alpha', sourceSig: '111:222' }));
    const { replacedForeign } = upsertEntry(
      before,
      entry('a', { title: 'Alpha', sourceSig: '999:222' }),
    );
    expect(replacedForeign).toBe(false);
  });
});

describe('removeEntry', () => {
  it('drops the id and leaves the rest untouched', () => {
    const index = removeEntry(indexOf(entry('a'), entry('b')), 'a');
    expect(index.entries.map((e) => e.id)).toEqual(['b']);
  });
});

describe('evictBeyond', () => {
  it('does nothing while the index fits the limit', () => {
    const before = indexOf(entry('a'), entry('b'));
    const { index, evicted } = evictBeyond(before, 2);
    expect(evicted).toEqual([]);
    expect(index).toBe(before);
  });

  it('evicts a record with no date at all FIRST (never played, never seen since the field existed)', () => {
    const before = indexOf(
      entry('played-old', { lastPlayedAt: '2020-01-01T00:00:00.000Z' }),
      entry('undated', { launchCount: 0, lastPlayedAt: null, savedAt: '2026-08-01T00:00:00.000Z' }),
      entry('played-new', { lastPlayedAt: '2026-08-01T00:00:00.000Z' }),
    );
    const { index, evicted } = evictBeyond(before, 2);
    expect(evicted).toEqual(['undated']);
    expect(index.entries.map((e) => e.id)).toEqual(['played-old', 'played-new']);
  });

  // The carousel sorts by the same date, so a freshly inserted card must not be the first thing thrown
  // away while it sits at the top of the strip.
  it('keeps a recently inserted but never-played game over an old played one', () => {
    const before = indexOf(
      entry('played-long-ago', {
        lastPlayedAt: '2020-01-01T00:00:00.000Z',
        lastSeenAt: '2020-01-01T00:00:00.000Z',
      }),
      entry('inserted-yesterday', {
        launchCount: 0,
        lastPlayedAt: null,
        lastSeenAt: '2026-08-10T00:00:00.000Z',
      }),
    );
    const { evicted } = evictBeyond(before, 1);
    expect(evicted).toEqual(['played-long-ago']);
  });

  it('then evicts the least recently played', () => {
    const before = indexOf(
      entry('old', { lastPlayedAt: '2020-01-01T00:00:00.000Z' }),
      entry('mid', { lastPlayedAt: '2023-01-01T00:00:00.000Z' }),
      entry('new', { lastPlayedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const { index, evicted } = evictBeyond(before, 1);
    expect(evicted).toEqual(['old', 'mid']);
    expect(index.entries.map((e) => e.id)).toEqual(['new']);
  });

  it('never evicts a game on the inserted card, even the weakest one', () => {
    const before = indexOf(
      entry('orphan-active', { launchCount: 0, lastPlayedAt: null }),
      entry('played', { lastPlayedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const { index, evicted } = evictBeyond(before, 1, ['orphan-active']);
    expect(evicted).toEqual(['played']);
    expect(index.entries.map((e) => e.id)).toEqual(['orphan-active']);
  });

  it('keeps a protected over-limit index intact rather than evicting a protected id', () => {
    const before = indexOf(entry('a'), entry('b'));
    const { index, evicted } = evictBeyond(before, 1, ['a', 'b']);
    expect(evicted).toEqual([]);
    expect(index.entries).toHaveLength(2);
  });
});

describe('orderForCarousel', () => {
  it('puts the inserted card first, then history — each group by lastPlayedAt desc', () => {
    const entries = [
      entry('history-old', { lastPlayedAt: '2020-01-01T00:00:00.000Z' }),
      entry('card-old', { lastPlayedAt: '2021-01-01T00:00:00.000Z' }),
      entry('history-new', { lastPlayedAt: '2026-01-01T00:00:00.000Z' }),
      entry('card-new', { lastPlayedAt: '2026-06-01T00:00:00.000Z' }),
    ];
    // The card's ids are passed OLDEST first: the group is ordered by date, not by that argument.
    const order = orderForCarousel(entries, ['card-old', 'card-new']);
    expect(order.map((e) => e.id)).toEqual(['card-new', 'card-old', 'history-new', 'history-old']);
  });

  it('sends a never-played card game to the END of its group, not ahead of a played one', () => {
    const entries = [
      entry('never', { launchCount: 0, lastPlayedAt: null }),
      entry('played', { lastPlayedAt: '2026-01-01T00:00:00.000Z' }),
      entry('history', { lastPlayedAt: '2025-01-01T00:00:00.000Z' }),
    ];
    const order = orderForCarousel(entries, ['never', 'played']);
    expect(order.map((e) => e.id)).toEqual(['played', 'never', 'history']);
  });

  it('breaks equal dates by title, so the order is stable', () => {
    const same = '2026-01-01T00:00:00.000Z';
    const entries = [
      entry('z', { title: 'Zeta', lastPlayedAt: same }),
      entry('a', { title: 'Alpha', lastPlayedAt: same }),
    ];
    expect(orderForCarousel(entries, []).map((e) => e.id)).toEqual(['a', 'z']);
  });

  // The history is "everything this device has seen", played or not — it is ordered by the last time the
  // game was available, and hiding a game you had yesterday would contradict that very date.
  it('keeps a never-played history entry, ordered by when its card was last inserted', () => {
    const entries = [
      entry('played-long-ago', {
        lastPlayedAt: '2020-01-01T00:00:00.000Z',
        lastSeenAt: '2020-01-01T00:00:00.000Z',
      }),
      entry('seen-yesterday', {
        launchCount: 0,
        lastPlayedAt: null,
        lastSeenAt: '2026-08-10T00:00:00.000Z',
      }),
    ];
    expect(orderForCarousel(entries, []).map((e) => e.id)).toEqual([
      'seen-yesterday',
      'played-long-ago',
    ]);
  });

  // The two dates are a MAXIMUM, not a replacement: a game played today stays on top even though its
  // card has not been re-inserted since.
  it('ranks a game played today above one merely inserted today', () => {
    const entries = [
      entry('played-today', {
        lastPlayedAt: '2026-08-11T12:00:00.000Z',
        lastSeenAt: '2024-01-01T00:00:00.000Z',
      }),
      entry('seen-today', {
        launchCount: 0,
        lastPlayedAt: null,
        lastSeenAt: '2026-08-11T09:00:00.000Z',
      }),
    ];
    expect(orderForCarousel(entries, []).map((e) => e.id)).toEqual(['played-today', 'seen-today']);
  });

  it('ignores an active id that has no record yet (assets are still being copied)', () => {
    const order = orderForCarousel([entry('played')], ['not-copied-yet']);
    expect(order.map((e) => e.id)).toEqual(['played']);
  });
});
