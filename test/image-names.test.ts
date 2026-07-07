import { describe, expect, it } from 'vitest';
import { imageMatches, normalizeImageNames, toImageName } from '../src/main/image-names';

describe('image-names (return-to-game process matching)', () => {
  describe('toImageName', () => {
    it('lower-cases a bare image name', () => {
      expect(toImageName('Game.exe')).toBe('game.exe');
    });

    it('takes the basename of a full Win32 path', () => {
      expect(toImageName('C:\\Program Files\\Hollow Knight\\hollow_knight.exe')).toBe('hollow_knight.exe');
    });

    it('handles a path with spaces and mixed case', () => {
      expect(toImageName('D:\\Games\\My Game\\LAUNCHER.EXE')).toBe('launcher.exe');
    });
  });

  describe('normalizeImageNames', () => {
    it('normalizes and drops empty entries', () => {
      expect(normalizeImageNames(['Game.exe', '', 'C:\\x\\Other.EXE'])).toEqual(['game.exe', 'other.exe']);
    });
  });

  describe('imageMatches', () => {
    const wanted = normalizeImageNames(['game.exe', 'launcher.exe']);

    it('matches a full window process path against wanted names (case-insensitive)', () => {
      expect(imageMatches('C:\\Games\\Game\\GAME.exe', wanted)).toBe(true);
    });

    it('does not match an unrelated image', () => {
      expect(imageMatches('C:\\Windows\\explorer.exe', wanted)).toBe(false);
    });
  });
});
