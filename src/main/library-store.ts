// The game HISTORY store: `<userData>/library/` — copies of the assets (grid, hero, music) of
// every game that has been inserted into this device, so the launcher's carousel works with NO card in.
//
// Layout:
//   library/index.json          — the record list (see library-index.ts, which owns the pure rules)
//   library/<id>/grid.<ext>     — raw copy of the card's gridImage (or its first heroImage)
//   library/<id>/grid-thumb.*   — the downscaled card, produced LAZILY on the first grid request
//   library/<id>/hero-<n>.<ext> — hero backgrounds, manifest order preserved
//   library/<id>/music.<ext>
//
// Two deliberate performance rules (they are the reason the copy is safe to do on card insert):
//  • copying is a byte copy under a size cap and does NOT decode — `nativeImage` is synchronous and would
//    block the main thread. The single exception is an image ALREADY over its cap, which is re-encoded
//    down instead of being dropped (copyImageCapped): the alternative is a game with no background in the
//    history at all, and it happens once per card, in the background, after the window is up;
//  • the downscale happens on demand, once per game, and is cached on disk.
//
// GUI-only (it imports `electron` for nativeImage): the Game Mode daemon must never reach this module —
// see CLAUDE.md and test/daemon-imports.test.ts.
import path from 'node:path';
import fse from 'fs-extra';
import { nativeImage } from 'electron';
import { z } from 'zod';
import type { HeroAssets, ResolvedManifest, Stats } from '../shared/types';
import { readAudioDataUrl, readImageDataUrl } from './asset-reader';
import { readJsonValidated, writeJsonAtomic } from './json-store';
import {
  EMPTY_LIBRARY_INDEX,
  evictBeyond,
  orderForCarousel,
  removeEntry,
  upsertEntry,
  type LibraryEntryRecord,
  type LibraryIndex,
} from './library-index';
import { log } from './logger';
import { describe } from './util';

/** How many games the history keeps. Beyond it the weakest records are evicted (see evictBeyond). */
export const MAX_LIBRARY_ENTRIES = 40;
/** Target height of the carousel card thumbnail: 2x the 204 design px, so it stays crisp on a 4K screen. */
const GRID_TARGET_HEIGHT = 408;
const JPEG_QUALITY = 85;
/** Per-asset byte caps. An AUDIO file over its cap is skipped with a warn (nothing to shrink); an IMAGE
 *  over it is re-encoded down to fit — see copyImageCapped. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_MUSIC_BYTES = 8 * 1024 * 1024;

/** One attempt at squeezing an oversized image under the cap: scale to `height`, encode at `quality`.
 *  Tried in order until one fits, so a picture only loses as much as it has to. */
interface CompressStep {
  readonly height: number;
  readonly quality: number;
}
/** Backgrounds are drawn full-screen, so the first step still covers a 1440p panel; a 4K hero is
 *  downscaled rather than lost. */
const HERO_COMPRESS_STEPS: readonly CompressStep[] = [
  { height: 1440, quality: 85 },
  { height: 1080, quality: 75 },
  { height: 720, quality: 65 },
];
/** The stored cover only ever feeds the 408-tall thumbnail, so it can be squeezed harder. */
const GRID_COMPRESS_STEPS: readonly CompressStep[] = [
  { height: 1200, quality: 85 },
  { height: 900, quality: 80 },
  { height: 600, quality: 70 },
];


const entrySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  grid: z.string().optional(),
  gridThumb: z.string().optional(),
  hero: z.array(z.string()).default([]),
  music: z.string().optional(),
  savedAt: z.string(),
  lastSeenAt: z.string().nullable().default(null),
  sourceSig: z.string().optional(),
  launchCount: z.number().int().nonnegative().default(0),
  lastPlayedAt: z.string().nullable().default(null),
});

const indexSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(entrySchema).default([]),
});

/** Interface-DI, like StatsService/UpdaterService: no electron paths, no direct PcStore reference. */
export interface LibraryStoreDeps {
  /** app.getPath('userData') — `library/` is created inside it. */
  readonly baseDir: string;
  /** Reads a game's authoritative stats (PcStore). The index only CACHES these numbers — see Р1. */
  readonly readStats: (id: string) => Promise<Stats>;
}

/** The assets a browsed (history) game needs on screen: its backgrounds and its music. */
export interface BrowseAssets {
  readonly hero: HeroAssets | null;
  readonly music: string | null;
}

export class LibraryStore {
  private index: LibraryIndex = EMPTY_LIBRARY_INDEX;
  private readonly dir: string;

  constructor(private readonly deps: LibraryStoreDeps) {
    this.dir = path.join(deps.baseDir, 'library');
  }

  /**
   * Loads the index, re-syncs the cached stats against their authority (`stats/<id>.json`) and runs the
   * GC. The re-sync matters because stats can change without us: another PC's card copy is merged into
   * the PC mirror on insert, and a user can wipe the stats folder.
   */
  async init(): Promise<void> {
    await fse.ensureDir(this.dir);
    const stored = await readJsonValidated(this.indexPath(), indexSchema, {
      schemaVersion: 1 as const,
      entries: [],
    });
    this.index = { schemaVersion: 1, entries: stored.entries.map(toRecord) };
    const entries: LibraryEntryRecord[] = [];
    let changed = false;
    for (const entry of this.index.entries) {
      const stats = await this.deps.readStats(entry.id);
      if (stats.launchCount === entry.launchCount && stats.lastPlayedAt === entry.lastPlayedAt) {
        entries.push(entry);
        continue;
      }
      changed = true;
      entries.push({ ...entry, launchCount: stats.launchCount, lastPlayedAt: stats.lastPlayedAt });
    }
    if (changed) {
      this.index = { schemaVersion: 1, entries };
      await this.writeIndex();
    }
    await this.gc();
  }

  /** The carousel order for the given card ids: the card's games first, then the played history (Р1). */
  entriesForCarousel(activeIds: readonly string[]): readonly LibraryEntryRecord[] {
    return orderForCarousel(this.index.entries, activeIds);
  }

  /** One record by id, or null when this game was never copied in. */
  entry(id: string): LibraryEntryRecord | null {
    return this.index.entries.find((e) => e.id === id) ?? null;
  }

  /**
   * Copies the assets of every game on the inserted card into the library, ONE GAME AT A TIME. The
   * sequence is not an optimisation to undo: `index.json` is a single file, so N parallel
   * read-modify-writes would lose records (writeJsonAtomic protects against a torn file, not a lost
   * update). A game whose grid source is unchanged since last time (same `sourceSig`) only refreshes its
   * cached stats — that is what keeps re-inserting the same card off the disk.
   *
   * Best-effort throughout: the card can be yanked mid-copy, so a failed game is logged and skipped, and
   * the index is written only AFTER that game's files are in place (never a half-copied catalogue).
   */
  async saveFromCard(manifests: readonly ResolvedManifest[]): Promise<void> {
    for (const manifest of manifests) {
      try {
        await this.saveOne(manifest);
      } catch (cause) {
        log.warn(`[library] failed to copy assets for id=${manifest.raw.id}:`, describe(cause));
      }
    }
    await this.gc(manifests.map((m) => m.raw.id));
  }

  private async saveOne(manifest: ResolvedManifest): Promise<void> {
    const id = manifest.raw.id;
    const gridSource = manifest.gridImagePath ?? manifest.heroImagePaths?.[0];
    const sourceSig = await assetsSignature(manifest);
    const previous = this.entry(id);
    const stats = await this.deps.readStats(id);
    // "This game was available at this moment" — the carousel orders the history by it, so it is stamped
    // on EVERY insert, including the one below that copies nothing.
    const lastSeenAt = new Date().toISOString();

    // Same card, same assets → nothing to re-copy. Only the cached stats are refreshed. The signature
    // covers EVERY source file, not just the cover: editing any of them in Configure (and applying it to
    // the running launcher) must land in the history without a restart.
    if (
      previous !== null &&
      sourceSig !== undefined &&
      previous.sourceSig === sourceSig &&
      previous.title === manifest.raw.title
    ) {
      await this.replace({
        ...previous,
        lastSeenAt,
        launchCount: stats.launchCount,
        lastPlayedAt: stats.lastPlayedAt,
      });
      return;
    }

    const gameDir = this.gameDir(id);
    // A real re-copy replaces the WHOLE set, so wipe the directory first: a renamed asset (grid.png →
    // grid.jpg), one hero image fewer, or a dropped music track would otherwise leave an orphan behind,
    // and the lazily-built thumbnail would keep serving the previous cover.
    if (previous !== null) await fse.remove(gameDir);
    await fse.ensureDir(gameDir);

    const grid =
      gridSource === undefined
        ? undefined
        : await copyImageCapped(gridSource, gameDir, 'grid', MAX_IMAGE_BYTES, GRID_COMPRESS_STEPS);

    const hero: string[] = [];
    for (const [index, heroPath] of (manifest.heroImagePaths ?? []).entries()) {
      // Position is load-bearing: the renderer keys its palette cache by `${id}#${index}`, so a copy that
      // reordered the backgrounds would hand a game the colors of another of its own images.
      const name = await copyImageCapped(
        heroPath,
        gameDir,
        `hero-${index}`,
        MAX_IMAGE_BYTES,
        HERO_COMPRESS_STEPS,
      );
      if (name !== undefined) hero.push(name);
    }

    const music =
      manifest.backgroundMusicPath === undefined
        ? undefined
        : await copyCapped(manifest.backgroundMusicPath, gameDir, 'music', MAX_MUSIC_BYTES);

    const record: LibraryEntryRecord = {
      id,
      title: manifest.raw.title,
      ...(grid !== undefined ? { grid } : {}),
      hero,
      ...(music !== undefined ? { music } : {}),
      savedAt: lastSeenAt,
      lastSeenAt,
      ...(sourceSig !== undefined ? { sourceSig } : {}),
      launchCount: stats.launchCount,
      lastPlayedAt: stats.lastPlayedAt,
    };
    const { index, replacedForeign } = upsertEntry(this.index, record);
    if (replacedForeign) {
      // Two cards sharing a manifest id now overwrite each other's COVER AND NAME, not just their stats
      // numbers — a new, visible class of mistake, so it gets a breadcrumb (Р3).
      log.warn(
        `[library] id="${id}" already existed with a different title/source — the history entry was overwritten (colliding manifest ids across cards)`,
      );
    }
    this.index = index;
    await this.writeIndex();
  }

  /**
   * The carousel card as a data URL: the downscaled copy, produced on the FIRST request and cached on
   * disk. Falls back to the raw copy when the image can't be decoded (webp/gif/avif — nativeImage only
   * guarantees PNG/JPEG) so an exotic cover still shows, just heavier.
   */
  async readGridThumb(id: string): Promise<string | null> {
    const entry = this.entry(id);
    if (entry === null) return null;
    const gameDir = this.gameDir(id);
    if (entry.gridThumb !== undefined) {
      const cached = await readImageDataUrl(path.join(gameDir, entry.gridThumb));
      if (cached !== undefined) return cached;
      // The cached file vanished (a manual clean-up) → fall through and rebuild it.
    }
    if (entry.grid === undefined) return null;
    const source = path.join(gameDir, entry.grid);
    const thumb = await this.buildThumb(source, gameDir);
    if (thumb === null) return (await readImageDataUrl(source)) ?? null;
    await this.replace({ ...entry, gridThumb: thumb.name });
    return thumb.dataUrl;
  }

  /**
   * Downscales the copied grid to GRID_TARGET_HEIGHT and writes it next to the original. Returns null
   * when the image can't be decoded or is already small enough (the caller then serves the raw file).
   *
   * A PNG stays a PNG: `toJPEG` flattens transparency to black, and a cover with an alpha channel is a
   * real case. Everything else (JPEG) re-encodes as JPEG.
   */
  private async buildThumb(
    source: string,
    gameDir: string,
  ): Promise<{ readonly name: string; readonly dataUrl: string } | null> {
    try {
      const image = nativeImage.createFromPath(source);
      if (image.isEmpty()) return null; // webp/gif/avif — nativeImage can't read it
      const { height } = image.getSize();
      if (height <= GRID_TARGET_HEIGHT) return null; // already small — re-encoding would only lose quality
      const resized = image.resize({ height: GRID_TARGET_HEIGHT });
      const keepAlpha = path.extname(source).toLowerCase() === '.png';
      const buffer = keepAlpha ? resized.toPNG() : resized.toJPEG(JPEG_QUALITY);
      const name = keepAlpha ? 'grid-thumb.png' : 'grid-thumb.jpg';
      await fse.writeFile(path.join(gameDir, name), buffer);
      const mime = keepAlpha ? 'image/png' : 'image/jpeg';
      return { name, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
    } catch (cause) {
      log.warn(`[library] failed to downscale "${source}":`, describe(cause));
      return null;
    }
  }

  /** The browsed game's backgrounds + music as data URLs (null halves when it has none). */
  async readBrowseAssets(id: string): Promise<BrowseAssets> {
    const entry = this.entry(id);
    if (entry === null) return { hero: null, music: null };
    const gameDir = this.gameDir(id);
    const images: string[] = [];
    for (const name of entry.hero) {
      const url = await readImageDataUrl(path.join(gameDir, name));
      if (url !== undefined) images.push(url);
    }
    const music =
      entry.music === undefined
        ? null
        : ((await readAudioDataUrl(path.join(gameDir, entry.music))) ?? null);
    return { hero: images.length > 0 ? { images } : null, music };
  }

  /** Refreshes the cached play stats after a finished session (the authority stays stats/<id>.json). */
  async noteLaunch(id: string, stats: Stats): Promise<void> {
    const entry = this.entry(id);
    if (entry === null) return;
    await this.replace({
      ...entry,
      launchCount: stats.launchCount,
      lastPlayedAt: stats.lastPlayedAt,
    });
  }

  /** Trims the history to MAX_LIBRARY_ENTRIES, deleting the evicted games' directories. */
  async gc(protectedIds: readonly string[] = []): Promise<void> {
    const { index, evicted } = evictBeyond(this.index, MAX_LIBRARY_ENTRIES, protectedIds);
    if (evicted.length === 0) return;
    this.index = index;
    await this.writeIndex();
    for (const id of evicted) {
      try {
        await fse.remove(this.gameDir(id));
        log.info(`[library] evicted id=${id} (history limit ${MAX_LIBRARY_ENTRIES})`);
      } catch (cause) {
        // The record is already gone from the index; a leftover directory is cosmetic, not a corruption.
        log.warn(`[library] failed to remove the directory of evicted id=${id}:`, describe(cause));
        this.index = removeEntry(this.index, id);
      }
    }
  }

  private async replace(record: LibraryEntryRecord): Promise<void> {
    this.index = upsertEntry(this.index, record).index;
    await this.writeIndex();
  }

  private async writeIndex(): Promise<void> {
    try {
      await fse.ensureDir(this.dir);
      await writeJsonAtomic(this.indexPath(), this.index);
    } catch (cause) {
      log.warn('[library] failed to write the history index:', describe(cause));
    }
  }

  private indexPath(): string {
    return path.join(this.dir, 'index.json');
  }

  private gameDir(id: string): string {
    // `id` is validated by the manifest schema as a single safe path segment (no separators, no dots).
    return path.join(this.dir, id);
  }
}

/**
 * Narrows a validated (mutable) index entry to the domain record. An entry written by an older build may
 * still carry fields this one no longer knows (the `sounds` map of the card-supplied UI sounds, dropped
 * from the product) — the schema strips them, and the next write persists the file without them.
 */
function toRecord(stored: z.infer<typeof entrySchema>): LibraryEntryRecord {
  return { ...stored, hero: [...stored.hero] };
}

/**
 * A fingerprint of ALL of this game's source assets (`<name>:<mtimeMs>:<size>` per file), prefixed with
 * the copy's own version. Re-inserting an unchanged card matches it and skips the copy; changing any
 * single image, the music or a sound misses it and re-copies the set. Undefined when there is nothing to
 * copy, or when a file cannot be stat'ed — both mean "don't trust the shortcut", so the copy runs.
 *
 * The version prefix is what refreshes records the OLD copy produced: an image that was skipped for being
 * over the cap is re-encoded now, but the sources it was skipped from are untouched, so their fingerprint
 * alone would keep serving the incomplete record forever. Bump it whenever the copy's OUTPUT changes —
 * every game is then re-copied ONCE, and the shortcut holds again from the next insert on.
 */
const COPY_VERSION = 'v2';

async function assetsSignature(manifest: ResolvedManifest): Promise<string | undefined> {
  const sources = [
    manifest.gridImagePath,
    ...(manifest.heroImagePaths ?? []),
    manifest.backgroundMusicPath,
  ].filter((source): source is string => source !== undefined);
  if (sources.length === 0) return undefined;
  const parts: string[] = [];
  for (const source of sources) {
    const signature = await fileSignature(source);
    if (signature === undefined) return undefined;
    parts.push(`${path.basename(source)}:${signature}`);
  }
  return [COPY_VERSION, ...parts].join('|');
}

/** `<mtimeMs>:<size>` of a source file, or undefined when it can't be stat'ed. */
async function fileSignature(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fse.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

/**
 * Byte-copies `source` into `<gameDir>/<baseName><ext>` when it fits `maxBytes`, returning the file name
 * (or undefined when it is missing, too large, or unreadable — always with a breadcrumb). No decoding:
 * see the module doc for why the insert path must not touch nativeImage.
 */
async function copyCapped(
  source: string,
  gameDir: string,
  baseName: string,
  maxBytes: number,
): Promise<string | undefined> {
  const size = await fileSize(source);
  if (size === undefined) return undefined;
  if (size > maxBytes) {
    log.warn(`[library] skipping "${source}": ${size} bytes exceeds the ${maxBytes}-byte cap`);
    return undefined;
  }
  return copyRaw(source, gameDir, baseName);
}

/**
 * The same for an IMAGE, except that being over the cap is not the end: rather than lose the picture, it
 * is re-encoded down through `steps` until one fits. A 12 MB 4K background is a perfectly ordinary card
 * asset — dropping it left the game with no background in the history at all, while the card itself
 * (which reads the original) still showed one.
 *
 * This is the ONE place the copy decodes an image, and it is deliberate: it runs only for a file that
 * would otherwise be skipped, only once per card (the signature shortcut skips unchanged cards), and the
 * whole copy already happens in the background, after the window is up. An image nativeImage cannot read
 * (webp/gif/avif) is still skipped — there is nothing to re-encode.
 */
async function copyImageCapped(
  source: string,
  gameDir: string,
  baseName: string,
  maxBytes: number,
  steps: readonly CompressStep[],
): Promise<string | undefined> {
  const size = await fileSize(source);
  if (size === undefined) return undefined;
  if (size <= maxBytes) return copyRaw(source, gameDir, baseName);
  return compressUnderCap(source, gameDir, baseName, maxBytes, steps, size);
}

/** Byte-copy, no questions asked. Returns the written file's name. */
async function copyRaw(
  source: string,
  gameDir: string,
  baseName: string,
): Promise<string | undefined> {
  const name = `${baseName}${path.extname(source).toLowerCase()}`;
  try {
    await fse.copy(source, path.join(gameDir, name), { overwrite: true, dereference: true });
    return name;
  } catch (cause) {
    log.warn(`[library] failed to copy "${source}":`, describe(cause));
    return undefined;
  }
}

/** Walks `steps` until one encodes under the cap, writes it as JPEG and returns the name. */
async function compressUnderCap(
  source: string,
  gameDir: string,
  baseName: string,
  maxBytes: number,
  steps: readonly CompressStep[],
  originalSize: number,
): Promise<string | undefined> {
  try {
    const image = nativeImage.createFromPath(source);
    if (image.isEmpty()) {
      log.warn(
        `[library] skipping "${source}": ${originalSize} bytes over the ${maxBytes}-byte cap and not decodable (webp/gif/avif?)`,
      );
      return undefined;
    }
    const name = `${baseName}.jpg`;
    for (const step of steps) {
      // JPEG throughout — a background/cover has no use for the alpha channel PNG would keep, and keeping
      // it is exactly what makes these files too big in the first place.
      const scaled = image.getSize().height > step.height ? image.resize({ height: step.height }) : image;
      const buffer = scaled.toJPEG(step.quality);
      if (buffer.byteLength > maxBytes) continue;
      await fse.writeFile(path.join(gameDir, name), buffer);
      log.info(
        `[library] re-encoded "${source}" to fit the history: ${originalSize} → ${buffer.byteLength} bytes (${step.height}p, q${step.quality})`,
      );
      return name;
    }
    log.warn(
      `[library] skipping "${source}": still over the ${maxBytes}-byte cap after re-encoding it down`,
    );
    return undefined;
  } catch (cause) {
    log.warn(`[library] failed to re-encode "${source}":`, describe(cause));
    return undefined;
  }
}

/** The file's size in bytes, or undefined (with a breadcrumb) when it cannot be stat'ed. */
async function fileSize(source: string): Promise<number | undefined> {
  try {
    return (await fse.stat(source)).size;
  } catch (cause) {
    log.warn(`[library] source asset missing "${source}":`, describe(cause));
    return undefined;
  }
}
