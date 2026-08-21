// Steam provider: URL building, answer parsing and description sanitizing. Fixtures only — the HTTP
// client is faked, so the unofficial endpoints are never actually called from a test.
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, type FetchInit, type FetchResponse } from '../src/main/metadata/http';
import {
  SteamProvider,
  appDetailsUrl,
  libraryGridUrl,
  sanitizeDescription,
  toAppArt,
  steamAppIdFromKey,
  steamCandidateKey,
  storeSearchUrl,
  toCandidates,
} from '../src/main/metadata/steam';

const SEARCH_FIXTURE = JSON.stringify({
  total: 3,
  items: [
    { type: 'app', name: 'Half-Life 2', id: 220 },
    { type: 'app', name: 'Half-Life 2: Episode One', id: 380 },
    { type: 'bundle', name: 'Half-Life Collection', id: 999 },
  ],
});

const ART_DETAILS = JSON.stringify({
  '220': {
    success: true,
    data: {
      name: 'Half-Life 2',
      background_raw: 'https://cdn.test/220/page-bg.jpg',
      screenshots: [
        {
          id: 1,
          path_thumbnail: 'https://cdn.test/220/shot1-thumb.jpg',
          path_full: 'https://cdn.test/220/shot1.1920x1080.jpg',
        },
        {
          id: 2,
          path_thumbnail: 'https://cdn.test/220/shot2-thumb.jpg',
          path_full: 'https://cdn.test/220/shot2.1920x1080.jpg',
        },
      ],
    },
  },
});

const DETAILS_EN = JSON.stringify({
  '220': {
    success: true,
    data: { name: 'Half-Life 2', short_description: '<strong>1998.</strong> A&nbsp;war.' },
  },
});
const DETAILS_RU = JSON.stringify({
  '220': { success: true, data: { name: 'Half-Life 2', short_description: 'Война.' } },
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
  routes: (url: string, init?: FetchInit) => FetchResponse,
  locale: 'en' | 'ru' = 'en',
): SteamProvider {
  const http = new HttpClient({
    fetch: async (url, init) => routes(url, init),
    userAgent: 'Playhook/test',
  });
  return new SteamProvider({ http, locale: () => locale });
}

describe('steam metadata provider', () => {
  describe('urls', () => {
    it('searches with the English store parameters by default', () => {
      expect(storeSearchUrl('Half-Life 2', 'en')).toBe(
        'https://store.steampowered.com/api/storesearch/?term=Half-Life%202&l=english&cc=US',
      );
    });

    it('searches the Russian store for a Russian UI, so Russian titles are findable', () => {
      expect(storeSearchUrl('Мор', 'ru')).toBe(
        'https://store.steampowered.com/api/storesearch/?term=%D0%9C%D0%BE%D1%80&l=russian&cc=RU',
      );
    });

    it('builds the appdetails url per language', () => {
      expect(appDetailsUrl(220, 'ru')).toBe(
        'https://store.steampowered.com/api/appdetails?appids=220&l=russian',
      );
    });

    it('builds the CDN cover urls from the appid', () => {
      expect(libraryGridUrl(220)).toBe(
        'https://cdn.cloudflare.steamstatic.com/steam/apps/220/library_600x900.jpg',
      );
      expect(libraryGridUrl(220, true)).toBe(
        'https://cdn.cloudflare.steamstatic.com/steam/apps/220/library_600x900_2x.jpg',
      );
    });
  });

  describe('candidate keys', () => {
    it('round-trips an appid through its key', () => {
      expect(steamAppIdFromKey(steamCandidateKey(220))).toBe(220);
    });

    it("does not claim another provider's key", () => {
      expect(steamAppIdFromKey('sgdb:1234')).toBeUndefined();
      expect(steamAppIdFromKey('steam:not-a-number')).toBeUndefined();
    });
  });

  describe('search', () => {
    it('keeps apps and drops non-app store entries', () => {
      const candidates = toCandidates([
        { id: 220, name: 'Half-Life 2', type: 'app' },
        { id: 999, name: 'Bundle', type: 'bundle' },
      ]);
      expect(candidates).toEqual([
        { key: 'steam:220', title: 'Half-Life 2', provider: 'steam', steamAppId: 220 },
      ]);
    });

    it('parses a real-shaped storesearch answer', async () => {
      const provider = providerOf(() => textResponse(SEARCH_FIXTURE));
      const result = await provider.search('half-life');
      expect(result.ok === true && result.value.map((c) => c.steamAppId)).toEqual([220, 380]);
    });

    it('reports a broken answer as a failure instead of throwing', async () => {
      const provider = providerOf(() => textResponse('<html>maintenance</html>'));
      const result = await provider.search('half-life');
      expect(result.ok).toBe(false);
    });
  });

  describe('artwork', () => {
    it('offers only the variants whose full-size file exists', async () => {
      const provider = providerOf((url, init) => {
        if (init?.method === 'HEAD') {
          return textResponse('', url.includes('_2x') ? 404 : 200);
        }
        return textResponse('{}');
      });
      const result = await provider.artwork(
        { key: 'steam:220', title: 'Half-Life 2', steamAppId: 220 },
        'grid',
      );
      expect(result.ok === true && result.value.map((v) => v.key)).toEqual(['steam:220:grid']);
    });

    it('offers the store backdrop first, then the screenshots in the order Steam lists them', async () => {
      const provider = providerOf(() => textResponse(ART_DETAILS));
      const result = await provider.artwork(
        { key: 'steam:220', title: 'HL2', steamAppId: 220 },
        'hero',
      );
      expect(result.ok === true && result.value.map((v) => v.key)).toEqual([
        'steam:220:backdrop',
        'steam:220:shot-1',
        'steam:220:shot-2',
      ]);
    });

    it("takes a screenshot's thumbnail for the grid and its full size for the download", async () => {
      const provider = providerOf(() => textResponse(ART_DETAILS));
      const result = await provider.artwork(
        { key: 'steam:220', title: 'HL2', steamAppId: 220 },
        'hero',
      );
      expect(result.ok === true && result.value[1]).toMatchObject({
        thumbUrl: 'https://cdn.test/220/shot1-thumb.jpg',
        fullUrl: 'https://cdn.test/220/shot1.1920x1080.jpg',
      });
    });

    it('states no dimensions for a screenshot — the path says nothing about the real size', async () => {
      const provider = providerOf(() => textResponse(ART_DETAILS));
      const result = await provider.artwork(
        { key: 'steam:220', title: 'HL2', steamAppId: 220 },
        'hero',
      );
      const shot = result.ok === true ? result.value[1] : undefined;
      expect(shot).not.toHaveProperty('width');
      expect(shot).not.toHaveProperty('height');
    });

    it('never checks a background for existence — the URL came from the answer itself', async () => {
      const fetch = vi.fn(async (_url: string, init?: FetchInit) => {
        expect(init?.method).not.toBe('HEAD');
        return textResponse(ART_DETAILS);
      });
      const http = new HttpClient({ fetch, userAgent: 'Playhook/test' });
      const provider = new SteamProvider({ http, locale: () => 'en' });
      await provider.artwork({ key: 'steam:220', title: 'HL2', steamAppId: 220 }, 'hero');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('has no backgrounds for a delisted app, whose appdetails answers success:false', async () => {
      const provider = providerOf(() => textResponse('{"220":{"success":false}}'));
      const result = await provider.artwork(
        { key: 'steam:220', title: 'HL2', steamAppId: 220 },
        'hero',
      );
      expect(result).toEqual({ ok: true, value: [] });
    });

    it('asks appdetails once per app, however often the gallery is opened', async () => {
      let detailCalls = 0;
      const provider = providerOf(() => {
        detailCalls += 1;
        return textResponse(ART_DETAILS);
      });
      const ref = { key: 'steam:220', title: 'HL2', steamAppId: 220 };
      await provider.artwork(ref, 'hero');
      await provider.artwork(ref, 'hero');
      expect(detailCalls).toBe(1);
    });

    it('has nothing to offer for a candidate that is not a Steam app', async () => {
      const provider = providerOf(() => textResponse('', 200));
      const result = await provider.artwork({ key: 'sgdb:7', title: 'Some game' }, 'grid');
      expect(result).toEqual({ ok: true, value: [] });
    });
  });

  describe('reading the art fields of an appdetails answer', () => {
    const answer = JSON.parse(ART_DETAILS) as Parameters<typeof toAppArt>[0];

    it('takes the backdrop and every screenshot that has a full size', () => {
      const art = toAppArt(answer, 220);
      expect(art.backdrop).toBe('https://cdn.test/220/page-bg.jpg');
      expect(art.screenshots.map((shot) => shot.id)).toEqual([1, 2]);
    });

    it('falls back to the full size when a screenshot states no thumbnail', () => {
      const noThumb = {
        '220': { success: true, data: { screenshots: [{ id: 5, path_full: 'f.jpg' }] } },
      };
      expect(toAppArt(noThumb, 220).screenshots[0]).toEqual({
        id: 5,
        thumb: 'f.jpg',
        full: 'f.jpg',
      });
    });

    it('drops a screenshot with no full size — that is the picture apply would download', () => {
      const noFull = {
        '220': { success: true, data: { screenshots: [{ id: 5, path_thumbnail: 't.jpg' }] } },
      };
      expect(toAppArt(noFull, 220).screenshots).toEqual([]);
    });

    it('reads nothing at all out of an unsuccessful answer', () => {
      expect(toAppArt({ '220': { success: false } }, 220)).toEqual({ screenshots: [] });
    });
  });

  describe('descriptions', () => {
    it('strips store markup, decodes entities and collapses whitespace', () => {
      expect(sanitizeDescription('<p>Hello   <br>  <b>world</b> &amp; friends</p>')).toBe(
        'Hello world & friends',
      );
    });

    it('cuts an overlong description on a word boundary', () => {
      const long = `${'word '.repeat(600)}tail`;
      const cut = sanitizeDescription(long);
      expect(cut.length).toBeLessThanOrEqual(2000);
      expect(cut.endsWith('word')).toBe(true);
    });

    it('fetches both languages and returns them side by side', async () => {
      const provider = providerOf((url) =>
        textResponse(url.includes('russian') ? DETAILS_RU : DETAILS_EN),
      );
      const result = await provider.descriptions({
        key: 'steam:220',
        title: 'HL2',
        steamAppId: 220,
      });
      expect(result).toEqual({ ok: true, value: { en: '1998. A war.', ru: 'Война.' } });
    });

    it('keeps the language that answered when the other one fails', async () => {
      const provider = providerOf((url) =>
        url.includes('russian') ? textResponse('', 500) : textResponse(DETAILS_EN),
      );
      const result = await provider.descriptions({
        key: 'steam:220',
        title: 'HL2',
        steamAppId: 220,
      });
      expect(result).toEqual({ ok: true, value: { en: '1998. A war.' } });
    });

    it('omits a language Steam has no text for', async () => {
      const empty = JSON.stringify({ '220': { success: false } });
      const provider = providerOf((url) =>
        textResponse(url.includes('russian') ? empty : DETAILS_EN),
      );
      const result = await provider.descriptions({
        key: 'steam:220',
        title: 'HL2',
        steamAppId: 220,
      });
      expect(result).toEqual({ ok: true, value: { en: '1998. A war.' } });
    });
  });
});
