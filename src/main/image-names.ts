// Pure helpers for matching a running game by its process IMAGE NAME (the *.exe basename), used by the
// return-to-game feature (window-finder resolves a window's process path, we compare its basename against
// the game's expected image names). Split out of the koffi-bound window-finder so this logic is testable
// in plain Node (window-finder evaluates FFI at import — see CLAUDE.md "Tests").
//
// Windows paths use backslashes and QueryFullProcessImageNameW returns a full Win32 path, so we normalize
// with path.win32.basename explicitly — deterministic on any host OS (the app itself is Windows-only).
import path from 'node:path';

/** The comparable image name for a name-or-path: the Win32 basename, lower-cased. */
export function toImageName(nameOrPath: string): string {
  return path.win32.basename(nameOrPath).toLowerCase();
}

/** Normalizes a list of names/paths to lower-cased *.exe basenames, dropping empties. */
export function normalizeImageNames(names: readonly string[]): readonly string[] {
  return names.map(toImageName).filter((name) => name.length > 0);
}

/** True if the window's process image path matches any of the (already-normalized) wanted image names. */
export function imageMatches(windowImagePath: string, wanted: readonly string[]): boolean {
  return wanted.includes(toImageName(windowImagePath));
}
