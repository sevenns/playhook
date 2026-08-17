// Hero background subsystem (split out of app.ts). Owns everything about "what image is on
// screen and its colors": the two cross-fading hero layers, the shown-url gate, the renderer-local hero
// rotation, the empty/idle wallpaper screen, and the two-color palette (compute + cache + apply). These
// share `shownUrl`/`wallpaperUrl` so they live together — keeping the palette race gate internal rather
// than threaded through app.ts. The controller reaches back only through the narrow `deps` seam.
import type { HeroAssets } from '../shared/types';
import type { Translator } from '../shared/i18n/index.js';
import { computePalette, type Palette } from './dominant-color.js';
import { req } from './dom.js';

const HERO_ROTATE_MS = 60_000;

/** The narrow view of app state the hero subsystem needs. */
export interface HeroDeps {
  /** Whether a game (not the idle/empty screen) is currently on screen. */
  hasGameOnScreen(): boolean;
  /** The current game's id (for the per-hero palette cache key); '' when none. */
  getGameId(): string;
  /** The current translator (read live so the empty-screen title follows the language). */
  getTranslator(): Translator;
}

export interface HeroController {
  /** Repaints the current hero (no-op when there are no images yet — waits for applyAssets). */
  repaint(): void;
  /** (Re)evaluates the rotation timer for the current state (idempotent). */
  startRotation(): void;
  /** New hero payload for the current CARD: reset cursor, paint first image, restart rotation. An empty
   *  payload here means "no card", and leaves whatever is on screen alone. */
  applyAssets(assets: HeroAssets | null): void;
  /** New hero payload for the BROWSED game. Same thing, except an empty payload REPLACES the background
   *  (with the wallpaper) instead of leaving the previous game's image up. */
  applyBrowseAssets(assets: HeroAssets | null): void;
  /** The empty / idle screen: fallback wallpaper background, its palette, "Insert a game card" title. */
  applyEmptyScreen(): void;
  /**
   * Paints the fallback wallpaper as the FIRST background of the session — without claiming the screen
   * is empty (no title change): a launcher opening onto a card has nothing to show until its hero data
   * URL arrives, and a blank window in the meantime is worse than the wallpaper the game's own hero then
   * cross-fades over. No-op once anything is on screen.
   */
  showWallpaperBackdrop(): void;
  /** Stores the fallback wallpaper data URL (delivered by main); does not repaint on its own. */
  setWallpaper(url: string | null): void;
  /** Parallax offset in DESIGN px: the background drifts with the carousel (see #hero in styles.css). */
  setParallax(designPx: number): void;
  /**
   * Whether a direction is being HELD, i.e. the strip is flipping on its own. While it is, the image on
   * screen stays exactly where it is — whatever heroes arrive meanwhile are remembered, not painted —
   * and the last one lands as soon as the key/stick is let go. Interruptible: the request that arrives
   * during the hold is the one that gets shown.
   */
  setFlipping(flipping: boolean): void;
  /**
   * The COMPUTED transform (a matrix) of the layer currently on screen — its bg-pan caught mid-drift.
   * The boot backdrop converges on it as it dissolves, so the handover has no offset to give away; see
   * the boot reveal in app.ts.
   */
  currentLayerTransform(): string;
}

export function createHeroController(deps: HeroDeps): HeroController {
  const app = req('app');
  const heroPanEl = req('hero-pan');
  const titleEl = req('title');

  // Fallback wallpaper (data URL from main) for the empty / idle screen, and its cached palette.
  let wallpaperUrl: string | null = null;
  let wallpaperPalette: Palette | null | undefined;
  const paletteCache = new Map<string, Palette | null>();

  // ── Palette (two dominant colors) ─────────────────────────────────────────

  function applyPalette(palette: Palette | null): void {
    if (palette === null) {
      app.style.removeProperty('--d1');
      app.style.removeProperty('--d2');
      return;
    }
    app.style.setProperty('--d1', palette.d1);
    app.style.setProperty('--d2', palette.d2);
  }

  // Computes (or reuses a cached) palette for an arbitrary image, keyed by an arbitrary cache key
  // (per-hero: `${gameId}#${index}`). Applies it only if that image is STILL the one on screen, so a
  // slow compute for a rotated-away image can't clobber the current palette.
  function updatePaletteFor(url: string, cacheKey: string): void {
    const cached = paletteCache.get(cacheKey);
    if (cached !== undefined) {
      applyPalette(cached);
      return;
    }
    void computePalette(url).then((palette) => {
      paletteCache.set(cacheKey, palette);
      if (shownUrl === url) applyPalette(palette);
    });
  }

  // The wallpaper's palette, reused both on the idle screen AND when a game's hero falls back to the
  // wallpaper — so we never recompute the same dominant colors under a per-game key.
  function applyWallpaperPalette(): void {
    if (wallpaperPalette !== undefined) {
      applyPalette(wallpaperPalette);
      return;
    }
    if (wallpaperUrl === null) {
      applyPalette(null);
      return;
    }
    const url = wallpaperUrl;
    void computePalette(url).then((palette) => {
      wallpaperPalette = palette;
      if (shownUrl === url) applyPalette(palette);
    });
  }

  // ── Hero background (two cross-fading layers, GTA-5-style) ──────────────────

  // Two stacked layers we cross-fade between: activeLayer shows the current image, idleLayer receives the
  // next one; then the roles swap. Both run bg-pan perpetually (see styles.css).
  const heroLayers = Array.from(document.querySelectorAll<HTMLElement>('#hero .hero-layer'));
  const [heroLayerA, heroLayerB] = heroLayers;
  if (heroLayerA === undefined || heroLayerB === undefined) {
    throw new Error('#hero must contain two .hero-layer elements');
  }
  let activeLayer: HTMLElement = heroLayerA;
  let idleLayer: HTMLElement = heroLayerB;
  // The url the active layer currently shows — a gate so the dozens of state.set renders per session
  // don't trigger a needless cross-fade / pan re-randomize when the image hasn't actually changed.
  let shownUrl: string | null = null;

  /** Matches the .hero-layer opacity transition in styles.css — how long a cross-fade owns both layers. */
  const CROSSFADE_MS = 700;
  /**
   * How long the requested image must stand before it is painted. Deliberately longer than the nav
   * repeat (NAV_REPEAT_MS in gamepad.ts), so a HELD left/right never paints a background at all: the
   * strip flips, and the hero lands once, on wherever the user stopped.
   */
  const SETTLE_MS = 120;

  // What the launcher WANTS on screen, versus what is on it (shownUrl). They differ while a swap waits —
  // see requestImage. The palette travels with the image rather than being applied at request time: the
  // colors and the picture must never disagree, which is what a straight apply would do while flipping.
  let desiredUrl: string | null = null;
  let desiredPaint: (() => void) | null = null;
  let swapTimer: number | null = null;
  let lastSwapAt = Number.NEGATIVE_INFINITY;
  // A direction is being held (controls.ts tells us). SETTLE_MS alone almost covers this — the repeat is
  // faster than it — but "almost" depends on the OS keyboard repeat rate, which is the user's setting,
  // not ours. The held state says it outright: no swap at all until the flip stops.
  let flipping = false;

  /**
   * Asks for an image (and the palette that goes with it). The swap is deferred twice over: until the
   * request has stood still for SETTLE_MS, and until the previous cross-fade has finished. Painting into
   * a layer that is still fading is what made a fast card change snap — the incoming layer is visible by
   * then, so swapping its background-image replaces the picture instantly, with no fade at all.
   */
  function requestImage(url: string | null, paintPalette: () => void): void {
    if (url === desiredUrl) {
      // The same image asked for again (a re-render, a language change). No cross-fade — but the palette
      // may still need re-applying, unless the swap to it hasn't happened yet, where it is the swap's job.
      if (shownUrl === desiredUrl) paintPalette();
      else desiredPaint = paintPalette;
      return;
    }
    desiredUrl = url;
    desiredPaint = paintPalette;
    // The session's FIRST image has nothing to cross-fade with and nobody waiting to see it settle.
    if (shownUrl === null && swapTimer === null && !flipping) runSwap();
    else armSwap();
  }

  function armSwap(): void {
    if (swapTimer !== null) {
      window.clearTimeout(swapTimer);
      swapTimer = null;
    }
    // Held: the swap is re-armed by setFlipping when the direction is released, with whatever the last
    // request turned out to be.
    if (flipping) return;
    const waitForFade = lastSwapAt + CROSSFADE_MS - performance.now();
    swapTimer = window.setTimeout(runSwap, Math.max(SETTLE_MS, waitForFade));
  }

  function setFlipping(next: boolean): void {
    if (flipping === next) return;
    flipping = next;
    if (flipping) {
      if (swapTimer !== null) {
        window.clearTimeout(swapTimer);
        swapTimer = null;
      }
      return;
    }
    if (desiredUrl !== shownUrl) armSwap();
  }

  function runSwap(): void {
    if (swapTimer !== null) {
      window.clearTimeout(swapTimer);
      swapTimer = null;
    }
    const paint = desiredPaint;
    desiredPaint = null;
    if (desiredUrl !== shownUrl) {
      lastSwapAt = performance.now();
      swapLayers(desiredUrl);
    }
    paint?.();
  }

  // Cross-fades to a new image on the idle layer, then swaps roles. Only ever called from runSwap, which
  // owns the timing; null → no image (blank background).
  function swapLayers(url: string | null): void {
    shownUrl = url;
    // The incoming (idle) layer gets the new image + a fresh random pan direction (drift left vs right).
    idleLayer.style.backgroundImage = url !== null ? `url("${url}")` : 'none';
    idleLayer.style.setProperty('--pan-x', Math.random() < 0.5 ? '1.5%' : '-1.5%');
    // Force-restart bg-pan so the incoming image starts its drift from zero: opacity:0 does NOT pause the
    // animation, so without this the layer would fade in mid-drift. Toggling animation + a reflow retriggers
    // it — and the same reflow flushes styles so the opacity transition below actually animates.
    idleLayer.style.animation = 'none';
    void idleLayer.offsetWidth;
    idleLayer.style.animation = '';
    // Cross-fade: incoming layer in, outgoing out, then swap the roles.
    idleLayer.classList.add('is-active');
    activeLayer.classList.remove('is-active');
    const previousActive = activeLayer;
    activeLayer = idleLayer;
    idleLayer = previousActive;
  }

  // The empty / idle screen (no game): the fallback wallpaper as background, its dominant colors as
  // the palette, and "Insert a game card" as the title. Reuses the main screen's bottom bar layout.
  function applyEmptyScreen(): void {
    titleEl.textContent = deps.getTranslator()('launcher.emptyTitle');
    if (wallpaperUrl === null) {
      requestImage(null, () => applyPalette(null));
      return;
    }
    requestImage(wallpaperUrl, applyWallpaperPalette);
  }

  // The wallpaper as the opening backdrop: same image and palette as the empty screen, but it says
  // nothing about the state — the title is left to render(). Only ever paints into an empty screen, so
  // it can never override a hero that already arrived.
  function showWallpaperBackdrop(): void {
    if (shownUrl !== null || desiredUrl !== null || wallpaperUrl === null) return;
    requestImage(wallpaperUrl, applyWallpaperPalette);
  }

  // ── Hero rotation (renderer-local, GTA-5 cadence) ──────────────────────────

  // Hero images for the current card (delivered on the hero:update channel) and the rotation cursor.
  let heroImages: readonly string[] = [];
  let heroIndex = 0;
  let heroTimer: number | null = null;

  // Shows the hero at `index`: cross-fade the image + (re)apply its palette. When the only image is the
  // wallpaper fallback, reuse the wallpaper palette instead of recomputing it under a per-game key.
  function showHeroAt(index: number): void {
    const url = heroImages[index];
    if (url === undefined) return;
    const id = deps.getGameId();
    requestImage(url, () => {
      if (url === wallpaperUrl) applyWallpaperPalette();
      else updatePaletteFor(url, `${id}#${index}`);
    });
  }

  // Rotation runs only with >1 image, the window visible, and a game on screen (symmetric to the music
  // gate). During a Steam download the window stays on the ready screen with a game, so rotation is fine.
  function heroRotationEligible(): boolean {
    return (
      heroImages.length > 1 &&
      document.visibilityState === 'visible' &&
      deps.hasGameOnScreen()
    );
  }

  // (Re)evaluates the rotation timer: starts it when eligible, stops it otherwise. Idempotent — if it is
  // already running and still eligible the countdown is left intact, so frequent state.set renders don't
  // starve the rotation by resetting the interval.
  function startRotation(): void {
    if (!heroRotationEligible()) {
      stopRotation();
      return;
    }
    if (heroTimer !== null) return;
    heroTimer = window.setInterval(() => {
      heroIndex = (heroIndex + 1) % heroImages.length;
      showHeroAt(heroIndex);
    }, HERO_ROTATE_MS);
  }

  function stopRotation(): void {
    if (heroTimer === null) return;
    window.clearInterval(heroTimer);
    heroTimer = null;
  }

  // New hero payload: reset the cursor, paint the first image if a game is already on screen (channels are
  // independent — render may have landed first), and restart the rotation from fresh. `replaceWhenEmpty`
  // decides what an EMPTY payload means — see the branch below.
  function applyAssets(assets: HeroAssets | null, replaceWhenEmpty = false): void {
    heroImages = assets?.images ?? [];
    heroIndex = 0;
    // A fresh payload can carry the same per-game key `${id}#${index}` mapped to a DIFFERENT image — e.g.
    // after the user reorders hero images on the Customize screen and saves. The palette cache is keyed by
    // position, not content, so drop it here: the new first image must recompute --d1/--d2 rather than
    // reuse the previous image's colors. (Intra-card rotation still fills and reuses the cache.)
    paletteCache.clear();
    stopRotation();
    if (deps.hasGameOnScreen()) {
      if (heroImages.length > 0) showHeroAt(0);
      // An empty payload on the BROWSE channel is a statement — "the game now on screen has no background
      // of its own" — and must replace what is there, not leave it: keeping the previous image is how one
      // game's artwork ended up sitting under another game's name. Main normally substitutes the wallpaper
      // before it gets here; this is the last line of that same rule. On the CARD channel an empty payload
      // means something else entirely ("no card any more"), and there the old image may stay until the
      // browse cursor lands somewhere — hence the flag rather than one rule for both.
      else if (replaceWhenEmpty) {
        if (wallpaperUrl !== null) requestImage(wallpaperUrl, applyWallpaperPalette);
        else requestImage(null, () => applyPalette(null));
      }
    }
    startRotation();
  }

  function repaint(): void {
    if (heroImages.length > 0) showHeroAt(heroIndex);
  }

  function setWallpaper(url: string | null): void {
    wallpaperUrl = url;
    // Drop the cached wallpaper palette so a changed wallpaper recomputes its own --d1/--d2 (the cache is
    // encapsulated in this closure — it can't be reset from app.ts; see plan F2-3).
    wallpaperPalette = undefined;
  }

  function setParallax(designPx: number): void {
    // On the pan wrapper, not on #hero: that one carries the (much faster) screen zoom — see styles.css.
    heroPanEl.style.setProperty('--hero-parallax', `calc(${designPx} * var(--px))`);
  }

  function currentLayerTransform(): string {
    return getComputedStyle(activeLayer).transform;
  }

  return {
    repaint,
    startRotation,
    applyAssets,
    applyBrowseAssets: (assets) => applyAssets(assets, true),
    applyEmptyScreen,
    showWallpaperBackdrop,
    setWallpaper,
    setParallax,
    setFlipping,
    currentLayerTransform,
  };
}
