// The library's artwork cache is the only thing standing between a grid of hundreds and main, which
// generates every cover synchronously on first request. Its two bounds — the LRU and the request queue —
// are pure logic, and neither would ever fail loudly: a broken queue just makes a Deck stutter.
import { describe, expect, it, vi } from 'vitest';
import { artKey, createCardArtCache } from '../src/renderer/card-art';

/** A requestGrid whose promises are resolved by hand, so the queue can be inspected mid-flight. */
function deferredGrid(): {
  requestGrid: (id: string) => Promise<string | null>;
  calls: string[];
  settle: (id: string, url: string | null) => Promise<void>;
} {
  const calls: string[] = [];
  const pending = new Map<string, (url: string | null) => void>();
  return {
    calls,
    requestGrid: (id) => {
      calls.push(id);
      return new Promise<string | null>((resolve) => pending.set(id, resolve));
    },
    settle: async (id, url) => {
      pending.get(id)?.(url);
      pending.delete(id);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('artKey', () => {
  it('keys by id AND artwork revision, so a re-copied cover misses the cache', () => {
    expect(artKey({ id: 'g', title: 'g', active: true, artRev: '7' })).toBe('g@7');
    expect(artKey({ id: 'g', title: 'g', active: true })).not.toBe('g@7');
  });
});

describe('createCardArtCache', () => {
  it('reports an unknown key as undefined and a game with no cover as null', async () => {
    const cache = createCardArtCache({ requestGrid: () => Promise.resolve(null) });
    expect(cache.get('a@')).toBeUndefined();
    await cache.load('a@', 'a');
    expect(cache.get('a@')).toBeNull();
  });

  it('asks for a cover once, however often the slot is loaded', async () => {
    const grid = deferredGrid();
    const cache = createCardArtCache(grid);
    const first = cache.load('a@', 'a');
    const second = cache.load('a@', 'a');
    await grid.settle('a', 'data:a');
    expect(await first).toBe('data:a');
    expect(await second).toBe('data:a');
    await cache.load('a@', 'a');
    expect(grid.calls).toEqual(['a']);
  });

  it('evicts the oldest entry and tells the host about it', async () => {
    const evicted: string[] = [];
    const cache = createCardArtCache({ requestGrid: (id) => Promise.resolve(`data:${id}`) }, 2);
    cache.onEvict((key) => evicted.push(key));
    await cache.load('a@', 'a');
    await cache.load('b@', 'b');
    await cache.load('c@', 'c');
    expect(evicted).toEqual(['a@']);
    expect(cache.get('a@')).toBeUndefined();
    expect(cache.get('c@')).toBe('data:c');
  });

  it('counts a read as freshness — the entry just looked at is not the one thrown out', async () => {
    const evicted: string[] = [];
    const cache = createCardArtCache({ requestGrid: (id) => Promise.resolve(`data:${id}`) }, 2);
    cache.onEvict((key) => evicted.push(key));
    await cache.load('a@', 'a');
    await cache.load('b@', 'b');
    cache.get('a@');
    await cache.load('c@', 'c');
    expect(evicted).toEqual(['b@']);
    expect(cache.get('a@')).toBe('data:a');
  });

  it('keeps at most `concurrency` requests in flight and serves the backlog newest-first', async () => {
    const grid = deferredGrid();
    const cache = createCardArtCache(grid, 100, 2);
    for (const id of ['a', 'b', 'c', 'd']) void cache.load(`${id}@`, id);
    expect(grid.calls).toEqual(['a', 'b']);
    // 'c' and 'd' waited: the freed slot goes to the one asked for LAST, which is the card the selection
    // has just reached rather than the one it left behind.
    await grid.settle('a', 'data:a');
    expect(grid.calls).toEqual(['a', 'b', 'd']);
  });

  it('frees the slot when a request rejects, instead of jamming the queue', async () => {
    const failing = vi
      .fn<(id: string) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('ipc is gone'))
      .mockResolvedValue('data:b');
    const cache = createCardArtCache({ requestGrid: failing }, 100, 1);
    expect(await cache.load('a@', 'a')).toBeNull();
    expect(await cache.load('b@', 'b')).toBe('data:b');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('drops the queued requests that left the window, and keeps the started ones', async () => {
    const grid = deferredGrid();
    const cache = createCardArtCache(grid, 100, 1);
    const started = cache.load('a@', 'a');
    const kept = cache.load('b@', 'b');
    const dropped = cache.load('c@', 'c');
    cache.dropPending(new Set(['b@']));
    expect(await dropped).toBeNull();
    await grid.settle('a', 'data:a');
    expect(await started).toBe('data:a');
    expect(grid.calls).toEqual(['a', 'b']);
    await grid.settle('b', 'data:b');
    expect(await kept).toBe('data:b');
    expect(grid.calls).not.toContain('c');
  });

  it('lets a dropped key be asked for again when it comes back into the window', async () => {
    const grid = deferredGrid();
    const cache = createCardArtCache(grid, 100, 1);
    void cache.load('a@', 'a');
    void cache.load('b@', 'b');
    cache.dropPending(new Set());
    void cache.load('b@', 'b');
    await grid.settle('a', 'data:a');
    expect(grid.calls).toEqual(['a', 'b']);
  });
});
