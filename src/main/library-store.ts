// The game HISTORY store: `<userData>/library/` — copies of the assets (grid, hero, music) of
// every game that has been inserted into this device, so the launcher's carousel works with NO card in.
//
// Layout:
//   library/index.json          — the record list (see library-index.ts, which owns the pure rules)
//   library/<id>/grid.<ext>     — raw copy of the card's gridImage (or its first heroImage)
//   library/<id>/grid-thumb.*   — the downscaled card, produced LAZILY on the first grid request
//   library/<id>/hero-<n>.<ext> — hero backgrounds, manifest order preserved
//   library/<id>/music.<ext>
//   library/<id>/card-slot.json  — pristine snapshot of the game's slot as the CARD had it
//   library/<id>/game.json       — the user's edits to that slot, made with no card in (absent until then)
//   library/<id>/staged/         — the originals of assets picked for those edits, awaiting the card
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
import type { HeroAssets, Stats } from '../shared/types';
import type { ResolvedManifest } from './manifest-types';
import { readAudioDataUrl, readImageDataUrl } from './asset-reader';
import { isEnoent, readJsonValidated, writeFileAtomicEnsuringDir, writeJsonAtomic } from './json-store';
import { uniqueAssetFileName } from './asset-file-names';
import { assertImportableAsset, type ImportKind } from './asset-import';
import { slotHash, type GameSlot } from './history-config';
import {
  EMPTY_LIBRARY_INDEX,
  orderForCarousel,
  removeEntry,
  upsertEntry,
  type LibraryEntryRecord,
  type LibraryIndex,
} from './library-index';
import { log } from './logger';
import { describe } from './util';

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

/** The pristine card slot, the user's edits to it, and the originals staged for those edits. */
const CARD_SLOT_FILENAME = 'card-slot.json';
const EDITED_MANIFEST_FILENAME = 'game.json';
const STAGED_DIRNAME = 'staged';
/** What a re-copy of the artwork must NOT sweep away (see clearCopies). */
const KEPT_ON_RECOPY: ReadonlySet<string> = new Set([
  CARD_SLOT_FILENAME,
  EDITED_MANIFEST_FILENAME,
  STAGED_DIRNAME,
]);


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
  // New fields migrate by zod default, exactly as `lastSeenAt` did — a record written by an older build
  // simply reads as "no snapshot, no pending edits, no answered dialog".
  sourceKind: z.enum(['card', 'pc']).optional(),
  cardSlotHash: z.string().optional(),
  configuredAt: z.string().nullable().default(null),
  collisionResolvedAt: z.string().nullable().default(null),
});

const indexSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(entrySchema).default([]),
});

/** Interface-DI, like StatsService/UpdaterService: no electron paths, no direct PcStore reference. */
export interface LibraryStoreDeps {
  /** app.getPath('userData') — `library/` is created inside it. */
  readonly baseDir: string;
  /** Reads a game's authoritative stats (PcStore). The index only CACHES these numbers. */
  readonly readStats: (id: string) => Promise<Stats>;
}

/** The assets a browsed (history) game needs on screen: its backgrounds and its music. */
export interface BrowseAssets {
  readonly hero: HeroAssets | null;
  readonly music: string | null;
}

export class LibraryStore {
  private index: LibraryIndex = EMPTY_LIBRARY_INDEX;
  private queue: Promise<void> = Promise.resolve();
  private readonly dir: string;

  constructor(private readonly deps: LibraryStoreDeps) {
    this.dir = path.join(deps.baseDir, 'library');
  }

  /**
   * Loads the index and re-syncs the cached stats against their authority (`stats/<id>.json`). The
   * re-sync matters because stats can change without us: another PC's card copy is merged into the PC
   * mirror on insert, and a user can wipe the stats folder.
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
  }

  /** The carousel order for the given card ids: the card's games first, then the played history. */
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
  async saveFromCard(
    manifests: readonly ResolvedManifest[],
    cardSlots?: ReadonlyMap<string, GameSlot>,
  ): Promise<void> {
    for (const manifest of manifests) {
      try {
        await this.saveOne(manifest, cardSlots?.get(manifest.raw.id));
      } catch (cause) {
        log.warn(`[library] failed to copy assets for id=${manifest.raw.id}:`, describe(cause));
      }
    }
  }

  private async saveOne(manifest: ResolvedManifest, cardSlot?: GameSlot): Promise<void> {
    const id = manifest.raw.id;
    const gridSource = manifest.gridImagePath ?? manifest.heroImagePaths?.[0];
    const sourceSig = await assetsSignature(manifest);
    const stats = await this.deps.readStats(id);
    // "This game was available at this moment" — the carousel orders the history by it, so it is stamped
    // on EVERY insert, including the one below that copies nothing.
    const lastSeenAt = new Date().toISOString();
    // The title the CARD last had, read before the snapshot is overwritten. `record.title` is editable
    // from the history now, so comparing against it would read a not-yet-applied rename as a foreign card
    // (a false warning, and a full re-copy of every asset on every insert).
    const pristineTitle = (await this.readCardSlot(id))?.['title'];
    // The snapshot belongs to the CARD path alone: a PC-library game's slot speaks the `pc` dialect and
    // would make a card unreadable if it were ever applied to one.
    const cardSlotHash =
      manifest.source === 'card' && cardSlot !== undefined
        ? await this.takeCardSlot(id, cardSlot)
        : undefined;
    const sourceKind = manifest.source;
    const previous = this.entry(id);
    const titleUnchanged =
      (typeof pristineTitle === 'string' ? pristineTitle : previous?.title) === manifest.raw.title;

    // Same card, same assets → nothing to re-copy. Only the cached stats (and the snapshot fields, which
    // can move while the asset bytes do not) are refreshed. The signature covers EVERY source file, not
    // just the cover: editing any of them in Configure (and applying it to the running launcher) must
    // land in the history without a restart.
    if (previous !== null && sourceSig !== undefined && previous.sourceSig === sourceSig && titleUnchanged) {
      await this.mutate((index) => {
        const current = index.entries.find((entry) => entry.id === id) ?? previous;
        return upsertEntry(
          index,
          {
            ...current,
            lastSeenAt,
            launchCount: stats.launchCount,
            lastPlayedAt: stats.lastPlayedAt,
            sourceKind,
            ...(cardSlotHash !== undefined ? { cardSlotHash } : {}),
          },
          typeof pristineTitle === 'string' ? pristineTitle : undefined,
        ).index;
      });
      return;
    }

    const gameDir = this.gameDir(id);
    // A real re-copy replaces the WHOLE set, so clear the copies first: a renamed asset (grid.png →
    // grid.jpg), one hero image fewer, or a dropped music track would otherwise leave an orphan behind,
    // and the lazily-built thumbnail would keep serving the previous cover. Selectively, though — the
    // snapshot, the user's pending edits and their staged originals are NOT this path's to destroy.
    if (previous !== null) await this.clearCopies(gameDir);
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

    let replacedForeign = false;
    await this.mutate((index) => {
      // Re-read the record AFTER the file work: a collision answer or a save from the history may have
      // written this entry while the copying awaited, and building from the stale read would clobber it.
      // Every field this path does not own has to be carried over BY HAND — the record is built fresh,
      // and an optional field forgotten here is silently dropped rather than caught by the types.
      const current = index.entries.find((entry) => entry.id === id) ?? previous;
      const record: LibraryEntryRecord = {
        id,
        // A rename saved from the history but not yet applied to the card outlives this re-copy: the
        // carousel must keep showing what the user typed until their edits reach the card or lose to it.
        title:
          current !== null && current !== undefined && current.configuredAt !== null
            ? current.title
            : manifest.raw.title,
        ...(grid !== undefined ? { grid } : {}),
        hero,
        ...(music !== undefined ? { music } : {}),
        savedAt: lastSeenAt,
        lastSeenAt,
        ...(sourceSig !== undefined ? { sourceSig } : {}),
        launchCount: stats.launchCount,
        lastPlayedAt: stats.lastPlayedAt,
        sourceKind,
        ...(cardSlotHash !== undefined
          ? { cardSlotHash }
          : current?.cardSlotHash !== undefined
            ? { cardSlotHash: current.cardSlotHash }
            : {}),
        configuredAt: current?.configuredAt ?? null,
        collisionResolvedAt: current?.collisionResolvedAt ?? null,
      };
      const result = upsertEntry(
        index,
        record,
        typeof pristineTitle === 'string' ? pristineTitle : undefined,
      );
      replacedForeign = result.replacedForeign;
      return result.index;
    });
    if (replacedForeign) {
      // Two cards sharing a manifest id now overwrite each other's COVER AND NAME, not just their stats
      // numbers — a new, visible class of mistake, so it gets a breadcrumb.
      log.warn(
        `[library] id="${id}" already existed with a different title/source — the history entry was overwritten (colliding manifest ids across cards)`,
      );
    }
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

  /**
   * Drops ONE game from the history on the user's request: its record and the artwork copied for it. The
   * same deletion the GC performs, minus the choosing — so a game the user is done with can go before the
   * limit would have evicted it.
   *
   * Deliberately NOT touched: `stats/<id>.json` and the save backups. Those belong to the game, not to
   * the catalogue — putting the card back in must bring the playtime and the saves back with it, and a
   * menu item that quietly destroyed them would be a different (and far more dangerous) feature.
   *
   * Returns false when there was no such record — the caller has nothing to re-push then.
   */
  async forget(id: string): Promise<boolean> {
    if (this.entry(id) === null) return false;
    // Through the queue like every other index write: a bare read-modify-write here would race the
    // background copy after an insert, whose `current ?? previous` fallback would then put the record
    // this just deleted straight back.
    await this.mutate((index) => removeEntry(index, id));
    try {
      await fse.remove(this.gameDir(id));
      log.info(`[library] forgot id=${id} (removed from the history by the user)`);
    } catch (cause) {
      // As in the GC: the record is already gone, a leftover directory is cosmetic. The next copy of this
      // game overwrites it anyway (saveOne removes the directory before re-filling it).
      log.warn(`[library] failed to remove the directory of forgotten id=${id}:`, describe(cause));
    }
    return true;
  }

  // ── Configuring a game from the history ───────────────────────────────────────────────────────────
  //
  // Two files per game, and which one may be written by whom is the whole safety of the feature:
  //
  //   card-slot.json — the PRISTINE slot as the card had it. Written only by the insertion path, which
  //                    owns it; it is the baseline for "did the card move?", for the title guard, and
  //                    for mapping a slot's asset paths onto the library's copies.
  //   game.json      — the user's edits. Written only by save-from-history; the insertion path never
  //                    touches it, so a failed apply (read-only card, a copy that broke off) cannot cost
  //                    the user their work. It is deleted when the edits reach the card, or lose to it.

  /** Snapshots the slot the card currently has and returns its hash (the change-detection baseline). */
  async takeCardSlot(id: string, slot: GameSlot): Promise<string> {
    // Atomically, like every other store here: a torn snapshot reads back as a slot that does not match
    // the card, which the sync treats as a foreign card — and a foreign card means the edits are dropped.
    await writeFileAtomicEnsuringDir(this.cardSlotPath(id), `${JSON.stringify(slot, null, 2)}\n`);
    return slotHash(slot);
  }

  /** The pristine card slot, or null when this game has never been snapshotted. */
  async readCardSlot(id: string): Promise<GameSlot | null> {
    return readSlotFile(this.cardSlotPath(id));
  }

  /**
   * What the settings screen must show for a history game: the user's edits when there are any, the
   * pristine snapshot otherwise. Without the fallback the very first Customize from the history would
   * open onto nothing.
   */
  async storedManifestText(id: string): Promise<string | null> {
    const edited = await readTextFile(this.editedManifestPath(id));
    if (edited !== null) return edited;
    return readTextFile(this.cardSlotPath(id));
  }

  /** The user's pending edits, or null when they have none. */
  async readEditedSlot(id: string): Promise<GameSlot | null> {
    return readSlotFile(this.editedManifestPath(id));
  }

  /**
   * Stores edits made with no card in and stamps `configuredAt` — the flag the next insertion reads as
   * "there is something to apply". The record's title follows the edit so the carousel shows the new
   * name at once, before any card is back.
   */
  async saveEdits(id: string, text: string, title: string): Promise<void> {
    // Atomic for the same reason the snapshot is: this file IS the user's unapplied work, and half of it
    // parses as nothing, which the apply step reports as "no stored edits" and drops.
    await writeFileAtomicEnsuringDir(
      this.editedManifestPath(id),
      text.endsWith('\n') ? text : `${text}\n`,
    );
    const configuredAt = new Date().toISOString();
    await this.mutate((index) => {
      const current = index.entries.find((entry) => entry.id === id);
      if (current === undefined) return index;
      return upsertEntry(index, { ...current, title, configuredAt }, current.title).index;
    });
  }

  /**
   * Drops the pending edits and everything staged for them — after they reached the card, and after they
   * lost a conflict to it. The snapshot stays: it is the baseline, and it is now the only truth again.
   */
  async dropEdits(id: string): Promise<void> {
    await this.removeQuietly(this.editedManifestPath(id));
    await this.clearStaged(id);
    await this.mutate((index) => {
      const current = index.entries.find((entry) => entry.id === id);
      if (current === undefined || current.configuredAt === null) return index;
      return upsertEntry(index, { ...current, configuredAt: null }, current.title).index;
    });
  }

  /** Remembers that the user answered the "on the card AND on this PC" dialog for this id. */
  async markCollisionResolved(id: string): Promise<void> {
    const collisionResolvedAt = new Date().toISOString();
    await this.mutate((index) => {
      const current = index.entries.find((entry) => entry.id === id);
      const record: LibraryEntryRecord =
        current ??
        {
          id,
          title: id,
          hero: [],
          savedAt: collisionResolvedAt,
          lastSeenAt: collisionResolvedAt,
          launchCount: 0,
          lastPlayedAt: null,
          configuredAt: null,
          collisionResolvedAt: null,
        };
      return upsertEntry(index, { ...record, collisionResolvedAt }, record.title).index;
    });
  }

  /** Forgets that answer for every id that is no longer on both sides — the collision is over. */
  async clearCollisionAnswers(keepIds: readonly string[]): Promise<void> {
    const keep = new Set(keepIds);
    await this.mutate((index) => ({
      schemaVersion: 1,
      entries: index.entries.map((entry) =>
        entry.collisionResolvedAt !== null && !keep.has(entry.id)
          ? { ...entry, collisionResolvedAt: null }
          : entry,
      ),
    }));
  }

  /**
   * Copies an asset picked from anywhere on this PC into `library/<id>/staged/`, under the very name it
   * will take on the card, and returns that name. The originals wait here because the card the edits are
   * for is not in — the file the slot points at has to exist somewhere until it can be copied over.
   */
  async importStagedAsset(
    id: string,
    absolutePath: string,
    kind: ImportKind,
    allowedExtensions: readonly string[],
  ): Promise<string> {
    await assertImportableAsset(absolutePath, kind, allowedExtensions);
    const dir = this.stagedDir(id);
    await fse.ensureDir(dir);
    const name = await uniqueAssetFileName(dir, path.basename(absolutePath));
    await fse.copy(absolutePath, path.join(dir, name), { overwrite: false, errorOnExist: true });
    return name;
  }

  /** The names of everything staged for this game (empty when nothing is). */
  async stagedFiles(id: string): Promise<readonly string[]> {
    try {
      return await fse.readdir(this.stagedDir(id));
    } catch (cause) {
      if (!isEnoent(cause)) {
        log.warn(`[library] cannot list the staged assets of id=${id}:`, describe(cause));
      }
      return [];
    }
  }

  /** Absolute path of one staged file — the apply step copies from it, the preview reads it. */
  stagedFilePath(id: string, name: string): string {
    return path.join(this.stagedDir(id), path.basename(name));
  }

  /** Absolute path of one copied asset inside `library/<id>/` (a preview source, never written to). */
  copiedAssetPath(id: string, name: string): string {
    return path.join(this.gameDir(id), path.basename(name));
  }

  async clearStaged(id: string): Promise<void> {
    await this.removeQuietly(this.stagedDir(id));
  }

  private async replace(record: LibraryEntryRecord): Promise<void> {
    await this.mutate((index) => upsertEntry(index, record).index);
  }

  /**
   * Serializes every mutation of `index.json` through one chain. Two writers now race for it — the
   * background copy after an insert and the user's own actions (a save from the history, an answer to the
   * collision dialog) — and both read-modify-write the same file, so an interleaving would silently drop
   * whichever field was written first.
   */
  private mutate(mutator: (index: LibraryIndex) => LibraryIndex): Promise<void> {
    const run = this.queue.then(async () => {
      this.index = mutator(this.index);
      await this.writeIndex();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Removes the COPIES of a game's assets, keeping the snapshot, the pending edits and their staged
   * originals — those belong to the history-config paths, not to the insert that re-copies artwork.
   */
  private async clearCopies(gameDir: string): Promise<void> {
    let names: readonly string[];
    try {
      names = await fse.readdir(gameDir);
    } catch (cause) {
      if (!isEnoent(cause)) log.warn(`[library] cannot list "${gameDir}":`, describe(cause));
      return;
    }
    for (const name of names) {
      if (KEPT_ON_RECOPY.has(name)) continue;
      await this.removeQuietly(path.join(gameDir, name));
    }
  }

  private async removeQuietly(target: string): Promise<void> {
    try {
      await fse.remove(target);
    } catch (cause) {
      log.warn(`[library] failed to remove "${target}":`, describe(cause));
    }
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
    // `id` is a single safe path segment (no separators, no bare dots) — enforced by the manifest schema
    // for an id that came off a card, and by `isSafeGameId` at the IPC boundary for one that came from
    // the renderer, which addresses a history game by id alone (see GameConfigService.init).
    return path.join(this.dir, id);
  }

  private cardSlotPath(id: string): string {
    return path.join(this.gameDir(id), CARD_SLOT_FILENAME);
  }

  private editedManifestPath(id: string): string {
    return path.join(this.gameDir(id), EDITED_MANIFEST_FILENAME);
  }

  private stagedDir(id: string): string {
    return path.join(this.gameDir(id), STAGED_DIRNAME);
  }
}

/** Reads a JSON file as a slot object, or null when it is absent or not one. */
async function readSlotFile(filePath: string): Promise<GameSlot | null> {
  const text = await readTextFile(filePath);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as GameSlot;
  } catch (cause) {
    log.warn(`[library] "${filePath}" is not readable JSON:`, describe(cause));
    return null;
  }
}

/** File contents, or null when the file is not there (a normal state for both history files). */
async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fse.readFile(filePath, 'utf8');
  } catch (cause) {
    if (!isEnoent(cause)) log.warn(`[library] cannot read "${filePath}":`, describe(cause));
    return null;
  }
}

/** True for an "it isn't there" fs error — an absent history file is a normal state, not a failure. */
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
