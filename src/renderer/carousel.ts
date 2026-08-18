// The history carousel: the launcher's top-level screen. A strip of cards — the inserted card's games
// first (dotted: launchable right now), then what was played on this device before, then the launcher's
// own three cards (Notifications / Settings / System, see system-cards.ts) — sliding under a fixed anchor
// while the selection stays put. Pressing A on a game card opens the existing bar screen for it
// (`detail`); B comes back here. Pressing A on a launcher card opens that surface instead — the screen
// level does not change.
//
// Owns only the strip: the DOM of the cards, the selection, the artwork cache and the `data-screen`
// attribute. What is SHOWN for the selected card (title, stats, background, music) is main's answer to
// `browseGame(id)` — this module never derives it; a launcher card answers `browseNone()`, which is main's
// "nothing is on screen". The geometry lives in carousel-geometry.ts (pure).
import type { LibraryEntry } from '../shared/types';
import type { Translator } from '../shared/i18n/index.js';
import {
  MAX_STRIP_GAMES,
  anchorIndex,
  RETURN_FAN_MS,
  RETURN_LOCK_MS,
  clampIndex,
  fanIndex,
  isNearViewport,
  isWithinWindow,
  stripOffset,
} from './carousel-geometry.js';
import { SYSTEM_CARDS, type SystemCard } from './system-cards.js';
import { systemCardIcon } from './system-card-icons.js';
import { req } from './dom.js';

/** The two levels of the launcher screen (mirrors `#app[data-screen]`). */
export type Screen = 'carousel' | 'detail';

/**
 * One place in the row: a game from main's library, or one of the launcher's own cards. The row always
 * holds the launcher cards, which is why there is no such thing as an empty carousel any more.
 */
export type CarouselItem =
  | { readonly kind: 'game'; readonly game: LibraryEntry }
  | { readonly kind: 'system'; readonly card: SystemCard };

/**
 * What a `move` did. `at-end` is the one the caller acts on: the strip is against a hard stop, so the
 * press has nowhere to go and says so (see controls.ts). It must stay distinct from `locked`, which is
 * the return-morph still running and means "this press does nothing at all" — treating the two alike
 * would sound a dead end on every press right after coming back.
 */
export type MoveResult = 'moved' | 'at-end' | 'locked';

export interface CarouselDeps {
  /** Fetches one card's artwork as a data URL (main caches nothing; we cache by id here). */
  requestGrid(id: string): Promise<string | null>;
  /** Tells main which game is on screen — it answers on the browse:* channels. Debounced by the caller. */
  browseGame(id: string): void;
  /** Tells main that no game is on screen: a launcher card is selected (main answers with empty browse). */
  browseNone(): void;
  /** The screen level changed (app.ts re-renders: the no-play layout and the focus model depend on it). */
  onScreenChange(screen: Screen): void;
  /** A card was activated (A / click on the selected card) — app.ts decides what that means per kind. */
  onActivate(item: CarouselItem): void;
  /** The selection moved by `delta` cards (a nav sound / the background parallax belong to app.ts). */
  onNavigate(delta: number): void;
  /** The current translator (the launcher cards' aria-labels are the only text this module writes). */
  getTranslator(): Translator;
}

export interface Carousel {
  /** New game list from main (insert / removal / a finished session / an eviction). Keeps the selection
   *  BY IDENTITY — including a launcher card, which no list update can take away. */
  setGames(games: readonly LibraryEntry[]): void;
  /** Moves the selection by `delta` cards (no wrap-around — the ends are hard stops). */
  move(delta: number): MoveResult;
  /**
   * Puts the selection on `id` WITHOUT telling main about it — for the reverse direction, where main
   * decided what is on screen (a card was inserted, a game was picked) and the strip has to follow.
   * A no-op when the id isn't in the list.
   */
  focusGame(id: string): void;
  /**
   * Puts the selection on the FIRST launcher card, again without telling main. Used when main's browse
   * cursor says "nothing is on screen" while the row is standing on a game — a reconnected window, where
   * the user was parked on a launcher card and which of the three it was is not remembered anywhere.
   */
  focusSystem(): void;
  /** Activates the selected card (A / a click on it). */
  activate(): void;
  /** The current screen level. */
  screen(): Screen;
  /** Switches level. */
  setScreen(screen: Screen): void;
  /** The selected item — a game or a launcher card. */
  selected(): CarouselItem | undefined;
  /** Marks the game AppState is busy with, so its card can pulse wherever it sits in the list. */
  setBusyGame(id: string | null): void;
  /** Whether the inbox holds anything unread — the Notifications card wears the same dot a game does. */
  setUnread(unread: boolean): void;
  /**
   * Replays the staggered fan the strip uses when it comes back from a detail screen. Called once at
   * startup, the moment the loading wallpaper hands over: the cards are built and laid out while the
   * boot screen still covers them, so without this their entrance would have already happened, unseen.
   */
  playIntro(): void;
  /**
   * A direction is being HELD, i.e. the row is flipping on its own. Artwork loading pauses for the
   * duration and resumes on release: each cover is a file read plus a base64 encode in main and a
   * megabyte-ish string over IPC, and firing that per step is what makes a held flip stutter. The cards
   * the flip ends on are the only ones anyone actually looks at.
   */
  setFlipping(flipping: boolean): void;
  /**
   * Seeds this cache with a cover somebody else already decoded — the Library screen, when a game is
   * opened from its grid. applyLayout reads the cache SYNCHRONOUSLY to dress the play button for the
   * morph, so without the hand-over the detail screen would open on an empty plate and fill in a frame
   * later. The key is the same `id@artRev` the row uses, so a stale revision simply misses.
   */
  primeArt(game: LibraryEntry, url: string): void;
  /**
   * The artwork the play button morphs out of, for a detail screen the STRIP cannot speak for: the row
   * carries at most MAX_STRIP_GAMES games, so a game opened from the Library (or from a notification) may
   * have no card here at all — and the selected card's cover would then be another game's. Cleared on the
   * way back to the carousel; `null` is "this game has none", which is not the same as no override.
   */
  setDetailArt(url: string | null): void;
}

/** The row's identity for one item — the key of the DOM node, and what a list update keeps the selection by. */
function itemKey(item: CarouselItem): string {
  return item.kind === 'game' ? `g:${item.game.id}` : `s:${item.card.id}`;
}

export function createCarousel(deps: CarouselDeps): Carousel {
  const app = req('app');
  const strip = req('carousel-strip');
  const playButton = req('play-button');

  const systemItems: readonly CarouselItem[] = SYSTEM_CARDS.map((card) => ({
    kind: 'system',
    card,
  }));
  // The row: main's games, then the launcher's own cards. Never empty — which is what lets the carousel
  // be the launcher's top level unconditionally, with no empty screen and no single-game special case.
  let items: readonly CarouselItem[] = [...systemItems];
  let index = 0;
  let screen: Screen = 'detail';
  let busyId: string | null = null;
  // Whether the inbox holds unread entries (main's push, relayed by app.ts) — the Notifications card's dot.
  let unread = false;
  // While the strip is coming back from the detail screen the selected card is still growing out of the
  // play square. Moving the selection through that resizes and reorders a card mid-morph, which shows.
  // Timestamp (performance.now) until which a move is refused; 0 = the card stands at full size.
  let lockedUntil = 0;
  // Pending clear of `data-returning` (see markReturning); null when the strip is not returning.
  let returnTimer: number | null = null;
  // A direction is being held (app.ts relays it) — artwork loading waits it out. See setFlipping.
  let flipping = false;
  // Artwork, keyed by game id AND artwork revision. Decoded data URLs are heavy, so each is fetched at
  // most once; a game with no art at all is remembered as null so we don't ask again on every re-render.
  // The revision is what keeps that cache honest: editing gridImage re-copies the assets,
  // main bumps `artRev`, and the new key misses the cache — no restart needed to see the new cover.
  const art = new Map<string, string | null>();
  // The morph source set from outside for the current detail screen; undefined when the row speaks for
  // itself (see setDetailArt).
  let detailArt: string | null | undefined = undefined;
  // The card nodes, by itemKey — the launcher cards share the row with the games, so a raw game id would
  // not be unique enough to address a node by.
  const cards = new Map<string, HTMLElement>();
  // A focusGame() that named a game the list does not hold YET. The browse cursor and the carousel list
  // are seeded over two independent channels, in either order, so on startup the "put the strip on the
  // game main is showing" request routinely arrives first — and used to be dropped on the floor, leaving
  // the strip on games[0] while the title, the background and the music belonged to another game.
  // Honoured by the next setGames, then forgotten; a real move by the user outranks it (see move()).
  let pendingFocusId: string | null = null;

  const artKey = (game: LibraryEntry): string => `${game.id}@${game.artRev ?? ''}`;

  /** How many of the row's cards are games — the launcher's own cards always follow them. */
  const gameCount = (): number => items.filter((item) => item.kind === 'game').length;

  function selected(): CarouselItem | undefined {
    return items[index];
  }

  /**
   * Whether a card shows its dot. For a game it marks "this one is playable right now" — it is on the
   * inserted card or in the local library — unconditionally: the mark belongs to the game, and holding it
   * back until the row also holds history entries made a card silently change meaning as the history grew.
   * A busy game keeps it too, where the pulsing dot is the only sign of an install/run happening
   * elsewhere in the list. On the Notifications card the same dot means what it meant beside the old menu
   * item: something is unread.
   */
  function showsDot(item: CarouselItem): boolean {
    if (item.kind === 'system') return item.card.id === 'notifications' && unread;
    return item.game.active || item.game.id === busyId;
  }

  /** The strip's translation + the per-card selected/active/busy state. Cheap; safe to call often. */
  function applyLayout(): void {
    strip.style.setProperty('--strip-offset', String(stripOffset(anchorIndex(index, gameCount()))));
    const current = selected();
    const currentKey = current === undefined ? null : itemKey(current);
    items.forEach((item, position) => {
      const key = itemKey(item);
      const card = cards.get(key);
      if (card === undefined) return;
      card.classList.toggle('is-selected', key === currentKey);
      card.classList.toggle('is-busy', item.kind === 'game' && item.game.id === busyId);
      card.classList.toggle('shows-dot', showsDot(item));
      // Past the shown window (see VISIBLE_CARDS): still laid out — the strip's offset is positional and
      // a removed node would shift every card after it — but faded out, so it slides in softly when the
      // selection reaches it instead of popping into existence at the row's end.
      // The launcher cards never wait off-view: the window is about a long history running off the right
      // edge, and those four are the row's fixed furniture — the whole point of them is being reachable.
      card.classList.toggle(
        'is-beyond',
        item.kind === 'game' && !isWithinWindow(position, index),
      );
      // Its place in the fan the strip returns in (styles.css turns this into a transition-delay).
      card.style.setProperty('--fan', String(fanIndex(position, index)));
    });
    // The morph's source image: #play-button wears the selected card's artwork so the swap into `detail`
    // is invisible (see the morph block in styles.css). A launcher card has none — and no detail screen
    // to morph into either.
    const url =
      detailArt !== undefined
        ? detailArt
        : current === undefined || current.kind === 'system'
          ? null
          : (art.get(artKey(current.game)) ?? null);
    playButton.style.setProperty('--card-art', url === null ? 'none' : `url("${url}")`);
  }

  /** Loads the artwork of the cards near the selection (a 40-game history must not decode 40 covers). */
  function loadNearbyArt(): void {
    if (flipping) return; // see setFlipping — the row is mid-flight, nobody is reading these cards yet
    // The position is the one in the WHOLE row (isNearViewport measures against the selection), while only
    // the games have anything to fetch.
    items.forEach((item, i) => {
      if (item.kind !== 'game') return;
      const game = item.game;
      const key = artKey(game);
      if (!isNearViewport(i, index) || art.has(key)) return;
      art.set(key, null); // claim the slot first: the request is async and re-renders are frequent
      void deps.requestGrid(game.id).then((url) => {
        if (url === null) return;
        art.set(key, url);
        paintArt(game.id, url);
        const current = selected();
        if (current?.kind === 'game' && current.game.id === game.id) applyLayout(); // refresh the morph source
      });
    });
  }

  function paintArt(id: string, url: string): void {
    const card = cards.get(`g:${id}`);
    if (card === undefined) return;
    card.style.backgroundImage = `url("${url}")`;
    card.classList.add('has-art');
  }

  function buildCard(item: CarouselItem): HTMLElement {
    const card = document.createElement('div');
    card.className = item.kind === 'system' ? 'card is-system' : 'card';
    // Whether this card gets its dot is decided per render by showsDot (applyLayout) — for a game it
    // depends on the rest of the row, not on that game alone.
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    if (item.kind === 'system') {
      // The label is written by localizeDocument on every language change; the attribute below is what it
      // reads, and the initial value is set here so the card is named from the frame it is built in.
      card.dataset['i18nAriaLabel'] = item.card.ariaKey;
      card.setAttribute('aria-label', deps.getTranslator()(item.card.ariaKey));
      card.append(systemCardIcon(item.card.id), dot);
    } else {
      const label = document.createElement('span');
      label.className = 'card-label';
      // Card data is untrusted (it comes from game.json) — textContent, never innerHTML.
      label.textContent = item.game.title;
      card.append(label, dot);
      const url = art.get(artKey(item.game));
      if (url !== undefined && url !== null) {
        card.style.backgroundImage = `url("${url}")`;
        card.classList.add('has-art');
      }
    }
    const key = itemKey(item);
    card.addEventListener('click', () => {
      const position = items.findIndex((candidate) => itemKey(candidate) === key);
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
    const nodes = items.map((item) => {
      const card = buildCard(item);
      cards.set(itemKey(item), card);
      return card;
    });
    strip.replaceChildren(...nodes);
  }

  /**
   * Applies a new order to the row WITHOUT the cards jumping into place: FLIP. `apply` rebuilds the nodes
   * in the new order (the browser lays that out instantly, which is the jump), then every card that was
   * already on screen is shoved back to where it used to be and released in the same frame — the CSS
   * transform transition carries it from there to its new slot.
   *
   * Positions are read as `offsetLeft`, i.e. LAYOUT coordinates relative to the strip. Viewport rects
   * would be wrong here: the strip carries its own sliding transform, and half the time it is mid-flight,
   * so its motion would be folded into the measurement and every card would overshoot by that much.
   */
  function reorderSmoothly(apply: () => void): void {
    const before = new Map<string, number>();
    for (const [key, card] of cards) before.set(key, card.offsetLeft);
    apply();
    const shifted: HTMLElement[] = [];
    for (const [key, card] of cards) {
      const from = before.get(key);
      if (from === undefined) continue; // new to the row: it belongs where it is, and fades in there
      const dx = from - card.offsetLeft;
      if (Math.abs(dx) < 1) continue;
      card.style.transition = 'none';
      card.style.transform = `translateX(${dx}px)`;
      shifted.push(card);
    }
    if (shifted.length === 0) return;
    void strip.offsetWidth; // ONE reflow for the whole row, so every card starts its travel together
    for (const card of shifted) {
      card.style.transition = '';
      card.style.transform = '';
    }
  }

  /** Tells main what is on screen now — a game, or nothing at all on a launcher card. */
  function announceSelection(): void {
    const current = selected();
    if (current === undefined) return;
    if (current.kind === 'game') deps.browseGame(current.game.id);
    else deps.browseNone();
  }

  function setScreen(next: Screen): void {
    if (next === screen) return;
    screen = next;
    app.dataset['screen'] = next;
    // The override belongs to ONE detail screen (see setDetailArt); back on the row the strip speaks for
    // itself again.
    if (next === 'carousel') detailArt = undefined;
    // Coming back, the strip is unusable until the selected card is back at full size (RETURN_LOCK_MS);
    // leaving, nothing is locked — the detail screen has its own focus model.
    lockedUntil = next === 'carousel' ? performance.now() + RETURN_LOCK_MS : 0;
    markReturning(next === 'carousel');
    deps.onScreenChange(next);
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
    // The user is steering now: a seed request still waiting for its list must not yank the strip later.
    pendingFocusId = null;
    const next = clampIndex(index + delta, items.length);
    if (next === index) return 'at-end'; // no move — the caller decides what a stop means, sound included
    const moved = next - index;
    index = next;
    deps.onNavigate(moved);
    applyLayout();
    loadNearbyArt();
    announceSelection();
    return 'moved';
  }

  // The launcher starts on the plain bar screen; the first list promotes it to the carousel (applyLibrary).
  app.dataset['screen'] = screen;

  return {
    focusGame(id: string): void {
      const position = items.findIndex((item) => item.kind === 'game' && item.game.id === id);
      if (position === -1) {
        pendingFocusId = id; // the list carrying it is still in flight — see the field
        return;
      }
      pendingFocusId = null;
      if (position === index) return;
      index = position;
      applyLayout();
      loadNearbyArt();
    },
    focusSystem(): void {
      const position = items.findIndex((item) => item.kind === 'system');
      if (position === -1 || position === index) return;
      pendingFocusId = null;
      index = position;
      applyLayout();
      loadNearbyArt();
    },
    setGames(all: readonly LibraryEntry[]): void {
      // Home shows a shortlist — the rest of the library has a screen of its own now (see
      // MAX_STRIP_GAMES). Everything below still speaks of `list` because that IS the row's list.
      const list = all.slice(0, MAX_STRIP_GAMES);
      // The selection is remembered BY IDENTITY, not by position: the list is re-ordered whenever a card
      // is inserted or a session ends, and a positional cursor would silently land on a different game.
      // A launcher card survives every update by construction — it is in every list this builds.
      // A pending focus request wins over the current selection — it is the newer instruction of the two.
      const currentKey = pendingFocusId !== null ? `g:${pendingFocusId}` : (selected() === undefined ? undefined : itemKey(selected() as CarouselItem));
      items = [...list.map((game): CarouselItem => ({ kind: 'game', game })), ...systemItems];
      // Cleared against the FULL list: once main has sent the game, the request has been answered one
      // way or the other. A game past the cap simply has no card here to put the selection on, and
      // leaving the request pending would re-aim every later update at a card that never comes.
      if (pendingFocusId !== null && all.some((game) => game.id === pendingFocusId)) {
        pendingFocusId = null;
      }
      index = clampIndex(
        currentKey === undefined
          ? 0
          : Math.max(
              0,
              items.findIndex((item) => itemKey(item) === currentKey),
            ),
        items.length,
      );
      // Both together: applyLayout is what resizes the selected card, so measuring between the two would
      // compare against a width the row is about to change.
      reorderSmoothly(() => {
        rebuild();
        applyLayout();
      });
      loadNearbyArt();
    },
    move,
    activate,
    screen: () => screen,
    setScreen,
    selected,
    setUnread(next: boolean): void {
      if (unread === next) return;
      unread = next;
      applyLayout();
    },
    primeArt(game: LibraryEntry, url: string): void {
      art.set(artKey(game), url);
    },
    setDetailArt(url: string | null): void {
      detailArt = url;
      applyLayout();
    },
    setFlipping(next: boolean): void {
      if (flipping === next) return;
      flipping = next;
      // The attribute switches the strip and the cards onto the glide timing (see --flip-step in
      // styles.css): a held direction slides at one even speed instead of restarting an eased morph
      // three times a second.
      if (flipping) app.dataset['flipping'] = 'on';
      else delete app.dataset['flipping'];
      // Released: pick up the covers of wherever the row came to rest.
      if (!flipping) loadNearbyArt();
    },
    playIntro(): void {
      if (screen !== 'carousel') return;
      // Pull the cards back to zero and flush BEFORE arming the fan, rather than trusting them to still
      // be hidden. By the time the boot screen hands over, the strip has been through setGames and
      // setScreen — either of which may already have run (and finished) a return of its own, leaving the
      // row fully faded in. Starting the fan from that state is a no-op: an opacity that never changes
      // has nothing to transition, which is exactly the "the carousel is just there" it was meant to fix.
      // Suppressing the transition for that reset is not optional: the cards carry a DELAYED opacity
      // transition, so a plain `opacity = 0` would animate its way there (350ms later) instead of taking
      // effect now — leaving nothing to fade in from. The reflow makes the 0 the transition's start value.
      for (const card of cards.values()) {
        card.style.transition = 'none';
        card.style.opacity = '0';
      }
      void strip.offsetWidth;
      markReturning(true);
      // Same fan, one difference: the selected card fades in with the rest. On a real hand-back it swaps
      // in opaque because it takes over from a pixel-identical play button — at startup there is no button
      // to take over from, and an opaque card appearing mid-wave is the one thing that breaks it.
      app.dataset['returning'] = 'intro';
      for (const card of cards.values()) {
        card.style.removeProperty('transition');
        card.style.removeProperty('opacity');
      }
    },
    setBusyGame(id: string | null): void {
      if (id === busyId) return;
      busyId = id;
      applyLayout();
    },
  };
}
