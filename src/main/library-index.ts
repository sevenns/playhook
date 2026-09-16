// The launcher's game HISTORY index — pure ordering logic over `library/index.json`, with no fs and no
// electron (LibraryStore owns the bytes; this module owns the rules, so they are unit-testable).
//
// The index is a DENORMALIZATION, not a second source of truth: `launchCount`/`lastPlayedAt` are cached
// copies of `stats/<id>.json` (the authority), kept here so building the carousel doesn't read a stats
// file per game off disk on every card insert. LibraryStore re-syncs them on init and after every
// recorded play.
//
// The history is UNBOUNDED by decision: it once evicted the weakest records past a 40-game limit, but a
// record may now hold edits waiting for their card (see history-config.ts), and throwing those away
// behind the user's back is worse than the disk they cost. `forget` is the only way out.

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
  /** Which source wrote this record last — a card, or this PC's own library. Absent on a record written
   * before the field existed; those are read as `'card'` (nearly all history is cards) and fill in the
   * next time the game shows up. Drives the library screen's source filter. */
  readonly sourceKind?: 'card' | 'pc';
  /** sha256 of the game's slot AS WE LAST SAW IT ON THE CARD — the baseline the insertion compares the
   * card against (see history-config.ts `slotHash`). Absent until the first insert that snapshots it,
   * which reads as "the card moved", i.e. the pre-feature behaviour. */
  readonly cardSlotHash?: string;
  /** When the user last saved edits for this game FROM THE HISTORY, or null when there are none pending.
   * Non-null is what makes the next insertion consider writing them onto the card. */
  readonly configuredAt: string | null;
  /** When the user answered the "this game is on the card AND on this PC" dialog for this id, or null
   * when they have not — the answer is remembered so the dialog does not return on every insert. */
  readonly collisionResolvedAt: string | null;
}

export interface LibraryIndex {
  readonly schemaVersion: 1;
  readonly entries: readonly LibraryEntryRecord[];
}

export const EMPTY_LIBRARY_INDEX: LibraryIndex = { schemaVersion: 1, entries: [] };

/** Result of an upsert: the new index plus whether an entry for this id already existed under a
 * DIFFERENT TITLE — a card-id collision between two cards, which the store logs. */
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
 *
 * `previousTitle` overrides what the stored record says the game was called. The insertion path passes
 * the title of the PRISTINE card snapshot, because `record.title` is now editable from the history: a
 * rename saved but not yet applied to the card would otherwise read as a foreign card on every single
 * insert — a false warning plus a pointless re-copy of every asset.
 *
 * A genuinely foreign replacement also CLEARS `collisionResolvedAt`: the user answered the collision
 * dialog about a different game, so that answer says nothing about this one.
 */
export function upsertEntry(
  index: LibraryIndex,
  record: LibraryEntryRecord,
  previousTitle?: string,
): UpsertResult {
  const previous = index.entries.find((entry) => entry.id === record.id);
  const before = previousTitle ?? previous?.title;
  const replacedForeign = previous !== undefined && before !== record.title;
  const stored = replacedForeign ? { ...record, collisionResolvedAt: null } : record;
  const entries =
    previous === undefined
      ? [...index.entries, stored]
      : index.entries.map((entry) => (entry.id === record.id ? stored : entry));
  return { index: { schemaVersion: 1, entries }, replacedForeign };
}

/** Drops one id from the index (used by the store after removing its directory). */
export function removeEntry(index: LibraryIndex, id: string): LibraryIndex {
  return { schemaVersion: 1, entries: index.entries.filter((entry) => entry.id !== id) };
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
