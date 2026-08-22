// Wallhaven — the backgrounds source, and the only one here that serves the actual target content:
// wallpapers. Steam's screenshots and GOG's are gameplay frames with a HUD in them; these are pictures
// composed to be looked at full-screen, which is exactly what this launcher paints behind a game.
//
// It searches WALLPAPERS, not games, so it takes no part in finding candidates — there is no
// `wallhavenId` on a candidate and nothing to merge. All it answers is "backgrounds for this title".
//
// The API is official and documented (wallhaven.cc/help/api), keyless for SFW, and rate-limited at 45
// requests per minute per IP — a gallery costs one to three of those. The thumbnail and full-size hosts
// are static and outside that limit, so downloading a page of thumbnails three at a time never nears it.
//
// Two things about its search decide the shape of this module:
//
//  * it matches on WORDS, ANDed. A Russian title finds nothing at all (the tags are English), so the
//    query is built from the English name — see `WallhavenDeps.englishTitle`;
//  * extra words do not merely add noise, they empty the result: "The Witcher 3: Wild Hunt" answers with
//    674 wallpapers, "The Witcher 3: Wild Hunt - Complete Edition" with none. Steam titles are full of
//    such edition tails, hence the fallback cascade in `searchTerms`.
import { z } from 'zod';
import { type ArtworkKind, type MetadataResult } from '../../shared/types';
import {
  type ArtworkOffer,
  type ArtworkOffers,
  type GameCandidateRef,
  type MetadataProvider,
} from './provider';
import { type HttpClient } from './http';

const API_ORIGIN = 'https://wallhaven.cc/api/v1';
/**
 * general + anime, people OFF — the third category is mostly cosplay and portraits, which is not what
 * "a background for this game" means.
 */
const CATEGORIES = '110';
/** SFW only. This is the default and the only purity available without a key; NSFW is not offered. */
const PURITY = '100';
/**
 * The floor for a wallpaper's size. The Deck's panel is 1280x800, so 1080p already carries half again
 * the pixels it can show; asking for 1440p only narrowed the choice without looking any better on it.
 * Bigger ones still come back — this is a minimum, not a target.
 */
const MIN_RESOLUTION = '1920x1080';
/**
 * Landscape, and landscape only — a portrait wallpaper would be cropped to a ribbon behind a 16:10
 * screen. Deliberately NOT a list of exact ratios: this endpoint matches those EXACTLY, so `16x9,16x10`
 * threw away a 4096x2286 wallpaper for being 1.79 rather than 1.78, and with it most of what the less
 * photographed games have. The gallery shows each tile whole (object-fit) and states its size, so a
 * wider-than-usual wallpaper is something the user can see and judge, not something to hide from them.
 */
const RATIOS = 'landscape';
/**
 * Anything heavier than the image cap would be refused at apply time anyway (see MAX_BYTES in
 * service.ts), and the search answer states each file's size — so an unusable offer is dropped before it
 * ever becomes a tile. 4K PNGs routinely weigh 12-14 MB, so this is not a theoretical bound.
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** The edition tails publishers append. Cutting them is what turns an empty answer into a full one. */
const EDITION_MARKERS: readonly string[] = [
  'complete edition',
  'definitive edition',
  'enhanced edition',
  'final cut',
  'game of the year edition',
  'goty edition',
  'goty',
  'remastered',
];

/** `page` is 0-based here and 1-based there — the endpoint counts its pages from one. */
export function searchUrl(term: string, page = 0): string {
  const query = new URLSearchParams({
    q: term,
    categories: CATEGORIES,
    purity: PURITY,
    atleast: MIN_RESOLUTION,
    ratios: RATIOS,
    sorting: 'relevance',
    page: String(page + 1),
  });
  return `${API_ORIGIN}/search?${query.toString()}`;
}

/**
 * The queries to try, in order, until one of them finds something: the title as it stands, then the same
 * title with its edition tail removed.
 *
 * Deliberately NOT the merge normalization from the candidate merge — that one must never conflate two
 * different games, so it keeps every word. This one exists for the opposite reason: here an extra word
 * is what makes a game's wallpapers invisible.
 */
export function searchTerms(title: string): readonly string[] {
  const first = title.trim().replace(/\s+/g, ' ');
  if (first === '') return [];
  const terms = [first];
  for (const candidate of [withoutEditionTail(first), beforeSubtitle(first)]) {
    if (candidate === '') continue;
    if (terms.some((term) => term.toLowerCase() === candidate.toLowerCase())) continue;
    terms.push(candidate);
  }
  return terms;
}

/**
 * A title with its edition tail removed. Two shapes cover what stores actually append:
 *
 *  * everything after a dash — "Disco Elysium - The Final Cut", "The Witcher 3: Wild Hunt - Complete
 *    Edition". The dash is the store's own seam between the game and its edition, so it is the safest
 *    cut and it is tried first;
 *  * a trailing marker with no dash in front of it — "Dark Souls Remastered".
 *
 * Only the TAIL goes, and only when something is left: "Final Fantasy" survives "Final Cut" being a
 * marker, and a subtitle that belongs to the name ("Wild Hunt") is not an edition and stays.
 */
export function withoutEditionTail(title: string): string {
  const separator = Math.max(title.lastIndexOf(' - '), title.lastIndexOf(' – '));
  if (separator > 0) {
    const head = title.slice(0, separator).trim();
    if (head !== '') return head;
  }
  const lower = title.toLowerCase();
  for (const marker of EDITION_MARKERS) {
    const at = lower.lastIndexOf(marker);
    if (at === -1 || at + marker.length !== lower.length) continue;
    const head = title
      .slice(0, at)
      .replace(/[\s:–—-]+$/u, '')
      .trim();
    if (head !== '') return head;
  }
  return title;
}

/**
 * The part before a colon — the last resort of the cascade. A subtitle is usually part of the name and
 * finds wallpapers on its own, so this is only reached once the fuller queries have come back empty.
 */
export function beforeSubtitle(title: string): string {
  const at = title.indexOf(': ');
  return at > 0 ? title.slice(0, at).trim() : '';
}

/** Whether a title is written in the Latin alphabet — the only case it can stand in for the English one. */
export function isLatinTitle(title: string): boolean {
  return !/\p{Script=Cyrillic}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(
    title,
  );
}

const searchSchema = z.object({
  /**
   * The endpoint states which page it just served and how many there are, which is what makes "load
   * more" honest: the gallery offers another page only when one exists. Optional all the same — a
   * missing `meta` costs the extra pages, not the answer.
   */
  meta: z
    .object({
      current_page: z.number().int().positive().optional(),
      last_page: z.number().int().positive().optional(),
    })
    .optional(),
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        path: z.string().min(1),
        file_size: z.number().nonnegative().optional(),
        dimension_x: z.number().int().positive().optional(),
        dimension_y: z.number().int().positive().optional(),
        thumbs: z.object({ small: z.string().min(1).optional() }).optional(),
      }),
    )
    .default([]),
});

type Wallpaper = z.infer<typeof searchSchema>['data'][number];
type SearchMeta = z.infer<typeof searchSchema>['meta'];

/** Whether the answer says another page follows. Silence means no: an empty page is a worse offer. */
export function hasMorePages(meta: SearchMeta): boolean {
  const current = meta?.current_page;
  const last = meta?.last_page;
  return current !== undefined && last !== undefined && current < last;
}

/**
 * Wallpapers as offers, with the ones too heavy to apply left out. The thumbnail is Wallhaven's own
 * (~24 KB, already the right size for the grid); unlike Steam's screenshots these state their real
 * dimensions, so the tiles can show them.
 */
export function toArtworkOffers(wallpapers: readonly Wallpaper[]): readonly ArtworkOffer[] {
  return wallpapers
    .filter((paper) => paper.file_size === undefined || paper.file_size <= MAX_FILE_BYTES)
    .map((paper) => ({
      key: `wallhaven:${paper.id}`,
      kind: 'hero' as const,
      provider: 'wallhaven' as const,
      ...(paper.dimension_x === undefined ? {} : { width: paper.dimension_x }),
      ...(paper.dimension_y === undefined ? {} : { height: paper.dimension_y }),
      thumbUrl: paper.thumbs?.small ?? paper.path,
      fullUrl: paper.path,
    }));
}

export interface WallhavenDeps {
  readonly http: HttpClient;
  /**
   * The game's ENGLISH name, when something knows it — in practice Steam's appdetails answer, which the
   * Steam provider already holds for the candidate the user picked. Without it a Russian UI would search
   * Wallhaven for a Russian title and always find nothing.
   */
  readonly englishTitle: (ref: GameCandidateRef) => string | undefined;
}

export class WallhavenProvider implements MetadataProvider {
  readonly id = 'wallhaven' as const;
  /** The query that answered for a candidate, so "load more" pages through THAT search, not another. */
  private readonly answeredTerm = new Map<string, string>();

  constructor(private readonly deps: WallhavenDeps) {}

  /**
   * Backgrounds only, and only for a title this can search in English. Each term of the cascade is tried
   * until one answers with something; an empty result is not a failure, just a game nobody has made a
   * wallpaper for.
   *
   * A later page repeats the term that worked rather than walking the cascade again: the cascade exists
   * to find A query that answers, and page 2 of a different query would be a different set of pictures
   * appended to the same gallery.
   */
  async artwork(
    ref: GameCandidateRef,
    kind: ArtworkKind,
    page: number,
    signal?: AbortSignal,
  ): Promise<MetadataResult<ArtworkOffers>> {
    const nothing = { ok: true, value: { offers: [], hasMore: false } } as const;
    if (kind !== 'hero') return nothing;
    const title = this.deps.englishTitle(ref) ?? (isLatinTitle(ref.title) ? ref.title : undefined);
    if (title === undefined) return nothing;
    const options = signal === undefined ? undefined : { signal };
    const remembered = page > 0 ? this.answeredTerm.get(ref.key) : undefined;
    let failure: MetadataResult<ArtworkOffers> | undefined;
    for (const term of remembered === undefined ? searchTerms(title) : [remembered]) {
      const answer = await this.deps.http.json(searchUrl(term, page), searchSchema, options);
      if (!answer.ok) {
        failure = answer;
        continue;
      }
      const offers = toArtworkOffers(answer.value.data);
      const hasMore = hasMorePages(answer.value.meta);
      // A later page of the term already in use is this game's answer whether or not the filters left
      // anything on it; on the first page an empty result means "try the next term".
      if (offers.length === 0 && remembered === undefined) continue;
      this.answeredTerm.set(ref.key, term);
      return { ok: true, value: { offers, hasMore } };
    }
    return failure ?? nothing;
  }
}
