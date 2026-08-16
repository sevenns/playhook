// The electron-free half of adding a game through the launcher: what gameConfig:read-root answers for a
// root, and which games a write actually ADDED to one. Both are pure so they can be unit-tested — the
// service around them cannot be imported in vitest (ipcMain), which is the same reason launch-args.ts
// was carved out of game-launcher.ts.
import { type ConfigRootReadResult, type ManifestSource } from '../shared/types';

/** The fixed half of a root read — everything that does not depend on whether a game.json is there. */
export interface RootReadBase {
  readonly root: string;
  readonly source: ManifestSource;
  readonly signature: string;
  readonly windows: boolean;
}

/**
 * What the Add-game screen is told about a root. `text` is null when the root carries NO game.json —
 * a blank card, or a PC library with no local game yet — which is the normal case here rather than a
 * failure, and is reported as `hasManifest: false` with an empty text. The screen turns that into an
 * empty slot list; `'[]'` could not be used instead, because parsing it back rejects an empty games array.
 */
export function rootReadResult(base: RootReadBase, text: string | null): ConfigRootReadResult {
  return { ok: true, ...base, hasManifest: text !== null, text: text ?? '' };
}

/** A game that appeared in a manifest — what a notification about the write needs to name it. */
export interface AddedGame {
  readonly id: string;
  readonly title: string;
}

/**
 * The games in `text` whose ids were not in the root's signature before the write (see gameIdsSignature:
 * the sorted ids joined with `|`). Only well-formed text reaches this — Save re-validates first — so a
 * parse failure means "nothing can be said about it" rather than "everything is new".
 *
 * An `'invalid'` signature is treated the same way: the previous file could not be read, so its ids are
 * unknown, and calling every game in the file new would announce games the user never added.
 */
export function addedGamesOf(beforeSignature: string, text: string): readonly AddedGame[] {
  if (beforeSignature === 'invalid') return [];
  const before = new Set(beforeSignature.split('|').filter((id) => id.length > 0));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const games: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const added: AddedGame[] = [];
  for (const game of games) {
    if (typeof game !== 'object' || game === null) continue;
    const id = 'id' in game && typeof game.id === 'string' ? game.id : '';
    if (id.length === 0 || before.has(id)) continue;
    const title = 'title' in game && typeof game.title === 'string' ? game.title : '';
    added.push({ id, title: title.length > 0 ? title : id });
  }
  return added;
}
