// Pure helpers for building dist/audio/index.json — the bundled sound-set + ambience listing the
// settings window reads at runtime (one readFile) instead of a readdir over the asar, which has no
// precedent in this codebase and whose withFileTypes/isDirectory was historically weak in the asar shim.
// Side-effect-free so a unit test can exercise the .DS_Store / incomplete-set / non-audio filtering
// without touching the filesystem.
import { extname } from 'node:path';

// Audio file extensions (with the leading dot) accepted as an ambience track. Mirrors AUDIO_MIME in
// src/main/asset-reader.ts — kept in sync by hand (a build script can't import the strict-TS module).
export const AMBIENCE_EXTENSIONS = [
  '.mp3',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.webm',
];

/**
 * Sound-set folder names under audio/ui/. A set is a SUBDIRECTORY that contains move.wav (the file the
 * launcher's navigate slot needs) — so non-directories (`.DS_Store`) are dropped and an incomplete set
 * (no move.wav) is skipped rather than offered and then silently failing. Sorted for a stable dropdown.
 *
 * @param {import('node:fs').Dirent[]} uiDirents  readdir(audio/ui, { withFileTypes: true })
 * @param {(name: string) => boolean} hasMoveWav  whether a set folder contains move.wav
 * @returns {string[]}
 */
export function listSoundSets(uiDirents, hasMoveWav) {
  return uiDirents
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => hasMoveWav(name))
    .sort();
}

/**
 * Ambience track file names (extension included) under audio/ambience/. A track is a regular FILE with a
 * supported audio extension — `.DS_Store` and any non-audio file are dropped. Sorted for a stable dropdown.
 *
 * @param {import('node:fs').Dirent[]} ambienceDirents  readdir(audio/ambience, { withFileTypes: true })
 * @returns {string[]}
 */
export function listAmbientTracks(ambienceDirents) {
  return ambienceDirents
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => AMBIENCE_EXTENSIONS.includes(extname(name).toLowerCase()))
    .sort();
}
