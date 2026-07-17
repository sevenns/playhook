// Linux SavePathResolver (Р5/Э6): resolves the Windows-dictionary `pcSavePath` to a physical folder
// INSIDE the game's Wine prefix (exe/install modes) or its Steam compatdata prefix (steam mode). The
// moment of resolution is sync-time, not manifest-read, so a prefix that doesn't exist yet is a no-op
// sync (null), not a rejected card. The prefix→subpath mapping is a pure function (unit-tested without
// fs); the async wrapper adds the per-game prefix lookup + existence gate.
import path from 'node:path';
import fse from 'fs-extra';
import type { ResolvedManifest } from '../../shared/types';
import type { PcSaveLocation, SavePathResolver, SteamLocator } from './types';
import { prefixDir } from './umu';
import { steamLibraryDirs } from '../steam';
import { log } from '../logger';

/**
 * Where each Windows env-prefix lives inside a Wine prefix, relative to `drive_c` (Р5). Wine lays the
 * steamuser home out exactly like a Windows profile, so the mapping is a fixed table. `%USERPROFILE%` is
 * the steamuser home itself (empty tail). Modern Proton uses the Vista+ `AppData\…` / `Documents` layout
 * (not the XP `My Documents` one), matching the prefixes we create and the compatdata Steam maintains.
 */
const WINE_PREFIX_SUBPATHS: Readonly<Record<string, readonly string[]>> = {
  APPDATA: ['users', 'steamuser', 'AppData', 'Roaming'],
  LOCALAPPDATA: ['users', 'steamuser', 'AppData', 'Local'],
  LOCALLOW: ['users', 'steamuser', 'AppData', 'LocalLow'],
  USERPROFILE: ['users', 'steamuser'],
  DOCUMENTS: ['users', 'steamuser', 'Documents'],
};

/**
 * Maps a manifest `pcSavePath` (`%APPDATA%\rest`, …) to the ABSOLUTE host folder inside the Wine prefix
 * rooted at `pfx` (`<pfx>/drive_c/users/steamuser/AppData/Roaming/rest`, …). Pure — no fs. Returns null
 * for an unknown/absent prefix token or a `..`-traversal in the tail (both already rejected upstream by
 * validatePcSavePathStatic, so null here is defensive). Both `\` and `/` separate the tail (a Windows
 * manifest may use either), mirroring expandPcSavePath.
 */
export function resolveInsideWinePrefix(pfx: string, pcSavePath: string): string | null {
  const match = /^%([A-Za-z]+)%[\\/]?(.*)$/.exec(pcSavePath);
  if (match === null) return null;
  const prefix = (match[1] ?? '').toUpperCase();
  const base = WINE_PREFIX_SUBPATHS[prefix];
  if (base === undefined) return null;
  const tail = (match[2] ?? '').split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (tail.includes('..')) return null;
  // POSIX-join: this is always a Linux path regardless of the OS the tests run on.
  return path.posix.join(pfx, 'drive_c', ...base, ...tail);
}

/**
 * Reverse of resolveInsideWinePrefix, for the Configure window's pcSavePath Browse (Р5). Takes an
 * ABSOLUTE host folder the user picked and expresses it as a `%PREFIX%/…` manifest string, or null when it
 * lives in no Wine prefix at all (then it cannot be a Windows game's save location and the picker rejects
 * it). Pure.
 *
 * Which prefix it belongs to is irrelevant — only the part below `drive_c` decides the token — so this
 * works for both the app's own per-game prefixes and Steam's compatdata. The realistic flow is: run the
 * game once, then Browse to the folder it actually saved into and get the portable Windows-dictionary
 * string back. Matching is segment-wise (never string-prefix), so `AppData/LocalLow` can't be mistaken for
 * `AppData/Local`, and the longest base wins so the bare steamuser home (%USERPROFILE%) is the last resort.
 */
export function winePrefixToManifestPcSavePath(absolute: string): string | null {
  const segments = absolute.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const driveIndex = segments.lastIndexOf('drive_c');
  if (driveIndex === -1) return null;
  const inside = segments.slice(driveIndex + 1);
  const byLongestBase = Object.entries(WINE_PREFIX_SUBPATHS).sort(([, a], [, b]) => b.length - a.length);
  for (const [token, base] of byLongestBase) {
    if (inside.length < base.length) continue;
    const matches = base.every((segment, i) => inside[i]?.toLowerCase() === segment.toLowerCase());
    if (!matches) continue;
    const rest = inside.slice(base.length);
    return rest.length === 0 ? `%${token}%` : `%${token}%/${rest.join('/')}`;
  }
  return null;
}

/** Deps for the linux resolver: the app userData (exe/install prefixes) and the Steam locator (compatdata). */
export interface LinuxSavePathDeps {
  readonly userData: string;
  readonly steamLocator: SteamLocator;
}

/**
 * The Steam compatdata prefix for an appid (`<library>/steamapps/compatdata/<appid>/pfx`), found by
 * walking every Steam library, or null when Steam isn't found or the game has no compatdata (never run
 * under Proton, or a native-Linux Steam build that has none) — then there's simply nothing to sync.
 */
async function findCompatdataPrefix(appid: number, steamLocator: SteamLocator): Promise<string | null> {
  const steamPath = await steamLocator.locateSteam();
  if (steamPath === null) return null;
  const libs = await steamLibraryDirs(steamPath);
  for (const lib of libs) {
    const pfx = path.join(lib, 'steamapps', 'compatdata', String(appid), 'pfx');
    if (await fse.pathExists(pfx)) return pfx;
  }
  return null;
}

/**
 * The Wine prefix that owns this game's saves, and whether it exists yet.
 *
 * exe/install: the path is DETERMINISTIC (`<userData>/prefixes/<id>` — Р2), so it is always returned, even
 * before the prefix exists. That is what lets sync-in restore card saves into a prefix that a launch is
 * about to create (launchGame ensureDir's it anyway); `exists: false` tells the caller the PC side has no
 * authority, so a stale baseline must not turn the empty prefix into a phantom deletion on the card.
 *
 * steam: compatdata is Steam's to create, so we only ever point at one that already exists — never
 * pre-seeding a prefix Steam hasn't made. Not found → null ("nothing to sync").
 */
async function prefixForManifest(
  manifest: ResolvedManifest,
  deps: LinuxSavePathDeps,
): Promise<{ readonly pfx: string; readonly exists: boolean } | null> {
  if (manifest.steam !== undefined) {
    const compat = await findCompatdataPrefix(manifest.steam.appid, deps.steamLocator);
    return compat === null ? null : { pfx: compat, exists: true };
  }
  const pfx = prefixDir(deps.userData, manifest.raw.id);
  return { pfx, exists: await fse.pathExists(pfx) };
}

export function createLinuxSavePathResolver(deps: LinuxSavePathDeps): SavePathResolver {
  return {
    async resolvePcSavePath(manifest, pcSavePath): Promise<PcSaveLocation | null> {
      const prefix = await prefixForManifest(manifest, deps);
      if (prefix === null) {
        // Steam mode with no compatdata: the game has never run under Proton (or isn't installed), so
        // there is no location to sync with — a logged no-op, not an error (Р5).
        log.info(`[save-sync] no Steam compatdata for "${manifest.raw.id}" yet — pcSavePath "${pcSavePath}" unresolved`);
        return null;
      }
      const resolved = resolveInsideWinePrefix(prefix.pfx, pcSavePath);
      if (resolved === null) return null;
      if (!prefix.exists) {
        log.info(`[save-sync] Wine prefix for "${manifest.raw.id}" does not exist yet — card saves are authoritative`);
      }
      return { path: resolved, containerExists: prefix.exists };
    },
    toManifestPcSavePath: (absolute) => winePrefixToManifestPcSavePath(absolute),
  };
}
