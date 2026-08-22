// What a metadata source must look like from the service's side, and the internal shapes the sources
// speak in.
//
// A provider answers with OFFERS, not with the renderer-facing types from shared/types.ts: an offer
// still carries the http(s) URLs behind a picture or a track. Turning those into a data: URL (the only
// image source the renderer's CSP allows) is MetadataService's job, and keeping the URLs on this side
// of that seam is what lets the renderer address everything by an opaque key — it never learns a URL,
// and can therefore never ask main to download one of its own choosing.
//
// Every method is optional: Steam searches, offers art and knows descriptions; SteamGridDB searches and
// offers art; Khinsider only knows music. The service asks whoever answers.
import { type SizeFloor } from '../../shared/artwork-filter';
import {
  type ArtworkKind,
  type GameCandidate,
  type GameDetails,
  type MetadataProviderId,
  type MetadataResult,
  type MusicAlbum,
  type MusicTrack,
} from '../../shared/types';

/**
 * What the service knows about a candidate when it asks a provider for more. Every reference the merge
 * collected travels together: the gallery of one game is built from whichever sources recognized it, and
 * a provider simply ignores a request that carries no reference of its own.
 */
export interface GameCandidateRef {
  readonly key: string;
  readonly title: string;
  readonly steamAppId?: number;
  readonly gogId?: string;
}

/** One offered picture, with the URLs the renderer must never see. */
export interface ArtworkOffer {
  readonly key: string;
  readonly kind: ArtworkKind;
  readonly provider: MetadataProviderId;
  readonly width?: number;
  readonly height?: number;
  /** Small picture shown in the gallery grid. */
  readonly thumbUrl: string;
  /** What gets downloaded when the user picks this variant (and what the lightbox shows). */
  readonly fullUrl: string;
}

/**
 * What a gallery page is asking a source for: which page, and the size floor the user set in the
 * sidebar. The floor is passed on rather than only applied afterwards — a source that can search by size
 * (Wallhaven does) fills a page of 4K wallpapers where filtering its answer would leave three tiles.
 */
export interface ArtworkRequest {
  readonly page: number;
  readonly minSize: SizeFloor;
}

/**
 * One page of a source's pictures, and whether that source can serve another behind it.
 *
 * Stated by the SOURCE rather than guessed from the count: a full page means "more" for Wallhaven (whose
 * answer names its last page) and means nothing for Steam (whose screenshots are simply all there is).
 * The gallery's "load more" tile is only shown when something is actually there to load.
 */
export interface ArtworkOffers {
  readonly offers: readonly ArtworkOffer[];
  readonly hasMore: boolean;
}

/** One offered track. The audio URL is NOT here: Khinsider only reveals it on the track's own page. */
export interface MusicTrackOffer {
  readonly key: string;
  readonly title: string;
  readonly sizeBytes?: number;
  /** The track page the audio URL is scraped from, when the source needs one more hop. */
  readonly pageUrl: string;
}

export interface MetadataProvider {
  readonly id: MetadataProviderId;
  /**
   * Whether this source can be used at all right now. Only SteamGridDB implements it: a missing key is
   * not a failure to report, it is a source that quietly does not take part.
   */
  available?(): boolean;
  search?(query: string, signal?: AbortSignal): Promise<MetadataResult<readonly GameCandidate[]>>;
  /** The candidate for an appid the caller already knows — the manifest's own `steam.appid`. */
  candidateByAppId?(appId: number, signal?: AbortSignal): Promise<MetadataResult<GameCandidate>>;
  /**
   * One page of what this source has for the game, 0-based. A source that serves everything it knows at
   * once (Steam's screenshots, GOG's, a SteamGridDB list) answers page 0 with the lot and every later
   * page with nothing — the service keeps what did not fit on screen and hands it out itself.
   */
  artwork?(
    ref: GameCandidateRef,
    kind: ArtworkKind,
    request: ArtworkRequest,
    signal?: AbortSignal,
  ): Promise<MetadataResult<ArtworkOffers>>;
  musicSearch?(query: string, signal?: AbortSignal): Promise<MetadataResult<readonly MusicAlbum[]>>;
  musicTracks?(
    albumKey: string,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly MusicTrackOffer[]>>;
  /** The direct audio URL of one track — the extra hop Khinsider's markup forces. */
  musicTrackUrl?(track: MusicTrackOffer, signal?: AbortSignal): Promise<MetadataResult<string>>;
  /**
   * Everything about the game that is not a picture. Named for what it began as — the descriptions — and
   * widened since: the same answers carry the genres, the date and the platforms, and dropping them
   * would mean asking again later for a game the user has already moved past.
   */
  details?(ref: GameCandidateRef, signal?: AbortSignal): Promise<MetadataResult<GameDetails>>;
}

/** `MusicTrack` as the renderer sees it — the page URL dropped. */
export function toMusicTrack(offer: MusicTrackOffer): MusicTrack {
  return offer.sizeBytes === undefined
    ? { key: offer.key, title: offer.title }
    : { key: offer.key, title: offer.title, sizeBytes: offer.sizeBytes };
}
