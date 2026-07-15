// Linux SavePathResolver (Р5/Э6): resolves the Windows-dictionary `pcSavePath` to a physical folder
// INSIDE the game's Wine prefix (exe/install modes) or its Steam compatdata prefix (steam mode). The
// moment of resolution is sync-time, not manifest-read, so a prefix that doesn't exist yet is a no-op
// sync (null), not a rejected card. The prefix→subpath mapping is a pure function (unit-tested without
// fs); the async wrapper adds the per-game prefix lookup + existence gate.
import path from 'node:path';
import fse from 'fs-extra';
import type { ResolvedManifest } from '../../shared/types';
import type { SavePathResolver, SteamLocator } from './types';
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
 * The Wine prefix that owns this game's saves: the Steam compatdata prefix (steam mode) or the app's
 * per-game prefix `<userData>/prefixes/<id>` (exe/install modes — Р2). null when it doesn't exist yet
 * (first run, before any launch/install created it), which the caller treats as "nothing to sync".
 */
async function prefixForManifest(manifest: ResolvedManifest, deps: LinuxSavePathDeps): Promise<string | null> {
  if (manifest.steam !== undefined) {
    return findCompatdataPrefix(manifest.steam.appid, deps.steamLocator);
  }
  const pfx = prefixDir(deps.userData, manifest.raw.id);
  return (await fse.pathExists(pfx)) ? pfx : null;
}

export function createLinuxSavePathResolver(deps: LinuxSavePathDeps): SavePathResolver {
  return {
    async resolvePcSavePath(manifest, pcSavePath): Promise<string | null> {
      const pfx = await prefixForManifest(manifest, deps);
      if (pfx === null) {
        // The prefix/compatdata doesn't exist yet → nothing on the PC side to sync (a logged no-op, Р5).
        log.info(`[save-sync] no Wine prefix for "${manifest.raw.id}" yet — pcSavePath "${pcSavePath}" unresolved`);
        return null;
      }
      return resolveInsideWinePrefix(pfx, pcSavePath);
    },
    // Reverse mapping (Configure Browse) is a Windows-authoring concern: a picked host folder can't be
    // expressed as a `%PREFIX%/…` without a game-specific prefix context. On Linux the user types the
    // Windows-dictionary string directly, so this returns null (the picker reports "outside allowed bases").
    toManifestPcSavePath: () => null,
  };
}
