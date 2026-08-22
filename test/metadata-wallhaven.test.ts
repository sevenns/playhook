// Wallhaven provider: the search parameters, the edition-tail cascade that keeps an AND-search from
// coming back empty, and the file-size filter. Fixtures only — no test reaches wallhaven.cc.
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, type FetchResponse } from '../src/main/metadata/http';
import {
  WallhavenProvider,
  hasMorePages,
  isLatinTitle,
  searchTerms,
  searchUrl,
  toArtworkOffers,
  withoutEditionTail,
} from '../src/main/metadata/wallhaven';

/** What a page request looks like now: the page, plus the size floor the sidebar's filter sets. */
function pageRequest(
  page = 0,
  minSize = { width: 0, height: 0 },
): {
  readonly page: number;
  readonly minSize: { readonly width: number; readonly height: number };
} {
  return { page, minSize };
}

const RESULTS = JSON.stringify({
  data: [
    {
      id: 'abc123',
      path: 'https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg',
      file_size: 2_400_000,
      dimension_x: 3840,
      dimension_y: 2160,
      thumbs: { small: 'https://th.wallhaven.cc/small/ab/abc123.jpg' },
    },
    {
      id: 'def456',
      path: 'https://w.wallhaven.cc/full/de/wallhaven-def456.png',
      file_size: 40_000_000,
      dimension_x: 3840,
      dimension_y: 2160,
      thumbs: { small: 'https://th.wallhaven.cc/small/de/def456.jpg' },
    },
  ],
});

const EMPTY = JSON.stringify({ data: [] });

function textResponse(text: string, status = 200): FetchResponse {
  const chunks = [new TextEncoder().encode(text)];
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true };
          const value = chunks[index]!;
          index += 1;
          return { done: false, value };
        },
        cancel: async () => undefined,
      }),
    },
  };
}

/** `english: null` stands for "no English name is known" — undefined would take the default. */
function providerOf(
  routes: (url: string) => FetchResponse,
  english: string | null = 'Hades',
): { provider: WallhavenProvider; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async (url: string) => routes(url));
  const http = new HttpClient({ fetch, userAgent: 'Playhook/test' });
  return {
    provider: new WallhavenProvider({ http, englishTitle: () => english ?? undefined }),
    fetch,
  };
}

/** The `q` a request was made with, so a test can assert the cascade rather than a whole URL. */
function queriesOf(fetch: ReturnType<typeof vi.fn>): string[] {
  return fetch.mock.calls.map((call) => {
    const url = new URL(String(call[0]));
    return url.searchParams.get('q') ?? '';
  });
}

describe('wallhaven search parameters', () => {
  const params = new URL(searchUrl('Hades')).searchParams;

  it('asks for SFW general and anime wallpapers, with people switched off', () => {
    expect(params.get('categories')).toBe('110');
    expect(params.get('purity')).toBe('100');
  });

  it('asks for landscape wallpapers of at least 1080p', () => {
    expect(params.get('atleast')).toBe('1920x1080');
  });

  // The endpoint matches listed ratios EXACTLY: '16x9,16x10' dropped a 4096x2286 wallpaper for being
  // 1.79 instead of 1.78, which cost most of the choice for anything but the most photographed games.
  it('asks for landscape as a shape, not as a list of exact ratios', () => {
    expect(params.get('ratios')).toBe('landscape');
  });

  it('sorts by relevance, so the gallery keeps its order within a session', () => {
    expect(params.get('sorting')).toBe('relevance');
  });

  it('escapes the query', () => {
    expect(new URL(searchUrl('The Witcher 3: Wild Hunt')).searchParams.get('q')).toBe(
      'The Witcher 3: Wild Hunt',
    );
  });
});

describe('wallhaven paging', () => {
  it('counts pages from one, where the endpoint does', () => {
    expect(new URL(searchUrl('Hades')).searchParams.get('page')).toBe('1');
    expect(new URL(searchUrl('Hades', 2)).searchParams.get('page')).toBe('3');
  });

  it('offers another page only when the answer says one exists', () => {
    expect(hasMorePages({ current_page: 1, last_page: 7 })).toBe(true);
    expect(hasMorePages({ current_page: 7, last_page: 7 })).toBe(false);
    expect(hasMorePages(undefined)).toBe(false);
  });
});

describe('wallhaven edition tails', () => {
  it('cuts the edition markers Steam titles carry', () => {
    expect(withoutEditionTail('The Witcher 3: Wild Hunt - Complete Edition')).toBe(
      'The Witcher 3: Wild Hunt',
    );
    expect(withoutEditionTail('Disco Elysium - The Final Cut')).toBe('Disco Elysium');
    expect(withoutEditionTail('Dark Souls Remastered')).toBe('Dark Souls');
    expect(withoutEditionTail('Skyrim Game of the Year Edition')).toBe('Skyrim');
  });

  it('keeps a subtitle that is part of the name', () => {
    expect(withoutEditionTail('The Witcher 3: Wild Hunt')).toBe('The Witcher 3: Wild Hunt');
    expect(withoutEditionTail('Hades')).toBe('Hades');
  });

  it('never cuts a title down to nothing', () => {
    expect(withoutEditionTail('Remastered')).toBe('Remastered');
    expect(withoutEditionTail('Final Fantasy')).toBe('Final Fantasy');
  });

  it('offers the full title first and the trimmed one as a fallback', () => {
    expect(searchTerms('Disco Elysium - The Final Cut')).toEqual([
      'Disco Elysium - The Final Cut',
      'Disco Elysium',
    ]);
  });

  it('keeps the part before a subtitle as the last resort', () => {
    expect(searchTerms('The Witcher 3: Wild Hunt')).toEqual([
      'The Witcher 3: Wild Hunt',
      'The Witcher 3',
    ]);
  });

  it('offers a single term when there is nothing to trim', () => {
    expect(searchTerms('Hades')).toEqual(['Hades']);
  });

  it('has nothing to search for an empty title', () => {
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('wallhaven titles it can search at all', () => {
  it('accepts Latin titles', () => {
    expect(isLatinTitle('The Witcher 3')).toBe(true);
    expect(isLatinTitle('Ōkami HD')).toBe(true);
  });

  it('rejects the scripts whose words its tags do not carry', () => {
    expect(isLatinTitle('Ведьмак 3')).toBe(false);
    expect(isLatinTitle('原神')).toBe(false);
  });
});

describe('wallhaven offers', () => {
  it('takes the ready-made thumbnail and the full-size path, with the stated dimensions', () => {
    const offers = toArtworkOffers([
      {
        id: 'abc123',
        path: 'https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg',
        file_size: 2_400_000,
        dimension_x: 3840,
        dimension_y: 2160,
        thumbs: { small: 'https://th.wallhaven.cc/small/ab/abc123.jpg' },
      },
    ]);
    expect(offers[0]).toEqual({
      key: 'wallhaven:abc123',
      kind: 'hero',
      provider: 'wallhaven',
      width: 3840,
      height: 2160,
      thumbUrl: 'https://th.wallhaven.cc/small/ab/abc123.jpg',
      fullUrl: 'https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg',
    });
  });

  it('drops a wallpaper too heavy to apply, rather than offering a tile that would fail', () => {
    const offers = toArtworkOffers(
      JSON.parse(RESULTS).data as Parameters<typeof toArtworkOffers>[0],
    );
    expect(offers.map((offer) => offer.key)).toEqual(['wallhaven:abc123']);
  });
});

describe('wallhaven provider', () => {
  it('searches by the English name, not by the localized candidate title', async () => {
    const { provider, fetch } = providerOf(() => textResponse(RESULTS), 'Hades');
    await provider.artwork(
      { key: 'steam:1145360', title: 'Аид', steamAppId: 1145360 },
      'hero',
      pageRequest(),
    );
    expect(queriesOf(fetch)).toEqual(['Hades']);
  });

  it('falls back to the candidate title when it is already Latin', async () => {
    const { provider, fetch } = providerOf(() => textResponse(RESULTS), null);
    await provider.artwork(
      { key: 'gog:1', title: 'Hollow Knight', gogId: '1' },
      'hero',
      pageRequest(),
    );
    expect(queriesOf(fetch)).toEqual(['Hollow Knight']);
  });

  it('does not search at all for a title it can only spell in another script', async () => {
    const { provider, fetch } = providerOf(() => textResponse(RESULTS), null);
    const result = await provider.artwork(
      { key: 'steam:1', title: 'Ведьмак 3' },
      'hero',
      pageRequest(),
    );
    expect(result).toEqual({ ok: true, value: { offers: [], hasMore: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries without the edition tail when the full title finds nothing', async () => {
    const { provider, fetch } = providerOf(
      (url) => textResponse(url.includes('Complete') ? EMPTY : RESULTS),
      'The Witcher 3: Wild Hunt - Complete Edition',
    );
    const result = await provider.artwork(
      { key: 'steam:292030', title: 'x' },
      'hero',
      pageRequest(),
    );
    expect(queriesOf(fetch)).toEqual([
      'The Witcher 3: Wild Hunt - Complete Edition',
      'The Witcher 3: Wild Hunt',
    ]);
    expect(result.ok === true && result.value.offers).toHaveLength(1);
  });

  it('stops at the first term that finds something', async () => {
    const { provider, fetch } = providerOf(
      () => textResponse(RESULTS),
      'Disco Elysium - The Final Cut',
    );
    await provider.artwork({ key: 'steam:632470', title: 'x' }, 'hero', pageRequest());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports nothing found as an empty gallery, not as an error', async () => {
    const { provider } = providerOf(() => textResponse(EMPTY), 'Some Niche Indie');
    expect(await provider.artwork({ key: 'steam:1', title: 'x' }, 'hero', pageRequest())).toEqual({
      ok: true,
      value: { offers: [], hasMore: false },
    });
  });

  it('reports a failing endpoint as a failure', async () => {
    const { provider } = providerOf(() => textResponse('', 429), 'Hades');
    expect((await provider.artwork({ key: 'steam:1', title: 'x' }, 'hero', pageRequest())).ok).toBe(
      false,
    );
  });

  it('pages through the term that answered, not through the cascade again', async () => {
    const { provider, fetch } = providerOf(
      (url) => textResponse(url.includes('Complete') ? EMPTY : RESULTS),
      'The Witcher 3: Wild Hunt - Complete Edition',
    );
    const ref = { key: 'steam:292030', title: 'x' };
    await provider.artwork(ref, 'hero', pageRequest());
    fetch.mockClear();
    await provider.artwork(ref, 'hero', pageRequest(1));
    expect(queriesOf(fetch)).toEqual(['The Witcher 3: Wild Hunt']);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('page')).toBe('2');
  });

  it('reports a later page as the last one when the answer states no more', async () => {
    const { provider } = providerOf(() => textResponse(RESULTS), 'Hades');
    const result = await provider.artwork({ key: 'steam:1', title: 'x' }, 'hero', pageRequest());
    expect(result.ok === true && result.value.hasMore).toBe(false);
  });

  it('offers no covers — it is a wallpaper source', async () => {
    const { provider, fetch } = providerOf(() => textResponse(RESULTS), 'Hades');
    expect(await provider.artwork({ key: 'steam:1', title: 'x' }, 'grid', pageRequest())).toEqual({
      ok: true,
      value: { offers: [], hasMore: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
