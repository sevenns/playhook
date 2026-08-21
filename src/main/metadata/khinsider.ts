// Khinsider — the soundtrack source, and the only per-game one that exists in practice.
//
// It has no API. This is a scraper, and it is written to be one honestly: every answer is parsed out of
// HTML with tolerant patterns, anything unrecognized becomes an ordinary "nothing found", and the whole
// provider is isolated behind the same interface the others implement. Deleting this file would cost the
// Music entry of the menu and nothing else — which is deliberate, because a scraper is one redesign away
// from breaking, and the copyright status of the material is a grey area we do not want to spread.
//
// For the same reason nothing here is ever fetched on its own: a search happens because the user pressed
// Music, a track downloads because the user pressed that track.
//
// The site's flow forces one hop more than the others: the album page lists tracks but NOT their audio
// URLs — those live on each track's own page, which is why `musicTrackUrl` exists at all.
import { type MetadataResult, type MusicAlbum } from '../../shared/types';
import { type MetadataProvider, type MusicTrackOffer } from './provider';
import { type HttpClient } from './http';

const ORIGIN = 'https://downloads.khinsider.com';
/** How many albums a search offers. The site returns everything it matched; a menu wants a shortlist. */
const MAX_ALBUMS = 20;

export function searchUrl(term: string): string {
  return `${ORIGIN}/search?search=${encodeURIComponent(term)}`;
}

export function albumUrl(albumKey: string): string {
  return `${ORIGIN}/game-soundtracks/album/${albumKey}`;
}

/** `khinsider:<album>:<file>` — the key a track is addressed by, and what its page URL is rebuilt from. */
export function trackKey(albumKey: string, file: string): string {
  return `khinsider:${albumKey}:${file}`;
}

/** The five entities that actually occur in these titles. A full HTML decoder would be overkill here. */
function decodeEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&nbsp;', ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replaceAll(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The albums a search page lists. Matched by the album URL rather than by the surrounding table markup:
 * the link shape is the part of this site that has stayed put, the table around it is not.
 */
export function parseAlbums(html: string): readonly MusicAlbum[] {
  const albums: MusicAlbum[] = [];
  const seen = new Set<string>();
  const pattern = /<a\s+href="\/game-soundtracks\/album\/([^"/?#]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(pattern)) {
    const key = match[1];
    const title = stripTags(match[2] ?? '');
    if (key === undefined || title.length === 0 || seen.has(key)) continue;
    seen.add(key);
    albums.push({ key, title });
    if (albums.length >= MAX_ALBUMS) break;
  }
  return albums;
}

/** `4.44 MB` / `763 KB` as bytes. Undefined when the row states no size at all. */
export function parseSize(text: string): number | undefined {
  const match = /([\d.]+)\s*(KB|MB|GB)/i.exec(text);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = (match[2] ?? '').toUpperCase();
  const factor = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024;
  return Math.round(amount * factor);
}

/**
 * One album page's tracks. The size is read from whatever follows the link up to the end of its row —
 * the first figure there is the mp3's, and a page that states none simply yields no size.
 */
export function parseTracks(html: string, albumKey: string): readonly MusicTrackOffer[] {
  const tracks: MusicTrackOffer[] = [];
  const seen = new Set<string>();
  const escaped = albumKey.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<a\\s+href="/game-soundtracks/album/${escaped}/([^"?#]+)"[^>]*>([\\s\\S]*?)</a>([\\s\\S]{0,400}?)</tr>`,
    'g',
  );
  for (const match of html.matchAll(pattern)) {
    const file = match[1];
    if (file === undefined || seen.has(file)) continue;
    const label = stripTags(match[2] ?? '');
    const title = label.length > 0 ? label : decodeURIComponent(file);
    seen.add(file);
    const sizeBytes = parseSize(stripTags(match[3] ?? ''));
    tracks.push({
      key: trackKey(albumKey, file),
      title,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      pageUrl: `${ORIGIN}/game-soundtracks/album/${albumKey}/${file}`,
    });
  }
  return tracks;
}

/**
 * The direct audio URL on a track page. Both shapes the page has used are accepted — the download link
 * and the inline player — and only the audio extensions this app can actually play are taken.
 */
export function parseAudioUrl(html: string): string | undefined {
  const pattern = /(?:href|src)="(https?:\/\/[^"]+\.(?:mp3|flac|ogg|m4a))"/gi;
  for (const match of html.matchAll(pattern)) {
    const url = match[1];
    if (url !== undefined) return decodeEntities(url);
  }
  return undefined;
}

/** `khinsider:<album>:<file>` back to its parts. Undefined for a key from another provider. */
export function parseTrackKey(
  key: string,
): { readonly album: string; readonly file: string } | undefined {
  const match = /^khinsider:([^:]+):(.+)$/.exec(key);
  const album = match?.[1];
  const file = match?.[2];
  return album === undefined || file === undefined ? undefined : { album, file };
}

export interface KhinsiderDeps {
  readonly http: HttpClient;
}

export class KhinsiderProvider implements MetadataProvider {
  readonly id = 'khinsider' as const;

  constructor(private readonly deps: KhinsiderDeps) {}

  async musicSearch(
    query: string,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly MusicAlbum[]>> {
    const page = await this.deps.http.text(
      searchUrl(query),
      signal === undefined ? undefined : { signal },
    );
    if (!page.ok) return page;
    return { ok: true, value: parseAlbums(page.value) };
  }

  async musicTracks(
    albumKey: string,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly MusicTrackOffer[]>> {
    const page = await this.deps.http.text(
      albumUrl(albumKey),
      signal === undefined ? undefined : { signal },
    );
    if (!page.ok) return page;
    return { ok: true, value: parseTracks(page.value, albumKey) };
  }

  /** The extra hop: the album page names the track, the track's own page names the file. */
  async musicTrackUrl(
    track: MusicTrackOffer,
    signal?: AbortSignal,
  ): Promise<MetadataResult<string>> {
    if (parseTrackKey(track.key) === undefined)
      return { ok: false, message: 'not a khinsider track' };
    const page = await this.deps.http.text(
      track.pageUrl,
      signal === undefined ? undefined : { signal },
    );
    if (!page.ok) return page;
    const url = parseAudioUrl(page.value);
    return url === undefined
      ? { ok: false, message: `${track.pageUrl}: no audio link on the track page` }
      : { ok: true, value: url };
  }
}
