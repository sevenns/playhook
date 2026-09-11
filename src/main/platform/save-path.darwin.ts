// macOS SavePathResolver: maps the card's Windows-dictionary `pcSavePath` onto a real folder in the
// user's home. There is no Wine prefix here — a mac game writes into the mac profile — so the mapping is a
// best-effort translation of the Windows known folders:
//
//   %APPDATA% / %LOCALAPPDATA% / %LOCALLOW%  →  ~/Library/Application Support
//   %USERPROFILE%                            →  ~
//   %DOCUMENTS%                              →  ~/Documents
//
// The three AppData prefixes collapsing onto one base is deliberate: Unity on macOS writes to
// `~/Library/Application Support/<Company>/<Product>`, which is exactly what it puts in LocalLow on
// Windows, and for everything else this is the closest approximation available. When a game keeps its
// saves elsewhere, the sync simply reports a missing folder — nothing destructive.
//
// The REVERSE mapping is therefore ambiguous, and that ambiguity is contained rather than papered over:
// `%APPDATA%` is the canonical answer for a folder the user picks under Application Support. A pcSavePath
// the user never touched is not re-derived through this (see the Configure flow), so an existing
// `%LOCALLOW%/…` card is never silently rewritten into `%APPDATA%/…` — on Windows those are two different
// folders.
//
// The prefix→path mapping is pure (unit-tested without fs); paths are built with `path.posix` (CLAUDE.md).
import path from 'node:path';
import type { ResolvedManifest } from '../../shared/types';
import type { PcSaveLocation, SavePathResolver } from './types';

/** The home-relative bases the Windows prefixes map onto. Resolved once from the OS/Electron paths. */
export interface DarwinSaveBases {
  /** The user's home directory (`os.homedir()`). */
  readonly home: string;
  /** The Documents known folder (`app.getPath('documents')`). */
  readonly documents: string;
}

/** `~/Library/Application Support` — where every AppData-family prefix lands on macOS. */
export function applicationSupportDir(home: string): string {
  return path.posix.join(home, 'Library', 'Application Support');
}

/**
 * The absolute base a Windows env-prefix maps to on macOS, or null for an unknown token. Pure.
 * Kept as an explicit switch (not a table keyed by string) so an unknown prefix cannot silently resolve.
 */
export function darwinSaveBase(bases: DarwinSaveBases, prefix: string): string | null {
  switch (prefix.toUpperCase()) {
    case 'APPDATA':
    case 'LOCALAPPDATA':
    case 'LOCALLOW':
      return applicationSupportDir(bases.home);
    case 'USERPROFILE':
      return bases.home;
    case 'DOCUMENTS':
      return bases.documents;
    default:
      return null;
  }
}

/**
 * Maps a manifest `pcSavePath` (`%APPDATA%\rest`, …) to an ABSOLUTE macOS folder. Pure — no fs. Returns
 * null for an unknown/absent prefix token or a `..`-traversal in the tail (both already rejected upstream
 * by validatePcSavePathStatic, so null here is defensive). Both `\` and `/` separate the tail (a Windows
 * manifest may use either), mirroring expandPcSavePath.
 */
export function resolveDarwinPcSavePath(bases: DarwinSaveBases, pcSavePath: string): string | null {
  const match = /^%([A-Za-z]+)%[\\/]?(.*)$/.exec(pcSavePath);
  if (match === null) return null;
  const base = darwinSaveBase(bases, match[1] ?? '');
  if (base === null) return null;
  const tail = (match[2] ?? '').split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (tail.includes('..')) return null;
  return path.posix.join(base, ...tail);
}

/**
 * Reverse of resolveDarwinPcSavePath, for the Configure window's pcSavePath Browse: an ABSOLUTE mac folder
 * → a `%PREFIX%/…` manifest string, or null when it lives under none of the bases (then it cannot be
 * expressed and the picker rejects it). Pure.
 *
 * Matching is segment-wise (never string-prefix) and the LONGEST base wins, so the bare home
 * (`%USERPROFILE%`) is the last resort. Application Support answers `%APPDATA%` — the canonical choice for
 * the three prefixes that share that base (see the header).
 */
export function darwinToManifestPcSavePath(bases: DarwinSaveBases, absolute: string): string | null {
  const candidates: ReadonlyArray<{ readonly token: string; readonly base: string }> = [
    { token: 'APPDATA', base: applicationSupportDir(bases.home) },
    { token: 'DOCUMENTS', base: bases.documents },
    { token: 'USERPROFILE', base: bases.home },
  ];
  const segmentsOf = (value: string): readonly string[] =>
    value.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const target = segmentsOf(absolute);
  const byLongestBase = [...candidates].sort(
    (a, b) => segmentsOf(b.base).length - segmentsOf(a.base).length,
  );
  for (const { token, base } of byLongestBase) {
    const baseSegments = segmentsOf(base);
    if (baseSegments.length === 0 || target.length < baseSegments.length) continue;
    const matches = baseSegments.every((segment, i) => target[i] === segment);
    if (!matches) continue;
    const rest = target.slice(baseSegments.length);
    return rest.length === 0 ? `%${token}%` : `%${token}%/${rest.join('/')}`;
  }
  return null;
}

/**
 * The macOS SavePathResolver. `containerExists` is always true, exactly as on win32: the container here is
 * the user's home, which exists for as long as the app runs. There is no prefix that an uninstall can wipe,
 * so the pre-port change-detection semantics (an empty save folder DOES mean the saves were deleted) hold.
 */
export function createDarwinSavePathResolver(bases: DarwinSaveBases): SavePathResolver {
  return {
    resolvePcSavePath(manifest: ResolvedManifest, pcSavePath: string): Promise<PcSaveLocation | null> {
      // A local mac game may point straight at a folder (`/Users/me/Library/…`) instead of a `%PREFIX%`
      // token — it is already a host path, so there is nothing to translate (symmetric with win32).
      if (manifest.source === 'pc' && path.posix.isAbsolute(pcSavePath)) {
        return Promise.resolve({ path: path.posix.normalize(pcSavePath), containerExists: true });
      }
      const resolved = resolveDarwinPcSavePath(bases, pcSavePath);
      return Promise.resolve(resolved === null ? null : { path: resolved, containerExists: true });
    },
    toManifestPcSavePath: (absolute) => darwinToManifestPcSavePath(bases, absolute),
  };
}
