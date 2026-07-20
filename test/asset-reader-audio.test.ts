// Pure audio helpers in asset-reader.ts: the UI-slot→file mapping and the ambience anti-traversal guard.
// The rest of AssetReader touches the filesystem / electron and isn't unit-tested here.
import { describe, expect, it } from 'vitest';
import { isValidAmbientTrack, sfxFileName } from '../src/main/asset-reader';
import type { SfxName } from '../src/shared/types';

describe('sfxFileName — UI slot → set file basename', () => {
  it('maps navigate to move and the rest 1:1', () => {
    const expected: Record<SfxName, string> = {
      play: 'play',
      navigate: 'move',
      button: 'button',
      back: 'back',
    };
    for (const [slot, file] of Object.entries(expected) as [SfxName, string][]) {
      expect(sfxFileName(slot)).toBe(file);
    }
  });
});

describe('isValidAmbientTrack — bundled-folder anti-traversal', () => {
  it('accepts a bare file name with a supported audio extension', () => {
    expect(isValidAmbientTrack('ps5.mp3')).toBe(true);
    expect(isValidAmbientTrack('steam-big-picture.mp3')).toBe(true);
    expect(isValidAmbientTrack('gleaming-void.WAV')).toBe(true); // extension match is case-insensitive
  });

  it('rejects a path (traversal / subdirectory) — only bare names are read', () => {
    expect(isValidAmbientTrack('../evil.mp3')).toBe(false);
    expect(isValidAmbientTrack('sub/nested.mp3')).toBe(false);
  });

  it('rejects an unsupported or missing extension', () => {
    expect(isValidAmbientTrack('ps5.txt')).toBe(false);
    expect(isValidAmbientTrack('ps5')).toBe(false);
    expect(isValidAmbientTrack('')).toBe(false);
  });
});
