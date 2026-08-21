// SteamGridDB — the community art database, and the only source of ALTERNATIVE covers and backgrounds
// (Steam offers exactly one of each, and nothing at all for a non-Steam game).
//
// Unlike the Steam endpoints this one has a documented API v2 and REQUIRES a key. Playhook ships none:
// an open-source repository cannot carry a secret, so the key is the user's own, typed into Settings.
// With the field empty the provider reports itself unavailable and the whole feature degrades to
// Steam-only — no error, no prompt, just fewer variants.
import { z } from 'zod';
import { type ArtworkKind, type GameCandidate, type MetadataResult } from '../../shared/types';
import { type ArtworkOffer, type GameCandidateRef, type MetadataProvider } from './provider';
import { type HttpClient } from './http';

const API_ORIGIN = 'https://www.steamgriddb.com/api/v2';
/** The launcher's cover geometry — anything else would be letterboxed in the carousel. */
const GRID_DIMENSIONS = '600x900';

/** `sgdb:<gameId>` — the candidate key for a game this database knows but Steam's search did not. */
export function sgdbCandidateKey(gameId: number): string {
  return `sgdb:${gameId}`;
}

/** `sgdb:<gameId>` back to a game id. Undefined for a key that belongs to another provider. */
export function sgdbGameIdFromKey(key: string): number | undefined {
  const match = /^sgdb:(\d+)$/.exec(key);
  if (match === null) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function autocompleteUrl(term: string): string {
  return `${API_ORIGIN}/search/autocomplete/${encodeURIComponent(term)}`;
}

/**
 * The art endpoints accept EITHER the database's own game id or a Steam appid, addressed by platform.
 * Going straight at `steam/<appid>` for a Steam candidate saves the `/games/steam/<appid>` hop that
 * would otherwise only translate one id into the other.
 */
export function artworkUrl(kind: ArtworkKind, ref: SgdbArtRef): string {
  const endpoint = kind === 'grid' ? 'grids' : 'heroes';
  const target = ref.kind === 'steam' ? `steam/${ref.id}` : `game/${ref.id}`;
  const query = kind === 'grid' ? `?dimensions=${GRID_DIMENSIONS}` : '';
  return `${API_ORIGIN}/${endpoint}/${target}${query}`;
}

/** Which id an art request is addressed by — the database's own, or a Steam appid. */
export type SgdbArtRef = { readonly kind: 'steam' | 'game'; readonly id: number };

const searchSchema = z.object({
  success: z.boolean(),
  data: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1),
      }),
    )
    .default([]),
});

const artworkSchema = z.object({
  success: z.boolean(),
  data: z
    .array(
      z.object({
        id: z.number().int().positive(),
        url: z.string().min(1),
        thumb: z.string().min(1),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      }),
    )
    .default([]),
});

type SgdbArtItem = z.infer<typeof artworkSchema>['data'][number];

/** The database's art rows as offers. The `id` is the art's, not the game's — one game has many. */
export function toArtworkOffers(
  items: readonly SgdbArtItem[],
  kind: ArtworkKind,
): readonly ArtworkOffer[] {
  return items.map((item) => ({
    key: `sgdb:art:${item.id}`,
    kind,
    provider: 'steamgriddb' as const,
    ...(item.width === undefined ? {} : { width: item.width }),
    ...(item.height === undefined ? {} : { height: item.height }),
    thumbUrl: item.thumb,
    fullUrl: item.url,
  }));
}

export interface SteamGridDbDeps {
  readonly http: HttpClient;
  /** Read live: the user can paste a key while the app runs, and the next search must already use it. */
  readonly apiKey: () => string;
}

export class SteamGridDbProvider implements MetadataProvider {
  readonly id = 'steamgriddb' as const;

  constructor(private readonly deps: SteamGridDbDeps) {}

  /** Whether a key has been entered at all. The service skips this provider entirely when it has not. */
  available(): boolean {
    return this.deps.apiKey().trim().length > 0;
  }

  async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly GameCandidate[]>> {
    const options = this.options(signal);
    if (options === undefined) return { ok: true, value: [] };
    const answer = await this.deps.http.json(autocompleteUrl(query), searchSchema, options);
    if (!answer.ok) return answer;
    return {
      ok: true,
      value: answer.value.data.map((item) => ({
        key: sgdbCandidateKey(item.id),
        title: item.name,
        provider: this.id,
      })),
    };
  }

  async artwork(
    ref: GameCandidateRef,
    kind: ArtworkKind,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly ArtworkOffer[]>> {
    const options = this.options(signal);
    if (options === undefined) return { ok: true, value: [] };
    const target = this.artRef(ref);
    if (target === undefined) return { ok: true, value: [] };
    const answer = await this.deps.http.json(artworkUrl(kind, target), artworkSchema, options);
    if (!answer.ok) return answer;
    return { ok: true, value: toArtworkOffers(answer.value.data, kind) };
  }

  /** A Steam candidate is addressed by its appid; anything else must carry an `sgdb:` key of its own. */
  private artRef(ref: GameCandidateRef): SgdbArtRef | undefined {
    if (ref.steamAppId !== undefined) return { kind: 'steam', id: ref.steamAppId };
    const gameId = sgdbGameIdFromKey(ref.key);
    return gameId === undefined ? undefined : { kind: 'game', id: gameId };
  }

  /** The authorized request options, or undefined when there is no key to authorize with. */
  private options(
    signal?: AbortSignal,
  ): { headers: Record<string, string>; signal?: AbortSignal } | undefined {
    const key = this.deps.apiKey().trim();
    if (key.length === 0) return undefined;
    const headers = { Authorization: `Bearer ${key}` };
    return signal === undefined ? { headers } : { headers, signal };
  }
}
