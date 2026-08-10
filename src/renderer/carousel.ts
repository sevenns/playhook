// The history carousel: the launcher's top-level screen. A strip of game cards — the inserted card's
// games first (dotted: launchable right now), then what was played on this device before — sliding under
// a fixed anchor while the selection stays put. Pressing A on a card opens the existing bar screen for it
// (`detail`); B comes back here.
//
// Owns only the strip: the DOM of the cards, the selection, the artwork cache and the `data-screen`
// attribute. What is SHOWN for the selected card (title, stats, background, music) is main's answer to
// `browseGame(id)` — this module never derives it. The geometry lives in carousel-geometry.ts (pure).
import type { LibraryEntry } from '../shared/types';
import { clampIndex, isNearViewport, stripOffset } from './carousel-geometry.js';
import { req } from './dom.js';

/** The two levels of the launcher screen (mirrors `#app[data-screen]`). */
export type Screen = 'carousel' | 'detail';

export interface CarouselDeps {
  /** Fetches one card's artwork as a data URL (main caches nothing; we cache by id here). */
  requestGrid(id: string): Promise<string | null>;
  /** Tells main which game is on screen — it answers on the browse:* channels. Debounced by the caller. */
  browseGame(id: string): void;
  /** The screen level changed (app.ts re-renders: the no-play layout and the focus model depend on it). */
  onScreenChange(screen: Screen): void;
  /** A card was activated (A / click on the selected card) — app.ts decides what entering detail means. */
  onActivate(entry: LibraryEntry): void;
  /** The selection moved (a nav sound belongs to the interaction layer, not here). */
  onNavigate(): void;
}

export interface Carousel {
  /** New list from main (insert / removal / a finished session / an eviction). Keeps the selection BY ID. */
  setGames(games: readonly LibraryEntry[]): void;
  /** Moves the selection by `delta` cards (no wrap-around — the ends are hard stops). */
  move(delta: number): void;
  /** Activates the selected card (A / a click on it). */
  activate(): void;
  /** The current screen level. */
  screen(): Screen;
  /** Switches level. Refused into `carousel` when there is no carousel to show (0 or 1 game). */
  setScreen(screen: Screen): void;
  /** Whether the carousel exists at all (>1 game — with one there is nothing to flip through). */
  exists(): boolean;
  /** The selected entry, or undefined for an empty list. */
  selected(): LibraryEntry | undefined;
  /** Marks the game AppState is busy with, so its card can pulse wherever it sits in the list. */
  setBusyGame(id: string | null): void;
}

export function createCarousel(deps: CarouselDeps): Carousel {
  const app = req('app');
  const strip = req('carousel-strip');
  const playButton = req('play-button');

  let games: readonly LibraryEntry[] = [];
  let index = 0;
  let screen: Screen = 'detail';
  let busyId: string | null = null;
  // Artwork by game id. Decoded data URLs are heavy, so each is fetched at most once per session; a
  // card whose game has no art at all is remembered as null so we don't ask again on every re-render.
  const art = new Map<string, string | null>();
  const cards = new Map<string, HTMLElement>();

  function exists(): boolean {
    return games.length > 1;
  }

  function selected(): LibraryEntry | undefined {
    return games[index];
  }

  /** The strip's translation + the per-card selected/active/busy state. Cheap; safe to call often. */
  function applyLayout(): void {
    strip.style.setProperty('--strip-offset', String(stripOffset(index)));
    const current = selected();
    for (const [id, card] of cards) {
      card.classList.toggle('is-selected', id === current?.id);
      card.classList.toggle('is-busy', id === busyId);
    }
    // The morph's source image: #play-button wears the selected card's artwork so the swap into `detail`
    // is invisible (see the morph block in styles.css).
    const url = current === undefined ? null : (art.get(current.id) ?? null);
    playButton.style.setProperty('--card-art', url === null ? 'none' : `url("${url}")`);
  }

  /** Loads the artwork of the cards near the selection (a 40-game history must not decode 40 covers). */
  function loadNearbyArt(): void {
    games.forEach((game, i) => {
      if (!isNearViewport(i, index) || art.has(game.id)) return;
      art.set(game.id, null); // claim the slot first: the request is async and re-renders are frequent
      void deps.requestGrid(game.id).then((url) => {
        if (url === null) return;
        art.set(game.id, url);
        paintArt(game.id, url);
        if (game.id === selected()?.id) applyLayout(); // refresh the morph source
      });
    });
  }

  function paintArt(id: string, url: string): void {
    const card = cards.get(id);
    if (card === undefined) return;
    card.style.backgroundImage = `url("${url}")`;
    card.classList.add('has-art');
  }

  function buildCard(game: LibraryEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset['gameId'] = game.id;
    // A game on the inserted card gets the dot: it can be launched/installed right now.
    card.classList.toggle('is-active', game.active);
    const label = document.createElement('span');
    label.className = 'card-label';
    // Card data is untrusted (it comes from game.json) — textContent, never innerHTML.
    label.textContent = game.title;
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    card.append(label, dot);
    const url = art.get(game.id);
    if (url !== undefined && url !== null) {
      card.style.backgroundImage = `url("${url}")`;
      card.classList.add('has-art');
    }
    card.addEventListener('click', () => {
      const position = games.findIndex((g) => g.id === game.id);
      if (position === -1) return;
      // Click on the selected card = enter it; click on another = select it (two-step, like a d-pad).
      if (position === index) {
        activate();
        return;
      }
      index = position;
      deps.onNavigate();
      applyLayout();
      announceSelection();
    });
    return card;
  }

  function rebuild(): void {
    cards.clear();
    const nodes = games.map((game) => {
      const card = buildCard(game);
      cards.set(game.id, card);
      return card;
    });
    strip.replaceChildren(...nodes);
  }

  /** Tells main what is on screen now. */
  function announceSelection(): void {
    const current = selected();
    if (current === undefined) return;
    deps.browseGame(current.id);
  }

  function setScreen(next: Screen): void {
    // With 0 or 1 game there is nothing to flip through: the launcher stays on the plain bar screen (Р7).
    const effective: Screen = next === 'carousel' && !exists() ? 'detail' : next;
    if (effective === screen) return;
    screen = effective;
    app.dataset['screen'] = effective;
    deps.onScreenChange(effective);
  }

  function activate(): void {
    const current = selected();
    if (current === undefined) return;
    deps.onActivate(current);
  }

  function move(delta: number): void {
    const next = clampIndex(index + delta, games.length);
    if (next === index) return; // at an end — no move, no sound
    index = next;
    deps.onNavigate();
    applyLayout();
    loadNearbyArt();
    announceSelection();
  }

  // The launcher starts on the plain bar screen; the first list with more than one game promotes it.
  app.dataset['screen'] = screen;

  return {
    setGames(list: readonly LibraryEntry[]): void {
      // The selection is remembered BY ID, not by position: the list is re-ordered whenever a card is
      // inserted or a session ends, and a positional cursor would silently land on a different game.
      const currentId = selected()?.id;
      games = list;
      index = clampIndex(
        currentId === undefined
          ? 0
          : Math.max(
              0,
              games.findIndex((game) => game.id === currentId),
            ),
        games.length,
      );
      rebuild();
      applyLayout();
      loadNearbyArt();
      // A list that shrank to a single game (or none) has no carousel left to stand on.
      if (!exists() && screen === 'carousel') setScreen('detail');
    },
    move,
    activate,
    screen: () => screen,
    setScreen,
    exists,
    selected,
    setBusyGame(id: string | null): void {
      if (id === busyId) return;
      busyId = id;
      applyLayout();
    },
  };
}
