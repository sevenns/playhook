// The pure half of "configure a game from the history" — the slot surgery and the sync verdict, with no
// electron, no fs and no app state, so it is unit-testable and safe on the daemon's graph.
//
// Two ideas carry the feature:
//
//   * A game's entry in `game.json` is a SLOT — the whole file is either one game object or an array of
//     them. The launcher edits one slot and must leave every neighbour, and every key it does not know
//     about (`description`/`genres` written by "Find online"), exactly as the author left it. So the slot
//     travels as a parsed value, never as a schema-narrowed one: `ResolvedManifest.raw` has already lost
//     the unknown keys, and a hash taken from it would never match a hash taken from the text.
//   * Which side wins on insertion is decided by CONTENT, not by clocks (see save-sync.ts, the same
//     shape): each side is compared against the snapshot we last saw, and the timestamps are consulted
//     only to break a real conflict — a FAT card's mtime and this PC's clock are not trustworthy enough
//     to be the primary mechanism.
import { createHash } from 'node:crypto';

/** One game's entry in `game.json`, as parsed — unknown keys included. */
export type GameSlot = Readonly<Record<string, unknown>>;

/** Why a slot could not be taken out of (or put back into) the manifest text. */
export type SlotFailure =
  | 'invalid-json'
  | 'not-object-or-array'
  | 'missing-id'
  | 'duplicate-id';

export type SlotResult =
  | { readonly ok: true; readonly slot: GameSlot }
  | { readonly ok: false; readonly reason: SlotFailure };

export type SlotTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: SlotFailure };

/** How far apart two timestamps may sit and still count as "the same moment" (see save-sync.ts). */
export const CONFIG_SYNC_TOLERANCE_MS = 2000;

/**
 * The slot of `id` in a manifest text, with every key it carries.
 *
 * A file with the id twice is refused rather than guessed at: readManifests rejects such a card anyway
 * (`manifest.duplicateId`), and editing one of the two blind would be a coin flip.
 */
export function extractGameSlot(text: string, id: string): SlotResult {
  const items = parseSlots(text);
  if (!items.ok) return items;
  const matching = items.slots.filter((slot) => slot['id'] === id);
  if (matching.length > 1) return { ok: false, reason: 'duplicate-id' };
  const slot = matching[0];
  if (slot === undefined) return { ok: false, reason: 'missing-id' };
  return { ok: true, slot };
}

/**
 * The manifest text with `id`'s slot replaced by `slot`, keeping the file's shape (a bare object stays a
 * bare object, an array stays an array with its neighbours in place).
 *
 * The file is re-serialized, so hand-authored formatting of the OTHER slots is lost — their DATA is not,
 * unknown keys included. That trade is deliberate: a range-level text replacement would be both dearer
 * and more fragile (see the plan, п.7).
 */
export function replaceGameSlot(text: string, id: string, slot: GameSlot): SlotTextResult {
  const items = parseSlots(text);
  if (!items.ok) return items;
  const indexes = items.slots.flatMap((item, index) => (item['id'] === id ? [index] : []));
  if (indexes.length > 1) return { ok: false, reason: 'duplicate-id' };
  const index = indexes[0];
  if (index === undefined) return { ok: false, reason: 'missing-id' };
  const replaced = items.slots.map((item, at) => (at === index ? slot : item));
  const value: unknown = items.isArray ? replaced : replaced[0];
  return { ok: true, text: `${JSON.stringify(value, null, 2)}\n` };
}

/** sha256 of the slot in canonical form — key order and formatting cannot move the hash. */
export function slotHash(slot: GameSlot): string {
  return createHash('sha256').update(canonicalJson(slot)).digest('hex');
}

export interface ConfigSyncInput {
  /** The history holds edits the user has not synced yet (`configuredAt !== null`). */
  readonly historyDirty: boolean;
  /** The card's slot differs from the snapshot we last took of it. */
  readonly cardChanged: boolean;
  /** mtime of the card's `game.json`, or null when it could not be read. */
  readonly cardMtimeMs: number | null;
  /** When the pending edits were saved, or null when there are none. */
  readonly configuredAtMs: number | null;
  readonly toleranceMs?: number;
}

/**
 * What the insertion should do with one game:
 *
 *   * `none`     — nothing to sync; the card is the truth, exactly as before this feature.
 *   * `apply`    — write the history's edits onto the card.
 *   * `take-card` — drop the history's edits; the card's version is the newer one.
 *
 * Only a genuine conflict (both sides moved) consults the clocks, and there the card wins any tie — the
 * conservative direction, since it is what the launcher did before.
 */
export function decideConfigSync(input: ConfigSyncInput): 'apply' | 'take-card' | 'none' {
  const { historyDirty, cardChanged, cardMtimeMs, configuredAtMs } = input;
  if (!historyDirty) return 'none';
  if (!cardChanged) return 'apply';
  if (cardMtimeMs === null || configuredAtMs === null) return 'take-card';
  const tolerance = input.toleranceMs ?? CONFIG_SYNC_TOLERANCE_MS;
  return configuredAtMs > cardMtimeMs + tolerance ? 'apply' : 'take-card';
}

type ParsedSlots =
  | { readonly ok: true; readonly slots: readonly GameSlot[]; readonly isArray: boolean }
  | { readonly ok: false; readonly reason: SlotFailure };

function parseSlots(text: string): ParsedSlots {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (Array.isArray(parsed)) {
    const slots = parsed.filter(isSlot);
    if (slots.length !== parsed.length) return { ok: false, reason: 'not-object-or-array' };
    return { ok: true, slots, isArray: true };
  }
  if (!isSlot(parsed)) return { ok: false, reason: 'not-object-or-array' };
  return { ok: true, slots: [parsed], isArray: false };
}

function isSlot(value: unknown): value is GameSlot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted at every depth — arrays keep their order, which is data. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
