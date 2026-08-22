// SteamGridDB provider: url building, answer parsing, and the "no key → no source" rule.
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, type FetchInit, type FetchResponse } from '../src/main/metadata/http';
import {
  SteamGridDbProvider,
  autocompleteUrl,
  coversUrl,
  sgdbCandidateKey,
  sgdbGameIdFromKey,
  toArtworkOffers,
} from '../src/main/metadata/steamgriddb';

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

const SEARCH_FIXTURE = JSON.stringify({
  success: true,
  data: [
    { id: 5250, name: 'Hollow Knight' },
    { id: 5251, name: 'Hollow Knight: Silksong' },
  ],
});

const GRIDS_FIXTURE = JSON.stringify({
  success: true,
  data: [
    {
      id: 81,
      url: 'https://cdn.test/grid-81.png',
      thumb: 'https://cdn.test/t81.jpg',
      width: 600,
      height: 900,
    },
    { id: 82, url: 'https://cdn.test/grid-82.png', thumb: 'https://cdn.test/t82.jpg' },
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

function providerOf(
  key: string,
  routes: (url: string, init?: FetchInit) => FetchResponse = () => textResponse('{}'),
): { provider: SteamGridDbProvider; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async (url: string, init?: FetchInit) => routes(url, init));
  const http = new HttpClient({ fetch, userAgent: 'Playhook/test' });
  return { provider: new SteamGridDbProvider({ http, apiKey: () => key }), fetch };
}

describe('steamgriddb metadata provider', () => {
  describe('urls', () => {
    it('escapes the search term', () => {
      expect(autocompleteUrl('Hollow Knight')).toBe(
        'https://www.steamgriddb.com/api/v2/search/autocomplete/Hollow%20Knight',
      );
    });

    it("asks for covers in the launcher's own geometry", () => {
      expect(coversUrl({ kind: 'game', id: 5250 })).toBe(
        'https://www.steamgriddb.com/api/v2/grids/game/5250?dimensions=600x900',
      );
    });

    it('addresses a Steam candidate by its appid, with no extra lookup', () => {
      expect(coversUrl({ kind: 'steam', id: 220 })).toBe(
        'https://www.steamgriddb.com/api/v2/grids/steam/220?dimensions=600x900',
      );
    });

    it('round-trips a game id through its key', () => {
      expect(sgdbGameIdFromKey(sgdbCandidateKey(5250))).toBe(5250);
      expect(sgdbGameIdFromKey('steam:220')).toBeUndefined();
    });
  });

  describe('without a key', () => {
    it('reports itself unavailable', () => {
      expect(providerOf('   ').provider.available()).toBe(false);
      expect(providerOf('abc').provider.available()).toBe(true);
    });

    it('answers an empty search without making a request at all', async () => {
      const { provider, fetch } = providerOf('');
      await expect(provider.search('anything')).resolves.toEqual({ ok: true, value: [] });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('offers no artwork and makes no request', async () => {
      const { provider, fetch } = providerOf('');
      await expect(
        provider.artwork({ key: 'sgdb:1', title: 'x' }, 'grid', pageRequest()),
      ).resolves.toEqual({
        ok: true,
        value: { offers: [], hasMore: false },
      });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('with a key', () => {
    it("authorizes with the user's key", async () => {
      const { provider, fetch } = providerOf('secret', () => textResponse(SEARCH_FIXTURE));
      await provider.search('hollow');
      expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer secret' });
    });

    it('parses the autocomplete answer into candidates', async () => {
      const { provider } = providerOf('secret', () => textResponse(SEARCH_FIXTURE));
      const result = await provider.search('hollow');
      expect(result.ok === true && result.value[0]).toEqual({
        key: 'sgdb:5250',
        title: 'Hollow Knight',
        provider: 'steamgriddb',
      });
    });

    it('turns art rows into offers, keeping the dimensions the source states', () => {
      const offers = toArtworkOffers([
        {
          id: 81,
          url: 'https://cdn.test/a.png',
          thumb: 'https://cdn.test/t.jpg',
          width: 600,
          height: 900,
        },
        { id: 82, url: 'https://cdn.test/b.png', thumb: 'https://cdn.test/u.jpg' },
      ]);
      expect(offers[0]).toEqual({
        key: 'sgdb:art:81',
        kind: 'grid',
        provider: 'steamgriddb',
        width: 600,
        height: 900,
        thumbUrl: 'https://cdn.test/t.jpg',
        fullUrl: 'https://cdn.test/a.png',
      });
      expect(offers[1]).not.toHaveProperty('width');
    });

    it('offers no backgrounds at all — its heroes are banners, not full-screen art', async () => {
      const { provider, fetch } = providerOf('secret', () => textResponse(GRIDS_FIXTURE));
      const result = await provider.artwork(
        { key: 'steam:220', title: 'HL2', steamAppId: 220 },
        'hero',
        pageRequest(),
      );
      expect(result).toEqual({ ok: true, value: { offers: [], hasMore: false } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('fetches art for a Steam candidate through the steam endpoint', async () => {
      const { provider, fetch } = providerOf('secret', () => textResponse(GRIDS_FIXTURE));
      const result = await provider.artwork(
        { key: 'steam:220', title: 'HL2', steamAppId: 220 },
        'grid',
        pageRequest(),
      );
      expect(fetch.mock.calls[0]?.[0]).toContain('/grids/steam/220');
      expect(result.ok === true && result.value.offers).toHaveLength(2);
    });

    it('reports a rejected key as a failure rather than as an empty gallery', async () => {
      const { provider } = providerOf('bad', () => textResponse('{"success":false}', 401));
      const result = await provider.artwork(
        { key: 'sgdb:5250', title: 'HK' },
        'grid',
        pageRequest(),
      );
      expect(result.ok).toBe(false);
    });
  });
});
