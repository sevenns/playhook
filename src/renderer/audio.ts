// UI sound effects + looping background music for the launcher.
// Assets arrive from main as data URLs (read from the card's game.json), so every game can ship
// its own set; any missing slot is simply silent. Music and UI sounds have independent volumes
// (0..1) driven by the settings window (persisted app-wide); music plays only while the launcher
// window is visible and no game is running (see app.ts for the gating).
import type { AudioAssets, CarouselSfx, SfxName } from '../shared/types';

// Fallback volumes until the persisted ones arrive from main (music historically played at 0.5).
const DEFAULT_MUSIC_VOLUME = 0.5;
const DEFAULT_SFX_VOLUME = 1;

/** The carousel uses cross-game (bundled default) sounds — only navigate/button are ever played there. */
export type CarouselSfxName = 'navigate' | 'button';

export interface AudioController {
  /** Loads a new game's audio (or clears it when null). */
  setAssets(assets: AudioAssets | null): void;
  /** Plays a one-shot UI sound; a no-op when that slot isn't configured. */
  play(name: SfxName): void;
  /** Switches the background music to the carousel's focused-game track (recreated — starts from zero,
   * which is fine while browsing). `undefined` clears the music. Shares the same `music` element and
   * gating as setAssets, so syncMusic and the carousel don't fight over it. */
  setCarouselMusic(url: string | undefined): void;
  /** Loads the bundled default carousel SFX (navigate/button), used by playCarousel. */
  setCarouselSfx(sfx: CarouselSfx): void;
  /** Plays a bundled default carousel SFX (cross-game screen — not the per-game sounds). */
  playCarousel(name: CarouselSfxName): void;
  /** Starts/stops the background music to match the desired playing state. */
  setMusicPlaying(shouldPlay: boolean): void;
  /** Sets the background-music volume (0..1), live. */
  setMusicVolume(volume: number): void;
  /** Sets the UI sound-effects volume (0..1), live. */
  setSfxVolume(volume: number): void;
}

export function createAudioController(): AudioController {
  const sfx = new Map<SfxName, HTMLAudioElement>();
  // Bundled default carousel SFX (navigate/button), loaded once from main — cross-game, so independent
  // of the per-game `sfx` map above.
  const carouselSfx = new Map<CarouselSfxName, HTMLAudioElement>();
  let music: HTMLAudioElement | null = null;
  // The data-URL of the music element currently loaded, so setAssets can REUSE it when the same track is
  // re-delivered (e.g. picking the focused carousel card → ready) instead of recreating it (which would
  // restart the music from zero and break the continuity — see the plan, decision 6).
  let musicUrl: string | null = null;
  // Remembered across asset swaps so newly-loaded music resumes if it should already be playing.
  let musicWanted = false;
  // Current volumes, applied to elements as they're created and updated live via the setters.
  let musicVolume = DEFAULT_MUSIC_VOLUME;
  let sfxVolume = DEFAULT_SFX_VOLUME;

  const clearMusic = (): void => {
    if (music === null) return;
    music.pause();
    music.removeAttribute('src');
    music.load();
    music = null;
    musicUrl = null;
  };

  // Creates the looping music element for `url` (replacing any current one) and starts it if wanted.
  const loadMusic = (url: string): void => {
    clearMusic();
    const el = new Audio(url);
    el.loop = true;
    el.volume = musicVolume;
    el.preload = 'auto';
    // The OS can pause our looping music with no user intent — most notably on resume from sleep,
    // where the audio session is torn down (UI sounds are unaffected: each is a fresh clone.play()).
    // Resume if we still want it playing. setMusicPlaying(false) clears musicWanted BEFORE pausing,
    // and clearMusic nulls `music`, so this never fights an intentional stop nor a swapped-out asset.
    el.addEventListener('pause', () => {
      if (musicWanted && music === el) void el.play().catch(() => undefined);
    });
    music = el;
    musicUrl = url;
    if (musicWanted) void el.play().catch(() => undefined);
  };

  return {
    setAssets(assets: AudioAssets | null): void {
      sfx.clear();

      // Music: reuse the current element when the track is unchanged (same data-URL) so it keeps playing
      // seamlessly across the carousel-card → ready handoff. Only recreate (or clear) on a real change.
      const nextMusic = assets?.music;
      if (nextMusic === undefined) clearMusic();
      else if (nextMusic !== musicUrl) loadMusic(nextMusic);

      if (assets === null) return;

      for (const name of Object.keys(assets.sounds) as SfxName[]) {
        const url = assets.sounds[name];
        if (url === undefined) continue;
        const el = new Audio(url);
        el.volume = sfxVolume;
        el.preload = 'auto';
        sfx.set(name, el);
      }
    },

    setCarouselMusic(url: string | undefined): void {
      if (url === undefined) {
        clearMusic();
        return;
      }
      if (url === musicUrl) return; // same track already loaded — keep it playing (no restart)
      loadMusic(url);
    },

    setCarouselSfx(sfxAssets: CarouselSfx): void {
      carouselSfx.clear();
      for (const name of ['navigate', 'button'] as const) {
        const url = sfxAssets[name];
        if (url === undefined) continue;
        const el = new Audio(url);
        el.volume = sfxVolume;
        el.preload = 'auto';
        carouselSfx.set(name, el);
      }
    },

    play(name: SfxName): void {
      const el = sfx.get(name);
      if (el === undefined) return;
      // Clone so rapid retriggers (fast navigation) overlap instead of cutting each other off.
      const node = el.cloneNode() as HTMLAudioElement;
      node.volume = sfxVolume;
      void node.play().catch(() => undefined);
    },

    playCarousel(name: CarouselSfxName): void {
      const el = carouselSfx.get(name);
      if (el === undefined) return;
      const node = el.cloneNode() as HTMLAudioElement;
      node.volume = sfxVolume;
      void node.play().catch(() => undefined);
    },

    setMusicPlaying(shouldPlay: boolean): void {
      musicWanted = shouldPlay;
      if (music === null) return;
      if (shouldPlay) void music.play().catch(() => undefined);
      else music.pause();
    },

    setMusicVolume(volume: number): void {
      musicVolume = volume;
      if (music !== null) music.volume = volume;
    },

    setSfxVolume(volume: number): void {
      sfxVolume = volume;
      for (const el of sfx.values()) el.volume = volume;
    },
  };
}
