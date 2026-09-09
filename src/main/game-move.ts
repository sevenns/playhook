// The electron-free half of "Move to card…" (see the plan, Р2.4/Р2.5/Р2.8): moving a local (PC-library)
// game onto a card. Pure so it can be unit-tested — the transaction itself (GameConfigService.moveToCard)
// touches fs and cannot be imported in vitest, the same reason game-config-add.ts was carved out.
import path from 'node:path';
import {
  movedGridAssetPath,
  movedHeroAssetPath,
  movedMusicAssetPath,
} from '../shared/asset-move-names';
import { type ResolvedManifest } from '../shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Manifest TEXT with `id`'s game removed — used for BOTH halves of a move's rollback story: the PC
 * library's post-move text (the "from" side — never sent by the renderer, always derived here; the same
 * never-trust-the-renderer's-derived-text stance the rest of GameConfigService takes for a write), and the
 * target card's PRE-move text, recovered by removing the just-inserted slot back out of `toText` (used to
 * best-effort restore the card if the library write fails after the card's already been written — see the
 * plan, Р2.5's rollback note). Mirrors `gamesToText`'s shape rules (configure-form-model.ts) so the result
 * round-trips through the SAME reader every other write does: a lone object for exactly one game left, an
 * array for more than one, `'[]\n'` for none. Returns null only if `text` is not valid JSON, which never
 * happens for text this function is actually called with (always already schema-validated beforehand).
 */
export function removeGameFromManifestText(id: string, text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const items: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const kept = items.filter((item) => !(isRecord(item) && item['id'] === id));
  if (kept.length === 0) return '[]\n';
  const value: unknown = kept.length === 1 ? kept[0] : kept;
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The raw (already-validated) JSON object for game `id` inside manifest `text` — a single object or one
 * element of an array. Null when `text` is not valid JSON or names no game with that id. */
export function findGameInText(id: string, text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const items: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const found = items.find((item) => isRecord(item) && item['id'] === id);
  return found !== undefined && isRecord(found) ? found : null;
}

/**
 * The card-relative path that must already exist on the target BEFORE a move commits (Р2.6 — "the files
 * of the game itself"), or null when there is nothing to check: Steam mode has no card file at all.
 *
 * `carryFormToCard` only ever LANDS a moved game in `steam` or `executable` mode, but the form stays open
 * afterwards and offers every mode a card allows — Installer among them — so all three are reachable by
 * the time Save runs. Which field names the on-card file differs per mode:
 *  • installer (`install.type` other than `copy`) — `install.installer`. `executable` there is a path
 *    INSIDE the installed game (manifest.ts resolveInstall resolves it against the install dir, not the
 *    card), so checking it would reject a perfectly good move forever;
 *  • `copy` — `executable`, which in that mode is card-root-relative and includes the source directory
 *    prefix, so it names a real file on the card;
 *  • no install block — `executable`, card-relative as usual.
 */
export function expectedGameFilePath(raw: Record<string, unknown>): string | null {
  if (raw['steam'] !== undefined) return null;
  const install = raw['install'];
  if (isRecord(install) && install['type'] !== 'copy') {
    return typeof install['installer'] === 'string' ? install['installer'] : null;
  }
  return typeof raw['executable'] === 'string' ? raw['executable'] : null;
}

/** How many games in manifest `text` carry `id` — used to detect an id already taken on the target card
 * (our own inserted slot always counts as one; more than one means a genuine collision). */
export function countGamesWithId(id: string, text: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return 0;
  }
  const items: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return items.filter((item) => isRecord(item) && item['id'] === id).length;
}

/** One asset that needs copying: an absolute source (in the PC library) to an absolute destination (under
 * the target card root), the destination named by the SAME deterministic function the renderer used to
 * write the path into the target manifest text (see asset-move-names.ts). */
export interface AssetCopyPlan {
  readonly from: string;
  readonly to: string;
}

/**
 * The asset copies a move needs, derived from the SOURCE game's resolved manifest (absolute paths) and its
 * id. Order is stable (hero images in manifest order, then grid, then music) but not meaningful beyond
 * that — each copy is independent.
 */
export function planAssetCopies(
  manifest: Pick<ResolvedManifest, 'heroImagePaths' | 'gridImagePath' | 'backgroundMusicPath'>,
  id: string,
  targetRoot: string,
): readonly AssetCopyPlan[] {
  const plans: AssetCopyPlan[] = [];
  for (const [index, source] of (manifest.heroImagePaths ?? []).entries()) {
    plans.push({ from: source, to: path.join(targetRoot, movedHeroAssetPath(id, index, source)) });
  }
  if (manifest.gridImagePath !== undefined) {
    plans.push({
      from: manifest.gridImagePath,
      to: path.join(targetRoot, movedGridAssetPath(id, manifest.gridImagePath)),
    });
  }
  if (manifest.backgroundMusicPath !== undefined) {
    plans.push({
      from: manifest.backgroundMusicPath,
      to: path.join(targetRoot, movedMusicAssetPath(id, manifest.backgroundMusicPath)),
    });
  }
  return plans;
}
