// The service behind the "Find online" flow: it owns the providers, the per-session caches, and the one
// place where something fetched from the internet becomes a file inside the user's card or library.
//
// Three responsibilities are worth naming, because they are what the renderer cannot be trusted with:
//
//  • URLs never leave main. The renderer addresses a candidate, a picture or a track by an opaque key
//    this service handed it; the key resolves against a bounded in-memory map here. So "download this"
//    can only ever mean one of the URLs a provider offered during this session.
//  • Bytes reach the renderer as data: URLs only — its CSP allows no other image or media source, the
//    same rule the hero and the carousel art already live under.
//  • A downloaded file is written under a name derived from ITS OWN BYTES (see media-type.ts) and a
//    path derived from the manifest's deterministic asset names, never from anything the source said.
//
// Registered like GameConfigService: one init() that installs every metadata:* handler.
import path from 'node:path';
import fse from 'fs-extra';
import { ipcMain } from 'electron';
import {
  IPC,
  type ArtworkKind,
  type ArtworkVariant,
  type GameCandidate,
  type LocalizedText,
  type MetadataApplyRequest,
  type MetadataApplyResult,
  type MetadataProviderId,
  type MetadataResult,
  type MusicAlbum,
  type MusicTrack,
} from '../../shared/types';
import { type Translator } from '../../shared/i18n/index';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS } from '../asset-reader';
import { resolveInside } from '../manifest';
import { type PcLibraryStore } from '../pc-library';
import { log } from '../logger';
import { describe } from '../util';
import { applyRelativePath, stalePathsFor, validateApply, type ApplyTarget } from './apply-target';
import { sniffMedia, type MediaKind } from './media-type';
import { type HttpClient } from './http';
import {
  type ArtworkOffer,
  type GameCandidateRef,
  type MetadataProvider,
  type MusicTrackOffer,
  toMusicTrack,
} from './provider';

/** The same caps the manual import enforces (pc-library.ts) — a download is not a reason to relax them. */
const MAX_BYTES: Readonly<Record<MediaKind, number>> = {
  image: 32 * 1024 * 1024,
  audio: 64 * 1024 * 1024,
};
/** A gallery thumbnail. Generous for a 600x900 cover, small enough that a stray full-size file trips it. */
const MAX_THUMB_BYTES = 8 * 1024 * 1024;
/** How many thumbnails are fetched at once — the concurrency the carousel's art cache settled on. */
const THUMB_CONCURRENCY = 3;
/** How many keys each map remembers. Bounded for the reason card-art's LRU is: a session is unbounded. */
const CACHE_LIMIT = 300;
/**
 * How many pictures ONE source may offer for one game. SteamGridDB answers with everything the community
 * uploaded — for a popular game that is dozens of covers, every one of which would be downloaded as a
 * thumbnail and held in the renderer as a data: URL until the gallery closes. A gallery is a shortlist,
 * not an archive, and what gets dropped is logged rather than silently swallowed.
 */
const MAX_ARTWORK_PER_PROVIDER = 24;

/**
 * The order sources appear in the gallery, best-suited first. Fixed rather than "whoever answered
 * first": the answers arrive in parallel, and a gallery that reshuffles itself between two visits to the
 * same game is a gallery the user cannot navigate from memory.
 */
const PROVIDER_ORDER: readonly MetadataProviderId[] = [
  'steam',
  'steamgriddb',
  'gog',
  'rawg',
  'khinsider',
];
/** Where a full-size download lands before it is checked and moved into place. */
const DOWNLOADS_DIRNAME = 'downloads';

/**
 * A Map that forgets its oldest entry once it is full — the same shape (and the same reason) as the
 * renderer's card-art cache. Re-reading a key refreshes it, so the keys a screen is actually using stay.
 */
class BoundedMap<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly limit: number) {}

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size <= this.limit) return;
    const oldest = this.entries.keys().next();
    if (oldest.done !== true) this.entries.delete(oldest.value);
  }
}

export interface MetadataDeps {
  readonly http: HttpClient;
  /** Every source, in the order their answers are merged. A provider answers only what it knows. */
  readonly providers: readonly MetadataProvider[];
  /** `<userData>/metadata-cache` — scratch space for downloads, cleared at startup. */
  readonly cacheDir: string;
  readonly pcLibrary: PcLibraryStore;
  /** The same "may this app write there?" check every gameConfig:* write runs (GameConfigService). */
  readonly isAllowedRoot: (root: string) => Promise<boolean>;
  /** The current translator — the messages here are shown to the user as they are. */
  readonly getTranslator: () => Translator;
}

export class MetadataService {
  private readonly candidates = new BoundedMap<GameCandidate>(CACHE_LIMIT);
  private readonly artwork = new BoundedMap<ArtworkOffer>(CACHE_LIMIT);
  private readonly tracks = new BoundedMap<MusicTrackOffer>(CACHE_LIMIT);
  private readonly thumbs = new BoundedMap<string>(CACHE_LIMIT);
  /**
   * Everything currently in flight. `metadata:cancel` aborts the lot: the user pressed Back, and every
   * request that is still running belongs to the surface they just left.
   */
  private readonly inFlight = new Set<AbortController>();

  constructor(private readonly deps: MetadataDeps) {}

  /** Registers every metadata:* handler once (the service is a singleton, like GameConfigService). */
  init(): void {
    ipcMain.handle(
      IPC.metadataSearch,
      (_event, query: unknown): Promise<MetadataResult<readonly GameCandidate[]>> =>
        this.search(typeof query === 'string' ? query : ''),
    );
    ipcMain.handle(
      IPC.metadataSteamCandidate,
      (_event, appId: unknown): Promise<MetadataResult<GameCandidate>> =>
        this.steamCandidate(typeof appId === 'number' ? appId : 0),
    );
    ipcMain.handle(
      IPC.metadataArtwork,
      (
        _event,
        payload: { readonly candidateKey: string; readonly kind: ArtworkKind },
      ): Promise<MetadataResult<readonly ArtworkVariant[]>> =>
        this.artworkFor(payload.candidateKey, payload.kind),
    );
    ipcMain.handle(
      IPC.metadataArtworkPreview,
      (_event, variantKey: unknown): Promise<MetadataResult<string>> =>
        this.fullPreview(typeof variantKey === 'string' ? variantKey : ''),
    );
    ipcMain.handle(
      IPC.metadataMusicAlbums,
      (_event, query: unknown): Promise<MetadataResult<readonly MusicAlbum[]>> =>
        this.musicAlbums(typeof query === 'string' ? query : ''),
    );
    ipcMain.handle(
      IPC.metadataMusicTracks,
      (_event, albumKey: unknown): Promise<MetadataResult<readonly MusicTrack[]>> =>
        this.musicTracks(typeof albumKey === 'string' ? albumKey : ''),
    );
    ipcMain.handle(
      IPC.metadataTrackPreview,
      (_event, trackKey: unknown): Promise<MetadataResult<string>> =>
        this.trackPreview(typeof trackKey === 'string' ? trackKey : ''),
    );
    ipcMain.handle(
      IPC.metadataDescriptions,
      (_event, candidateKey: unknown): Promise<MetadataResult<LocalizedText>> =>
        this.descriptions(typeof candidateKey === 'string' ? candidateKey : ''),
    );
    ipcMain.handle(
      IPC.metadataApply,
      (_event, request: MetadataApplyRequest): Promise<MetadataApplyResult> => this.apply(request),
    );
    ipcMain.on(IPC.metadataCancel, () => this.cancelAll());
  }

  /**
   * Empties the download scratch directory. Called at startup: a download interrupted by a crash (or by
   * the user quitting mid-fetch) has no owner afterwards, and nothing else ever reads these files.
   */
  async clearCache(): Promise<void> {
    try {
      await fse.remove(path.join(this.deps.cacheDir, DOWNLOADS_DIRNAME));
    } catch (cause) {
      log.warn('[metadata] could not clear the download cache:', describe(cause));
    }
  }

  /** Aborts everything in flight — the renderer's Back. */
  cancelAll(): void {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
  }

  /**
   * Every source's answer to one query, merged. A game that both Steam and SteamGridDB know appears
   * ONCE: the Steam entry wins, because it is the one that carries an appid — and the appid is what the
   * CDN art and the descriptions are addressed by.
   */
  private async search(query: string): Promise<MetadataResult<readonly GameCandidate[]>> {
    const term = query.trim();
    if (term.length === 0) return { ok: true, value: [] };
    const answers = await this.fromProviders((provider, signal) => provider.search?.(term, signal));
    if (answers.length === 0) return { ok: false, message: this.t('metadata.noSources') };
    const failures = answers.filter((answer) => !answer.ok);
    const found = answers.flatMap((answer) => (answer.ok ? [...answer.value] : []));
    if (found.length === 0 && failures.length > 0) return failures[0] ?? { ok: true, value: [] };
    const merged = mergeCandidates(found);
    for (const candidate of merged) this.candidates.set(candidate.key, candidate);
    return { ok: true, value: merged };
  }

  /**
   * The candidate for an appid the manifest already names. Cached like a searched one, so every later
   * request (artwork, descriptions) is addressed exactly as it would be after a search.
   */
  private async steamCandidate(appId: number): Promise<MetadataResult<GameCandidate>> {
    const answers = await this.fromProviders((provider, signal) =>
      provider.candidateByAppId?.(appId, signal),
    );
    const found = answers.find((answer) => answer.ok);
    if (found === undefined || !found.ok) {
      const failure = answers.find((answer) => !answer.ok);
      return failure !== undefined && !failure.ok
        ? failure
        : { ok: false, message: this.t('metadata.noSources') };
    }
    const enriched = await this.withOtherSources(found.value);
    this.candidates.set(enriched.key, enriched);
    return { ok: true, value: enriched };
  }

  /**
   * Fills in the references the OTHER sources have for a game that arrived from one of them alone.
   *
   * Skipping the search is the whole point of the appid shortcut, but the search is also where the merge
   * happens — so without this a Steam game reached that way would be offered Steam's backgrounds and
   * nothing else, however many the other sources hold. The extra searches are best-effort: they run on
   * one explicit press, and a source that fails simply contributes no reference.
   */
  private async withOtherSources(candidate: GameCandidate): Promise<GameCandidate> {
    const answers = await this.fromProviders((provider, signal) =>
      provider.id === candidate.provider ? undefined : provider.search?.(candidate.title, signal),
    );
    return withMergedRefs(
      candidate,
      answers.flatMap((answer) => (answer.ok ? [...answer.value] : [])),
    );
  }

  /**
   * The gallery for one candidate: every source's offers, with their thumbnails already downloaded and
   * encoded. A thumbnail that cannot be fetched drops its variant rather than showing an empty tile —
   * whatever is wrong with it would be wrong with the full-size download too.
   */
  private async artworkFor(
    candidateKey: string,
    kind: ArtworkKind,
  ): Promise<MetadataResult<readonly ArtworkVariant[]>> {
    const ref = this.candidates.get(candidateKey);
    if (ref === undefined) return { ok: false, message: this.t('metadata.staleSelection') };
    const answers = await this.fromProviders((provider, signal) =>
      provider.artwork?.(toCandidateRef(ref), kind, signal),
    );
    const offers = answers.flatMap((answer) => (answer.ok ? [...answer.value] : []));
    if (offers.length === 0) {
      const failure = answers.find((answer) => !answer.ok);
      if (failure !== undefined && !failure.ok) return failure;
      // Nothing at all, and one source that could have answered is switched off for want of a key. Say
      // so: "nothing found" would send the user looking for a different game, not for the setting.
      if (kind === 'hero' && this.isDisabledForKey('rawg')) {
        return { ok: false, message: this.t('metadata.noArtworkNeedsRawgKey') };
      }
      return { ok: true, value: [] };
    }
    const shown = capArtworkPerProvider(orderByProvider(offers), MAX_ARTWORK_PER_PROVIDER);
    if (shown.length < offers.length) {
      log.info(
        `[metadata] showing ${shown.length} of ${offers.length} ${kind} variants (${MAX_ARTWORK_PER_PROVIDER} per source)`,
      );
    }
    for (const offer of shown) this.artwork.set(offer.key, offer);
    const variants = await this.withThumbnails(shown);
    return { ok: true, value: variants };
  }

  /** One variant at full size, for the lightbox. Downloaded on demand and never kept on disk. */
  private async fullPreview(variantKey: string): Promise<MetadataResult<string>> {
    const offer = this.artwork.get(variantKey);
    if (offer === undefined) return { ok: false, message: this.t('metadata.staleSelection') };
    const bytes = await this.run((signal) =>
      this.deps.http.bytes(offer.fullUrl, MAX_BYTES.image, { signal }),
    );
    if (!bytes.ok) {
      log.warn(`[metadata] full-size preview failed: ${bytes.message}`);
      return { ok: false, message: this.t('metadata.downloadFailed') };
    }
    const sniffed = sniffMedia(bytes.value.bytes);
    if (sniffed === null || sniffed.kind !== 'image') {
      return { ok: false, message: this.t('metadata.downloadFailed') };
    }
    return { ok: true, value: toDataUrl(sniffed, bytes.value.bytes) };
  }

  private async musicAlbums(query: string): Promise<MetadataResult<readonly MusicAlbum[]>> {
    const term = query.trim();
    if (term.length === 0) return { ok: true, value: [] };
    const answers = await this.fromProviders((provider, signal) =>
      provider.musicSearch?.(term, signal),
    );
    if (answers.length === 0) return { ok: false, message: this.t('metadata.noSources') };
    const failure = answers.find((answer) => !answer.ok);
    const albums = answers.flatMap((answer) => (answer.ok ? [...answer.value] : []));
    if (albums.length === 0 && failure !== undefined && !failure.ok) return failure;
    return { ok: true, value: albums };
  }

  private async musicTracks(albumKey: string): Promise<MetadataResult<readonly MusicTrack[]>> {
    if (albumKey.length === 0) return { ok: true, value: [] };
    const answers = await this.fromProviders((provider, signal) =>
      provider.musicTracks?.(albumKey, signal),
    );
    if (answers.length === 0) return { ok: false, message: this.t('metadata.noSources') };
    const failure = answers.find((answer) => !answer.ok);
    const offers = answers.flatMap((answer) => (answer.ok ? [...answer.value] : []));
    if (offers.length === 0 && failure !== undefined && !failure.ok) return failure;
    for (const offer of offers) this.tracks.set(offer.key, offer);
    return { ok: true, value: offers.map(toMusicTrack) };
  }

  /**
   * One track as a playable data: URL. This is a FULL download (there is no preview stream to be had),
   * which is why the renderer shows a status line and can cancel it.
   */
  private async trackPreview(trackKey: string): Promise<MetadataResult<string>> {
    const resolved = await this.resolveTrackUrl(trackKey);
    if (!resolved.ok) return resolved;
    const bytes = await this.run((signal) =>
      this.deps.http.bytes(resolved.value, MAX_BYTES.audio, { signal }),
    );
    if (!bytes.ok) {
      log.warn(`[metadata] track preview failed: ${bytes.message}`);
      return { ok: false, message: this.t('metadata.downloadFailed') };
    }
    const sniffed = sniffMedia(bytes.value.bytes);
    if (sniffed === null || sniffed.kind !== 'audio') {
      return { ok: false, message: this.t('metadata.downloadFailed') };
    }
    return { ok: true, value: toDataUrl(sniffed, bytes.value.bytes) };
  }

  private async descriptions(candidateKey: string): Promise<MetadataResult<LocalizedText>> {
    const ref = this.candidates.get(candidateKey);
    if (ref === undefined) return { ok: false, message: this.t('metadata.staleSelection') };
    const answers = await this.fromProviders((provider, signal) =>
      provider.descriptions?.(toCandidateRef(ref), signal),
    );
    const texts = answers.flatMap((answer) => (answer.ok ? [answer.value] : []));
    if (texts.length === 0) {
      const failure = answers.find((answer) => !answer.ok);
      return failure !== undefined && !failure.ok
        ? failure
        : { ok: false, message: this.t('metadata.noDescriptions') };
    }
    return {
      ok: true,
      value: texts.reduce<LocalizedText>((all, text) => ({ ...all, ...text }), {}),
    };
  }

  /**
   * Downloads the chosen variant and puts it into the game's root, answering with the MANIFEST-relative
   * path the renderer writes into the form field. Nothing here trusts the request: the root is
   * re-checked, the id and slot are validated before a byte is fetched, and the file's own bytes decide
   * both its extension and whether it is written at all.
   */
  private async apply(request: MetadataApplyRequest): Promise<MetadataApplyResult> {
    const validation = validateApply(request.gameId, request.slot);
    if (!validation.ok) return { ok: false, message: this.t('metadata.badRequest') };
    if (!(await this.deps.isAllowedRoot(request.root))) {
      return { ok: false, message: this.t('errors.driveUnavailable') };
    }
    const target = validation.target;
    const source = await this.sourceUrlFor(request.variantKey, target.expectedKind);
    if (!source.ok) return source;
    const bytes = await this.run((signal) =>
      this.deps.http.bytes(source.value, MAX_BYTES[target.expectedKind], { signal }),
    );
    if (!bytes.ok) {
      log.warn(`[metadata] apply download failed: ${bytes.message}`);
      return { ok: false, message: this.t('metadata.downloadFailed') };
    }
    const sniffed = sniffMedia(bytes.value.bytes);
    if (sniffed === null || sniffed.kind !== target.expectedKind) {
      return { ok: false, message: this.t('metadata.unsupportedFile') };
    }
    const allowed = target.expectedKind === 'image' ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
    if (!allowed.includes(sniffed.extension)) {
      return { ok: false, message: this.t('metadata.unsupportedFile') };
    }
    try {
      const relative =
        request.root === this.deps.pcLibrary.root
          ? await this.writeIntoLibrary(target, sniffed.extension, bytes.value.bytes)
          : await this.writeIntoCard(
              request.root,
              target,
              sniffed.extension,
              bytes.value.bytes,
              allowed,
            );
      return relative === null
        ? { ok: false, message: this.t('metadata.writeFailed') }
        : { ok: true, path: relative };
    } catch (cause) {
      log.warn('[metadata] applying a downloaded asset failed:', describe(cause));
      return { ok: false, message: this.t('metadata.writeFailed') };
    }
  }

  /**
   * The PC library's own import path, reused as-is: the bytes go through a scratch file so importAsset
   * performs exactly the checks a manually picked file gets, and the library's existing GC keeps the
   * folder tidy when a game stops referencing an older copy.
   */
  private async writeIntoLibrary(
    target: ApplyTarget,
    extension: string,
    bytes: Uint8Array,
  ): Promise<string | null> {
    const scratch = await this.writeScratch(target, extension, bytes);
    try {
      return await this.deps.pcLibrary.importAsset(scratch, target.expectedKind, [extension]);
    } finally {
      await fse.remove(scratch).catch((cause: unknown) => {
        log.warn('[metadata] could not remove a scratch download:', describe(cause));
      });
    }
  }

  /**
   * A card has no importer of its own — the manual picker only ever checks that a path is ALREADY inside
   * the card. So the copy is written here, under the same deterministic names a move-to-card uses, with
   * the same refusals importAsset applies (no symlink at the destination) plus the cleanup a card cannot
   * do for itself: the same slot's file under another extension is removed, or it would linger forever.
   */
  private async writeIntoCard(
    root: string,
    target: ApplyTarget,
    extension: string,
    bytes: Uint8Array,
    allowedExtensions: readonly string[],
  ): Promise<string | null> {
    const relative = applyRelativePath(target, extension);
    const absolute = resolveInside(root, relative);
    if (absolute === null) return null;
    const stats = await fse.lstat(absolute).catch(() => null);
    if (stats !== null && (stats.isSymbolicLink() || !stats.isFile())) {
      log.warn(`[metadata] refusing to overwrite "${absolute}": not a regular file`);
      return null;
    }
    await fse.ensureDir(path.dirname(absolute));
    await fse.writeFile(absolute, bytes);
    for (const stale of stalePathsFor(target, extension, allowedExtensions)) {
      const staleAbsolute = resolveInside(root, stale);
      if (staleAbsolute === null) continue;
      const staleStats = await fse.lstat(staleAbsolute).catch(() => null);
      if (staleStats === null || !staleStats.isFile()) continue;
      await fse.remove(staleAbsolute).catch((cause: unknown) => {
        log.warn(`[metadata] could not remove the superseded "${stale}":`, describe(cause));
      });
    }
    return relative;
  }

  /** Writes the download to `<cacheDir>/downloads/<name>` so the library importer has a file to check. */
  private async writeScratch(
    target: ApplyTarget,
    extension: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const dir = path.join(this.deps.cacheDir, DOWNLOADS_DIRNAME);
    await fse.ensureDir(dir);
    const name = path.basename(applyRelativePath(target, extension));
    const scratch = path.join(dir, name);
    await fse.writeFile(scratch, bytes);
    return scratch;
  }

  /** The URL behind a key — a picture's full size, or a track's audio (one more hop for the latter). */
  private async sourceUrlFor(variantKey: string, kind: MediaKind): Promise<MetadataResult<string>> {
    if (kind === 'image') {
      const offer = this.artwork.get(variantKey);
      return offer === undefined
        ? { ok: false, message: this.t('metadata.staleSelection') }
        : { ok: true, value: offer.fullUrl };
    }
    return this.resolveTrackUrl(variantKey);
  }

  /** A track's audio URL: from the provider that owns it, since the list of tracks does not carry one. */
  private async resolveTrackUrl(trackKey: string): Promise<MetadataResult<string>> {
    const offer = this.tracks.get(trackKey);
    if (offer === undefined) return { ok: false, message: this.t('metadata.staleSelection') };
    const answers = await this.fromProviders((provider, signal) =>
      provider.musicTrackUrl?.(offer, signal),
    );
    const url = answers.find((answer) => answer.ok);
    if (url === undefined || !url.ok) {
      const failure = answers.find((answer) => !answer.ok);
      return failure !== undefined && !failure.ok
        ? failure
        : { ok: false, message: this.t('metadata.downloadFailed') };
    }
    return url;
  }

  /** Fetches each offer's thumbnail (three at a time) and drops the ones that do not arrive. */
  private async withThumbnails(
    offers: readonly ArtworkOffer[],
  ): Promise<readonly ArtworkVariant[]> {
    const variants: (ArtworkVariant | null)[] = new Array<ArtworkVariant | null>(
      offers.length,
    ).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const offer = offers[index];
        if (offer === undefined) return;
        const thumb = await this.thumbnail(offer);
        if (thumb !== null) variants[index] = toVariant(offer, thumb);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(THUMB_CONCURRENCY, offers.length) }, () => worker()),
    );
    return variants.filter((variant): variant is ArtworkVariant => variant !== null);
  }

  private async thumbnail(offer: ArtworkOffer): Promise<string | null> {
    const cached = this.thumbs.get(offer.key);
    if (cached !== undefined) return cached;
    const bytes = await this.run((signal) =>
      this.deps.http.bytes(offer.thumbUrl, MAX_THUMB_BYTES, { signal }),
    );
    if (!bytes.ok) {
      log.warn(`[metadata] thumbnail failed: ${bytes.message}`);
      return null;
    }
    const sniffed = sniffMedia(bytes.value.bytes);
    if (sniffed === null || sniffed.kind !== 'image') return null;
    const dataUrl = toDataUrl(sniffed, bytes.value.bytes);
    this.thumbs.set(offer.key, dataUrl);
    return dataUrl;
  }

  /**
   * Asks every provider the same question in parallel and keeps the answers of those that HAVE one.
   * A provider without the method (Khinsider knows no artwork) is simply absent from the result, which
   * is how "nothing can answer this at all" stays distinguishable from "everything answered nothing".
   */
  private async fromProviders<T>(
    ask: (
      provider: MetadataProvider,
      signal: AbortSignal,
    ) => Promise<MetadataResult<T>> | undefined,
  ): Promise<readonly MetadataResult<T>[]> {
    return this.run(async (signal) => {
      const asked = this.deps.providers.map((provider) => ask(provider, signal));
      const answers = await Promise.all(asked.filter((answer) => answer !== undefined));
      return answers;
    });
  }

  /** Whether a source exists in this build but is turned off because its key has not been entered. */
  private isDisabledForKey(id: MetadataProviderId): boolean {
    const provider = this.deps.providers.find((candidate) => candidate.id === id);
    return provider?.available !== undefined && !provider.available();
  }

  /** Runs one piece of work under a fresh AbortController that `metadata:cancel` can reach. */
  private async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      return await work(controller.signal);
    } finally {
      this.inFlight.delete(controller);
    }
  }

  private t(key: Parameters<Translator>[0]): string {
    return this.deps.getTranslator()(key);
  }
}

/** MIME by sniffed extension — narrow on purpose, so only what media-type.ts recognizes gets encoded. */
const DATA_URL_MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
};

function toDataUrl(media: { readonly extension: string }, bytes: Uint8Array): string {
  const mime = DATA_URL_MIME[media.extension] ?? 'application/octet-stream';
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function toVariant(offer: ArtworkOffer, thumbDataUrl: string): ArtworkVariant {
  return {
    key: offer.key,
    kind: offer.kind,
    provider: offer.provider,
    ...(offer.width === undefined ? {} : { width: offer.width }),
    ...(offer.height === undefined ? {} : { height: offer.height }),
    thumbDataUrl,
  };
}

/**
 * The first `limit` offers of EACH source, in the order they arrived. Per source rather than in total so
 * one talkative provider cannot crowd the other out of the gallery: Steam contributes one or two entries,
 * and a global cap would let SteamGridDB's list push them past it.
 */
export function capArtworkPerProvider(
  offers: readonly ArtworkOffer[],
  limit: number,
): readonly ArtworkOffer[] {
  const counts = new Map<string, number>();
  return offers.filter((offer) => {
    const seen = counts.get(offer.provider) ?? 0;
    if (seen >= limit) return false;
    counts.set(offer.provider, seen + 1);
    return true;
  });
}

/**
 * The order the gallery lists sources in — see PROVIDER_ORDER. Offers from a source the list does not
 * name (there is none today) sort last rather than disappearing.
 */
export function orderByProvider(offers: readonly ArtworkOffer[]): readonly ArtworkOffer[] {
  const rank = (id: MetadataProviderId): number => {
    const at = PROVIDER_ORDER.indexOf(id);
    return at === -1 ? PROVIDER_ORDER.length : at;
  };
  return [...offers].sort((a, b) => rank(a.provider) - rank(b.provider));
}

/** Everything a provider may need to recognize a merged candidate as one of its own. */
export function toCandidateRef(candidate: GameCandidate): GameCandidateRef {
  return {
    key: candidate.key,
    title: candidate.title,
    ...(candidate.steamAppId === undefined ? {} : { steamAppId: candidate.steamAppId }),
    ...(candidate.rawgId === undefined ? {} : { rawgId: candidate.rawgId }),
    ...(candidate.gogId === undefined ? {} : { gogId: candidate.gogId }),
  };
}

/**
 * A title reduced to what two sources can be expected to agree on: case, the trademark marks publishers
 * sprinkle differently, and punctuation. Deliberately shallow — no subtitle stripping, no edition
 * guessing, nothing that could make two DIFFERENT games look identical.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[™®©]/g, '')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

/**
 * One entry per game, across every source.
 *
 * Two things happen here. Within a source, repeats collapse — the same Steam appid, the same key.
 * Across sources, entries whose normalized titles match become ONE candidate carrying every reference
 * seen (`steamAppId` + `rawgId` + `gogId`), which is what lets a game's gallery combine Steam's
 * screenshots with GOG's and RAWG's. A candidate that matches nothing simply stays on its own: a
 * duplicate line in the menu costs the user one glance, whereas a wrong merge shows them another game's
 * pictures under the name of theirs.
 *
 * The surviving title and key are the first source's in PROVIDER_ORDER — Steam's when it answered,
 * because that entry is the one that can also reach the descriptions and the CDN cover.
 */
export function mergeCandidates(candidates: readonly GameCandidate[]): readonly GameCandidate[] {
  const merged: GameCandidate[] = [];
  const byTitle = new Map<string, number>();
  const seenKeys = new Set<string>();
  const seenAppIds = new Set<number>();
  const ranked = [...candidates].sort((a, b) => providerRank(a) - providerRank(b));
  for (const candidate of ranked) {
    if (seenKeys.has(candidate.key)) continue;
    seenKeys.add(candidate.key);
    if (candidate.steamAppId !== undefined) {
      if (seenAppIds.has(candidate.steamAppId)) continue;
      seenAppIds.add(candidate.steamAppId);
    }
    const title = normalizeTitle(candidate.title);
    const at = title === '' ? undefined : byTitle.get(title);
    const existing = at === undefined ? undefined : merged[at];
    if (at === undefined || existing === undefined) {
      if (title !== '') byTitle.set(title, merged.length);
      merged.push(candidate);
      continue;
    }
    // Only ACROSS sources. Two entries of one source that normalize alike are two entries: this
    // database says they are different games, and it is the one that knows.
    if (existing.provider === candidate.provider) {
      merged.push(candidate);
      continue;
    }
    merged[at] = {
      ...existing,
      ...(existing.steamAppId === undefined && candidate.steamAppId !== undefined
        ? { steamAppId: candidate.steamAppId }
        : {}),
      ...(existing.rawgId === undefined && candidate.rawgId !== undefined
        ? { rawgId: candidate.rawgId }
        : {}),
      ...(existing.gogId === undefined && candidate.gogId !== undefined
        ? { gogId: candidate.gogId }
        : {}),
    };
  }
  return merged;
}

/**
 * One candidate plus whatever the other sources called the same game, folded into a single entry that
 * keeps the original's identity (its key is already in the renderer's hands) and gains their references.
 * A search that matched nothing leaves the candidate exactly as it was.
 */
export function withMergedRefs(
  candidate: GameCandidate,
  others: readonly GameCandidate[],
): GameCandidate {
  if (others.length === 0) return candidate;
  const merged = mergeCandidates([candidate, ...others]);
  return merged.find((entry) => entry.key === candidate.key) ?? candidate;
}

/** Where a candidate's source sits in PROVIDER_ORDER — which entry leads a merge, and the menu. */
function providerRank(candidate: GameCandidate): number {
  const at = PROVIDER_ORDER.indexOf(candidate.provider);
  return at === -1 ? PROVIDER_ORDER.length : at;
}
