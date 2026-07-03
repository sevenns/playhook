// Hero background subsystem (audit I2 — split out of app.ts). Owns everything about "what image is on
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
  /** New hero payload for the current card: reset cursor, paint first image, restart rotation. */
  applyAssets(assets: HeroAssets | null): void;
  /** The empty / idle screen: fallback wallpaper background, its palette, "Insert a game card" title. */
  applyEmptyScreen(): void;
  /** Stores the fallback wallpaper data URL (delivered by main); does not repaint on its own. */
  setWallpaper(url: string | null): void;
}

export function createHeroController(deps: HeroDeps): HeroController {
  const app = req('app');
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
  // wallpaper — so we never recompute the same dominant colors under a per-game key (review note 7).
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

  // Cross-fades to a new image on the idle layer, then swaps roles. No-op when the url is unchanged
  // (keeps the running pan going). null → no image (blank background).
  function showImage(url: string | null): void {
    if (url === shownUrl) return;
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
      showImage(null);
      applyPalette(null);
      return;
    }
    showImage(wallpaperUrl);
    applyWallpaperPalette();
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
    showImage(url);
    if (url === wallpaperUrl) {
      applyWallpaperPalette();
      return;
    }
    const id = deps.getGameId();
    updatePaletteFor(url, `${id}#${index}`);
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

  // New hero payload for the current card: reset the cursor, paint the first image if a game is already on
  // screen (channels are independent — render may have landed first), and restart the rotation from fresh.
  function applyAssets(assets: HeroAssets | null): void {
    heroImages = assets?.images ?? [];
    heroIndex = 0;
    stopRotation();
    if (deps.hasGameOnScreen() && heroImages.length > 0) {
      showHeroAt(0);
    }
    startRotation();
  }

  function repaint(): void {
    if (heroImages.length > 0) showHeroAt(heroIndex);
  }

  function setWallpaper(url: string | null): void {
    wallpaperUrl = url;
  }

  return { repaint, startRotation, applyAssets, applyEmptyScreen, setWallpaper };
}
