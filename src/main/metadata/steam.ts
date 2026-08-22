// Steam as a metadata source: the store's search endpoint for "which game is this", the CDN for its
// artwork, and appdetails for the descriptions.
//
// Both endpoints are UNOFFICIAL — no key, no documentation, no promise they will keep their shape. That
// is why every answer is validated with zod and every failure comes back as a Result: when Steam changes
// something, this feature degrades to "nothing found" and the launcher carries on.
//
// The COVER comes from the CDN, built from the appid: that is the only way to reach `library_600x900`,
// which appdetails does not name.
//
// The BACKGROUNDS do not come from the CDN at all. `library_hero.jpg` is a 3840x1240 banner made for the
// strip above a Steam library page (~3:1), and this launcher paints a full-screen background on a ~16:10
// display — the banner loses about half its width to the crop and its centred composition falls apart.
// So backgrounds are taken from what appdetails names instead: `background_raw` (the store page's own
// art backdrop, ~16:9) first, then the screenshots. Screenshots are gameplay rather than art, which is a
// different KIND of picture — the gallery lets the user judge that, it is not ours to decide.
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
import { log } from '../logger';

const STORE_ORIGIN = 'https://store.steampowered.com';
const CDN_ORIGIN = 'https://cdn.cloudflare.steamstatic.com';
/** Descriptions are stored in a manifest the user may open in a text editor — keep them readable. */
const MAX_DESCRIPTION_CHARS = 2000;
/** How many appdetails answers the provider remembers. One session looks at a handful of games. */
const MAX_CACHED_APPS = 50;

/**
 * The STORE REGION every request is made from, regardless of where the user is.
 *
 * `cc` decides what the store considers available, not what language it answers in — and a region where
 * a game is not sold makes Steam behave as though the game did not exist: `storesearch` leaves it out of
 * the results entirely, and `appdetails` answers `success: false` with no data at all. That is a
 * catalogue hole, not a localization: a Russian region hides plenty of Western releases, and the launcher
 * would show a user "nothing found" for a game they have installed and are looking at.
 *
 * The language is a separate parameter and keeps following the UI (see storeLanguage), so Russian titles
 * and Russian descriptions are unaffected — verified against the endpoints: `l=russian&cc=US` returns
 * both the Russian text and the games `cc=RU` hides. Prices and regional availability are the only things
 * `cc` changes for real, and this feature reads neither.
 */
const STORE_COUNTRY = 'US';

/** The `l` a locale searches and reads with. Searching a Russian title with `l=english` finds nothing. */
export function storeLanguage(locale: Locale): string {
  return locale === 'ru' ? 'russian' : 'english';
}

/** `storesearch` — the store's own type-ahead, and the only keyless way to turn a title into an appid. */
export function storeSearchUrl(term: string, locale: Locale): string {
  return `${STORE_ORIGIN}/api/storesearch/?term=${encodeURIComponent(term)}&l=${storeLanguage(locale)}&cc=${STORE_COUNTRY}`;
}

/** `appdetails` for ONE language — the caller asks twice (en + ru) to fill a LocalizedText. */
export function appDetailsUrl(appId: number, locale: Locale): string {
  return `${STORE_ORIGIN}/api/appdetails?appids=${appId}&l=${storeLanguage(locale)}&cc=${STORE_COUNTRY}`;
}

/** The portrait cover (600x900) — the grid image the carousel wants. `2x` is the same art at 1200x1800. */
export function libraryGridUrl(appId: number, doubled = false): string {
  return `${CDN_ORIGIN}/steam/apps/${appId}/library_600x900${doubled ? '_2x' : ''}.jpg`;
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
        /** The store page's art backdrop. Optional — plenty of apps have none. */
        background_raw: z.string().optional(),
        /**
         * Gameplay screenshots. No dimensions are stated anywhere in the answer, and the `.1920x1080.`
         * in a path is a BOUNDING BOX rather than a promise: an old game's shot comes back 1024x768.
         * That is why the variants built from these carry no width/height at all.
         */
        screenshots: z
          .array(
            z.object({
              id: z.number().int().nonnegative(),
              path_thumbnail: z.string().optional(),
              path_full: z.string().optional(),
            }),
          )
          .optional(),
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

type AppDetailsAnswer = z.infer<typeof appDetailsSchema>;

/** One screenshot as the gallery needs it: a thumbnail to show and a full size to apply. */
export interface SteamScreenshot {
  readonly id: number;
  readonly thumb: string;
  readonly full: string;
}

/** The picture fields of one appdetails answer, reduced to what the gallery builds its variants from. */
export interface SteamAppArt {
  /** The store page's art backdrop, when the app has one. */
  readonly backdrop?: string;
  readonly screenshots: readonly SteamScreenshot[];
  /**
   * The game's name as the ENGLISH store spells it. Only ever filled from an `l=english` answer, because
   * that is its whole purpose: the wallpaper source searches English words, and a localized name finds
   * nothing there. Absent when the only answer seen so far came back in another language.
   */
  readonly englishName?: string;
}

/**
 * The art of one app, out of an appdetails answer. A screenshot with no full-size path is dropped: it is
 * the picture the user would end up applying, and half an entry is worse than none. A missing thumbnail
 * falls back to the full size — the gallery then downloads more than it needs, which beats a blank tile.
 */
export function toAppArt(
  answer: AppDetailsAnswer,
  appId: number,
  options?: { readonly english?: boolean },
): SteamAppArt {
  const entry = answer[String(appId)];
  const data = entry?.success === true ? entry.data : undefined;
  const backdrop = data?.background_raw;
  const screenshots = (data?.screenshots ?? []).flatMap((shot) => {
    const full = shot.path_full;
    if (full === undefined || full.length === 0) return [];
    return [{ id: shot.id, thumb: shot.path_thumbnail ?? full, full }];
  });
  const name = options?.english === true ? data?.name : undefined;
  return {
    ...(backdrop !== undefined && backdrop.length > 0 ? { backdrop } : {}),
    ...(name !== undefined && name.length > 0 ? { englishName: name } : {}),
    screenshots,
  };
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
   * What appdetails said about each app's pictures, so the gallery never asks twice. "This app names no
   * background at all" is a real answer and is cached as one — re-asking would spend a rate limit to
   * learn the same nothing.
   */
  private readonly appArtwork = new Map<number, SteamAppArt>();

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
    if (kind === 'hero') return { ok: true, value: await this.backgrounds(appId, signal) };
    return { ok: true, value: await this.covers(appId, signal) };
  }

  /**
   * The two CDN covers, each offered only once its full-size file is known to exist: `library_600x900`
   * is simply absent for many older apps, and a tile whose apply would 404 is worse than one tile fewer.
   */
  private async covers(appId: number, signal?: AbortSignal): Promise<readonly ArtworkOffer[]> {
    const options = signal === undefined ? undefined : { signal };
    const candidates: readonly ArtworkOffer[] = [
      {
        key: `steam:${appId}:grid-2x`,
        kind: 'grid',
        provider: this.id,
        width: 1200,
        height: 1800,
        thumbUrl: libraryGridUrl(appId),
        fullUrl: libraryGridUrl(appId, true),
      },
      {
        key: `steam:${appId}:grid`,
        kind: 'grid',
        provider: this.id,
        width: 600,
        height: 900,
        thumbUrl: libraryGridUrl(appId),
        fullUrl: libraryGridUrl(appId),
      },
    ];
    const present: ArtworkOffer[] = [];
    for (const offer of candidates) {
      if (await this.deps.http.exists(offer.fullUrl, options)) present.push(offer);
    }
    return present;
  }

  /**
   * The backgrounds appdetails names: the art backdrop first, then the screenshots in the order Steam
   * lists them. No existence check is needed here — unlike the CDN templates, these URLs came FROM the
   * answer, and a screenshot's thumbnail and full size are the same asset in two sizes, so the "the
   * thumbnail is there but the full size 404s" mismatch the covers guard against cannot occur.
   *
   * An app with no screenshots and no backdrop — and a delisted one, where appdetails answers
   * `success: false` — simply yields nothing, which the gallery states as "nothing found".
   */
  private async backgrounds(appId: number, signal?: AbortSignal): Promise<readonly ArtworkOffer[]> {
    const art = await this.appArt(appId, signal);
    if (art === undefined) return [];
    const offers: ArtworkOffer[] = [];
    if (art.backdrop !== undefined) {
      offers.push({
        key: `steam:${appId}:backdrop`,
        kind: 'hero',
        provider: this.id,
        thumbUrl: art.backdrop,
        fullUrl: art.backdrop,
      });
    }
    for (const shot of art.screenshots) {
      offers.push({
        key: `steam:${appId}:shot-${shot.id}`,
        kind: 'hero',
        provider: this.id,
        thumbUrl: shot.thumb,
        fullUrl: shot.full,
      });
    }
    return offers;
  }

  /**
   * The art fields of one appdetails answer, cached for the session. The cache is what keeps this
   * endpoint's rate limit (~200 calls / 5 minutes) comfortable: the gallery, a re-open of it and the
   * descriptions all ask about the same game, and the descriptions fill this cache on their way through.
   */
  private async appArt(appId: number, signal?: AbortSignal): Promise<SteamAppArt | undefined> {
    const cached = this.appArtwork.get(appId);
    if (cached !== undefined) return cached;
    const details = await this.deps.http.json(
      appDetailsUrl(appId, this.deps.locale()),
      appDetailsSchema,
      signal === undefined ? undefined : { signal },
    );
    if (!details.ok) {
      log.warn(`[metadata] appdetails failed for ${appId}: ${details.message}`);
      return undefined; // not cached: a failed call says nothing about the app
    }
    const art = this.rememberArt(appId, details.value, { english: this.deps.locale() === 'en' });
    // A store that answers `success: false` — a delisted app, or one the request's region does not sell —
    // looks exactly like a successful call with nothing in it. Worth a line: it is the difference between
    // "this game has no pictures" and "this store will not talk about this game".
    if (art.backdrop === undefined && art.screenshots.length === 0) {
      log.warn(`[metadata] appdetails returned no artwork for ${appId}`);
    }
    return art;
  }

  /**
   * Extracts the art fields from an answer already in hand and caches them, dropping the oldest. An
   * entry that already holds an English name keeps it: a later answer in another language knows the
   * pictures just as well, but its `name` is not the one the wallpaper search needs.
   */
  private rememberArt(
    appId: number,
    answer: AppDetailsAnswer,
    options?: { readonly english?: boolean },
  ): SteamAppArt {
    const known = this.appArtwork.get(appId)?.englishName;
    const fresh = toAppArt(answer, appId, options);
    const art: SteamAppArt =
      fresh.englishName === undefined && known !== undefined
        ? { ...fresh, englishName: known }
        : fresh;
    this.appArtwork.delete(appId);
    this.appArtwork.set(appId, art);
    if (this.appArtwork.size > MAX_CACHED_APPS) {
      const oldest = this.appArtwork.keys().next();
      if (oldest.done !== true) this.appArtwork.delete(oldest.value);
    }
    return art;
  }

  /**
   * The game's English name, if an English appdetails answer for it has been seen this session — which
   * it has as soon as the user picks the candidate, since the descriptions are fetched right then.
   * Handed to the wallpaper source, whose search only understands English words.
   */
  englishTitle(ref: GameCandidateRef): string | undefined {
    const appId = ref.steamAppId ?? steamAppIdFromKey(ref.key);
    if (appId === undefined) return undefined;
    return this.appArtwork.get(appId)?.englishName;
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
    // The same answer carries the backdrop and the screenshots; keeping them here spares the gallery a
    // second call for a game the user has just picked (descriptions are fetched on exactly that press).
    if (en.ok) this.rememberArt(appId, en.value, { english: true });
    const text: LocalizedText = {
      ...(en.ok ? pickDescription(en.value, appId, 'en') : {}),
      ...(ru.ok ? pickDescription(ru.value, appId, 'ru') : {}),
    };
    return { ok: true, value: text };
  }
}

/** The one entry appdetails answers with, reduced to `{ en: … }` / `{ ru: … }` (or nothing at all). */
function pickDescription(answer: AppDetailsAnswer, appId: number, locale: Locale): LocalizedText {
  const entry = answer[String(appId)];
  if (entry === undefined || !entry.success) return {};
  const raw = entry.data?.short_description ?? '';
  const text = sanitizeDescription(raw);
  if (text.length === 0) return {};
  return locale === 'ru' ? { ru: text } : { en: text };
}
