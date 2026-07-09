// Carousel (game-selection) screen. A card can carry several games; this module renders the browsing UI
// and owns the LOCAL index + navigation (per the plan, decision 4: the renderer owns index/animations,
// main owns the library/selection/lock). Left/right change the focused game instantly — swapping the
// fullscreen background, the two-color palette, the card row and the title — with no round-trip to main.
// Picking a card sends action:select (via deps.onSelect); main then drives the ready screen.
//
// The background is a SECOND hero instance (fade only, no pan, no rotation) writing --d1/--d2 to #app so
// the whole UI palette follows the focused game. The cards are plain divs whose background-image is each
// game's first hero image; the centered one gets .is-active (coral pulse-ring, see styles.css).
import type { GameLibrary } from '../shared/types';
import type { Translator } from '../shared/i18n/index.js';
import { createHeroController, type HeroController } from './hero.js';
import { type AudioController } from './audio.js';
import { req, reqQuery } from './dom.js';

/** What the carousel needs from the rest of the renderer. */
export interface CarouselDeps {
  /** The shared audio controller (navigate/button SFX). */
  audio: AudioController;
  /** The current translator (unused today; kept for parity/future labels). */
  getTranslator(): Translator;
  /** Pick the game at `index` — the renderer sends action:select to main. */
  onSelect(index: number): void;
}

export interface CarouselController {
  /** Stores the whole card's library (info+hero+audio per game). Re-renders if currently open. */
  setLibrary(library: GameLibrary | null): void;
  /** Shows the carousel focused at `index` (called on entering the selecting state). */
  open(index: number): void;
  /** Leaves the carousel (called when the state moves away from selecting). */
  close(): void;
  /** Focus the previous game (clamped at the left edge). Plays the navigate SFX on a real move. */
  moveLeft(): void;
  /** Focus the next game (clamped at the right edge). Plays the navigate SFX on a real move. */
  moveRight(): void;
  /** Pick the focused game (plays the button SFX). */
  select(): void;
  /** Whether the carousel is currently open (browsing). */
  isOpen(): boolean;
  /** The currently focused index (renderer-local). */
  getIndex(): number;
  /** How many games the current card carries (0 when no library) — gates the "Select game" button. */
  gameCount(): number;
}

export function createCarouselController(deps: CarouselDeps): CarouselController {
  const titleEl = req('carousel-title');
  const cardPrev = reqQuery<HTMLElement>('#carousel .carousel-card[data-slot="prev"]');
  const cardCurrent = reqQuery<HTMLElement>('#carousel .carousel-card[data-slot="current"]');
  const cardNext = reqQuery<HTMLElement>('#carousel .carousel-card[data-slot="next"]');

  let library: GameLibrary | null = null;
  let index = 0;
  let open = false;

  // Background hero instance: fade only (no pan), no local rotation; palette → #app so the whole UI
  // follows the focused game. Its "game on screen" gate is the carousel being open with a library.
  const bgHero: HeroController = createHeroController({
    hasGameOnScreen: () => open && (library?.games.length ?? 0) > 0,
    getGameId: () => library?.games[index]?.info.id ?? '',
    getTranslator: () => deps.getTranslator(),
    paletteTarget: req('app'),
    titleTarget: titleEl, // never used (the carousel never shows the empty screen), but must be an element
    layerSelector: '#carousel-bg .hero-layer',
    pan: false,
    rotate: false,
  });

  function firstHero(i: number): string | null {
    return library?.games[i]?.hero.images[0] ?? null;
  }

  function paintCard(card: HTMLElement, i: number): void {
    const url = firstHero(i);
    const exists = library?.games[i] !== undefined;
    card.style.backgroundImage = url !== null ? `url("${url}")` : 'none';
    // A neighbour card at the edge (no game on that side) is hidden entirely.
    card.classList.toggle('is-empty', !exists);
  }

  // Renders every focus-dependent surface for the current index: background hero + palette, the card row
  // (prev/current/next) and the title.
  function renderFocus(): void {
    const games = library?.games ?? [];
    const focused = games[index];
    if (focused === undefined) return;
    bgHero.applyAssets(focused.hero);
    // Switch the background music to the focused game's track. Idempotent when unchanged (same data-URL),
    // so re-rendering the same focus — or the audio:update main sends on entry — never restarts it.
    deps.audio.setCarouselMusic(focused.audio?.music);
    paintCard(cardPrev, index - 1);
    paintCard(cardCurrent, index);
    paintCard(cardNext, index + 1);
    titleEl.textContent = focused.info.title;
    // Hide neighbours at the edges (clamped, non-cyclic — see decision 7).
    cardPrev.classList.toggle('is-hidden', index <= 0);
    cardNext.classList.toggle('is-hidden', index >= games.length - 1);
  }

  function move(delta: number): void {
    if (!open) return;
    const games = library?.games ?? [];
    const next = Math.min(games.length - 1, Math.max(0, index + delta));
    if (next === index) return; // at the edge — no move, no sound (non-cyclic clamp)
    index = next;
    deps.audio.playCarousel('navigate'); // bundled default (cross-game screen)
    renderFocus();
  }

  function setLibrary(next: GameLibrary | null): void {
    library = next;
    if (open) {
      // Clamp the index into the new library and re-render (a reload may change the game count).
      const count = next?.games.length ?? 0;
      index = Math.min(Math.max(0, index), Math.max(0, count - 1));
      renderFocus();
    }
  }

  function openAt(i: number): void {
    const count = library?.games.length ?? 0;
    index = Math.min(Math.max(0, i), Math.max(0, count - 1));
    open = true;
    renderFocus();
  }

  function close(): void {
    open = false;
  }

  function select(): void {
    if (!open) return;
    if (library?.games[index] === undefined) return;
    deps.audio.playCarousel('button'); // bundled default (cross-game screen)
    deps.onSelect(index);
  }

  // Mouse: click the centered card to pick it; click a neighbour to move toward it.
  cardCurrent.addEventListener('click', () => select());
  cardPrev.addEventListener('click', () => move(-1));
  cardNext.addEventListener('click', () => move(1));

  return {
    setLibrary,
    open: openAt,
    close,
    moveLeft: () => move(-1),
    moveRight: () => move(1),
    select,
    isOpen: () => open,
    getIndex: () => index,
    gameCount: () => library?.games.length ?? 0,
  };
}
