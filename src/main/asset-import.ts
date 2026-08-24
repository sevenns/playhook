// The refusals every asset import passes through — the PC library's `assets/`, and the history's staging
// directory that reuses them (see the history-config plan, Р9).
//
// They were implicit while the only way in was a native dialog whose filters the OS enforced; the
// in-launcher picker names the path from the renderer instead, so the limits are stated here, in the one
// place both import paths share. Electron-free, like the pickers' other helpers.
import path from 'node:path';
import fse from 'fs-extra';

/** What an import may be. The allowed extensions themselves come from the caller (the AssetReader's). */
export type ImportKind = 'image' | 'audio';

/**
 * How big an import may be. The sizes are chosen with room to spare over what real artwork and music
 * weigh: a 4K PNG cover is a few megabytes, a lossless album track tens of them. They exist to stop a
 * disk image being copied into `<userData>` by a mistyped path, not to police the user's files.
 */
export const MAX_IMPORT_BYTES: Readonly<Record<ImportKind, number>> = {
  image: 32 * 1024 * 1024,
  audio: 64 * 1024 * 1024,
};

/**
 * Throws unless the path may be imported: `kind` decides the allowed extensions, `lstat` rejects a
 * symlink (it would copy whatever it points at, from anywhere), and the size cap keeps a mistyped path
 * from filling `<userData>`.
 */
export async function assertImportableAsset(
  absolutePath: string,
  kind: ImportKind,
  allowedExtensions: readonly string[],
): Promise<void> {
  const extension = path.extname(absolutePath).replace(/^\./, '').toLowerCase();
  if (!allowedExtensions.includes(extension)) {
    throw new Error(`refusing to import "${absolutePath}": not a ${kind} extension`);
  }
  const stats = await fse.lstat(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`refusing to import "${absolutePath}": symbolic link`);
  }
  if (!stats.isFile()) {
    throw new Error(`refusing to import "${absolutePath}": not a regular file`);
  }
  if (stats.size > MAX_IMPORT_BYTES[kind]) {
    throw new Error(
      `refusing to import "${absolutePath}": larger than ${MAX_IMPORT_BYTES[kind]} bytes`,
    );
  }
}
