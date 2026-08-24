// The file name an asset picked from the user's filesystem gets INSIDE the app's own storage — the PC
// library's `assets/`, and the history staging directory that reuses the same rules (see the
// history-config plan, Р9).
//
// Two properties matter and they pull against each other. The name comes from a foreign filesystem, so
// everything outside a conservative ASCII set must go (traversal, leading dots, exFAT-hostile characters
// — the card these files eventually land on is FAT/exFAT). But the EXTENSION is not decoration: the
// AssetReader decides an asset's type from it (see asset-reader.ts) and refuses what it cannot name, so a
// sanitizer that eats the extension makes the asset invisible. Sanitizing the stem only — and keeping the
// extension verbatim, lower-cased — satisfies both: "обложка.png" becomes "asset.png", not "png".
//
// Electron-free and fs-light on purpose: the pure half is unit-tested, the collision half needs only a
// directory listing.
import path from 'node:path';
import fse from 'fs-extra';

/** Characters an imported asset's file name may keep. Everything else collapses into `-`. */
const SAFE_ASSET_NAME = /[^A-Za-z0-9._-]+/g;

/** What a stem sanitizes to when nothing printable survives (a fully non-Latin name). */
const FALLBACK_STEM = 'asset';

/**
 * A sanitized file name: stem scrubbed of anything outside the safe set and of leading dots/dashes,
 * extension preserved (lower-cased) whatever the stem turns into.
 */
export function safeAssetFileName(original: string): string {
  const base = path.basename(original.replaceAll('\\', '/'));
  const raw = path.extname(base);
  const extension = /[A-Za-z0-9]/.test(raw) ? raw.replace(SAFE_ASSET_NAME, '-').toLowerCase() : '';
  const stem = base
    .slice(0, base.length - raw.length)
    .replace(SAFE_ASSET_NAME, '-')
    .replace(/^[-.]+/, '');
  return `${stem.length > 0 ? stem : FALLBACK_STEM}${extension}`;
}

/**
 * The same name, made collision-free inside `directory` with a `-2`, `-3`… suffix — so importing two
 * different `hero.jpg` files never overwrites the first one.
 */
export async function uniqueAssetFileName(directory: string, original: string): Promise<string> {
  const safe = safeAssetFileName(original);
  const extension = path.extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);
  let candidate = safe;
  for (let suffix = 2; await fse.pathExists(path.join(directory, candidate)); suffix += 1) {
    candidate = `${stem}-${suffix}${extension}`;
  }
  return candidate;
}
