// UI sound effects + looping background music/ambience for the launcher.
// SFX and the card's music arrive from main as data URLs (read from the card's game.json). A DEFAULT
// AMBIENCE track (app-wide, chosen in settings) arrives on its own channel and plays only while the card
// has no music of its own — a game's music always wins. The engine treats the effective source as
// `gameMusic ?? ambient` and CROSSFADES between sources (so inserting/removing a card, or switching the
// ambience, glides instead of cutting). Music/ambience share one volume; UI sounds have their own.
// Playback is gated by app.ts (visible && !running) via setMusicPlaying.
import type { AudioAssets, SfxName } from '../shared/types';

// Fallback volumes until the persisted ones arrive from main (music historically played at 0.5).
const DEFAULT_MUSIC_VOLUME = 0.5;
const DEFAULT_SFX_VOLUME = 1;

// Crossfade / fade-in duration in ms. A whole 0→1 volume ramp takes this long; partial ramps scale down.
const FADE_MS = 800;
// Volume within this of the target counts as "arrived" (float ramps never land exactly).
const FADE_EPSILON = 0.001;

export interface AudioController {
  /** Loads a new card's audio (sfx + its own music), or clears it when null. */
  setAssets(assets: AudioAssets | null): void;
  /** Sets the app-wide default ambience (data URL), or clears it when null. */
  setAmbient(url: string | null): void;
  /** Plays a one-shot UI sound; a no-op when that slot isn't configured. */
  play(name: SfxName): void;
  /** Starts/stops the background music+ambience to match the desired playing state. */
  setMusicPlaying(shouldPlay: boolean): void;
  /** Sets the background-music/ambience volume (0..1), live. */
  setMusicVolume(volume: number): void;
  /** Sets the UI sound-effects volume (0..1), live. */
  setSfxVolume(volume: number): void;
}

/** A live music/ambience element paired with the source URL it holds. */
interface Player {
  readonly el: HTMLAudioElement;
  readonly url: string;
}

export function createAudioController(): AudioController {
  const sfx = new Map<SfxName, HTMLAudioElement>();

  // The two music sources; the EFFECTIVE one is `gameMusic ?? ambient`. Changing the effective identity
  // (a different URL) triggers a crossfade; an unchanged identity is a no-op (never restarts playback).
  let gameMusic: string | null = null;
  let ambient: string | null = null;

  // The currently-primary player (fading IN or steady) and, during a crossfade, the outgoing one (fading
  // OUT). `activeUrl` mirrors the effective source we've committed to — the idempotence key.
  let active: Player | null = null;
  let outgoing: Player | null = null;
  let activeUrl: string | null = null;

  // The gate result (visible && !running). NOT a short-circuit: a repeated `true` re-issues play() on the
  // live element (resurrecting an OS-muted one after sleep) without restarting the fade.
  let wantPlay = false;

  let musicVolume = DEFAULT_MUSIC_VOLUME;
  let sfxVolume = DEFAULT_SFX_VOLUME;

  // The crossfade/fade animation handle + last timestamp. Runs only while wantPlay (paused audio needs no
  // ramp); paused elements freeze at their current volume and resume from there.
  let fadeHandle: number | null = null;
  let lastTs = 0;

  const stepToward = (current: number, target: number, maxDelta: number): number =>
    current < target ? Math.min(target, current + maxDelta) : Math.max(target, current - maxDelta);

  const drop = (player: Player): void => {
    player.el.pause();
    player.el.removeAttribute('src');
    player.el.load();
  };

  // A fresh looping element at volume 0. The OS can pause our looping audio with no user intent (most
  // notably on resume from sleep, where the audio session is torn down). The pause guard resumes it — but
  // ONLY while it is the ACTIVE element and we still want playback: an outgoing (fading-out) element's
  // guard no-ops (active?.el !== el), so a crossfade never ends up double-playing both elements.
  const createEl = (url: string): HTMLAudioElement => {
    const el = new Audio(url);
    el.loop = true;
    el.volume = 0;
    el.preload = 'auto';
    el.addEventListener('pause', () => {
      if (wantPlay && active?.el === el) void el.play().catch(() => undefined);
    });
    return el;
  };

  const tick = (ts: number): void => {
    fadeHandle = null;
    const maxDelta = Math.max(0, ts - lastTs) / FADE_MS;
    lastTs = ts;
    let busy = false;

    if (outgoing !== null) {
      const next = stepToward(outgoing.el.volume, 0, maxDelta);
      outgoing.el.volume = next;
      if (next <= FADE_EPSILON) {
        drop(outgoing);
        outgoing = null;
      } else {
        busy = true;
      }
    }

    if (active !== null && Math.abs(active.el.volume - musicVolume) > FADE_EPSILON) {
      active.el.volume = stepToward(active.el.volume, musicVolume, maxDelta);
      busy = true;
    }

    if (busy && wantPlay) fadeHandle = requestAnimationFrame(tick);
  };

  const ensureFade = (): void => {
    if (fadeHandle !== null) return;
    lastTs = performance.now();
    fadeHandle = requestAnimationFrame(tick);
  };

  const stopFade = (): void => {
    if (fadeHandle === null) return;
    cancelAnimationFrame(fadeHandle);
    fadeHandle = null;
  };

  // Silent source swap (used while paused / not wanted): no audible transition, so just replace the loaded
  // element at volume 0. A later setMusicPlaying(true) fades it in from 0.
  const hardSwap = (target: string | null): void => {
    if (outgoing !== null) {
      drop(outgoing);
      outgoing = null;
    }
    if (active !== null) {
      drop(active);
      active = null;
    }
    activeUrl = target;
    if (target !== null) active = { el: createEl(target), url: target };
  };

  // Audible source change: the current active fades out while a new element fades in (target null = fade
  // out to silence). A second change mid-fade drops the already-outgoing element (cap: two live elements).
  const crossfadeTo = (target: string | null): void => {
    if (outgoing !== null) drop(outgoing);
    outgoing = active;
    active = null;
    activeUrl = target;
    if (target !== null) {
      const el = createEl(target);
      active = { el, url: target };
      void el.play().catch(() => undefined);
    }
    ensureFade();
  };

  const applyEffective = (): void => {
    const target = gameMusic ?? ambient;
    if (target === activeUrl) return; // idempotent: same effective source → never restart playback
    if (wantPlay) crossfadeTo(target);
    else hardSwap(target);
  };

  return {
    setAssets(assets: AudioAssets | null): void {
      sfx.clear();
      if (assets !== null) {
        for (const name of Object.keys(assets.sounds) as SfxName[]) {
          const url = assets.sounds[name];
          if (url === undefined) continue;
          const el = new Audio(url);
          el.volume = sfxVolume;
          el.preload = 'auto';
          sfx.set(name, el);
        }
      }
      const music = assets?.music ?? null;
      if (music === gameMusic) return;
      gameMusic = music;
      applyEffective();
    },

    setAmbient(url: string | null): void {
      if (url === ambient) return;
      ambient = url;
      applyEffective();
    },

    play(name: SfxName): void {
      const el = sfx.get(name);
      if (el === undefined) return;
      // Clone so rapid retriggers (fast navigation) overlap instead of cutting each other off.
      const node = el.cloneNode() as HTMLAudioElement;
      node.volume = sfxVolume;
      void node.play().catch(() => undefined);
    },

    setMusicPlaying(shouldPlay: boolean): void {
      wantPlay = shouldPlay;
      if (shouldPlay) {
        // Always (re-)issue play() on the live elements — this is what resurrects an OS-muted element
        // after sleep. Then ramp only if we're not already at the target (a cold start from 0 fades in;
        // an already-full resume from the tray just plays, no volume dip).
        if (active !== null) void active.el.play().catch(() => undefined);
        if (outgoing !== null) void outgoing.el.play().catch(() => undefined);
        const activeSettled =
          active === null || Math.abs(active.el.volume - musicVolume) <= FADE_EPSILON;
        if (!activeSettled || outgoing !== null) ensureFade();
      } else {
        stopFade();
        if (active !== null) active.el.pause();
        if (outgoing !== null) {
          drop(outgoing);
          outgoing = null;
        }
      }
    },

    setMusicVolume(volume: number): void {
      musicVolume = volume;
      // Outside a fade, apply the new level immediately so steady-state volume tracks the slider; during a
      // fade the ramp reads `musicVolume` live, so the in-flight target follows the slider too.
      if (fadeHandle === null && active !== null) active.el.volume = volume;
    },

    setSfxVolume(volume: number): void {
      sfxVolume = volume;
      for (const el of sfx.values()) el.volume = volume;
    },
  };
}
