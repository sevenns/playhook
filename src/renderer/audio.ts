// UI sound effects + looping background music/ambience for the launcher.
// The UI sounds are ONE app-wide set (the bundle chosen in Settings → Audio) — a card cannot supply its
// own. The card's music arrives from main as a data URL, and a DEFAULT AMBIENCE track (app-wide, chosen
// in settings) arrives on its own channel and plays only while the card has no music of its own — a
// game's music always wins. The engine treats the effective source as
// `gameMusic ?? ambient` and CROSSFADES between sources (so inserting/removing a card, or switching the
// ambience, glides instead of cutting). Music/ambience share one volume; UI sounds have their own.
// Playback is gated by app.ts (visible && !running) via setMusicPlaying.
import type { SfxName, SfxSet } from '../shared/types';
import { shouldPlayLimit } from './sfx-limit.js';

// Fallback volumes until the persisted ones arrive from main (music historically played at 0.5).
const DEFAULT_MUSIC_VOLUME = 0.5;
const DEFAULT_SFX_VOLUME = 1;

// Crossfade / fade-in duration in ms. A whole 0→1 volume ramp takes this long; partial ramps scale down.
const FADE_MS = 800;
// Volume within this of the target counts as "arrived" (float ramps never land exactly).
const FADE_EPSILON = 0.001;

// Music is held while the startup jingle plays, so the release must be guaranteed — `ended` alone is
// not. Once the jingle's real length is known the gate opens that long after it began, plus this margin;
// until then (and if the metadata never arrives) the hard cap below is what frees the music.
const JINGLE_GRACE_MS = 400;
const JINGLE_MAX_MS = 20_000;

export interface AudioController {
  /** Sets the inserted card's own background music (data URL), or clears it when null. */
  setCardMusic(url: string | null): void;
  /**
   * What is ON SCREEN, musically — the carousel's browse channel, in ONE statement:
   *  • `url` — the browsed game's own music, which wins over the card's (with the card pulled you are
   *    looking at a history game and must hear ITS theme); null falls back to the card music, then to
   *    the ambience;
   *  • `idle` — there is no game on screen at all, the row is standing on one of the launcher's own
   *    cards. Then the ambience plays whatever is in the drive: a plain null would fall through to the
   *    CARD's music, and these cards are meant to sound like the launcher, not like the inserted game.
   *
   * The two are ONE call rather than two setters because they always arrive together, and applying them
   * one at a time passes through a third source in between — idle off while the url is still null is the
   * CARD's music — which starts a cross-fade the next call immediately interrupts. An interrupted
   * cross-fade drops the outgoing element outright (see crossfadeTo), and that is heard as the music
   * being cut off rather than faded.
   *
   * Music only — the SFX set is untouched, so flipping through the carousel never rebuilds the sound
   * elements.
   */
  setBrowseMusic(url: string | null, idle: boolean): void;
  /** Sets the app-wide default ambience (data URL), or clears it when null. */
  setAmbient(url: string | null): void;
  /** The bundled UI sound set — every sound the app plays, on every screen. */
  setSounds(set: SfxSet | null): void;
  /** Plays a one-shot UI sound; a no-op when that slot isn't configured. */
  play(name: SfxName): void;
  /**
   * Plays the `limit` dead-end sound, at most once per series of blocked attempts. Every call counts as
   * an attempt (that is what keeps a held direction from re-arming the latch by idling); the sound only
   * comes out when the latch is armed — see sfx-limit.ts.
   */
  playLimit(): void;
  /** Ends the current series of blocked attempts, so the next one sounds again. Called on release. */
  rearmLimit(): void;
  /**
   * Plays the bundled startup jingle, once. Resolves the moment playback actually STARTS — the boot
   * sequence times the hand-over from the boot image to the UI off it, so the jingle's two halves line up
   * with what is on screen (see the boot reveal in app.ts). Resolves right away when it can't play at
   * all: a silent launcher must still boot.
   */
  playStartup(url: string): Promise<void>;
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
  // The startup jingle, kept only so a late volumes seed can still reach it while it plays.
  let startup: HTMLAudioElement | null = null;
  // The `limit` latch: one sound per series of blocked attempts, armed by a release. App-wide on
  // purpose, not per slot or per surface — a left edge and a dead LB 100 ms later are one dead end to
  // the ear, and a doubled `limit` sounds worse than a swallowed second one.
  let limitArmed = true;
  let lastLimitAttemptAt = Number.NEGATIVE_INFINITY;

  const playSfx = (name: SfxName): void => {
    const el = sfx.get(name);
    if (el === undefined) return;
    // Clone so rapid retriggers (fast navigation) overlap instead of cutting each other off.
    const node = el.cloneNode() as HTMLAudioElement;
    node.volume = sfxVolume;
    void node.play().catch(() => undefined);
  };

  /** Builds the <audio> elements for one sound set into `target` (cleared first). */
  const loadSounds = (target: Map<SfxName, HTMLAudioElement>, assets: SfxSet | null): void => {
    target.clear();
    if (assets === null) return;
    for (const name of Object.keys(assets.sounds) as SfxName[]) {
      const url = assets.sounds[name];
      if (url === undefined) continue;
      const el = new Audio(url);
      el.volume = sfxVolume;
      el.preload = 'auto';
      target.set(name, el);
    }
  };

  // The three music sources; the EFFECTIVE one is `browseMusic ?? gameMusic ?? ambient`. Changing the
  // effective identity (a different URL) triggers a crossfade; an unchanged identity is a no-op (never
  // restarts playback) — which is why a single-game card, where browse and card music are the same file,
  // behaves exactly as before.
  let browseMusic: string | null = null;
  let gameMusic: string | null = null;
  let ambient: string | null = null;
  // No game on screen (a launcher card is selected) — see setBrowseMusic.
  let browseIdle = false;

  // The currently-primary player (fading IN or steady) and, during a crossfade, the outgoing one (fading
  // OUT). `activeUrl` mirrors the effective source we've committed to — the idempotence key.
  let active: Player | null = null;
  let outgoing: Player | null = null;
  let activeUrl: string | null = null;

  // The gate result (visible && !running, AND the startup jingle has finished). NOT a short-circuit: a
  // repeated `true` re-issues play() on the live element (resurrecting an OS-muted one after sleep)
  // without restarting the fade.
  let wantPlay = false;
  // What app.ts asked for, before the jingle gate below is applied to it.
  let musicWanted = false;
  // The startup jingle is still sounding. Music waits it out rather than playing underneath it: the two
  // are unrelated pieces of audio and the overlap is just mush.
  let jinglePlaying = false;

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

  /**
   * Puts playback where the two gates say it should be: what app.ts asked for (visible && !running) and
   * whether the startup jingle is still sounding. Called on every change to either, which is why it is
   * NOT a short-circuit on an unchanged value: re-issuing play() on the live element is what resurrects
   * one the OS muted while the machine slept.
   */
  const applyPlayback = (): void => {
    wantPlay = musicWanted && !jinglePlaying;
    if (wantPlay) {
      // Always (re-)issue play() on the live elements. Then ramp only if we're not already at the target
      // (a cold start from 0 fades in; an already-full resume from the tray just plays, no volume dip).
      if (active !== null) void active.el.play().catch(() => undefined);
      if (outgoing !== null) void outgoing.el.play().catch(() => undefined);
      const activeSettled =
        active === null || Math.abs(active.el.volume - musicVolume) <= FADE_EPSILON;
      if (!activeSettled || outgoing !== null) ensureFade();
      return;
    }
    stopFade();
    if (active !== null) active.el.pause();
    if (outgoing !== null) {
      drop(outgoing);
      outgoing = null;
    }
  };

  const applyEffective = (): void => {
    const target = browseIdle ? ambient : (browseMusic ?? gameMusic ?? ambient);
    if (target === activeUrl) return; // idempotent: same effective source → never restart playback
    if (wantPlay) crossfadeTo(target);
    else hardSwap(target);
  };

  return {
    setCardMusic(url: string | null): void {
      if (url === gameMusic) return;
      gameMusic = url;
      applyEffective();
    },

    setBrowseMusic(url: string | null, idle: boolean): void {
      if (url === browseMusic && idle === browseIdle) return;
      browseMusic = url;
      browseIdle = idle;
      applyEffective(); // both fields first, THEN one apply — see the interface note
    },

    setAmbient(url: string | null): void {
      if (url === ambient) return;
      ambient = url;
      applyEffective();
    },

    setSounds(set: SfxSet | null): void {
      loadSounds(sfx, set);
    },

    play: playSfx,

    playLimit(): void {
      const now = performance.now();
      const sound = shouldPlayLimit(limitArmed, lastLimitAttemptAt, now);
      lastLimitAttemptAt = now;
      if (!sound) return;
      limitArmed = false;
      playSfx('limit');
    },

    rearmLimit(): void {
      limitArmed = true;
    },

    setMusicPlaying(shouldPlay: boolean): void {
      musicWanted = shouldPlay;
      applyPlayback();
    },

    setMusicVolume(volume: number): void {
      musicVolume = volume;
      // Outside a fade, apply the new level immediately so steady-state volume tracks the slider; during a
      // fade the ramp reads `musicVolume` live, so the in-flight target follows the slider too.
      if (fadeHandle === null && active !== null) active.el.volume = volume;
    },

    async playStartup(url: string): Promise<void> {
      const el = new Audio(url);
      el.volume = sfxVolume;
      startup = el;
      // Music (and ambience) waits for the jingle to finish, so hold it here and release it below. Not
      // just at startup: if a track had already begun — the seeds can land first — this stops it, which
      // at that point is a barely-started fade-in, not an audible cut.
      jinglePlaying = true;
      applyPlayback();
      let watchdog = 0;
      const release = (): void => {
        if (startup !== el) return; // superseded — whoever replaced it owns the gate now
        if (watchdog !== 0) window.clearTimeout(watchdog);
        startup = null;
        jinglePlaying = false;
        applyPlayback();
      };
      el.addEventListener('ended', release);
      el.addEventListener('error', release);
      // `ended` can never come (the output device disappears mid-play), and music that never returns is
      // far worse than music that returns early — so the gate also opens on its own.
      el.addEventListener('loadedmetadata', () => {
        if (startup !== el || !Number.isFinite(el.duration)) return;
        if (watchdog !== 0) window.clearTimeout(watchdog);
        watchdog = window.setTimeout(release, el.duration * 1000 + JINGLE_GRACE_MS);
      });
      watchdog = window.setTimeout(release, JINGLE_MAX_MS);
      // The volumes seed arrives over IPC and may land AFTER this, hence startup being kept around for
      // setSfxVolume below — the jingle follows the SFX slider like every other one-shot.
      try {
        await el.play();
      } catch {
        // Playback refused (no output device, an autoplay policy): boot on in silence, music included.
        release();
      }
    },
    setSfxVolume(volume: number): void {
      sfxVolume = volume;
      for (const el of sfx.values()) el.volume = volume;
      if (startup !== null) startup.volume = volume;
    },
  };
}
