// Deterministic, id-based names a locally moved game's assets get on the DESTINATION card (see the plan,
// Р2.4). The card's game.json is written verbatim (never re-serialized — see game-config.ts), so the
// target file names must be known BEFORE anything is written, not derived from what main happens to copy.
//
// Pure and shared between the renderer (which writes these paths into the target game.json text as part
// of building the move — see carryFormToCard in game-settings-model.ts) and main (which copies the actual
// asset files under these same names — see game-move.ts). Neither side re-derives the answer from the
// other, so the two cannot desync.
//
// A collision is possible only with a PREVIOUS copy of the SAME game (the id is already checked unique on
// the target card before anything is copied — see GameConfigService.moveToCard), so overwriting is safe.

/** The file extension (with its leading dot), taken from the last path segment. '' when there is none. */
function assetExtension(sourcePath: string): string {
  const slash = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
  const base = slash === -1 ? sourcePath : sourcePath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

/** `assets/<id>-hero-<n>.<ext>` — n is 1-based, matching the manifest's hero rotation order. */
export function movedHeroAssetPath(id: string, index: number, sourcePath: string): string {
  return `assets/${id}-hero-${index + 1}${assetExtension(sourcePath)}`;
}

/** `assets/<id>-grid.<ext>` — the carousel card image. */
export function movedGridAssetPath(id: string, sourcePath: string): string {
  return `assets/${id}-grid${assetExtension(sourcePath)}`;
}

/** `assets/<id>-music.<ext>` — the background music track. */
export function movedMusicAssetPath(id: string, sourcePath: string): string {
  return `assets/${id}-music${assetExtension(sourcePath)}`;
}
