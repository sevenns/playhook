// The launcher's game HISTORY index — pure ordering/eviction logic over `library/index.json`, with no fs
// and no electron (LibraryStore owns the bytes; this module owns the rules, so they are unit-testable).
//
// The index is a DENORMALIZATION, not a second source of truth: `launchCount`/`lastPlayedAt` are cached
// copies of `stats/<id>.json` (the authority), kept here so building the carousel doesn't read up to
// MAX_LIBRARY_ENTRIES stats files off disk on every card insert. LibraryStore re-syncs them on init and
// after every recorded play.

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
  readonly savedAt: string;
  /** When this game was last AVAILABLE — the last time its card was inserted. Written on every insert,
   * including the one that re-copies nothing (unlike `savedAt`, which only moves when the assets really
   * changed). Null for a record written before this field existed; the next insert fills it in. */
  readonly lastSeenAt: string | null;
  /** Fingerprint of every SOURCE asset file — an unchanged card is not re-copied on every insert, while
   * an edited image or music track misses it and forces a fresh copy (see LibraryStore.assetsSignature). */
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
 * DIFFERENT TITLE — a card-id collision between two cards, which the store logs (Р3). */
export interface UpsertResult {
  readonly index: LibraryIndex;
  readonly replacedForeign: boolean;
}

/**
 * Inserts or replaces one game's record, keyed by id. A replacement under a DIFFERENT TITLE is flagged
 * `replacedForeign`: two different cards sharing a `manifest.id` now clobber each other's COVER AND NAME
 * (before the library they only merged invisible stats numbers), so it deserves a breadcrumb even though
 * replacing is still the right move.
 *
 * Changed asset bytes under the SAME title are NOT that: they are the author editing their own card
 * (Configure → Save & Apply), which must re-copy silently.
 */
export function upsertEntry(index: LibraryIndex, record: LibraryEntryRecord): UpsertResult {
  const previous = index.entries.find((entry) => entry.id === record.id);
  const replacedForeign = previous !== undefined && previous.title !== record.title;
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
 * Trims the index to `limit` records. Eviction order is the carousel's order read backwards: the least
 * recently TOUCHED goes first (see lastTouchedAt), and an entry with no date at all — never played, and
 * written before `lastSeenAt` existed — goes before those. Ids on the currently-inserted card
 * (`protectedIds`) are never evicted: they are on screen right now.
 *
 * Ranking by the same date the carousel sorts by is what keeps the two consistent: judged by play date
 * alone, a card you inserted yesterday but never started would be the FIRST thing thrown away while
 * sitting at the top of the strip.
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

  // Weakest first: undated entries, then the oldest touch. Ties fall back to the id so the choice is
  // deterministic (a test asserting "which one went" must not depend on insertion order).
  const byWeakest = [...removable].sort((a, b) => {
    const at = lastTouchedAt(a);
    const bt = lastTouchedAt(b);
    if ((at === null) !== (bt === null)) return at === null ? -1 : 1;
    if (at !== null && bt !== null && at !== bt) return Date.parse(at) - Date.parse(bt);
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

/** The minimum a game must carry to be placed in the carousel — see byRecentlyPlayed. */
export interface PlayedSortable {
  readonly title: string;
  readonly lastPlayedAt: string | null;
}

/** A game that also remembers when its card was last inserted — see lastTouchedAt. */
export interface TouchedSortable extends PlayedSortable {
  readonly lastSeenAt: string | null;
}

/**
 * Newest date first, `null` (never) LAST — a missing date means "never happened", not "happened at
 * epoch". `title` breaks every tie, so equal dates (or a row of never-dated games) keep a stable,
 * predictable order instead of drifting with insertion order.
 */
function byDateDesc<T extends { readonly title: string }>(
  items: readonly T[],
  dateOf: (item: T) => string | null,
): readonly T[] {
  return [...items].sort((a, b) => {
    const at = dateOf(a);
    const bt = dateOf(b);
    if ((at === null) !== (bt === null)) return at === null ? 1 : -1;
    if (at !== null && bt !== null && at !== bt) return Date.parse(bt) - Date.parse(at);
    return a.title.localeCompare(b.title);
  });
}

/** Most recently played first. Used for the group on the INSERTED card, where every game shares one
 *  insertion moment and only the play dates tell them apart. */
export function byRecentlyPlayed<T extends PlayedSortable>(items: readonly T[]): readonly T[] {
  return byDateDesc(items, (item) => item.lastPlayedAt);
}

/**
 * When the game was last RELEVANT: the later of "its card was inserted" (it became launchable) and "it
 * was played". Null only when neither ever happened — an entry written before `lastSeenAt` existed and
 * never launched since.
 *
 * Two dates rather than one because each alone gets a case wrong: by play date, a game inserted
 * yesterday but not started sinks below one played months ago; by insertion date, a game played today
 * sinks because its card has not been re-inserted since.
 */
export function lastTouchedAt(entry: TouchedSortable): string | null {
  if (entry.lastSeenAt === null) return entry.lastPlayedAt;
  if (entry.lastPlayedAt === null) return entry.lastSeenAt;
  return Date.parse(entry.lastSeenAt) >= Date.parse(entry.lastPlayedAt)
    ? entry.lastSeenAt
    : entry.lastPlayedAt;
}

/** Most recently touched first (see lastTouchedAt). Used for the HISTORY group. */
export function byRecentlyTouched<T extends TouchedSortable>(items: readonly T[]): readonly T[] {
  return byDateDesc(items, lastTouchedAt);
}

/**
 * The carousel order: the games on the inserted card FIRST (they are the ones you can launch right now),
 * ordered by `lastPlayedAt` — they all share one insertion moment, so only play dates separate them —
 * then the history, ordered by `lastTouchedAt`.
 *
 * The history holds EVERY game this device has seen, played or not: a card you inserted yesterday and
 * did not get around to starting still belongs at the top of "what I had recently", and hiding it would
 * contradict the very date the group is sorted by.
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
  const history = entries.filter((entry) => !activeSet.has(entry.id));
  return [...byRecentlyPlayed(active), ...byRecentlyTouched(history)];
}
