// RAWG.io — backgrounds for games that are not on Steam.
//
// Optional, and keyed like SteamGridDB: the key is free but personal, so it lives in Settings rather
// than in the repository, and with the field empty this provider simply does not take part. What it buys
// is the case Steam cannot cover at all — a game the store does not sell has no appdetails answer, and
// therefore no screenshots and no backdrop.
//
// Terms (rawg.io/tos_api, checked 2026-08-21): a free key allows 20 000 requests per month — per KEY, and
// every user brings their own, so the ceiling is theoretical — and requires ATTRIBUTION with a live link
// back to RAWG. That obligation is the project's, not this module's: see the README and the hint on the
// key's row in Settings.
import { z } from 'zod';
import { type ArtworkKind, type GameCandidate, type MetadataResult } from '../../shared/types';
import { type ArtworkOffer, type GameCandidateRef, type MetadataProvider } from './provider';
import { type HttpClient } from './http';

const API_ORIGIN = 'https://api.rawg.io/api';
/** A shortlist for the candidate menu — the full answer runs to twenty entries and pages beyond that. */
const SEARCH_PAGE_SIZE = 10;
/** Width the gallery's thumbnails are requested at through the media resizer (see thumbUrl). */
const THUMB_WIDTH = 640;

/** `rawg:<id>` — the candidate key, and what a later screenshots request is rebuilt from. */
export function rawgCandidateKey(id: number): string {
  return `rawg:${id}`;
}

/** `rawg:<id>` back to an id. Undefined for a key that belongs to another provider. */
export function rawgIdFromKey(key: string): number | undefined {
  const match = /^rawg:(\d+)$/.exec(key);
  if (match === null) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function searchUrl(term: string, apiKey: string): string {
  return `${API_ORIGIN}/games?search=${encodeURIComponent(term)}&page_size=${SEARCH_PAGE_SIZE}&key=${encodeURIComponent(apiKey)}`;
}

export function screenshotsUrl(gameId: number, apiKey: string): string {
  return `${API_ORIGIN}/games/${gameId}/screenshots?key=${encodeURIComponent(apiKey)}`;
}

/**
 * The gallery's thumbnail for a RAWG picture. The `/screenshots` endpoint hands out full-size images
 * only, and a grid of those is megabytes per game — RAWG's media host answers a `resize/<width>/-/`
 * segment with a scaled copy, which is what this builds.
 *
 * The pattern is UNDOCUMENTED, so it is used as an optimization and never as a requirement: a URL that
 * does not match the media host is passed through untouched, and the gallery drops a thumbnail that
 * fails to load anyway. If RAWG drops the pattern, galleries get heavier — they do not break.
 */
export function thumbUrl(fullUrl: string, width = THUMB_WIDTH): string {
  const marker = '/media/';
  const at = fullUrl.indexOf(marker);
  if (!fullUrl.startsWith('https://media.rawg.io/') || at === -1) return fullUrl;
  const tail = fullUrl.slice(at + marker.length);
  if (tail.startsWith('resize/')) return fullUrl; // already a resized URL — leave it alone
  return `${fullUrl.slice(0, at + marker.length)}resize/${width}/-/${tail}`;
}

const searchSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1),
        background_image: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

const screenshotsSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.number().int().nonnegative(),
        image: z.string().min(1),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      }),
    )
    .default([]),
});

type RawgShot = z.infer<typeof screenshotsSchema>['results'][number];

/** RAWG's screenshot rows as offers. Dimensions are kept when stated — unlike Steam, RAWG states them. */
export function toArtworkOffers(
  gameId: number,
  shots: readonly RawgShot[],
): readonly ArtworkOffer[] {
  return shots.map((shot) => ({
    key: `rawg:${gameId}:shot-${shot.id}`,
    kind: 'hero' as const,
    provider: 'rawg' as const,
    ...(shot.width === undefined ? {} : { width: shot.width }),
    ...(shot.height === undefined ? {} : { height: shot.height }),
    thumbUrl: thumbUrl(shot.image),
    fullUrl: shot.image,
  }));
}

export interface RawgDeps {
  readonly http: HttpClient;
  /** Read live: a key pasted in Settings mid-session applies to the very next search. */
  readonly apiKey: () => string;
}

export class RawgProvider implements MetadataProvider {
  readonly id = 'rawg' as const;
  /** The `background_image` a search already returned, so opening the gallery does not re-search. */
  private readonly backdrops = new Map<number, string>();

  constructor(private readonly deps: RawgDeps) {}

  /** Whether a key has been entered at all. Without one the provider contributes nothing, silently. */
  available(): boolean {
    return this.deps.apiKey().trim().length > 0;
  }

  async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly GameCandidate[]>> {
    const key = this.key();
    if (key === undefined) return { ok: true, value: [] };
    const answer = await this.deps.http.json(
      searchUrl(query, key),
      searchSchema,
      signal === undefined ? undefined : { signal },
    );
    if (!answer.ok) return answer;
    for (const game of answer.value.results) {
      const backdrop = game.background_image;
      if (backdrop !== null && backdrop !== undefined && backdrop.length > 0) {
        this.backdrops.set(game.id, backdrop);
      }
    }
    return {
      ok: true,
      value: answer.value.results.map((game) => ({
        key: rawgCandidateKey(game.id),
        title: game.name,
        provider: this.id,
        rawgId: game.id,
      })),
    };
  }

  /** Backgrounds only: covers are Steam's and SteamGridDB's job, and RAWG's are the wrong proportions. */
  async artwork(
    ref: GameCandidateRef,
    kind: ArtworkKind,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly ArtworkOffer[]>> {
    if (kind !== 'hero') return { ok: true, value: [] };
    const key = this.key();
    if (key === undefined) return { ok: true, value: [] };
    const gameId = ref.rawgId ?? rawgIdFromKey(ref.key);
    if (gameId === undefined) return { ok: true, value: [] };
    const answer = await this.deps.http.json(
      screenshotsUrl(gameId, key),
      screenshotsSchema,
      signal === undefined ? undefined : { signal },
    );
    if (!answer.ok) return answer;
    const offers = toArtworkOffers(gameId, answer.value.results);
    const backdrop = this.backdrops.get(gameId);
    if (backdrop === undefined) return { ok: true, value: offers };
    // The card's own background image leads: it is the picture RAWG itself picked to represent the game.
    return {
      ok: true,
      value: [
        {
          key: `rawg:${gameId}:backdrop`,
          kind: 'hero',
          provider: this.id,
          thumbUrl: thumbUrl(backdrop),
          fullUrl: backdrop,
        },
        ...offers,
      ],
    };
  }

  /** The trimmed key, or undefined when there is none — the provider's whole on/off switch. */
  private key(): string | undefined {
    const key = this.deps.apiKey().trim();
    return key.length > 0 ? key : undefined;
  }
}
