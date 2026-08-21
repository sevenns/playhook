// GOG provider: the catalogue search, the screenshot formatters, and the fact that backgrounds cost no
// second request. Fixtures only — no test reaches gog.com.
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, type FetchResponse } from '../src/main/metadata/http';
import {
  GogProvider,
  gogCandidateKey,
  gogIdFromKey,
  searchUrl,
  toArtworkOffers,
  withFormatter,
} from '../src/main/metadata/gog';

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
      );
      expect(result.ok === true && result.value).toHaveLength(2);
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
      );
      expect(result.ok === true && result.value).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('has nothing to offer for a game GOG does not sell', async () => {
      const { provider, fetch } = providerOf();
      const result = await provider.artwork(
        { key: 'steam:220', title: 'HL2', steamAppId: 220 },
        'hero',
      );
      expect(result).toEqual({ ok: true, value: [] });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('offers no covers — GOG covers are the wrong proportions for the launcher card', async () => {
      const { provider, fetch } = providerOf();
      const result = await provider.artwork(
        { key: 'gog:1207658691', title: 'x', gogId: '1207658691' },
        'grid',
      );
      expect(result).toEqual({ ok: true, value: [] });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('yields nothing for a product the catalogue lists with no screenshots', async () => {
      const { provider } = providerOf();
      await provider.search('witcher');
      const result = await provider.artwork(
        { key: 'gog:1207666393', title: 'The Witcher', gogId: '1207666393' },
        'hero',
      );
      expect(result).toEqual({ ok: true, value: [] });
    });
  });
});
