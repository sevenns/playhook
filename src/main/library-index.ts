// The launcher's game HISTORY index — pure ordering/eviction logic over `library/index.json`, with no fs
// and no electron (LibraryStore owns the bytes; this module owns the rules, so they are unit-testable).
//
// The index is a DENORMALIZATION, not a second source of truth: `launchCount`/`lastPlayedAt` are cached
// copies of `stats/<id>.json` (the authority), kept here so building the carousel doesn't read up to
// MAX_LIBRARY_ENTRIES stats files off disk on every card insert. LibraryStore re-syncs them on init and
// after every recorded play.
import type { SfxName } from '../shared/types';

/** One game's copied assets + the cached stats that order the carousel. Paths are FILE NAMES inside
 * `library/<id>/`, never absolute — the store owns the base directory. */
export interface LibraryEntryRecord {
  readonly id: string;
  readonly title: string;
  /** Raw copy of the card's gridImage (or its first heroImage when the card has no grid). */
  readonly grid?: string;
  /** Lazily-produced downscaled version of `grid` (created on the first grid request). */
  readonly gridThumb?: string;
  /** Hero backgrounds IN MANIFEST ORDER — the renderer's palette cache is keyed by position, so a
   * reshuffle would hand a game another game's background colors. */
  readonly hero: readonly string[];
  readonly music?: string;
  readonly sounds: Partial<Record<SfxName, string>>;
  readonly savedAt: string;
  /** `<mtimeMs>:<size>` of the SOURCE grid file — an unchanged card is not re-copied on every insert. */
  readonly sourceSig?: string;
  /** Cached from stats/<id>.json (see the module doc). */
  readonly launchCount: number;
  readonly lastPlayedAt: string | null;
}

export interface LibraryIndex {
  readonly schemaVersion: 1;
  readonly entries: readonly LibraryEntryRecord[];
}

export const EMPTY_LIBRARY_INDEX: LibraryIndex = { schemaVersion: 1, entries: [] };

/** Result of an upsert: the new index plus whether an entry for this id already existed under a
 * DIFFERENT title/source — a card-id collision between two cards, which the store logs (Р3). */
export interface UpsertResult {
  readonly index: LibraryIndex;
  readonly replacedForeign: boolean;
}

/**
 * Inserts or replaces one game's record, keyed by id. A replacement whose title or source signature
 * differs from the stored one is flagged `replacedForeign`: two different cards sharing a `manifest.id`
 * now clobber each other's COVER AND NAME (before the library they only merged invisible stats numbers),
 * so it deserves a breadcrumb even though replacing is still the right move.
 */
export function upsertEntry(index: LibraryIndex, record: LibraryEntryRecord): UpsertResult {
  const previous = index.entries.find((entry) => entry.id === record.id);
  const replacedForeign =
    previous !== undefined &&
    (previous.title !== record.title ||
      (previous.sourceSig !== undefined &&
        record.sourceSig !== undefined &&
        previous.sourceSig !== record.sourceSig));
  const entries =
    previous === undefined
      ? [...index.entries, record]
      : index.entries.map((entry) => (entry.id === record.id ? record : entry));
  return { index: { schemaVersion: 1, entries }, replacedForeign };
}

/** Drops one id from the index (used by the store after removing its directory). */
export function removeEntry(index: LibraryIndex, id: string): LibraryIndex {
  return { schemaVersion: 1, entries: index.entries.filter((entry) => entry.id !== id) };
}

/** What `evictBeyond` decided: the trimmed index and the ids whose directories must be deleted. */
export interface EvictResult {
  readonly index: LibraryIndex;
  readonly evicted: readonly string[];
}

/**
 * Trims the index to `limit` records. Eviction order: never-played "orphans" (`lastPlayedAt === null` —
 * a card that was inserted but never launched) first, then the least recently played. Ids on the
 * currently-inserted card (`protectedIds`) are never evicted: they are on screen right now.
 */
export function evictBeyond(
  index: LibraryIndex,
  limit: number,
  protectedIds: readonly string[] = [],
): EvictResult {
  const shielded = new Set(protectedIds);
  const removable = index.entries.filter((entry) => !shielded.has(entry.id));
  const overflow = index.entries.length - limit;
  if (overflow <= 0 || removable.length === 0) return { index, evicted: [] };

  // Weakest first: orphans, then oldest lastPlayedAt. Ties fall back to the title/id so the choice is
  // deterministic (a test asserting "which one went" must not depend on insertion order).
  const byWeakest = [...removable].sort((a, b) => {
    if ((a.lastPlayedAt === null) !== (b.lastPlayedAt === null))
      return a.lastPlayedAt === null ? -1 : 1;
    if (a.lastPlayedAt !== null && b.lastPlayedAt !== null && a.lastPlayedAt !== b.lastPlayedAt) {
      return Date.parse(a.lastPlayedAt) - Date.parse(b.lastPlayedAt);
    }
    return a.id.localeCompare(b.id);
  });
  const evicted = new Set(
    byWeakest.slice(0, Math.min(overflow, byWeakest.length)).map((e) => e.id),
  );
  return {
    index: { schemaVersion: 1, entries: index.entries.filter((entry) => !evicted.has(entry.id)) },
    evicted: [...evicted],
  };
}

/**
 * The carousel order: the games on the inserted card FIRST, in card order (they are the ones you can
 * launch right now), then the history by `lastPlayedAt` descending, `title` breaking ties so equal
 * dates (or two never-played entries) keep a stable, predictable order.
 *
 * History entries that were never launched are dropped: a card inserted but never played leaves a record
 * (assets are copied on insert), and showing it would put games you never started in your history. They
 * stay on disk only until the GC gets to them.
 */
export function orderForCarousel(
  entries: readonly LibraryEntryRecord[],
  activeIds: readonly string[],
): readonly LibraryEntryRecord[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const active: LibraryEntryRecord[] = [];
  for (const id of activeIds) {
    const entry = byId.get(id);
    if (entry !== undefined) active.push(entry);
  }
  const activeSet = new Set(activeIds);
  const history = entries
    .filter((entry) => !activeSet.has(entry.id) && entry.launchCount > 0)
    .sort((a, b) => {
      const at = a.lastPlayedAt === null ? 0 : Date.parse(a.lastPlayedAt);
      const bt = b.lastPlayedAt === null ? 0 : Date.parse(b.lastPlayedAt);
      if (at !== bt) return bt - at;
      return a.title.localeCompare(b.title);
    });
  return [...active, ...history];
}
