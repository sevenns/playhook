// The history carousel: the launcher's top-level screen. A strip of game cards — the inserted card's
// games first (dotted: launchable right now), then what was played on this device before — sliding under
// a fixed anchor while the selection stays put. Pressing A on a card opens the existing bar screen for it
// (`detail`); B comes back here.
//
// Owns only the strip: the DOM of the cards, the selection, the artwork cache and the `data-screen`
// attribute. What is SHOWN for the selected card (title, stats, background, music) is main's answer to
// `browseGame(id)` — this module never derives it. The geometry lives in carousel-geometry.ts (pure).
import type { LibraryEntry } from '../shared/types';
import {
  RETURN_FAN_MS,
  RETURN_LOCK_MS,
  clampIndex,
  fanIndex,
  isNearViewport,
  isWithinWindow,
  stripOffset,
} from './carousel-geometry.js';
import { req } from './dom.js';

/** The two levels of the launcher screen (mirrors `#app[data-screen]`). */
export type Screen = 'carousel' | 'detail';

/**
 * What a `move` did. `at-end` is the one the caller acts on: the strip is against a hard stop, so the
 * press is free for whatever lies beyond the row (the bar's More button — see controls.ts). It must stay
 * distinct from `locked`, which is the return-morph still running and means "this press does nothing at
 * all" — treating the two alike would fling the focus off the strip on any press right after coming back.
 */
export type MoveResult = 'moved' | 'at-end' | 'locked';

export interface CarouselDeps {
  /** Fetches one card's artwork as a data URL (main caches nothing; we cache by id here). */
  requestGrid(id: string): Promise<string | null>;
  /** Tells main which game is on screen — it answers on the browse:* channels. Debounced by the caller. */
  browseGame(id: string): void;
  /** The screen level changed (app.ts re-renders: the no-play layout and the focus model depend on it). */
  onScreenChange(screen: Screen): void;
  /** A card was activated (A / click on the selected card) — app.ts decides what entering detail means. */
  onActivate(entry: LibraryEntry): void;
  /** The selection moved by `delta` cards (a nav sound / the background parallax belong to app.ts). */
  onNavigate(delta: number): void;
}

export interface Carousel {
  /** New list from main (insert / removal / a finished session / an eviction). Keeps the selection BY ID. */
  setGames(games: readonly LibraryEntry[]): void;
  /** Moves the selection by `delta` cards (no wrap-around — the ends are hard stops). */
  move(delta: number): MoveResult;
  /**
   * Puts the selection on `id` WITHOUT telling main about it — for the reverse direction, where main
   * decided what is on screen (a card was inserted, a game was picked) and the strip has to follow.
   * A no-op when the id isn't in the list.
   */
  focusGame(id: string): void;
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
  // While the strip is coming back from the detail screen the selected card is still growing out of the
  // play square. Moving the selection through that resizes and reorders a card mid-morph, which shows.
  // Timestamp (performance.now) until which a move is refused; 0 = the card stands at full size.
  let lockedUntil = 0;
  // Pending clear of `data-returning` (see markReturning); null when the strip is not returning.
  let returnTimer: number | null = null;
  // Artwork, keyed by game id AND artwork revision. Decoded data URLs are heavy, so each is fetched at
  // most once; a game with no art at all is remembered as null so we don't ask again on every re-render.
  // The revision is what keeps that cache honest: editing gridImage in Configure re-copies the assets,
  // main bumps `artRev`, and the new key misses the cache — no restart needed to see the new cover.
  const art = new Map<string, string | null>();
  const cards = new Map<string, HTMLElement>();

  const artKey = (game: LibraryEntry): string => `${game.id}@${game.artRev ?? ''}`;

  function exists(): boolean {
    return games.length > 1;
  }

  function selected(): LibraryEntry | undefined {
    return games[index];
  }

  /**
   * Whether a card shows the "on the inserted card" dot. It only earns its place when it TELLS the two
   * kinds of entry apart — with no history in the row every card would wear one — or when that game is
   * busy, where the pulsing dot is the only sign of an install/run happening elsewhere in the list.
   */
  function showsDot(game: LibraryEntry, hasHistory: boolean): boolean {
    return (game.active && hasHistory) || game.id === busyId;
  }

  /** The strip's translation + the per-card selected/active/busy state. Cheap; safe to call often. */
  function applyLayout(): void {
    strip.style.setProperty('--strip-offset', String(stripOffset(index)));
    const current = selected();
    const hasHistory = games.some((game) => !game.active);
    games.forEach((game, position) => {
      const card = cards.get(game.id);
      if (card === undefined) return;
      card.classList.toggle('is-selected', game.id === current?.id);
      card.classList.toggle('is-busy', game.id === busyId);
      card.classList.toggle('shows-dot', showsDot(game, hasHistory));
      // Past the shown window (see VISIBLE_CARDS): still laid out — the strip's offset is positional and
      // a removed node would shift every card after it — but faded out, so it slides in softly when the
      // selection reaches it instead of popping into existence at the row's end.
      card.classList.toggle('is-beyond', !isWithinWindow(position, index));
      // Its place in the fan the strip returns in (styles.css turns this into a transition-delay).
      card.style.setProperty('--fan', String(fanIndex(position, index)));
    });
    // The morph's source image: #play-button wears the selected card's artwork so the swap into `detail`
    // is invisible (see the morph block in styles.css).
    const url = current === undefined ? null : (art.get(artKey(current)) ?? null);
    playButton.style.setProperty('--card-art', url === null ? 'none' : `url("${url}")`);
  }

  /** Loads the artwork of the cards near the selection (a 40-game history must not decode 40 covers). */
  function loadNearbyArt(): void {
    games.forEach((game, i) => {
      const key = artKey(game);
      if (!isNearViewport(i, index) || art.has(key)) return;
      art.set(key, null); // claim the slot first: the request is async and re-renders are frequent
      void deps.requestGrid(game.id).then((url) => {
        if (url === null) return;
        art.set(key, url);
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
    // Whether this card gets the "on the inserted card" dot is decided per render by showsDot
    // (applyLayout) — it depends on the rest of the row, not on this game alone.
    const label = document.createElement('span');
    label.className = 'card-label';
    // Card data is untrusted (it comes from game.json) — textContent, never innerHTML.
    label.textContent = game.title;
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    card.append(label, dot);
    const url = art.get(artKey(game));
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
      if (isLocked()) return; // same lock the d-pad obeys — a click may not jump a half-drawn strip
      const delta = position - index;
      index = position;
      deps.onNavigate(delta);
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
    // Coming back, the strip is unusable until the selected card is back at full size (RETURN_LOCK_MS);
    // leaving, nothing is locked — the detail screen has its own focus model.
    lockedUntil = effective === 'carousel' ? performance.now() + RETURN_LOCK_MS : 0;
    markReturning(effective === 'carousel');
    deps.onScreenChange(effective);
  }

  /**
   * Flags the staggered hand-back fade for as long as it runs (see RETURN_FAN_MS). CSS keys the fan's
   * transition-delay on it, so a card that scrolls into the window while merely FLIPPING fades in
   * immediately — the stagger belongs to the return, not to every appearance.
   */
  function markReturning(returning: boolean): void {
    if (returnTimer !== null) {
      window.clearTimeout(returnTimer);
      returnTimer = null;
    }
    if (!returning) {
      delete app.dataset['returning'];
      return;
    }
    app.dataset['returning'] = 'true';
    returnTimer = window.setTimeout(() => {
      returnTimer = null;
      delete app.dataset['returning'];
    }, RETURN_FAN_MS);
  }

  /** Whether the selected card is still growing back to full size, i.e. must not be flipped through yet. */
  function isLocked(): boolean {
    return performance.now() < lockedUntil;
  }

  function activate(): void {
    const current = selected();
    if (current === undefined) return;
    deps.onActivate(current);
  }

  function move(delta: number): MoveResult {
    if (isLocked()) return 'locked';
    const next = clampIndex(index + delta, games.length);
    if (next === index) return 'at-end'; // no move, no sound — the caller decides what a stop means
    const moved = next - index;
    index = next;
    deps.onNavigate(moved);
    applyLayout();
    loadNearbyArt();
    announceSelection();
    return 'moved';
  }

  // The launcher starts on the plain bar screen; the first list with more than one game promotes it.
  app.dataset['screen'] = screen;

  return {
    focusGame(id: string): void {
      const position = games.findIndex((game) => game.id === id);
      if (position === -1 || position === index) return;
      index = position;
      applyLayout();
      loadNearbyArt();
    },
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
