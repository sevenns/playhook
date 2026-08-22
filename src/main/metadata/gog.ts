// GOG — backgrounds for non-Steam games, without a key.
//
// It exists to soften a gap this feature would otherwise have: with backgrounds no longer taken from
// banner-shaped art, a game that Steam does not sell falls back to whatever the wallpaper source found
// for its title. GOG's catalogue covers a large part of a typical non-Steam library and needs no key.
//
// Two conveniences make this the cheapest provider here: the catalogue's search answer ALREADY carries
// each product's screenshots, so backgrounds cost a single request, and the picture URLs are templates
// whose size suffix is honest — `ggvgl_2x` really is 1920x1080, unlike Steam's bounding-box paths.
//
// What is deliberately NOT taken: the product's `images.background` (measured 2560x655 — a store banner,
// the same shape this feature already rejected) and GOG's vertical covers (~1:1.41, where the launcher's
// card is 1:1.5, and covers are already served by Steam and SteamGridDB).
//
// Unofficial, like Steam's storesearch: `embed.gog.com/games/ajax/filtered`, which older launchers used,
// now answers with an empty list, which is exactly why this uses `catalog.gog.com` instead. Every answer
// is zod-validated, and a shape that moved on makes the provider drop out of the results, nothing more.
//
// One thing about that endpoint shapes everything below: `like:` is NOT a title search. It matches
// descriptions and tags too, and there is no title-scoped form to ask for instead (`title:`/`name:` are
// ignored and answer with the whole catalogue). So its answer is filtered here — see titleMatches — and
// the cost is a real one: a one-word name searches badly there (`like:bastion`, `like:hades` come back
// with neither game), so those games get no GOG pictures. Better than a menu of other people's games.
import { z } from 'zod';
import {
  type ArtworkKind,
  type GameCandidate,
  type GameDetails,
  type GamePlatform,
  type MetadataResult,
} from '../../shared/types';
import {
  type ArtworkOffer,
  type ArtworkOffers,
  type ArtworkRequest,
  type GameCandidateRef,
  type MetadataProvider,
} from './provider';
import { type HttpClient } from './http';
import { searchableTitle } from './search-title';

const CATALOG_ORIGIN = 'https://catalog.gog.com/v1';
/** A shortlist for the candidate menu — a menu wants a handful of names, not a catalogue page. */
const SEARCH_LIMIT = 10;
/** The formatter the gallery's thumbnails use, and the one an applied background is downloaded at. */
const THUMB_FORMATTER = 'ggvgm';
const FULL_FORMATTER = 'ggvgl_2x';

/** `gog:<id>` — the candidate key. GOG product ids are strings, so this keeps them as they came. */
export function gogCandidateKey(id: string): string {
  return `gog:${id}`;
}

/** `gog:<id>` back to a product id. Undefined for a key that belongs to another provider. */
export function gogIdFromKey(key: string): string | undefined {
  const match = /^gog:([A-Za-z0-9._-]+)$/.exec(key);
  return match?.[1];
}

export function searchUrl(term: string): string {
  const wanted = searchableTitle(term);
  return `${CATALOG_ORIGIN}/catalog?query=${encodeURIComponent(`like:${wanted}`)}&limit=${SEARCH_LIMIT}`;
}

/**
 * Whether a product is actually the game that was asked for.
 *
 * The catalogue's `like:` is NOT a title search — it matches descriptions and tags as well, and says so
 * loudly once you look (measured 2026-08-22): `like:cyberpunk` answers with Cyberpunk 2077 and then
 * RoboCop, Deus Ex and Mirror's Edge, which merely carry the tag; `like:hades` answers with "The
 * Pedestrian Soundtrack"; `like:Watch Dogs`, a game GOG does not sell at all, answers with seven
 * unrelated titles. Left alone, those become candidates in a menu where every line claims to be the
 * user's game.
 *
 * So the answer is filtered here, by the only thing that can be checked: every meaningful word of the
 * query must appear in the product's title. Deliberately strict — a name that is missing a word is a
 * DIFFERENT game ("Sniper Elite V2" for "Sniper Elite 5"), and this source exists to add backgrounds to
 * a game the user already named, not to suggest games.
 */
export function titleMatches(title: string, query: string): boolean {
  const words = queryWords(query);
  if (words.length === 0) return true;
  const normalized = normalizeForMatch(title);
  return words.every((word) => normalized.includes(word));
}

/** The words a title has to carry. Articles are dropped: stores put them in and leave them out freely. */
function queryWords(query: string): readonly string[] {
  const skip = new Set(['the', 'a', 'an', 'of', 'and']);
  return normalizeForMatch(query)
    .split(' ')
    .filter((word) => word.length > 0 && !skip.has(word));
}

/** Case, trademark marks and punctuation out — shallow, like the candidate merge's own normalization. */
function normalizeForMatch(text: string): string {
  return searchableTitle(text)
    .toLowerCase()
    .replaceAll(/[™®©]/g, '')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

/**
 * A screenshot URL with its formatter filled in. The catalogue states these as templates carrying a
 * `{formatter}` placeholder; a URL that arrives without one is used as it is rather than dropped.
 */
export function withFormatter(template: string, formatter: string): string {
  return template.includes('{formatter}')
    ? template.replaceAll('{formatter}', formatter)
    : template;
}

const searchSchema = z.object({
  products: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        screenshots: z.array(z.string().min(1)).default([]),
        // Stated in the catalogue answer the search already makes — see GameDetails on why they are kept.
        genres: z.array(z.object({ name: z.string().min(1) })).optional(),
        releaseDate: z.string().optional(),
        operatingSystems: z.array(z.string().min(1)).optional(),
      }),
    )
    .default([]),
});

type GogProduct = z.infer<typeof searchSchema>['products'][number];

/** One product's screenshots as offers: `ggvgm` for the grid, `ggvgl_2x` (a true 1920x1080) to apply. */
export function toArtworkOffers(product: GogProduct): readonly ArtworkOffer[] {
  return product.screenshots.map((template, index) => ({
    key: `gog:${product.id}:shot-${index}`,
    kind: 'hero' as const,
    provider: 'gog' as const,
    width: 1920,
    height: 1080,
    thumbUrl: withFormatter(template, THUMB_FORMATTER),
    fullUrl: withFormatter(template, FULL_FORMATTER),
  }));
}

/** GOG writes dates as `2017.02.24`; the manifest keeps ISO. Anything else is left out rather than guessed. */
export function toIsoDate(stated: string | undefined): string | undefined {
  if (stated === undefined) return undefined;
  const parts = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/.exec(stated.trim());
  if (parts !== null) return `${parts[1]}-${parts[2]}-${parts[3]}`;
  const year = /^(\d{4})$/.exec(stated.trim());
  return year === null ? undefined : (year[1] ?? undefined);
}

/** GOG's `osx` is the same platform the Steam answer calls `mac`; anything unknown is dropped. */
export function toPlatforms(
  stated: readonly string[] | undefined,
): readonly GamePlatform[] | undefined {
  if (stated === undefined) return undefined;
  const known: Readonly<Record<string, GamePlatform>> = {
    windows: 'windows',
    osx: 'mac',
    mac: 'mac',
    linux: 'linux',
  };
  const named = stated.flatMap((os) => {
    const platform = known[os.toLowerCase()];
    return platform === undefined ? [] : [platform];
  });
  return named.length > 0 ? named : undefined;
}

/** One catalogue product as GameDetails. GOG states no description in this answer, so none is returned. */
export function toDetails(product: GogProduct): GameDetails {
  const genres = (product.genres ?? []).map((genre) => genre.name);
  const releaseDate = toIsoDate(product.releaseDate);
  const platforms = toPlatforms(product.operatingSystems);
  return {
    ...(genres.length > 0 ? { genres } : {}),
    ...(releaseDate === undefined ? {} : { releaseDate }),
    ...(platforms === undefined ? {} : { platforms }),
  };
}

export interface GogDeps {
  readonly http: HttpClient;
}

export class GogProvider implements MetadataProvider {
  readonly id = 'gog' as const;
  /**
   * The screenshots a search already returned, by product id. Without this the gallery would repeat the
   * search purely to reach pictures the provider has held in memory since the candidate was chosen.
   */
  private readonly screenshots = new Map<string, readonly ArtworkOffer[]>();
  /** The genres/date/platforms the same search answer carried, by product id — see GameDetails. */
  private readonly detailsById = new Map<string, GameDetails>();

  constructor(private readonly deps: GogDeps) {}

  async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly GameCandidate[]>> {
    const answer = await this.deps.http.json(
      searchUrl(query),
      searchSchema,
      signal === undefined ? undefined : { signal },
    );
    if (!answer.ok) return answer;
    for (const product of answer.value.products) {
      this.screenshots.set(product.id, toArtworkOffers(product));
      this.detailsById.set(product.id, toDetails(product));
    }
    // Only the products whose NAME answers the query become candidates — see titleMatches. The rest stay
    // in the caches above: a merged candidate can still reach them by id, which is how a game Steam
    // named and GOG spells differently keeps its screenshots.
    return {
      ok: true,
      value: answer.value.products
        .filter((product) => titleMatches(product.title, query))
        .map((product) => ({
          key: gogCandidateKey(product.id),
          title: product.title,
          provider: this.id,
          gogId: product.id,
        })),
    };
  }

  /**
   * What the catalogue said about the game, out of the search answer already in hand. GOG states no
   * description there, so this fills only the other fields — which is exactly what matters for a game
   * Steam does not sell, where Steam can state nothing at all.
   */
  async details(ref: GameCandidateRef, signal?: AbortSignal): Promise<MetadataResult<GameDetails>> {
    const productId = ref.gogId ?? gogIdFromKey(ref.key);
    if (productId === undefined) return { ok: true, value: {} };
    const cached = this.detailsById.get(productId);
    if (cached !== undefined) return { ok: true, value: cached };
    const answer = await this.deps.http.json(
      searchUrl(ref.title),
      searchSchema,
      signal === undefined ? undefined : { signal },
    );
    if (!answer.ok) return answer;
    const product = answer.value.products.find((candidate) => candidate.id === productId);
    if (product === undefined) return { ok: true, value: {} };
    const details = toDetails(product);
    this.detailsById.set(productId, details);
    return { ok: true, value: details };
  }

  /**
   * Backgrounds only, and answered from what the search already brought back. A candidate this provider
   * never saw (the user picked a Steam-only game) yields nothing — and costs no request to say so.
   */
  async artwork(
    ref: GameCandidateRef,
    kind: ArtworkKind,
    request: ArtworkRequest,
    signal?: AbortSignal,
  ): Promise<MetadataResult<ArtworkOffers>> {
    const nothing = { ok: true, value: { offers: [], hasMore: false } } as const;
    if (kind !== 'hero' || request.page > 0) return nothing;
    const productId = ref.gogId ?? gogIdFromKey(ref.key);
    if (productId === undefined) return nothing;
    const cached = this.screenshots.get(productId);
    if (cached !== undefined) return { ok: true, value: { offers: cached, hasMore: false } };
    // A candidate merged in from another source: the catalogue was searched under a title this product
    // did not answer to, so its pictures are fetched now, by the title the candidate carries.
    const answer = await this.deps.http.json(
      searchUrl(ref.title),
      searchSchema,
      signal === undefined ? undefined : { signal },
    );
    if (!answer.ok) return answer;
    const product = answer.value.products.find((candidate) => candidate.id === productId);
    if (product === undefined) return nothing;
    const offers = toArtworkOffers(product);
    this.screenshots.set(product.id, offers);
    return { ok: true, value: { offers, hasMore: false } };
  }
}
