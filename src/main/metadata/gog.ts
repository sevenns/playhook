// GOG — backgrounds for non-Steam games, without a key.
//
// It exists to soften a gap this feature would otherwise have: with backgrounds no longer taken from
// banner-shaped art, a game that Steam does not sell had nothing left unless the user also went and got
// a RAWG key. GOG's catalogue covers a large part of a typical non-Steam library and needs no key at all.
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
import { z } from 'zod';
import { type ArtworkKind, type GameCandidate, type MetadataResult } from '../../shared/types';
import { type ArtworkOffer, type GameCandidateRef, type MetadataProvider } from './provider';
import { type HttpClient } from './http';

const CATALOG_ORIGIN = 'https://catalog.gog.com/v1';
/** A shortlist for the candidate menu, in the same spirit as RAWG's page size. */
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
  return `${CATALOG_ORIGIN}/catalog?query=${encodeURIComponent(`like:${term}`)}&limit=${SEARCH_LIMIT}`;
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
    }
    return {
      ok: true,
      value: answer.value.products.map((product) => ({
        key: gogCandidateKey(product.id),
        title: product.title,
        provider: this.id,
        gogId: product.id,
      })),
    };
  }

  /**
   * Backgrounds only, and answered from what the search already brought back. A candidate this provider
   * never saw (the user picked a Steam-only game) yields nothing — and costs no request to say so.
   */
  async artwork(
    ref: GameCandidateRef,
    kind: ArtworkKind,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly ArtworkOffer[]>> {
    if (kind !== 'hero') return { ok: true, value: [] };
    const productId = ref.gogId ?? gogIdFromKey(ref.key);
    if (productId === undefined) return { ok: true, value: [] };
    const cached = this.screenshots.get(productId);
    if (cached !== undefined) return { ok: true, value: cached };
    // A candidate merged in from another source: the catalogue was searched under a title this product
    // did not answer to, so its pictures are fetched now, by the title the candidate carries.
    const answer = await this.deps.http.json(
      searchUrl(ref.title),
      searchSchema,
      signal === undefined ? undefined : { signal },
    );
    if (!answer.ok) return answer;
    const product = answer.value.products.find((candidate) => candidate.id === productId);
    if (product === undefined) return { ok: true, value: [] };
    const offers = toArtworkOffers(product);
    this.screenshots.set(product.id, offers);
    return { ok: true, value: offers };
  }
}
