// RAWG provider: url building, the thumbnail resize pattern, answer parsing, and the "no key → no
// source" rule. Fixtures only — no test reaches rawg.io.
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, type FetchResponse } from '../src/main/metadata/http';
import {
  RawgProvider,
  rawgCandidateKey,
  rawgIdFromKey,
  screenshotsUrl,
  searchUrl,
  thumbUrl,
  toArtworkOffers,
} from '../src/main/metadata/rawg';

const SEARCH_FIXTURE = JSON.stringify({
  count: 2,
  results: [
    {
      id: 41494,
      name: 'The Witcher 3: Wild Hunt',
      background_image: 'https://media.rawg.io/media/games/618/61833.jpg',
    },
    { id: 3498, name: 'Grand Theft Auto V', background_image: null },
  ],
});

const SHOTS_FIXTURE = JSON.stringify({
  count: 2,
  results: [
    {
      id: 11,
      image: 'https://media.rawg.io/media/screenshots/abc/one.jpg',
      width: 1920,
      height: 1080,
    },
    { id: 12, image: 'https://media.rawg.io/media/screenshots/abc/two.jpg' },
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
  routes: (url: string) => FetchResponse = () => textResponse('{}'),
): { provider: RawgProvider; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async (url: string) => routes(url));
  const http = new HttpClient({ fetch, userAgent: 'Playhook/test' });
  return { provider: new RawgProvider({ http, apiKey: () => key }), fetch };
}

describe('rawg provider', () => {
  describe('urls', () => {
    it('escapes both the term and the key', () => {
      expect(searchUrl('Hades II', 'k e y')).toBe(
        'https://api.rawg.io/api/games?search=Hades%20II&page_size=10&key=k%20e%20y',
      );
    });

    it('addresses screenshots by the game id', () => {
      expect(screenshotsUrl(41494, 'secret')).toBe(
        'https://api.rawg.io/api/games/41494/screenshots?key=secret',
      );
    });

    it('round-trips an id through its key', () => {
      expect(rawgIdFromKey(rawgCandidateKey(41494))).toBe(41494);
      expect(rawgIdFromKey('steam:220')).toBeUndefined();
    });
  });

  describe('thumbnails', () => {
    it('asks the media host for a scaled copy rather than the full-size image', () => {
      expect(thumbUrl('https://media.rawg.io/media/screenshots/abc/one.jpg')).toBe(
        'https://media.rawg.io/media/resize/640/-/screenshots/abc/one.jpg',
      );
    });

    it('leaves a URL that is already resized alone', () => {
      const resized = 'https://media.rawg.io/media/resize/420/-/screenshots/abc/one.jpg';
      expect(thumbUrl(resized)).toBe(resized);
    });

    it('passes through anything that is not on the media host — the pattern is undocumented', () => {
      const other = 'https://cdn.example.test/one.jpg';
      expect(thumbUrl(other)).toBe(other);
    });
  });

  describe('without a key', () => {
    it('reports itself unavailable', () => {
      expect(providerOf('  ').provider.available()).toBe(false);
      expect(providerOf('abc').provider.available()).toBe(true);
    });

    it('answers an empty search without making a request at all', async () => {
      const { provider, fetch } = providerOf('');
      await expect(provider.search('witcher')).resolves.toEqual({ ok: true, value: [] });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('offers no artwork and makes no request', async () => {
      const { provider, fetch } = providerOf('');
      await expect(provider.artwork({ key: 'rawg:1', title: 'x' }, 'hero')).resolves.toEqual({
        ok: true,
        value: [],
      });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('with a key', () => {
    it('parses a search answer into candidates carrying the rawg id', async () => {
      const { provider } = providerOf('secret', () => textResponse(SEARCH_FIXTURE));
      const result = await provider.search('witcher');
      expect(result.ok === true && result.value[0]).toEqual({
        key: 'rawg:41494',
        title: 'The Witcher 3: Wild Hunt',
        provider: 'rawg',
        rawgId: 41494,
      });
    });

    it('turns screenshots into offers, keeping the dimensions RAWG states', () => {
      const offers = toArtworkOffers(41494, [
        {
          id: 11,
          image: 'https://media.rawg.io/media/screenshots/abc/one.jpg',
          width: 1920,
          height: 1080,
        },
        { id: 12, image: 'https://media.rawg.io/media/screenshots/abc/two.jpg' },
      ]);
      expect(offers[0]).toEqual({
        key: 'rawg:41494:shot-11',
        kind: 'hero',
        provider: 'rawg',
        width: 1920,
        height: 1080,
        thumbUrl: 'https://media.rawg.io/media/resize/640/-/screenshots/abc/one.jpg',
        fullUrl: 'https://media.rawg.io/media/screenshots/abc/one.jpg',
      });
      expect(offers[1]).not.toHaveProperty('width');
    });

    it("leads the gallery with the game's own background image, kept from the search", async () => {
      const { provider } = providerOf('secret', (url) =>
        textResponse(url.includes('/screenshots') ? SHOTS_FIXTURE : SEARCH_FIXTURE),
      );
      await provider.search('witcher');
      const result = await provider.artwork(
        { key: 'rawg:41494', title: 'The Witcher 3', rawgId: 41494 },
        'hero',
      );
      expect(result.ok === true && result.value.map((v) => v.key)).toEqual([
        'rawg:41494:backdrop',
        'rawg:41494:shot-11',
        'rawg:41494:shot-12',
      ]);
    });

    it('offers only the screenshots for a game whose search never came through here', async () => {
      const { provider } = providerOf('secret', () => textResponse(SHOTS_FIXTURE));
      const result = await provider.artwork(
        { key: 'steam:292030', title: 'The Witcher 3', steamAppId: 292030, rawgId: 41494 },
        'hero',
      );
      expect(result.ok === true && result.value.map((v) => v.key)).toEqual([
        'rawg:41494:shot-11',
        'rawg:41494:shot-12',
      ]);
    });

    it('offers no covers — that is what Steam and SteamGridDB are for', async () => {
      const { provider, fetch } = providerOf('secret', () => textResponse(SHOTS_FIXTURE));
      const result = await provider.artwork(
        { key: 'rawg:41494', title: 'x', rawgId: 41494 },
        'grid',
      );
      expect(result).toEqual({ ok: true, value: [] });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('has nothing to offer for a candidate RAWG does not know', async () => {
      const { provider, fetch } = providerOf('secret', () => textResponse(SHOTS_FIXTURE));
      const result = await provider.artwork({ key: 'gog:123', title: 'x', gogId: '123' }, 'hero');
      expect(result).toEqual({ ok: true, value: [] });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('reports a rejected key as a failure rather than as an empty gallery', async () => {
      const { provider } = providerOf('bad', () => textResponse('{"error":"invalid"}', 401));
      const result = await provider.search('witcher');
      expect(result.ok).toBe(false);
    });
  });
});
