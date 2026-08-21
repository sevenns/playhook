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
import {
  type ArtworkKind,
  type GameCandidate,
  type LocalizedText,
  type MetadataProviderId,
  type MetadataResult,
  type MusicAlbum,
  type MusicTrack,
} from '../../shared/types';

/** What the service knows about a candidate when it asks a provider for more. */
export interface GameCandidateRef {
  readonly key: string;
  readonly title: string;
  readonly steamAppId?: number;
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
  search?(query: string, signal?: AbortSignal): Promise<MetadataResult<readonly GameCandidate[]>>;
  /** The candidate for an appid the caller already knows — the manifest's own `steam.appid`. */
  candidateByAppId?(appId: number, signal?: AbortSignal): Promise<MetadataResult<GameCandidate>>;
  artwork?(
    ref: GameCandidateRef,
    kind: ArtworkKind,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly ArtworkOffer[]>>;
  musicSearch?(query: string, signal?: AbortSignal): Promise<MetadataResult<readonly MusicAlbum[]>>;
  musicTracks?(
    albumKey: string,
    signal?: AbortSignal,
  ): Promise<MetadataResult<readonly MusicTrackOffer[]>>;
  /** The direct audio URL of one track — the extra hop Khinsider's markup forces. */
  musicTrackUrl?(track: MusicTrackOffer, signal?: AbortSignal): Promise<MetadataResult<string>>;
  descriptions?(
    ref: GameCandidateRef,
    signal?: AbortSignal,
  ): Promise<MetadataResult<LocalizedText>>;
}

/** `MusicTrack` as the renderer sees it — the page URL dropped. */
export function toMusicTrack(offer: MusicTrackOffer): MusicTrack {
  return offer.sizeBytes === undefined
    ? { key: offer.key, title: offer.title }
    : { key: offer.key, title: offer.title, sizeBytes: offer.sizeBytes };
}
