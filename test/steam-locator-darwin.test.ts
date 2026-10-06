import { describe, expect, it } from 'vitest';
import { libraryIndexPath, steamCandidateDirs } from '../src/main/platform/steam-locator.darwin';

describe('darwin SteamLocator — candidate paths', () => {
  it('probes the single macOS Steam root', () => {
    expect(steamCandidateDirs('/Users/deck')).toEqual([
      '/Users/deck/Library/Application Support/Steam',
    ]);
  });

  it('derives the library-index path used as the validity check', () => {
    expect(libraryIndexPath('/Users/deck/Library/Application Support/Steam')).toBe(
      '/Users/deck/Library/Application Support/Steam/steamapps/libraryfolders.vdf',
    );
  });
});
