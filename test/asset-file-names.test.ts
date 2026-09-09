import { describe, expect, it } from 'vitest';
import { safeAssetFileName } from '../src/main/asset-file-names';

describe('safeAssetFileName', () => {
  it('keeps an already-safe name as it is', () => {
    expect(safeAssetFileName('hero.jpg')).toBe('hero.jpg');
  });

  it('collapses unsafe characters in the stem', () => {
    expect(safeAssetFileName('hero image.jpg')).toBe('hero-image.jpg');
  });

  it('keeps the extension of a fully non-Latin name instead of eating it', () => {
    expect(safeAssetFileName('обложка.png')).toBe('asset.png');
    expect(safeAssetFileName('обложка игры.png')).toBe('asset.png');
  });

  it('lower-cases the extension', () => {
    expect(safeAssetFileName('Hero.JPG')).toBe('Hero.jpg');
  });

  it('strips traversal and leading dots without losing the extension', () => {
    expect(safeAssetFileName('..hidden .jpg')).toBe('hidden-.jpg');
    expect(safeAssetFileName('../../etc/passwd.png')).toBe('passwd.png');
  });

  it('falls back to a stem when nothing printable survives', () => {
    expect(safeAssetFileName('обложка')).toBe('asset');
    expect(safeAssetFileName('...')).toBe('asset');
  });
});
