// The boot reveal: the launcher opens on the background alone and the UI fades in once everything it
// needs has arrived.
//
// index.html ships #app[data-boot], which hides the bar and the carousel strip (styles.css):
// the launcher opens on the background alone. The order is deliberate — wallpaper, then the game's own
// hero, then the UI:
//   1. the bundled wallpaper is the fastest image main can hand over, so it paints on the boot backdrop
//      (#hero-boot — a layer of its own, ABOVE the hero) and keeps the screen for WALLPAPER_HOLD_MS,
//      however quickly the rest arrives;
//   2. the card's hero paints on the hero layers UNDERNEATH it as soon as it lands, and the backdrop
//      then dissolves to reveal a background that is already settled — the alternative, unwinding a
//      shared zoom, made the picture travel backwards at the exact moment the UI arrived;
//   3. only then does the UI fade in — so it is never seen assembling itself, and never changes colour
//      under the user's eyes a beat after appearing.
// The UI waits for ALL THREE seeds — the state, a settled background, and the carousel list — and never
// appears before BOOT_MIN_MS, so the reveal reads as an intro rather than as a stutter. The list is a
// seed in its own right because the strip's container is switched on in ONE frame (its opacity
// transition belongs to the card morph, see styles.css): arriving after the reveal, the whole carousel
// simply appeared, as if it had been display:none. The deadline covers a seed that never arrives
// (unreadable wallpaper, no hero, no library at all): the UI must not stay hidden forever.
import { req } from './dom.js';

/**
 * How long the bundled wallpaper owns the screen at startup. A hero arriving earlier is painted right
 * away but stays hidden under the backdrop, so the launcher always opens on the same picture for the
 * same beat instead of flashing whatever loaded first. It is also the length of the startup jingle's
 * FIRST half (assets/playhook-startup.mp3): the swell is the backdrop's, the tail plays over the UI
 * arriving — which is why the countdown runs from the moment the sound starts, not from window load.
 */
const WALLPAPER_HOLD_MS = 2000;
/** The UI never appears before this — the hold plus the cross-fade it hands over to. */
const BOOT_MIN_MS = WALLPAPER_HOLD_MS;
const BOOT_DEADLINE_MS = 5000;
/** Matches the backdrop's fade in styles.css (#hero-boot.is-gone). */
const BOOT_FADE_MS = 1000;

export interface BootDeps {
  /** The startup jingle's URL, fetched over IPC (null when there is none to play). */
  requestStartupSound(): Promise<string | null>;
  /** Plays it once; resolves when it actually started (or could not — a refused autoplay, a muted output). */
  playStartup(url: string): Promise<void>;
  /**
   * Where the hero layer under the backdrop currently sits — what the backdrop converges on as it
   * dissolves. 'none' when there is no image under it at all (see dissolveBootBackdrop).
   */
  settledTransform(): string;
  /** The UI is on: the strip's cards may fan in now. */
  onRevealed(): void;
}

export interface BootSequence {
  /** Whether the boot screen has come down. Every input path is fenced on this (see controls.ts). */
  isRevealed(): boolean;
  /** The first AppState landed. */
  noteState(): void;
  /** The carousel list landed — even an empty one counts (it settles `data-screen`). */
  noteLibrary(): void;
  /** Paints the bundled wallpaper on the backdrop — or takes the backdrop out when there is none. */
  noteWallpaper(url: string | null): void;
  /** What the hero channel delivered: a picture, or nothing for this game. */
  noteHero(payload: 'none' | 'present'): void;
}

export function createBootSequence(deps: BootDeps): BootSequence {
  const app = req('app');
  const bootBackdrop = req('hero-boot');
  const bootStart = performance.now();
  let bootStateReady = false;
  let bootHeroReady = false;
  let bootLibraryReady = false;
  let bootRevealed = false;
  let revealTimer = 0;
  // When the startup jingle actually began playing; null until it does (or forever, if it can't).
  let jingleStartedAt: number | null = null;

  /**
   * Hands the screen over to the hero underneath: the backdrop fades out and, over the same beat, travels
   * to where that hero layer currently sits. Converging rather than parting matters because the two are
   * often the SAME image — with no game on screen the background is this very wallpaper — and any offset left
   * between them shows up as a double image sliding apart. Then it is taken out of the page entirely: it
   * has nothing left to show, and a full-screen composited layer is not free.
   */
  function dissolveBootBackdrop(): void {
    const settled = deps.settledTransform();
    // 'none' means there is no image under it at all (no wallpaper, no hero) — then there is nothing to
    // converge on, and pulling the backdrop back to the identity transform would be the very lurch this
    // whole arrangement exists to avoid. It just fades where it is.
    if (settled !== 'none') bootBackdrop.style.transform = settled;
    bootBackdrop.classList.add('is-gone');
    window.setTimeout(() => {
      bootBackdrop.hidden = true;
    }, BOOT_FADE_MS);
  }

  function revealUi(): void {
    if (bootRevealed) return;
    bootRevealed = true;
    delete app.dataset['boot'];
    dissolveBootBackdrop();
    // The strip's cards were held at zero behind the boot screen — let them fan in now, so the carousel's
    // own entrance is actually seen instead of having happened under the wallpaper.
    deps.onRevealed();
  }

  /**
   * When the boot image's turn is up: BOOT_MIN_MS after the jingle started, or — when there is no jingle
   * (unreadable file, muted output, a refused autoplay) — after the window itself opened. The jingle is
   * fetched over IPC and can start a beat late; letting the hold slide with it is what keeps the swell and
   * the picture in step, rather than the sound arriving over a UI that is already up.
   */
  function bootHoldEndsAt(): number {
    return (jingleStartedAt ?? bootStart) + BOOT_MIN_MS;
  }

  /** Arms (or re-arms) the reveal for the end of the hold. No-op until every seed is in. */
  function scheduleReveal(): void {
    if (bootRevealed || !bootStateReady || !bootHeroReady || !bootLibraryReady) return;
    if (revealTimer !== 0) window.clearTimeout(revealTimer);
    revealTimer = window.setTimeout(revealUi, Math.max(0, bootHoldEndsAt() - performance.now()));
  }

  function noteBootSeed(seed: 'state' | 'hero' | 'library'): void {
    if (seed === 'state') bootStateReady = true;
    else if (seed === 'hero') bootHeroReady = true;
    else bootLibraryReady = true;
    scheduleReveal();
  }

  window.setTimeout(revealUi, BOOT_DEADLINE_MS);

  // The startup jingle, played once. Requested as early as everything else and started the moment it
  // lands; the boot hold is then re-armed around it (see bootHoldEndsAt). The deadline above is the
  // backstop: a jingle that arrives absurdly late can delay the reveal, but never hold it hostage.
  void deps.requestStartupSound().then(async (url) => {
    if (url === null || bootRevealed) return;
    await deps.playStartup(url);
    if (bootRevealed) return;
    jingleStartedAt = performance.now();
    scheduleReveal();
  });

  // The startup push on the backdrop (#hero-boot in styles.css): a wider, faster drift than the hero's
  // perpetual pan, and it never unwinds — the layer dissolves mid-travel instead. Two frames of delay
  // because a transition needs its starting value painted first: set in the same frame as the load and
  // there is nothing to move from. The direction is randomized like the layers' own pan, so the launcher
  // doesn't always open drifting the same way.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (bootRevealed) return;
      bootBackdrop.style.setProperty('--boot-pan', Math.random() < 0.5 ? '4.5%' : '-4.5%');
      bootBackdrop.classList.add('is-panning');
    });
  });

  // Whether the background that will STAY is up: the card's hero when it has one, the wallpaper when it
  // does not. The wallpaper alone is not enough while a hero is still expected — that is the cross-fade
  // the reveal is supposed to happen after, not during.
  let heroPayload: 'pending' | 'none' | 'present' = 'pending';
  let wallpaperPainted = false;

  function noteBackgroundSettled(): void {
    if (heroPayload === 'present' || (heroPayload === 'none' && wallpaperPainted))
      noteBootSeed('hero');
  }

  return {
    isRevealed: () => bootRevealed,
    noteState: () => noteBootSeed('state'),
    noteLibrary: () => noteBootSeed('library'),
    noteWallpaper: (url) => {
      if (url === null) bootBackdrop.hidden = true;
      else bootBackdrop.style.backgroundImage = `url("${url}")`;
      wallpaperPainted = url !== null;
      noteBackgroundSettled();
    },
    noteHero: (payload) => {
      heroPayload = payload;
      noteBackgroundSettled();
    },
  };
}
