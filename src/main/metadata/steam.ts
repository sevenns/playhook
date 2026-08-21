// Steam as a metadata source: the store's search endpoint for "which game is this", the CDN for its
// artwork, and appdetails for the descriptions.
//
// Both endpoints are UNOFFICIAL — no key, no documentation, no promise they will keep their shape. That
// is why every answer is validated with zod and every failure comes back as a Result: when Steam changes
// something, this feature degrades to "nothing found" and the launcher carries on.
//
// The CDN URLs are built from the appid rather than discovered, because that is the only way to reach
// `library_600x900` (appdetails does not name it). Where appdetails DOES name a picture — `header_image`
// — that URL wins over the template: it is the one that keeps working if Steam moves its assets to
// another host.
import { z } from 'zod';
import { type Locale } from '../../shared/i18n/index';
import {
  type ArtworkKind,
  type GameCandidate,
  type LocalizedText,
  type MetadataResult,
} from '../../shared/types';
import { type ArtworkOffer, type GameCandidateRef, type MetadataProvider } from './provider';
import { type HttpClient } from './http';

const STORE_ORIGIN = 'https://store.steampowered.com';
const CDN_ORIGIN = 'https://cdn.cloudflare.steamstatic.com';
/** Descriptions are stored in a manifest the user may open in a text editor — keep them readable. */
const MAX_DESCRIPTION_CHARS = 2000;
/** How many appdetails answers the provider remembers. One session looks at a handful of games. */
const MAX_CACHED_HEADERS = 50;

/** The `l`/`cc` pair a locale searches with. Searching a Russian title with `l=english` finds nothing. */
export function storeLocaleParams(locale: Locale): {
  readonly language: string;
  readonly country: string;
} {
  return locale === 'ru'
    ? { language: 'russian', country: 'RU' }
    : { language: 'english', country: 'US' };
}

/** `storesearch` — the store's own type-ahead, and the only keyless way to turn a title into an appid. */
export function storeSearchUrl(term: string, locale: Locale): string {
  const { language, country } = storeLocaleParams(locale);
  return `${STORE_ORIGIN}/api/storesearch/?term=${encodeURIComponent(term)}&l=${language}&cc=${country}`;
}

/** `appdetails` for ONE language — the caller asks twice (en + ru) to fill a LocalizedText. */
export function appDetailsUrl(appId: number, locale: Locale): string {
  const { language } = storeLocaleParams(locale);
  return `${STORE_ORIGIN}/api/appdetails?appids=${appId}&l=${language}`;
}

/** The portrait cover (600x900) — the grid image the carousel wants. `2x` is the same art at 1200x1800. */
export function libraryGridUrl(appId: number, doubled = false): string {
  return `${CDN_ORIGIN}/steam/apps/${appId}/library_600x900${doubled ? '_2x' : ''}.jpg`;
}

/** The wide library background — the hero. Missing for plenty of older apps, hence the existence check. */
export function libraryHeroUrl(appId: number): string {
  return `${CDN_ORIGIN}/steam/apps/${appId}/library_hero.jpg`;
}

/** The small store capsule. Always present, so it stands in as the hero's thumbnail. */
export function headerUrl(appId: number): string {
  return `${CDN_ORIGIN}/steam/apps/${appId}/header.jpg`;
}

/** `steam:<appid>` — the candidate key the renderer round-trips back to us. */
export function steamCandidateKey(appId: number): string {
  return `steam:${appId}`;
}

const searchSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1),
        type: z.string().optional(),
      }),
    )
    .default([]),
});

const appDetailsSchema = z.record(
  z.string(),
  z.object({
    success: z.boolean(),
    data: z
      .object({
        name: z.string().optional(),
        short_description: z.string().optional(),
        header_image: z.string().optional(),
      })
      .optional(),
  }),
);

/**
 * Steam's descriptions carry store markup (`<strong>`, `<br>`, entities). The manifest holds plain text,
 * so tags are dropped, the common entities decoded and the whitespace collapsed — then the result is cut
 * to MAX_DESCRIPTION_CHARS on a word boundary rather than mid-word.
 */
export function sanitizeDescription(raw: string): string {
  const withoutTags = raw
    .replaceAll(/<br\s*\/?>/gi, ' ')
    .replaceAll(/<[^>]*>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
  const collapsed = withoutTags.replaceAll(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_DESCRIPTION_CHARS) return collapsed;
  const cut = collapsed.slice(0, MAX_DESCRIPTION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MAX_DESCRIPTION_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Turns a validated storesearch answer into candidates, keeping only entries that are actual games. */
export function toCandidates(
  items: readonly { id: number; name: string; type?: string }[],
): readonly GameCandidate[] {
  return items
    .filter((item) => item.type === undefined || item.type === 'app' || item.type === 'game')
    .map((item) => ({
      key: steamCandidateKey(item.id),
      title: item.name,
      provider: 'steam' as const,
      steamAppId: item.id,
    }));
}

/** `steam:<appid>` back to an appid. Undefined for a key that belongs to another provider. */
export function steamAppIdFromKey(key: string): number | undefined {
  const match = /^steam:(\d+)$/.exec(key);
  if (match === null) return undefined;
  const appId = Number(match[1]);
  return Number.isSafeInteger(appId) && appId > 0 ? appId : undefined;
}

export interface SteamProviderDeps {
  readonly http: HttpClient;
  /** Read live: the user can switch the UI language while the app runs, and search follows it. */
  readonly locale: () => Locale;
}

export class SteamProvider implements MetadataProvider {
  readonly id = 'steam' as const;
  /**
   * What appdetails said about each app's own picture, so the gallery never asks twice. `url: undefined`
   * is a real answer ("this app names no picture") and is cached as one — re-asking would spend a rate
   * limit to learn the same nothing.
   */
  private readonly headerImages = new Map<number, { readonly url: string | undefined }>();

  constructor(private readonly deps: SteamProviderDeps) {}

  async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly GameCandidate[]>> {
    const url = storeSearchUrl(query, this.deps.locale());
    const answer = await this.deps.http.json(
      url,
      searchSchema,
      signal === undefined ? undefined : { signal },
    );
    if (!answer.ok) return answer;
    return { ok: true, value: toCandidates(answer.value.items) };
  }

  /**
   * The candidate behind an appid the manifest already carries. appdetails is asked only for the NAME —
   * a candidate needs one to show, and the alternative would be labelling it with a bare number. When
   * that call fails the appid alone is still a perfectly usable candidate.
   */
  async candidateByAppId(
    appId: number,
    signal?: AbortSignal,
  ): Promise<MetadataResult<GameCandidate>> {
    if (!Number.isSafeInteger(appId) || appId <= 0)
      return { ok: false, message: 'not a Steam appid' };
    const options = signal === undefined ? undefined : { signal };
    const details = await this.deps.http.json(
      appDetailsUrl(appId, this.deps.locale()),
      appDetailsSchema,
      options,
    );
    const name = details.ok ? details.value[String(appId)]?.data?.name : undefined;
    return {
      ok: true,
      value: {
        key: steamCandidateKey(appId),
        title: name !== undefined && name.length > 0 ? name : `Steam ${appId}`,
        provider: this.id,
        steamAppId: appId,
      },
    };
  }

  /**
   * The CDN art for one app. A variant is offered only once its FULL-size URL is known to exist: the
   * 600x900 cover and the hero are simply absent for many older apps, and a gallery tile whose apply
   * would 404 is worse than one tile fewer.
   */
  async artwork(
    ref: GameCandidateRef,
    kind: ArtworkKind,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly ArtworkOffer[]>> {
    const appId = ref.steamAppId ?? steamAppIdFromKey(ref.key);
    if (appId === undefined) return { ok: true, value: [] };
    const options = signal === undefined ? undefined : { signal };
    const candidates: readonly ArtworkOffer[] =
      kind === 'grid'
        ? [
            {
              key: `steam:${appId}:grid-2x`,
              kind,
              provider: this.id,
              width: 1200,
              height: 1800,
              thumbUrl: libraryGridUrl(appId),
              fullUrl: libraryGridUrl(appId, true),
            },
            {
              key: `steam:${appId}:grid`,
              kind,
              provider: this.id,
              width: 600,
              height: 900,
              thumbUrl: libraryGridUrl(appId),
              fullUrl: libraryGridUrl(appId),
            },
          ]
        : [
            {
              key: `steam:${appId}:hero`,
              kind,
              provider: this.id,
              thumbUrl: (await this.headerImage(appId, signal)) ?? headerUrl(appId),
              fullUrl: libraryHeroUrl(appId),
            },
          ];
    const present: ArtworkOffer[] = [];
    for (const offer of candidates) {
      if (await this.deps.http.exists(offer.fullUrl, options)) {
        present.push(offer);
        continue;
      }
      // The template 404s. That is normal for an old app — but it is ALSO what a move of Steam's assets
      // to another host would look like, and appdetails names its pictures rather than templating them.
      // So a hero whose `library_hero` is missing is still offered when appdetails gave a picture: the
      // capsule is smaller than a proper background, and smaller beats absent.
      const named = kind === 'hero' ? await this.headerImage(appId, signal) : undefined;
      if (named !== undefined) present.push({ ...offer, thumbUrl: named, fullUrl: named });
    }
    return { ok: true, value: present };
  }

  /**
   * `header_image` as appdetails states it, or undefined when it does not (or the call failed). Cached
   * for the session: the gallery, a re-open of it and the descriptions all want the same answer, and
   * appdetails is the one endpoint here with a rate limit worth respecting (~200 calls / 5 minutes).
   */
  private async headerImage(appId: number, signal?: AbortSignal): Promise<string | undefined> {
    const cached = this.headerImages.get(appId);
    if (cached !== undefined) return cached.url;
    const details = await this.deps.http.json(
      appDetailsUrl(appId, this.deps.locale()),
      appDetailsSchema,
      signal === undefined ? undefined : { signal },
    );
    if (!details.ok) return undefined; // not cached: a failed call says nothing about the app
    const url = details.value[String(appId)]?.data?.header_image;
    this.rememberHeaderImage(appId, url !== undefined && url.length > 0 ? url : undefined);
    return this.headerImages.get(appId)?.url;
  }

  /** Remembers one appdetails answer, dropping the oldest once the cache is full. */
  private rememberHeaderImage(appId: number, url: string | undefined): void {
    this.headerImages.delete(appId);
    this.headerImages.set(appId, { url });
    if (this.headerImages.size <= MAX_CACHED_HEADERS) return;
    const oldest = this.headerImages.keys().next();
    if (oldest.done !== true) this.headerImages.delete(oldest.value);
  }

  /**
   * The English and Russian short descriptions, fetched as two requests. Steam rate-limits appdetails at
   * roughly 200 calls per five minutes, which is why this runs on an explicit pick and never in a sweep.
   * A language Steam has nothing for is simply left out of the result.
   */
  async descriptions(
    ref: GameCandidateRef,
    signal?: AbortSignal,
  ): Promise<MetadataResult<LocalizedText>> {
    const appId = ref.steamAppId ?? steamAppIdFromKey(ref.key);
    if (appId === undefined) return { ok: false, message: 'not a Steam app' };
    const options = signal === undefined ? undefined : { signal };
    const [en, ru] = await Promise.all([
      this.deps.http.json(appDetailsUrl(appId, 'en'), appDetailsSchema, options),
      this.deps.http.json(appDetailsUrl(appId, 'ru'), appDetailsSchema, options),
    ]);
    if (!en.ok && !ru.ok) return en;
    // The same answer carries `header_image`; keeping it here spares the gallery a second call for a
    // game the user has just picked (descriptions are fetched on exactly that press).
    if (en.ok) {
      const named = en.value[String(appId)]?.data?.header_image;
      this.rememberHeaderImage(appId, named !== undefined && named.length > 0 ? named : undefined);
    }
    const text: LocalizedText = {
      ...(en.ok ? pickDescription(en.value, appId, 'en') : {}),
      ...(ru.ok ? pickDescription(ru.value, appId, 'ru') : {}),
    };
    return { ok: true, value: text };
  }
}

type AppDetailsAnswer = z.infer<typeof appDetailsSchema>;

/** The one entry appdetails answers with, reduced to `{ en: … }` / `{ ru: … }` (or nothing at all). */
function pickDescription(answer: AppDetailsAnswer, appId: number, locale: Locale): LocalizedText {
  const entry = answer[String(appId)];
  if (entry === undefined || !entry.success) return {};
  const raw = entry.data?.short_description ?? '';
  const text = sanitizeDescription(raw);
  if (text.length === 0) return {};
  return locale === 'ru' ? { ru: text } : { en: text };
}
