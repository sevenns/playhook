// The build-time enumeration that produces dist/audio/index.json (the sound-set + ambience listing the
// settings window reads at runtime). Guards the filtering: .DS_Store and other non-directories are not
// sound sets, an incomplete set (no move.wav) is skipped, and only supported audio files are ambience.
import type { Dirent } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listAmbientTracks, listSoundSets } from '../scripts/audio-index.mjs';

const dir = (name: string): Dirent => ({ name, isDirectory: () => true, isFile: () => false }) as Dirent;
const file = (name: string): Dirent => ({ name, isDirectory: () => false, isFile: () => true }) as Dirent;

describe('listSoundSets', () => {
  it('keeps only complete subdirectories, drops .DS_Store, sorts by name', () => {
    const dirents = [dir('winhanced'), dir('ps5'), file('.DS_Store'), dir('broken')];
    const hasMoveWav = (name: string): boolean => name !== 'broken'; // broken set lacks move.wav
    expect(listSoundSets(dirents, hasMoveWav)).toEqual(['ps5', 'winhanced']);
  });
});

describe('listAmbientTracks', () => {
  it('keeps only supported audio files, drops .DS_Store / non-audio / directories, sorts', () => {
    const dirents = [file('ps5.mp3'), file('.DS_Store'), file('notes.txt'), dir('sub'), file('ps2.mp3')];
    expect(listAmbientTracks(dirents)).toEqual(['ps2.mp3', 'ps5.mp3']);
  });
});
