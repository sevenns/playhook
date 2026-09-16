// macOS SteamLocator: Steam keeps its data under `~/Library/Application Support/Steam`, and the
// validity check is the same one the linux locator uses — the presence of `steamapps/libraryfolders.vdf`,
// Steam's own library index (the file the `.acf` walk in steam.ts reads). There is only one candidate on
// macOS: no flatpak, no snap, and the App Store carries no Steam.
//
// Paths are built with `path.posix` (CLAUDE.md): these describe a macOS filesystem, and the suite runs on
// the Windows CI runner too.
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import type { SteamLocator } from './types';

/** The Steam-root candidates for a given home dir. Pure — unit-tested. */
export function steamCandidateDirs(home: string): readonly string[] {
  return [path.posix.join(home, 'Library', 'Application Support', 'Steam')];
}

/** A Steam root is valid iff it holds `steamapps/libraryfolders.vdf` (Steam's library index). Pure path. */
export function libraryIndexPath(steamRoot: string): string {
  return path.posix.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
}

/** The macOS SteamLocator: the first candidate root whose library index exists, or null. */
export function createDarwinSteamLocator(): SteamLocator {
  return {
    async locateSteam(): Promise<string | null> {
      for (const dir of steamCandidateDirs(os.homedir())) {
        if (await fse.pathExists(libraryIndexPath(dir))) return dir;
      }
      return null;
    },
  };
}
