// Linux SteamLocator (Р4): probe the well-known Steam data directories and accept the first that carries a
// `steamapps/libraryfolders.vdf` (Steam's own library index — the same file the .acf walk reads). Covers
// the native install, the `~/.steam/steam` symlink, the flatpak install and the snap install. The candidate
// list + validity path are pure (unit-tested); locateSteam does the fs probe.
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import type { SteamLocator } from './types';

/**
 * The ordered Steam-root candidates for a given home dir (most common first). On Steam Deck / most desktop
 * installs it is `~/.local/share/Steam`; `~/.steam/steam` is usually a symlink to it. Pure — unit-tested.
 */
export function steamCandidateDirs(home: string): readonly string[] {
  return [
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.steam', 'steam'), // legacy symlink to the above on most installs
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'), // flatpak
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'), // snap
  ];
}

/** A Steam root is valid iff it holds `steamapps/libraryfolders.vdf` (Steam's library index). Pure path. */
export function libraryIndexPath(steamRoot: string): string {
  return path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
}

/** The linux SteamLocator: returns the first candidate root whose library index exists, or null. */
export function createLinuxSteamLocator(): SteamLocator {
  return {
    async locateSteam(): Promise<string | null> {
      for (const dir of steamCandidateDirs(os.homedir())) {
        if (await fse.pathExists(libraryIndexPath(dir))) return dir;
      }
      return null;
    },
  };
}
