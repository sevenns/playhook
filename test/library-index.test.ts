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

function entry(
  id: string,
  overrides: Partial<LibraryEntryRecord> = {},
): LibraryEntryRecord {
  return {
    id,
    title: id.toUpperCase(),
    hero: [],
    sounds: {},
    savedAt: '2026-01-01T00:00:00.000Z',
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

  it('flags a replacement whose source signature changed', () => {
    const before = indexOf(entry('a', { sourceSig: '111:222' }));
    const { replacedForeign } = upsertEntry(before, entry('a', { sourceSig: '999:222' }));
    expect(replacedForeign).toBe(true);
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

  it('evicts never-played orphans FIRST, even when they are the newest records', () => {
    const before = indexOf(
      entry('played-old', { lastPlayedAt: '2020-01-01T00:00:00.000Z' }),
      entry('orphan', { launchCount: 0, lastPlayedAt: null, savedAt: '2026-08-01T00:00:00.000Z' }),
      entry('played-new', { lastPlayedAt: '2026-08-01T00:00:00.000Z' }),
    );
    const { index, evicted } = evictBeyond(before, 2);
    expect(evicted).toEqual(['orphan']);
    expect(index.entries.map((e) => e.id)).toEqual(['played-old', 'played-new']);
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
  it('puts the inserted card first IN CARD ORDER, then history by lastPlayedAt desc', () => {
    const entries = [
      entry('history-old', { lastPlayedAt: '2020-01-01T00:00:00.000Z' }),
      entry('card-b'),
      entry('history-new', { lastPlayedAt: '2026-01-01T00:00:00.000Z' }),
      entry('card-a'),
    ];
    const order = orderForCarousel(entries, ['card-a', 'card-b']);
    expect(order.map((e) => e.id)).toEqual(['card-a', 'card-b', 'history-new', 'history-old']);
  });

  it('breaks equal dates by title, so the order is stable', () => {
    const same = '2026-01-01T00:00:00.000Z';
    const entries = [
      entry('z', { title: 'Zeta', lastPlayedAt: same }),
      entry('a', { title: 'Alpha', lastPlayedAt: same }),
    ];
    expect(orderForCarousel(entries, []).map((e) => e.id)).toEqual(['a', 'z']);
  });

  it('hides never-played history entries but keeps a never-played ACTIVE game', () => {
    const entries = [
      entry('orphan', { launchCount: 0, lastPlayedAt: null }),
      entry('fresh-card-game', { launchCount: 0, lastPlayedAt: null }),
      entry('played'),
    ];
    const order = orderForCarousel(entries, ['fresh-card-game']);
    expect(order.map((e) => e.id)).toEqual(['fresh-card-game', 'played']);
  });

  it('ignores an active id that has no record yet (assets are still being copied)', () => {
    const order = orderForCarousel([entry('played')], ['not-copied-yet']);
    expect(order.map((e) => e.id)).toEqual(['played']);
  });
});
