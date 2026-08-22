// GOG provider: the catalogue search, the screenshot formatters, and the fact that backgrounds cost no
// second request. Fixtures only — no test reaches gog.com.
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, type FetchResponse } from '../src/main/metadata/http';
import {
  GogProvider,
  gogCandidateKey,
  gogIdFromKey,
  searchUrl,
  titleMatches,
  toArtworkOffers,
  toDetails,
  toIsoDate,
  toPlatforms,
  withFormatter,
} from '../src/main/metadata/gog';

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

const CATALOG_FIXTURE = JSON.stringify({
  products: [
    {
      id: '1207658691',
      slug: 'the_witcher_3_wild_hunt',
      title: 'The Witcher 3: Wild Hunt',
      screenshots: [
        'https://images.gog-statics.com/aaa_{formatter}.jpg',
        'https://images.gog-statics.com/bbb_{formatter}.jpg',
      ],
    },
    { id: '1207666393', slug: 'the_witcher', title: 'The Witcher', screenshots: [] },
  ],
});

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

function providerOf(routes: (url: string) => FetchResponse = () => textResponse(CATALOG_FIXTURE)): {
  provider: GogProvider;
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetch = vi.fn(async (url: string) => routes(url));
  const http = new HttpClient({ fetch, userAgent: 'Playhook/test' });
  return { provider: new GogProvider({ http }), fetch };
}

describe('gog facts kept for a future library view', () => {
  it('normalizes the dotted catalogue date to ISO', () => {
    expect(toIsoDate('2017.02.24')).toBe('2017-02-24');
    expect(toIsoDate('2017')).toBe('2017');
    expect(toIsoDate('soon')).toBeUndefined();
    expect(toIsoDate(undefined)).toBeUndefined();
  });

  it("maps GOG's osx onto the same platform Steam calls mac", () => {
    expect(toPlatforms(['windows', 'linux', 'osx'])).toEqual(['windows', 'linux', 'mac']);
  });

  it('drops an operating system it does not know', () => {
    expect(toPlatforms(['windows', 'amiga'])).toEqual(['windows']);
    expect(toPlatforms([])).toBeUndefined();
    expect(toPlatforms(undefined)).toBeUndefined();
  });

  it('states no description — the catalogue answer carries none', () => {
    const details = toDetails({
      id: '1',
      title: 'Hollow Knight',
      screenshots: [],
      genres: [{ name: 'Metroidvania' }],
      releaseDate: '2017.02.24',
      operatingSystems: ['windows', 'linux'],
    });
    expect(details).toEqual({
      genres: ['Metroidvania'],
      releaseDate: '2017-02-24',
      platforms: ['windows', 'linux'],
    });
  });
});

describe('gog provider', () => {
  describe('urls and keys', () => {
    it('searches the catalogue with the like: prefix the endpoint expects', () => {
      expect(searchUrl('Witcher 3')).toBe(
        'https://catalog.gog.com/v1/catalog?query=like%3AWitcher%203&limit=10',
      );
    });

    it('round-trips a product id through its key, keeping it a string', () => {
      expect(gogIdFromKey(gogCandidateKey('1207658691'))).toBe('1207658691');
      expect(gogIdFromKey('steam:220')).toBeUndefined();
    });

    it('fills the formatter into a screenshot template', () => {
      expect(withFormatter('https://images.gog-statics.com/x_{formatter}.jpg', 'ggvgm')).toBe(
        'https://images.gog-statics.com/x_ggvgm.jpg',
      );
    });

    it('leaves a URL with no placeholder as it is rather than dropping it', () => {
      const plain = 'https://images.gog-statics.com/x.jpg';
      expect(withFormatter(plain, 'ggvgm')).toBe(plain);
    });
  });

  describe('search', () => {
    it('parses the catalogue answer into candidates carrying the product id', async () => {
      const { provider } = providerOf();
      const result = await provider.search('witcher');
      expect(result.ok === true && result.value[0]).toEqual({
        key: 'gog:1207658691',
        title: 'The Witcher 3: Wild Hunt',
        provider: 'gog',
        gogId: '1207658691',
      });
    });

    it('reports a moved-on answer shape as a failure, not as an empty catalogue', async () => {
      const { provider } = providerOf(() => textResponse('<html>maintenance</html>'));
      expect((await provider.search('witcher')).ok).toBe(false);
    });
  });

  // The catalogue's `like:` matches DESCRIPTIONS AND TAGS, not titles: measured against the live API,
  // `like:Watch Dogs` (a game GOG does not sell) answered with "The Signal From Tölva", "Din's Curse"
  // and five more, and `like:cyberpunk` answered with RoboCop and Mirror's Edge beside Cyberpunk 2077.
  describe('only the products whose NAME answers the query become candidates', () => {
    it('keeps the game and its editions', () => {
      expect(titleMatches('Cyberpunk 2077', 'Cyberpunk 2077')).toBe(true);
      expect(titleMatches('Cyberpunk 2077: Phantom Liberty', 'Cyberpunk 2077')).toBe(true);
      expect(titleMatches('The Witcher 3: Wild Hunt - Complete Edition', 'The Witcher 3')).toBe(
        true,
      );
    });

    it('drops what merely shares a tag or a word of the description', () => {
      expect(titleMatches('The Signal From Tölva', 'Watch Dogs')).toBe(false);
      expect(titleMatches("Din's Curse", 'Watch Dogs')).toBe(false);
      expect(titleMatches('RoboCop: Rogue City', 'Cyberpunk 2077')).toBe(false);
      expect(titleMatches('The Pedestrian Soundtrack', 'Hades')).toBe(false);
    });

    it('drops another game of the same series — a missing word is a different game', () => {
      expect(titleMatches('Sniper Elite V2 Remastered', 'Sniper Elite 5')).toBe(false);
    });

    it('ignores the articles and the marks stores sprinkle differently', () => {
      expect(titleMatches('Witcher 3: Wild Hunt', 'The Witcher 3')).toBe(true);
      expect(titleMatches('Watch Dogs', 'Watch_Dogs™')).toBe(true);
    });

    it('filters the candidates a search answers with', async () => {
      const { provider } = providerOf(() =>
        textResponse(
          JSON.stringify({
            products: [
              { id: '1', title: 'The Witcher 3: Wild Hunt', screenshots: [] },
              { id: '2', title: "Din's Curse", screenshots: [] },
            ],
          }),
        ),
      );
      const result = await provider.search('The Witcher 3');
      expect(result.ok === true && result.value.map((c) => c.title)).toEqual([
        'The Witcher 3: Wild Hunt',
      ]);
    });

    // The filter is about the MENU. A candidate that came from another source keeps its GOG pictures:
    // they are reached by product id, and the id was cached while the answer was still whole.
    it('still offers the pictures of a product the filter kept out of the menu', async () => {
      const { provider } = providerOf(() =>
        textResponse(
          JSON.stringify({
            products: [
              {
                id: '9',
                title: 'Some Other Spelling',
                screenshots: ['https://images.gog-statics.com/x_{formatter}.jpg'],
              },
            ],
          }),
        ),
      );
      await provider.search('The Witcher 3');
      const art = await provider.artwork(
        { key: 'steam:1', title: 'The Witcher 3', gogId: '9' },
        'hero',
        pageRequest(),
      );
      expect(art.ok === true && art.value.offers).toHaveLength(1);
    });
  });

  describe('backgrounds', () => {
    it('uses the small formatter for the grid and the true 1920x1080 one for the download', () => {
      const offers = toArtworkOffers({
        id: '1207658691',
        title: 'The Witcher 3: Wild Hunt',
        screenshots: ['https://images.gog-statics.com/aaa_{formatter}.jpg'],
      });
      expect(offers[0]).toEqual({
        key: 'gog:1207658691:shot-0',
        kind: 'hero',
        provider: 'gog',
        width: 1920,
        height: 1080,
        thumbUrl: 'https://images.gog-statics.com/aaa_ggvgm.jpg',
        fullUrl: 'https://images.gog-statics.com/aaa_ggvgl_2x.jpg',
      });
    });

    it('answers from what the search already returned, with no second request', async () => {
      const { provider, fetch } = providerOf();
      await provider.search('witcher');
      const calls = fetch.mock.calls.length;
      const result = await provider.artwork(
        { key: 'gog:1207658691', title: 'The Witcher 3', gogId: '1207658691' },
        'hero',
        pageRequest(),
      );
      expect(result.ok === true && result.value.offers).toHaveLength(2);
      expect(fetch.mock.calls.length).toBe(calls);
    });

    it('fetches by title for a candidate merged in from another source', async () => {
      const { provider, fetch } = providerOf();
      const result = await provider.artwork(
        {
          key: 'steam:292030',
          title: 'The Witcher 3: Wild Hunt',
          steamAppId: 292030,
          gogId: '1207658691',
        },
        'hero',
        pageRequest(),
      );
      expect(result.ok === true && result.value.offers).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('has nothing to offer for a game GOG does not sell', async () => {
      const { provider, fetch } = providerOf();
      const result = await provider.artwork(
        { key: 'steam:220', title: 'HL2', steamAppId: 220 },
        'hero',
        pageRequest(),
      );
      expect(result).toEqual({ ok: true, value: { offers: [], hasMore: false } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('offers no covers — GOG covers are the wrong proportions for the launcher card', async () => {
      const { provider, fetch } = providerOf();
      const result = await provider.artwork(
        { key: 'gog:1207658691', title: 'x', gogId: '1207658691' },
        'grid',
        pageRequest(),
      );
      expect(result).toEqual({ ok: true, value: { offers: [], hasMore: false } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('yields nothing for a product the catalogue lists with no screenshots', async () => {
      const { provider } = providerOf();
      await provider.search('witcher');
      const result = await provider.artwork(
        { key: 'gog:1207666393', title: 'The Witcher', gogId: '1207666393' },
        'hero',
        pageRequest(),
      );
      expect(result).toEqual({ ok: true, value: { offers: [], hasMore: false } });
    });
  });
});
