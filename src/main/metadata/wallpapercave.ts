// Wallpaper Cave — the second wallpaper source, and the one that covers what Wallhaven misses.
//
// Wallhaven is clean and filterable, but its coverage of recent releases is patchy: Atomfall had none
// there and 27 wallpapers here. This is an aggregator of user uploads, so it picks new games up fastest —
// and its role is exactly Khinsider's role in music: "dirty but wide", scraped, isolated, and deletable.
// Losing this file would cost some background choices and nothing else.
//
// Like Wallhaven it searches WALLPAPERS, not games: it takes no part in finding candidates and nothing
// merges. All it answers is "backgrounds for this title", from the English name (its albums and titles
// are English), reusing wallhaven.ts's fallback cascade for the rare query that finds nothing.
//
// There is no API. This is a scraper of two page shapes, and three of its facts decide the code:
//
//  * a STRONG match answers 302 straight to the album page (`?q=atomfall` → `/atomfall-wallpapers`), and
//    the http client follows redirects silently without reporting the final URL. So the same parse must
//    accept both shapes: no album list but `<img class="wimg">` present means the album page is already
//    in hand — the games with the best coverage are precisely the ones that redirect;
//  * every wallpaper states its own `width`/`height` in the markup, so portrait shots are dropped and the
//    tiles are sized without downloading a byte;
//  * the thumbnail and the full size are ONE file (the `/download/…` endpoint serves the identical
//    bytes), which is why an offer carries the same URL twice and the lightbox reuses the tile it
//    already fetched (see fullPreview in service.ts).
//
// File names follow no fixed shape — `/wp/wp123.webp`, `wp123.jpg`, `/wp/iee9mCb.jpg` — so URLs and
// extensions are taken from the markup only, never rebuilt from a template.
import { type ArtworkKind, type MetadataResult } from '../../shared/types';
import { IMAGE_EXTENSIONS } from '../asset-reader';
import {
  type ArtworkOffer,
  type ArtworkOffers,
  type ArtworkRequest,
  type GameCandidateRef,
  type MetadataProvider,
} from './provider';
import { type HttpClient } from './http';
import { isLatinTitle, searchTerms } from './wallhaven';

const ORIGIN = 'https://wallpapercave.com';
/**
 * How many albums one page of the gallery opens. Each is a separate page fetch, and the ranked top of
 * the list is where a game's own albums sit — the rest are other games that merely share a word. "Load
 * more" opens the next three, which is what keeps a deep search free until it is asked for.
 */
const ALBUMS_PER_PAGE = 3;
/**
 * Slug fragments that mark a phone album. Matched as SUBSTRINGS rather than as words on purpose: the
 * live listing carries `android-`, `smartphone-`, `cellphone-` and `-4k-phone-`, and `phone` catches all
 * of those at once where a word match would miss `cellphone`. This is a traffic saver, not the
 * correctness net — that is the portrait filter below, which works per FILE.
 */
const MOBILE_MARKERS: readonly string[] = ['phone', 'android', 'iphone', 'mobile'];
/**
 * Where "big enough" stops and "needlessly heavy" begins. Here the tile IS the full-size file, so a 4K
 * PNG (measured: 9.1 MB) costs its full weight twice over — once on the Deck's Wi-Fi and once in the
 * service's thumbnail cache, which is bounded by ENTRIES rather than by bytes. The Deck's panel is
 * 1280x800, so nothing above this is visibly better; such files are offered last rather than dropped.
 */
const PREFERRED_MAX_AREA = 2560 * 1440;

export function searchUrl(term: string): string {
  return `${ORIGIN}/search?q=${encodeURIComponent(term)}`;
}

export function albumUrl(pathname: string): string {
  return `${ORIGIN}${pathname}`;
}

/** One album as the search page lists it: its own path, its name, and how many wallpapers it holds. */
export interface CaveAlbum {
  readonly path: string;
  readonly title: string;
  readonly count: number;
}

/** One picture as an album page states it — dimensions included, which is what makes the filters free. */
export interface CaveWallpaper {
  readonly url: string;
  /** The last path segment. Two albums genuinely share files, and this is what dedupes them. */
  readonly file: string;
  readonly width?: number;
  readonly height?: number;
}

/** The five entities these pages actually carry. A full HTML decoder would be overkill, as on Khinsider. */
function decodeEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ');
}

/**
 * One double-quoted attribute of a tag, or undefined. Deliberately takes the FIRST occurrence: album
 * links carry `title` twice in a single tag, and reading both would offer the album twice.
 */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
}

/** A `src` as an absolute URL, whichever of the three forms the markup used. */
export function absoluteUrl(src: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  return src.startsWith('/') ? `${ORIGIN}${src}` : `${ORIGIN}/${src}`;
}

/** The extension of a URL's file name, lower-cased — the only thing that says whether it is a picture. */
function extensionOf(url: string): string {
  const file = url.split(/[?#]/)[0]?.split('/').pop() ?? '';
  const at = file.lastIndexOf('.');
  return at === -1 ? '' : file.slice(at + 1).toLowerCase();
}

function fileNameOf(url: string): string {
  return url.split(/[?#]/)[0]?.split('/').pop() ?? url;
}

/**
 * The albums a search page lists. Matched on the link itself rather than on the cards around it: the
 * `/{slug}-wallpapers` shape is the stable part of this markup, the layout is not.
 *
 * The count comes from the link's own `title` ("27 wallpapers in Atomfall"), which is accurate — it was
 * checked against the pictures actually on the page. A link without one still becomes an album, it just
 * ranks below those that state a number.
 */
export function parseAlbums(html: string): readonly CaveAlbum[] {
  const albums: CaveAlbum[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    const href = attribute(tag, 'href');
    if (href === undefined || !/^\/[^"?#]+-wallpapers\/?$/.test(href)) continue;
    const path = href.endsWith('/') ? href.slice(0, -1) : href;
    if (seen.has(path)) continue;
    seen.add(path);
    const stated = /^\s*(\d+)\s+wallpapers?\s+in\s+(.+?)\s*$/i.exec(attribute(tag, 'title') ?? '');
    const count = Number(stated?.[1] ?? 0);
    albums.push({
      path,
      title: stated?.[2] ?? slugTitle(path),
      count: Number.isFinite(count) ? count : 0,
    });
  }
  return albums;
}

/** `/the-witcher-3-wallpapers` as a name, for the links that state no title of their own. */
function slugTitle(path: string): string {
  return path
    .replace(/^\//, '')
    .replace(/-wallpapers$/, '')
    .replaceAll('-', ' ');
}

/**
 * Every wallpaper an album page holds. There is no lazy AJAX here — one page carries the lot — and each
 * `<img class="wimg">` states its own size, so nothing has to be downloaded to know what it is.
 */
export function parseWallpapers(html: string): readonly CaveWallpaper[] {
  const wallpapers: CaveWallpaper[] = [];
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\bwimg\b/i.test(attribute(tag, 'class') ?? '')) continue;
    const src = attribute(tag, 'src');
    if (src === undefined || src.length === 0) continue;
    const url = absoluteUrl(src);
    if (!IMAGE_EXTENSIONS.includes(extensionOf(url))) continue;
    const width = toDimension(attribute(tag, 'width'));
    const height = toDimension(attribute(tag, 'height'));
    wallpapers.push({
      url,
      file: fileNameOf(url),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    });
  }
  return wallpapers;
}

function toDimension(stated: string | undefined): number | undefined {
  if (stated === undefined) return undefined;
  const value = Number.parseInt(stated, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Whether a slug says "for a phone" — see MOBILE_MARKERS on why this is a substring match. */
export function isMobileAlbum(pathname: string): boolean {
  const slug = pathname.toLowerCase();
  return MOBILE_MARKERS.some((marker) => slug.includes(marker));
}

/**
 * The albums worth opening, best first: phone albums out, then by how well the name matches what was
 * searched for, then by how much the album holds. Sorting is stable, so albums that tie keep the order
 * the site listed them in — its own relevance ranking, which is better than nothing to fall back on.
 */
export function rankAlbums(albums: readonly CaveAlbum[], query: string): readonly CaveAlbum[] {
  const wanted = normalizeTitle(query);
  const score = (album: CaveAlbum): number => {
    const title = normalizeTitle(album.title);
    if (title === wanted) return 0;
    if (title.startsWith(wanted) || wanted.startsWith(title)) return 1;
    return title.includes(wanted) || wanted.includes(title) ? 2 : 3;
  };
  return albums
    .filter((album) => !isMobileAlbum(album.path))
    .map((album) => ({ album, rank: score(album) }))
    .sort((a, b) => (a.rank === b.rank ? b.album.count - a.album.count : a.rank - b.rank))
    .map((entry) => entry.album);
}

/** Case, marks and punctuation out — the shallow normalization the candidate merge uses, for titles. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[™®©]/g, '')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

/**
 * Wallpapers as offers: portrait ones dropped (they would be cropped to a ribbon behind a 16:10 screen),
 * repeats across albums collapsed by file name, and the rest ordered so the sizes that suit the Deck are
 * taken first — see PREFERRED_MAX_AREA. `thumbUrl` and `fullUrl` are the same file, deliberately.
 */
export function toArtworkOffers(wallpapers: readonly CaveWallpaper[]): readonly ArtworkOffer[] {
  const seen = new Set<string>();
  return [...wallpapers]
    .filter(
      (paper) =>
        paper.width === undefined || paper.height === undefined || paper.height <= paper.width,
    )
    .filter((paper) => {
      if (seen.has(paper.file)) return false;
      seen.add(paper.file);
      return true;
    })
    .sort((a, b) =>
      sizeGroup(a) === sizeGroup(b) ? withinGroup(a, b) : sizeGroup(a) - sizeGroup(b),
    )
    .map((paper) => ({
      key: `wallpapercave:${paper.file}`,
      kind: 'hero' as const,
      provider: 'wallpapercave' as const,
      ...(paper.width === undefined ? {} : { width: paper.width }),
      ...(paper.height === undefined ? {} : { height: paper.height }),
      thumbUrl: paper.url,
      fullUrl: paper.url,
    }));
}

/** 0 — a size worth showing first, 1 — a picture that states none, 2 — heavier than the Deck can use. */
function sizeGroup(paper: CaveWallpaper): number {
  const area = areaOf(paper);
  if (area === undefined) return 1;
  return area <= PREFERRED_MAX_AREA ? 0 : 2;
}

/** Inside a group: the largest of the suitable ones first, and the smallest of the oversized ones. */
function withinGroup(a: CaveWallpaper, b: CaveWallpaper): number {
  const first = areaOf(a);
  const second = areaOf(b);
  if (first === undefined || second === undefined) return 0;
  return sizeGroup(a) === 0 ? second - first : first - second;
}

function areaOf(paper: CaveWallpaper): number | undefined {
  return paper.width === undefined || paper.height === undefined
    ? undefined
    : paper.width * paper.height;
}

export interface WallpaperCaveDeps {
  readonly http: HttpClient;
  /** The game's ENGLISH name, for the same reason Wallhaven needs one — see WallhavenDeps.englishTitle. */
  readonly englishTitle: (ref: GameCandidateRef) => string | undefined;
}

/** What one search turned up, kept so that "load more" continues it instead of searching afresh. */
interface CaveSearch {
  readonly albums: readonly CaveAlbum[];
  /** Set only for the 302 case: the album page itself came back, and there is no list to page through. */
  readonly wallpapers: readonly CaveWallpaper[];
}

export class WallpaperCaveProvider implements MetadataProvider {
  readonly id = 'wallpapercave' as const;
  /** One search per candidate, by candidate key — see CaveSearch. */
  private readonly searches = new Map<string, CaveSearch>();

  constructor(private readonly deps: WallpaperCaveDeps) {}

  /**
   * Backgrounds only. The search here is forgiving — a full Steam title with its edition tail finds the
   * right album — so the cascade from wallhaven.ts is a fallback rather than the normal path.
   */
  async artwork(
    ref: GameCandidateRef,
    kind: ArtworkKind,
    request: ArtworkRequest,
    signal?: AbortSignal,
  ): Promise<MetadataResult<ArtworkOffers>> {
    const nothing = { ok: true, value: { offers: [], hasMore: false } } as const;
    if (kind !== 'hero') return nothing;
    const options = signal === undefined ? undefined : { signal };
    const remembered = request.page > 0 ? this.searches.get(ref.key) : undefined;
    const found = remembered ?? (await this.findAlbums(ref, options));
    if (found === undefined) return nothing;
    if (!('albums' in found)) return found;
    this.searches.set(ref.key, found);
    // The 302 case: one album, all of it already parsed out of the answer to the search itself. The
    // service keeps whatever did not fit on screen, so there is nothing left for a later page to fetch.
    if (found.albums.length === 0) {
      return request.page > 0
        ? nothing
        : { ok: true, value: { offers: toArtworkOffers(found.wallpapers), hasMore: false } };
    }
    return this.fromAlbums(found.albums, request.page, options);
  }

  /**
   * The search behind a gallery: the first term of the cascade that answers with anything, as either a
   * list of albums or — after the 302 a strong match earns — the album page itself. Undefined means the
   * title cannot be searched at all; a failure travels back as one.
   */
  private async findAlbums(
    ref: GameCandidateRef,
    options: { readonly signal: AbortSignal } | undefined,
  ): Promise<CaveSearch | MetadataResult<ArtworkOffers> | undefined> {
    const title = this.deps.englishTitle(ref) ?? (isLatinTitle(ref.title) ? ref.title : undefined);
    if (title === undefined) return undefined;
    let failure: MetadataResult<ArtworkOffers> | undefined;
    for (const term of searchTerms(title)) {
      const page = await this.deps.http.text(searchUrl(term), options);
      if (!page.ok) {
        failure = page;
        continue;
      }
      const albums = rankAlbums(parseAlbums(page.value), term);
      if (albums.length > 0) return { albums, wallpapers: [] };
      const wallpapers = parseWallpapers(page.value);
      if (wallpapers.length > 0) return { albums: [], wallpapers };
    }
    return failure;
  }

  /** The pictures of one page's worth of albums, with "more" meaning "there are albums left to open". */
  private async fromAlbums(
    albums: readonly CaveAlbum[],
    page: number,
    options: { readonly signal: AbortSignal } | undefined,
  ): Promise<MetadataResult<ArtworkOffers>> {
    const from = page * ALBUMS_PER_PAGE;
    const hasMore = albums.length > from + ALBUMS_PER_PAGE;
    const wallpapers: CaveWallpaper[] = [];
    let failure: MetadataResult<ArtworkOffers> | undefined;
    for (const album of albums.slice(from, from + ALBUMS_PER_PAGE)) {
      const opened = await this.deps.http.text(albumUrl(album.path), options);
      if (!opened.ok) {
        failure = opened;
        continue;
      }
      wallpapers.push(...parseWallpapers(opened.value));
    }
    const offers = toArtworkOffers(wallpapers);
    if (offers.length === 0 && failure !== undefined) return failure;
    return { ok: true, value: { offers, hasMore } };
  }
}
