// Wallpaper Cave provider: the two page shapes it must accept (a list of albums, and the album page a
// strong match redirects to), album selection, and the per-file filters read out of the markup.
// Fixtures only — no test reaches wallpapercave.com.
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, type FetchResponse } from '../src/main/metadata/http';
import {
  WallpaperCaveProvider,
  absoluteUrl,
  isMobileAlbum,
  parseAlbums,
  parseWallpapers,
  rankAlbums,
  searchUrl,
  toArtworkOffers,
  type CaveWallpaper,
} from '../src/main/metadata/wallpapercave';

/** The search page as it comes back for an ambiguous query: album cards, each one anchor with a title. */
const SEARCH_PAGE = `
<div class="albumthumb">
  <a href="/atomfall-wallpapers" title="27 wallpapers in Atomfall" title="27 wallpapers in Atomfall">
    <img class="albumthumbimg" src="/uwp/wp1.jpg">
  </a>
</div>
<div class="albumthumb">
  <a href="/atomfall-phone-wallpapers" title="18 wallpapers in Atomfall Phone"></a>
</div>
<div class="albumthumb">
  <a href="/atomfall-fan-art-wallpapers" title="9 wallpapers in Atomfall Fan Art"></a>
</div>
<div class="albumthumb">
  <a href="/cellphone-atomfall-wallpapers" title="12 wallpapers in Cellphone Atomfall"></a>
</div>
<a href="/">Home</a>
`;

/** An album page: every wallpaper at once, each stating its own size. */
const ALBUM_PAGE = `
<img class="wimg" src="/wp/wp111.webp" width="1920" height="1080" loading="lazy">
<img class="wimg" src="/wp/wp222.jpg" width="2560" height="1440" loading="lazy">
<img class="wimg" src="/wp/wp333.png" width="3840" height="2160" loading="lazy">
<img class="wimg" src="/wp/wp444.jpg" width="1242" height="2688" loading="lazy">
<img class="sidebar" src="/wp/wp555.jpg" width="1920" height="1080">
`;

const SECOND_ALBUM_PAGE = `
<img class="wimg" src="/wp/wp111.webp" width="1920" height="1080">
<img class="wimg" src="/wp/iee9mCb.jpg" width="1600" height="900">
`;

/** Four albums, so a page of three leaves one behind — what "load more" is there to reach. */
const SEARCH_PAGE_MANY = `
<a href="/atomfall-wallpapers" title="27 wallpapers in Atomfall"></a>
<a href="/atomfall-2-wallpapers" title="20 wallpapers in Atomfall 2"></a>
<a href="/atomfall-3-wallpapers" title="15 wallpapers in Atomfall 3"></a>
<a href="/atomfall-4-wallpapers" title="10 wallpapers in Atomfall 4"></a>
`;

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
  english: string | null = 'Atomfall',
): { provider: WallpaperCaveProvider; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async (url: string) => routes(url));
  const http = new HttpClient({ fetch, userAgent: 'Playhook/test' });
  return {
    provider: new WallpaperCaveProvider({ http, englishTitle: () => english ?? undefined }),
    fetch,
  };
}

function urlsOf(fetch: ReturnType<typeof vi.fn>): string[] {
  return fetch.mock.calls.map((call) => String(call[0]));
}

function paper(file: string, width?: number, height?: number): CaveWallpaper {
  return {
    url: `https://wallpapercave.com/wp/${file}`,
    file,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

describe('wallpapercave search page', () => {
  it('reads every album link, with the count the title states', () => {
    const albums = parseAlbums(SEARCH_PAGE);
    expect(albums).toContainEqual({ path: '/atomfall-wallpapers', title: 'Atomfall', count: 27 });
    expect(albums).toHaveLength(4);
  });

  it('offers an album once even though its anchor carries the title attribute twice', () => {
    expect(parseAlbums(SEARCH_PAGE).filter((a) => a.path === '/atomfall-wallpapers')).toHaveLength(
      1,
    );
  });

  it('takes no album from an album page — that is what tells the two shapes apart', () => {
    expect(parseAlbums(ALBUM_PAGE)).toEqual([]);
  });
});

describe('wallpapercave album choice', () => {
  it('drops phone albums, including the ones no word match would catch', () => {
    expect(isMobileAlbum('/atomfall-phone-wallpapers')).toBe(true);
    expect(isMobileAlbum('/cellphone-atomfall-wallpapers')).toBe(true);
    expect(isMobileAlbum('/android-atomfall-wallpapers')).toBe(true);
    expect(isMobileAlbum('/atomfall-4k-phone-wallpapers')).toBe(true);
    expect(isMobileAlbum('/atomfall-wallpapers')).toBe(false);
  });

  it('puts the album whose name matches the query first, then the fuller ones', () => {
    const ranked = rankAlbums(parseAlbums(SEARCH_PAGE), 'Atomfall');
    expect(ranked.map((album) => album.path)).toEqual([
      '/atomfall-wallpapers',
      '/atomfall-fan-art-wallpapers',
    ]);
  });

  it('ranks by how much an album holds when the names match equally well', () => {
    const albums = [
      { path: '/a-wallpapers', title: 'Something Else', count: 4 },
      { path: '/b-wallpapers', title: 'Another Thing', count: 40 },
    ];
    expect(rankAlbums(albums, 'Atomfall').map((album) => album.path)).toEqual([
      '/b-wallpapers',
      '/a-wallpapers',
    ]);
  });
});

describe('wallpapercave album page', () => {
  it('reads the pictures with their stated sizes and ignores the rest of the markup', () => {
    const wallpapers = parseWallpapers(ALBUM_PAGE);
    expect(wallpapers.map((paper) => paper.file)).toEqual([
      'wp111.webp',
      'wp222.jpg',
      'wp333.png',
      'wp444.jpg',
    ]);
    expect(wallpapers[0]).toEqual({
      url: 'https://wallpapercave.com/wp/wp111.webp',
      file: 'wp111.webp',
      width: 1920,
      height: 1080,
    });
  });

  it('makes every form of src absolute', () => {
    expect(absoluteUrl('/wp/wp1.jpg')).toBe('https://wallpapercave.com/wp/wp1.jpg');
    expect(absoluteUrl('//w.test/wp1.jpg')).toBe('https://w.test/wp1.jpg');
    expect(absoluteUrl('https://w.test/wp1.jpg')).toBe('https://w.test/wp1.jpg');
  });
});

describe('wallpapercave offers', () => {
  it('serves the same file as the tile and as the full size', () => {
    const offers = toArtworkOffers([paper('wp111.webp', 1920, 1080)]);
    expect(offers[0]).toEqual({
      key: 'wallpapercave:wp111.webp',
      kind: 'hero',
      provider: 'wallpapercave',
      width: 1920,
      height: 1080,
      thumbUrl: 'https://wallpapercave.com/wp/wp111.webp',
      fullUrl: 'https://wallpapercave.com/wp/wp111.webp',
    });
  });

  it('drops portrait pictures — a phone shot behind a 16:10 screen is a ribbon', () => {
    const offers = toArtworkOffers([paper('a.jpg', 1242, 2688), paper('b.jpg', 1920, 1080)]);
    expect(offers.map((offer) => offer.key)).toEqual(['wallpapercave:b.jpg']);
  });

  it('offers a picture once when two albums both carry it', () => {
    const offers = toArtworkOffers([
      paper('wp111.webp', 1920, 1080),
      paper('wp111.webp', 1920, 1080),
    ]);
    expect(offers).toHaveLength(1);
  });

  it('takes the sizes the Deck can use before the 4K ones', () => {
    const offers = toArtworkOffers([
      paper('big.png', 3840, 2160),
      paper('hd.jpg', 1920, 1080),
      paper('qhd.jpg', 2560, 1440),
    ]);
    expect(offers.map((offer) => offer.key)).toEqual([
      'wallpapercave:qhd.jpg',
      'wallpapercave:hd.jpg',
      'wallpapercave:big.png',
    ]);
  });

  // The gallery's page size lives in the service now (MAX_ARTWORK_PER_PROVIDER); what does not fit on a
  // page is kept for the next one, so a source that trimmed its own answer would hide pictures for good.
  it('offers everything it parsed, leaving the page size to the service', () => {
    const many = Array.from({ length: 30 }, (_, index) => paper(`wp${index}.jpg`, 1920, 1080));
    expect(toArtworkOffers(many)).toHaveLength(30);
  });
});

describe('wallpapercave provider', () => {
  it('searches by the English name and opens the album the search listed', async () => {
    const { provider, fetch } = providerOf((url) =>
      textResponse(url.includes('/search') ? SEARCH_PAGE : ALBUM_PAGE),
    );
    const result = await provider.artwork({ key: 'steam:1', title: 'Атомфолл' }, 'hero', 0);
    expect(urlsOf(fetch)[0]).toBe(searchUrl('Atomfall'));
    expect(urlsOf(fetch)[1]).toBe('https://wallpapercave.com/atomfall-wallpapers');
    expect(result.ok === true && result.value.offers.map((offer) => offer.key)).toEqual([
      'wallpapercave:wp222.jpg',
      'wallpapercave:wp111.webp',
      'wallpapercave:wp333.png',
    ]);
  });

  // A strong match answers 302 straight to the album; the client follows it silently, so the page that
  // comes back for a search URL is the album's. Getting this wrong would blind the best-covered games.
  it('takes the album page the search redirected to, without asking for anything else', async () => {
    const { provider, fetch } = providerOf(() => textResponse(ALBUM_PAGE));
    const result = await provider.artwork({ key: 'steam:1', title: 'Atomfall' }, 'hero', 0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.ok === true && result.value.offers).toHaveLength(3);
  });

  it('collects from several albums and offers a shared picture once', async () => {
    const pages: Readonly<Record<string, string>> = {
      '/atomfall-wallpapers': SECOND_ALBUM_PAGE,
      '/atomfall-fan-art-wallpapers': SECOND_ALBUM_PAGE,
    };
    const { provider } = providerOf((url) => {
      if (url.includes('/search')) return textResponse(SEARCH_PAGE);
      const path = new URL(url).pathname;
      return textResponse(pages[path] ?? '');
    });
    const result = await provider.artwork({ key: 'steam:1', title: 'Atomfall' }, 'hero', 0);
    expect(result.ok === true && result.value.offers.map((offer) => offer.key)).toEqual([
      'wallpapercave:wp111.webp',
      'wallpapercave:iee9mCb.jpg',
    ]);
  });

  it('opens the next albums on a later page, and says when none are left', async () => {
    const opened: string[] = [];
    const { provider } = providerOf((url) => {
      if (url.includes('/search')) return textResponse(SEARCH_PAGE_MANY);
      opened.push(new URL(url).pathname);
      return textResponse(SECOND_ALBUM_PAGE);
    });
    const ref = { key: 'steam:1', title: 'Atomfall' };
    const first = await provider.artwork(ref, 'hero', 0);
    expect(opened).toHaveLength(3);
    expect(first.ok === true && first.value.hasMore).toBe(true);
    opened.length = 0;
    const second = await provider.artwork(ref, 'hero', 1);
    expect(opened).toEqual(['/atomfall-4-wallpapers']);
    expect(second.ok === true && second.value.hasMore).toBe(false);
  });

  it('searches once for a gallery, however many pages it is paged through', async () => {
    const { provider, fetch } = providerOf((url) =>
      textResponse(url.includes('/search') ? SEARCH_PAGE_MANY : SECOND_ALBUM_PAGE),
    );
    const ref = { key: 'steam:1', title: 'Atomfall' };
    await provider.artwork(ref, 'hero', 0);
    fetch.mockClear();
    await provider.artwork(ref, 'hero', 1);
    expect(urlsOf(fetch).filter((url) => url.includes('/search'))).toEqual([]);
  });

  // The redirect case has no list to page through: everything the album holds arrived with page 0, and
  // the service hands out what did not fit on screen.
  it('has no later page after a search that landed on the album itself', async () => {
    const { provider } = providerOf(() => textResponse(ALBUM_PAGE));
    const ref = { key: 'steam:1', title: 'Atomfall' };
    const first = await provider.artwork(ref, 'hero', 0);
    expect(first.ok === true && first.value.hasMore).toBe(false);
    expect(await provider.artwork(ref, 'hero', 1)).toEqual({
      ok: true,
      value: { offers: [], hasMore: false },
    });
  });

  it('falls back to the candidate title when it is already Latin', async () => {
    const { provider, fetch } = providerOf(() => textResponse(ALBUM_PAGE), null);
    await provider.artwork({ key: 'gog:1', title: 'Hollow Knight' }, 'hero', 0);
    expect(urlsOf(fetch)[0]).toBe(searchUrl('Hollow Knight'));
  });

  it('does not search at all for a title it can only spell in another script', async () => {
    const { provider, fetch } = providerOf(() => textResponse(ALBUM_PAGE), null);
    expect(await provider.artwork({ key: 'steam:1', title: 'Ведьмак 3' }, 'hero', 0)).toEqual({
      ok: true,
      value: { offers: [], hasMore: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries without the edition tail when the full title finds nothing', async () => {
    const { provider, fetch } = providerOf(
      (url) => textResponse(url.includes('Complete') ? '' : ALBUM_PAGE),
      'The Witcher 3: Wild Hunt - Complete Edition',
    );
    const result = await provider.artwork({ key: 'steam:292030', title: 'x' }, 'hero', 0);
    expect(urlsOf(fetch)).toEqual([
      searchUrl('The Witcher 3: Wild Hunt - Complete Edition'),
      searchUrl('The Witcher 3: Wild Hunt'),
    ]);
    expect(result.ok === true && result.value.offers).toHaveLength(3);
  });

  it('reports nothing found as an empty gallery, not as an error', async () => {
    const { provider } = providerOf(() => textResponse('<html></html>'), 'Some Niche Indie');
    expect(await provider.artwork({ key: 'steam:1', title: 'x' }, 'hero', 0)).toEqual({
      ok: true,
      value: { offers: [], hasMore: false },
    });
  });

  it('reports a failing site as a failure', async () => {
    const { provider } = providerOf(() => textResponse('', 503));
    expect((await provider.artwork({ key: 'steam:1', title: 'x' }, 'hero', 0)).ok).toBe(false);
  });

  it('offers no covers — it is a wallpaper source', async () => {
    const { provider, fetch } = providerOf(() => textResponse(ALBUM_PAGE));
    expect(await provider.artwork({ key: 'steam:1', title: 'x' }, 'grid', 0)).toEqual({
      ok: true,
      value: { offers: [], hasMore: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
