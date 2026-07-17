import { describe, expect, it } from 'vitest';
import { steamCandidateDirs, libraryIndexPath } from '../src/main/platform/steam-locator.linux';

describe('linux SteamLocator — candidate paths', () => {
  it('lists native / symlink / flatpak / snap roots in priority order', () => {
    expect(steamCandidateDirs('/home/deck')).toEqual([
      '/home/deck/.local/share/Steam',
      '/home/deck/.steam/steam',
      '/home/deck/.var/app/com.valvesoftware.Steam/.local/share/Steam',
      '/home/deck/snap/steam/common/.local/share/Steam',
    ]);
  });

  it('puts the native install first (most common on Deck / desktop)', () => {
    expect(steamCandidateDirs('/home/user')[0]).toBe('/home/user/.local/share/Steam');
  });

  it('derives the library-index path used as the validity check', () => {
    expect(libraryIndexPath('/home/deck/.local/share/Steam')).toBe(
      '/home/deck/.local/share/Steam/steamapps/libraryfolders.vdf',
    );
  });
});
