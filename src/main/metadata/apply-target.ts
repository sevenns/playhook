// Where an applied download lands, and whether the request that asked for it is even shaped right.
//
// Kept pure and separate from the service for the usual reason: this is the part a mistake would be
// expensive in — the renderer names both the game id and the slot, and both end up in a file path. The
// checks run BEFORE anything is fetched or written, so a malformed request costs no network and no disk.
import { MAX_HERO_IMAGES, type MetadataApplySlot } from '../../shared/types';
import {
  movedGridAssetPath,
  movedHeroAssetPath,
  movedMusicAssetPath,
} from '../../shared/asset-move-names';
import { type MediaKind } from './media-type';

/** The manifest's own id syntax (manifest.ts). Re-stated here because this runs before any parse. */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** A request that passed validation, with the slot narrowed to what the writer branches on. */
export interface ApplyTarget {
  readonly gameId: string;
  readonly slot: MetadataApplySlot;
  /** Which family the download must sniff as for this slot — a cover cannot be an mp3. */
  readonly expectedKind: MediaKind;
}

export type ApplyValidation =
  | { readonly ok: true; readonly target: ApplyTarget }
  | { readonly ok: false; readonly reason: 'bad-id' | 'bad-slot' };

/** Whether the slot is one of the three the manifest has fields for, with a hero index in range. */
function checkSlot(slot: unknown): MetadataApplySlot | null {
  if (slot === 'grid' || slot === 'music') return slot;
  if (typeof slot !== 'object' || slot === null) return null;
  const hero = (slot as { readonly hero?: unknown }).hero;
  if (typeof hero !== 'number' || !Number.isInteger(hero)) return null;
  if (hero < 0 || hero >= MAX_HERO_IMAGES) return null;
  return { hero };
}

export function validateApply(gameId: unknown, slot: unknown): ApplyValidation {
  if (typeof gameId !== 'string' || !ID_PATTERN.test(gameId) || gameId === '.' || gameId === '..') {
    return { ok: false, reason: 'bad-id' };
  }
  const checked = checkSlot(slot);
  if (checked === null) return { ok: false, reason: 'bad-slot' };
  return {
    ok: true,
    target: { gameId, slot: checked, expectedKind: checked === 'music' ? 'audio' : 'image' },
  };
}

/**
 * The manifest-relative path this slot's file takes, under the SAME deterministic names a move-to-card
 * uses (`assets/<id>-grid.jpg` and friends). Reusing them is deliberate: a game whose art was fetched
 * online and one whose art was carried over by a move end up with identically named files, so nothing
 * downstream has to tell the two apart.
 */
export function applyRelativePath(target: ApplyTarget, extension: string): string {
  // The move-to-card helpers take a SOURCE PATH and read the extension off it (a leading dot alone reads
  // as a dotfile with no extension at all), so the extension is handed over as a whole file name.
  const source = `asset.${extension}`;
  if (target.slot === 'grid') return movedGridAssetPath(target.gameId, source);
  if (target.slot === 'music') return movedMusicAssetPath(target.gameId, source);
  return movedHeroAssetPath(target.gameId, target.slot.hero, source);
}

/**
 * The same slot's file under every OTHER allowed extension. Applying a `.png` cover over yesterday's
 * `.jpg` one would otherwise leave the `.jpg` behind for good: the manifest stops naming it, and a card
 * has no orphan collection of its own (unlike the PC library's gcOrphans).
 */
export function stalePathsFor(
  target: ApplyTarget,
  extension: string,
  allowedExtensions: readonly string[],
): readonly string[] {
  return allowedExtensions
    .filter((candidate) => candidate !== extension)
    .map((candidate) => applyRelativePath(target, candidate));
}
