// UI sound effects + looping background music for the launcher.
// Assets arrive from main as data URLs (read from the card's game.json), so every game can ship
// its own set; any missing slot is simply silent. Music plays at 0.5 of the system/app volume
// while the launcher window is visible and no game is running (see app.ts for the gating).
import type { AudioAssets, SfxName } from '../shared/types';

const MUSIC_VOLUME = 0.5;

export interface AudioController {
  /** Loads a new game's audio (or clears it when null). */
  setAssets(assets: AudioAssets | null): void;
  /** Plays a one-shot UI sound; a no-op when that slot isn't configured. */
  play(name: SfxName): void;
  /** Starts/stops the background music to match the desired playing state. */
  setMusicPlaying(shouldPlay: boolean): void;
}

export function createAudioController(): AudioController {
  const sfx = new Map<SfxName, HTMLAudioElement>();
  let music: HTMLAudioElement | null = null;
  // Remembered across asset swaps so newly-loaded music resumes if it should already be playing.
  let musicWanted = false;

  const clearMusic = (): void => {
    if (music === null) return;
    music.pause();
    music.removeAttribute('src');
    music.load();
    music = null;
  };

  return {
    setAssets(assets: AudioAssets | null): void {
      sfx.clear();
      clearMusic();
      if (assets === null) return;

      for (const name of Object.keys(assets.sounds) as SfxName[]) {
        const url = assets.sounds[name];
        if (url === undefined) continue;
        const el = new Audio(url);
        el.preload = 'auto';
        sfx.set(name, el);
      }

      if (assets.music !== undefined) {
        const el = new Audio(assets.music);
        el.loop = true;
        el.volume = MUSIC_VOLUME;
        el.preload = 'auto';
        music = el;
        if (musicWanted) void el.play().catch(() => undefined);
      }
    },

    play(name: SfxName): void {
      const el = sfx.get(name);
      if (el === undefined) return;
      // Clone so rapid retriggers (fast navigation) overlap instead of cutting each other off.
      const node = el.cloneNode() as HTMLAudioElement;
      node.volume = el.volume;
      void node.play().catch(() => undefined);
    },

    setMusicPlaying(shouldPlay: boolean): void {
      musicWanted = shouldPlay;
      if (music === null) return;
      if (shouldPlay) void music.play().catch(() => undefined);
      else music.pause();
    },
  };
}
