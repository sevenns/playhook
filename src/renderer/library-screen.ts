// The Library screen's controller: the sixth surface of the launcher. It shows the WHOLE game list as a
// grid of covers — everything main sent, history included — where the carousel only ever shows a row of
// it, and it is the one place a game can be added from.
//
// Structurally it is the Settings screen's twin (the same veil + column + sidebar, the same six
// primitives for controls.ts to route into) with one difference that shapes everything here: its pane
// holds hundreds of covers rather than a dozen rows. That is why the maths of a step lives in
// library-grid.ts, the artwork behind a bounded cache with a request queue in card-art.ts, and this
// module only paints what the two decide.
import type { LibraryEntry } from '../shared/types';
import type { MessageKey, Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { artKey, type CardArtCache } from './card-art.js';
import { req } from './dom.js';
import { clampIndex } from './index-math.js';
import {
  filterLibrary,
  gridColumns,
  gridStep,
  isNearInGrid,
  ringBox,
  type GridDir,
  type LibraryFilter,
} from './library-grid.js';
import type { NavSurface } from './nav-surface.js';
import { createScroller, pxUnit } from './screen-scroller.js';
import { createSidebar, type SidebarEntry } from './screen-sidebar.js';

/**
 * How long the grid takes to scroll one row on a SINGLE press — the morph's own duration, so the glide
 * and the card's growth are one movement. A held direction overrides it with --flip-step (see step()).
 */
const SINGLE_STEP_MS = 240;
/** Fallback for --flip-step, should the property not be readable yet (controls.ts writes it at startup). */
const FLIP_STEP_FALLBACK_MS = 143;
/** How long a card that left the section fades for before its node goes (mirrors .is-leaving in CSS). */
const LEAVE_MS = 220;
/** How long the staggered arrival of a section runs before the marks come off (mirrors .is-entering). */
const ENTRANCE_MS = 700;
/** The stagger stops counting here: past a dozen cards the wave is a wait, not a wave. */
const ENTRANCE_STEPS = 11;
/** How long the grid waits before drawing the section the column moved onto (see previewTimer). */
const PREVIEW_MS = 120;

export interface LibraryScreenDeps {
  readonly audio: AudioController;
  getTranslator(): Translator;
  /** The covers, bounded and queued — this screen is its only user (see card-art.ts). */
  readonly art: CardArtCache;
  /** The current game list, for the first paint (later ones arrive through setGames). */
  getGames(): readonly LibraryEntry[];
  /** A game was activated — app.ts opens its detail screen and remembers where it came from. */
  onOpenGame(id: string): void;
  /** The "Add game" entry — controls.ts hands over to the Customize screen in add mode. */
  onAddGame(): void;
  /** The screen closed itself (B / Close) — controls.ts restores the bar focus. */
  onClosed(): void;
}

export interface LibraryScreen extends NavSurface {
  /** A fresh visit: the first section, the first game, the top of the grid. */
  open(): void;
  /** Back from the detail screen (or from Add game): the screen returns exactly as it was left. */
  restore(): void;
  /** `silent` is a hand-over to another surface, which sounds and re-focuses for itself. */
  close(silent?: boolean): void;
  /** A new game list from main (a card went in or out) — the grid re-flows, the selection stays put. */
  setGames(games: readonly LibraryEntry[]): void;
  /** The game AppState is busy with, so its dot pulses here as it does on the carousel. */
  setBusyGame(id: string | null): void;
  /** A direction is HELD: artwork loading waits it out, exactly as it does in the carousel. */
  setFlipping(flipping: boolean): void;
  /** The cover this screen already decoded, for the play button's morph (see carousel.primeArt). */
  artFor(id: string): string | null;
}

const nodeKey = (id: string): string => `g:${id}`;

export function createLibraryScreen(deps: LibraryScreenDeps): LibraryScreen {
  const app = req('app');
  const screen = req('library');
  const gridEl = req('library-grid');
  // The grid's focus ring: ONE element that glides from card to card, the strip's twin (see
  // carousel.ts). A child of the grid, so it scrolls with the cards and shares their coordinates.
  const ring = req('library-ring');
  const scrollEl = req('library-scroll');
  const emptyEl = req('library-empty');
  const scroller = createScroller(scrollEl);

  const t = (): Translator => deps.getTranslator();

  let open = false;
  let filter: LibraryFilter = 'all';
  let games: readonly LibraryEntry[] = [];
  let shown: readonly LibraryEntry[] = [];
  let index = 0;
  let cols = 1;
  let busyId: string | null = null;
  let flipping = false;
  // A list arrived while the screen was away. The grid is NOT re-flowed then: it is still on screen,
  // fading out under the detail screen, and cards moving during that fade is what read as a twitch.
  // The next open/restore rebuilds it instead.
  let stale = false;
  // A held direction walks the column faster than the grid can be rebuilt, so the section the column
  // moved onto is drawn ONCE, when the movement stops — the same debounce the Settings pane uses for the
  // same reason. Short enough that a single press still reads as instant.
  let previewTimer = 0;
  let previewFilter: LibraryFilter | null = null;
  /** Pending end of the arrival wave — the marks come off every POOLED node, see playEntrance. */
  let entranceTimer = 0;
  // Every card node ever built, by game id — a POOL, not "what the grid holds right now". A section
  // switch only takes nodes out of the grid: their covers are painted on them, and rebuilding a card on
  // the way back to "All" would show its title again while the artwork was re-fetched (and, on a held
  // direction, not re-fetched at all — loading is paused then). Entries go only when main drops the game.
  const nodes = new Map<string, HTMLElement>();
  // The same nodes by ARTWORK key, so an eviction (which knows only the key) finds what to un-paint.
  const painted = new Map<string, HTMLElement>();

  const sidebar = createSidebar(req('library-nav'), {
    audio: deps.audio,
    onSection: (id, entered) => selectSection(id, entered),
    onAction: (id) => runAction(id),
  });

  /** The glide pace: one morph per press, or exactly one repeat interval — linear — while held. */
  function pace(): { readonly durationMs: number; readonly linear: boolean } {
    if (!flipping) return { durationMs: SINGLE_STEP_MS, linear: false };
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--flip-step');
    const parsed = Number.parseFloat(raw);
    return {
      durationMs: Number.isFinite(parsed) && parsed > 0 ? parsed : FLIP_STEP_FALLBACK_MS,
      linear: true,
    };
  }

  function selectedGame(): LibraryEntry | undefined {
    return shown[index];
  }

  function nodeOf(game: LibraryEntry): HTMLElement | undefined {
    return nodes.get(nodeKey(game.id));
  }

  /** How many columns fit right now. Measured, not assumed: the width follows the screen's aspect ratio. */
  function measureColumns(): void {
    const unit = pxUnit();
    const inner = unit > 0 ? gridEl.clientWidth / unit : 0;
    const next = gridColumns(inner);
    if (next === cols) return;
    cols = next;
    gridEl.style.setProperty('--cols', String(cols));
  }

  function buildCard(game: LibraryEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    const label = document.createElement('span');
    label.className = 'card-label';
    // Card data is untrusted (it comes from game.json) — textContent, never innerHTML.
    label.textContent = game.title;
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    card.append(label, dot);
    card.setAttribute('aria-label', game.title);
    // Two-step, like the carousel's cards: a click on another card selects it, a click on the selected
    // one opens it. The position is resolved at click time — the node outlives the list that made it.
    card.addEventListener('click', () => {
      const at = shown.findIndex((candidate) => candidate.id === game.id);
      if (at === -1) return;
      if (!sidebar.hasFocus() && at === index) {
        activateSelected();
        return;
      }
      sidebar.setFocused(false);
      index = at;
      deps.audio.play('navigate');
      applyLayout();
    });
    return card;
  }

  function paintArt(node: HTMLElement, url: string): void {
    node.style.backgroundImage = `url("${url}")`;
    node.classList.add('has-art');
  }

  function clearArt(node: HTMLElement): void {
    node.style.removeProperty('background-image');
    node.classList.remove('has-art');
  }

  /**
   * Loads the covers of the rows around the selection and drops the requests that left it. Both halves
   * matter: main generates a cover synchronously on first sight, so a grid that asked for everything it
   * ever scrolled past would stall the process that also answers every other call of the launcher.
   */
  function loadWindowArt(): void {
    if (!open || flipping) return;
    const keep = new Set<string>();
    shown.forEach((game, at) => {
      if (!isNearInGrid(at, index, cols)) return;
      const key = artKey(game);
      keep.add(key);
      const node = nodeOf(game);
      if (node === undefined) return;
      painted.set(key, node);
      const cached = deps.art.get(key);
      if (cached !== undefined) {
        if (cached !== null) paintArt(node, cached);
        return;
      }
      void deps.art.load(key, game.id).then((url) => {
        if (url === null) return;
        const target = painted.get(key);
        if (target !== undefined) paintArt(target, url);
      });
    });
    deps.art.dropPending(keep);
  }

  /**
   * Puts the focus ring around `node`, or takes it off screen when there is nothing to wrap — the focus
   * is in the column, or the section is empty.
   *
   * The card is MEASURED rather than derived (see ringBox): `justify-content: center` decides where the
   * track starts. `instant` is for the frames where the ring has no business travelling — a fresh open,
   * a section switch, a restore — since the card it was last on is not on screen any more and gliding
   * from it would send the ring across the whole grid.
   */
  function placeRing(node: HTMLElement | undefined, instant: boolean): void {
    if (node === undefined) {
      ring.classList.add('is-hidden');
      return;
    }
    const box = ringBox(node.offsetLeft, node.offsetTop, pxUnit());
    if (instant) ring.style.transition = 'none';
    ring.classList.remove('is-hidden');
    // Written WITH the unit: a bare number is no <length>, and translate() would drop the declaration
    // whole — the ring would then sit at the grid's corner and never move again.
    ring.style.setProperty('--ring-x', `${box.x}px`);
    ring.style.setProperty('--ring-y', `${box.y}px`);
    ring.style.setProperty('--ring-w', `${box.w}px`);
    ring.style.setProperty('--ring-h', `${box.h}px`);
    if (!instant) return;
    void ring.offsetWidth; // land the new place in this frame, before the transition comes back
    ring.style.removeProperty('transition');
  }

  /** The selection's ring, the dots, and the scroll that keeps the selected card in view. */
  function applyLayout(instant = false): void {
    const active = !sidebar.hasFocus();
    const current = selectedGame();
    shown.forEach((game, at) => {
      const node = nodeOf(game);
      if (node === undefined) return;
      node.classList.toggle('is-selected', active && at === index);
      node.classList.toggle('shows-dot', (game.active && game.unconfigured !== true) || game.id === busyId);
      node.classList.toggle('is-busy', game.id === busyId);
    });
    const selectedNode = active && current !== undefined ? nodeOf(current) : undefined;
    placeRing(selectedNode, instant);
    // Only while the screen is actually up: scrolling a grid that is fading out under the screen above
    // it moves cards nobody asked to move, right in the user's eye line.
    if (open && selectedNode !== undefined) {
      if (instant) scroller.reveal(selectedNode, true);
      else scroller.revealGlide(selectedNode, pace());
    }
    loadWindowArt();
  }

  function applyEmpty(): void {
    const key: MessageKey = filter === 'all' ? 'library.empty' : 'library.emptyPlayable';
    emptyEl.textContent = t()(key);
    emptyEl.setAttribute('aria-hidden', shown.length === 0 ? 'false' : 'true');
  }

  /**
   * Re-flows the grid WITHOUT the cards jumping into place: FLIP, the carousel's trick in two dimensions.
   * The inline transform composes translate WITH the scale, or the selected card would collapse to 1 for
   * the length of the animation — the literal would replace `scale(var(--card-scale))` from the stylesheet.
   */
  function reorderSmoothly(apply: () => void): void {
    const before = new Map<string, { readonly left: number; readonly top: number }>();
    for (const [key, node] of nodes)
      before.set(key, { left: node.offsetLeft, top: node.offsetTop });
    apply();
    const shifted: HTMLElement[] = [];
    for (const [key, node] of nodes) {
      const from = before.get(key);
      if (from === undefined) continue; // new to the grid: it belongs where it is
      const dx = from.left - node.offsetLeft;
      const dy = from.top - node.offsetTop;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      node.style.transition = 'none';
      node.style.transform = `translate(${dx}px, ${dy}px) scale(var(--card-scale, 1))`;
      shifted.push(node);
    }
    if (shifted.length === 0) return;
    void gridEl.offsetWidth; // ONE reflow for the whole grid, so every card starts together
    for (const node of shifted) {
      node.style.transition = '';
      node.style.transform = '';
    }
  }

  /**
   * Takes cards OUT of the grid without letting them vanish: each is frozen at the place it currently
   * occupies, out of the flow (so the ones behind close the gap straight away) and faded by the
   * stylesheet. Switching sections otherwise looked like `display: none` — half the grid blinking out.
   *
   * Measured in FULL before anything is moved. Freezing one card re-flows the grid, so measuring and
   * pinning them one at a time read every card's position after its predecessors had already left —
   * which piled the whole section onto the first card's place and faded it out as one lump.
   */
  function dismissAll(leaving: readonly HTMLElement[]): void {
    const places = leaving.map((node) => ({ left: node.offsetLeft, top: node.offsetTop }));
    leaving.forEach((node, at) => {
      const place = places[at];
      if (place === undefined) return;
      node.style.position = 'absolute';
      node.style.left = `${place.left}px`;
      node.style.top = `${place.top}px`;
      node.classList.remove('is-selected');
      node.classList.remove('is-entering'); // it is leaving; the arrival it was mid-way through is moot
      node.classList.add('is-leaving');
      // Checked again on the way out: a fast switch back puts this very node in the grid again (it lives
      // in the pool), and the timer must not then pull it out from under the section that took it.
      window.setTimeout(() => {
        if (node.classList.contains('is-leaving')) node.remove();
      }, LEAVE_MS);
    });
  }

  /** Builds the nodes of the current section and puts them in order, reusing whatever is still there. */
  function syncNodes(animate: boolean): void {
    shown = filterLibrary(games, filter);
    const fresh: HTMLElement[] = [];
    const wanted = shown.map((game, at) => {
      const key = nodeKey(game.id);
      const existing = nodes.get(key);
      // The stagger is positional, so it is written on every pass — a card that moved forward in the
      // list must arrive earlier than it did last time, not keep its old place in the wave.
      const stagger = String(Math.min(at, ENTRANCE_STEPS));
      if (existing !== undefined) {
        // It may be coming back from a section that dismissed it — undo the freeze before it is re-laid.
        existing.classList.remove('is-leaving');
        existing.style.removeProperty('position');
        existing.style.removeProperty('left');
        existing.style.removeProperty('top');
        existing.style.setProperty('--card-index', stagger);
        const label = existing.querySelector('.card-label');
        if (label !== null && label.textContent !== game.title) label.textContent = game.title;
        existing.setAttribute('aria-label', game.title);
        return existing;
      }
      const node = buildCard(game);
      node.style.setProperty('--card-index', stagger);
      nodes.set(key, node);
      fresh.push(node);
      return node;
    });
    const leaving: HTMLElement[] = [];
    for (const [key, node] of nodes) {
      const game = games.find((candidate) => nodeKey(candidate.id) === key);
      // Gone from main's list entirely: the node has nothing left to show, so it leaves the pool too.
      if (game === undefined) nodes.delete(key);
      if (shown.some((candidate) => nodeKey(candidate.id) === key)) continue;
      if (!node.isConnected) continue; // already out of the grid — another section left it there
      if (animate) leaving.push(node);
      else node.remove();
    }
    if (leaving.length > 0) dismissAll(leaving);
    // In-order sync rather than replaceChildren: re-inserting a node the grid already holds would drop
    // its transition state, which is exactly what the FLIP above is measuring.
    wanted.forEach((node, at) => {
      const current = gridEl.children[at];
      if (current !== node) gridEl.insertBefore(node, current ?? null);
    });
    if (animate && fresh.length > 0) playEntrance(fresh);
    applyEmpty();
  }

  /**
   * Plays the arrival on `cards` and takes the marks off again when it is over.
   *
   * The clean-up walks the POOL, not the grid — and that is the whole point. entrance.ts clears by
   * querying the container, which is right for a list whose rows only ever leave by being destroyed;
   * here a card can step out of the grid and live on in the pool, and a mark left on it that way is
   * permanent. It matters because the mark drives an ANIMATION: while it is there the animation owns
   * `transform`, so the card stops growing on selection and starts snapping instead — some cards
   * animating and some not, with no way to tell which from looking at them.
   */
  function playEntrance(cards: readonly HTMLElement[]): void {
    for (const node of cards) node.classList.remove('is-entering');
    void gridEl.offsetWidth; // re-adding a class the node already carries plays nothing at all
    for (const node of cards) node.classList.add('is-entering');
    if (entranceTimer !== 0) window.clearTimeout(entranceTimer);
    entranceTimer = window.setTimeout(() => {
      entranceTimer = 0;
      for (const node of nodes.values()) node.classList.remove('is-entering');
    }, ENTRANCE_MS);
  }

  /**
   * Puts a whole section on screen (a section switch, a fresh open, a list that arrived while away).
   *
   * Deliberately NOT the FLIP that a live re-flow uses. A section switch also sends the scroll back to
   * the top, and a card sliding to its new place while the whole grid is scrolling under it moves twice
   * at once — which is what made switching sections after scrolling look broken. Here the scroll snaps
   * and the section ARRIVES instead, in the launcher's own staggered wave (see entrance.ts): one
   * movement, and the same one the Settings pane plays when its section changes.
   */
  function renderSection(animate: boolean): void {
    syncNodes(animate);
    stale = false;
    index = clampIndex(index, 0, shown.length);
    measureColumns();
    scroller.to(0, true);
    applyLayout(true);
    if (animate) playEntrance([...nodes.values()].filter((node) => node.isConnected));
    requestAnimationFrame(() => scroller.fades());
  }

  /** Draws whatever section the column last landed on, if the debounce has not done it yet. */
  function flushPreview(): void {
    if (previewTimer !== 0) {
      window.clearTimeout(previewTimer);
      previewTimer = 0;
    }
    const next = previewFilter;
    previewFilter = null;
    if (next === null || next === filter) return;
    filter = next;
    index = 0;
    renderSection(true);
  }

  function selectSection(id: string, entered: boolean): void {
    previewFilter = id === 'playable' ? 'playable' : 'all';
    if (entered) {
      // Stepping INTO a section is a commitment — it must be on screen before the focus lands in it.
      flushPreview();
      enterGrid();
      return;
    }
    if (previewTimer !== 0) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = 0;
      flushPreview();
    }, PREVIEW_MS);
  }

  /** Hands the focus from the column to the grid. An empty section has nothing to hand it to. */
  function enterGrid(): void {
    if (shown.length === 0) {
      deps.audio.playLimit();
      return;
    }
    sidebar.setFocused(false);
    index = clampIndex(index, 0, shown.length);
    applyLayout();
  }

  /** …and back. The column is the only place the screen can be left from, as on the Settings screen. */
  function leaveGrid(): void {
    sidebar.setFocused(true);
    applyLayout();
  }

  function runAction(id: string): void {
    if (id === 'add') {
      deps.audio.play('button');
      deps.onAddGame();
      return;
    }
    close();
  }

  function activateSelected(): void {
    const game = selectedGame();
    if (game === undefined) return;
    deps.audio.play('button');
    deps.onOpenGame(game.id);
  }

  /** One press in the grid: the maths says where it lands, this says what it sounds like. */
  function step(dir: GridDir, repeat: boolean): void {
    const move = gridStep(index, dir, shown.length, cols);
    if (move.result === 'to-sidebar') {
      // A held left hands over too, unlike the boundaries that leave a SCREEN: the column is the wall on
      // this side, so running into it has to end in the column rather than against the first card. It
      // goes no further — left in the column is a dead end.
      deps.audio.play('navigate');
      leaveGrid();
      return;
    }
    if (move.result === 'at-end') {
      if (!repeat) deps.audio.playLimit();
      return;
    }
    index = move.index;
    deps.audio.play('navigate');
    applyLayout();
  }

  function sidebarEntries(): readonly SidebarEntry[] {
    const translate = t();
    return [
      { id: 'all', label: translate('library.all'), kind: 'section' },
      { id: 'playable', label: translate('library.playable'), kind: 'section' },
      { id: 'add', label: translate('launcher.menu.addGame'), kind: 'action' },
      { id: 'close', label: translate('launcher.menu.close'), kind: 'action' },
    ];
  }

  /**
   * Drops the screen's fade for one frame. A hand-over to the detail screen (and the way back) must be a
   * CUT: through a 0.35s fade the carousel underneath is seen re-assembling itself — the strip fanning
   * back in, the title swapping — and that reads as the launcher glitching, not as a screen changing.
   */
  function withoutTransition(swap: () => void): void {
    screen.classList.add('is-instant');
    swap();
    void screen.offsetWidth; // land the swapped state in this frame, before the class comes off
    requestAnimationFrame(() => screen.classList.remove('is-instant'));
  }

  function close(silent = false): void {
    if (!open) return;
    open = false;
    if (previewTimer !== 0) {
      window.clearTimeout(previewTimer);
      previewTimer = 0;
    }
    previewFilter = null;
    const hide = (): void => {
      delete app.dataset['overlay'];
      screen.setAttribute('aria-hidden', 'true');
    };
    // A silent close is a hand-over to another surface (the detail screen, Add game): it sounds and
    // re-focuses for itself, and announcing this one would fight it.
    if (silent) {
      withoutTransition(hide);
      return;
    }
    hide();
    deps.audio.play('back');
    deps.onClosed();
  }

  function show(): void {
    open = true;
    app.dataset['overlay'] = 'library';
    screen.setAttribute('aria-hidden', 'false');
  }

  deps.art.onEvict((key) => {
    const node = painted.get(key);
    painted.delete(key);
    if (node !== undefined) clearArt(node);
  });

  // The column count follows the pane's width, which follows the window — and the pane is the only thing
  // that can tell us it changed (--px is tied to the height, so a resize moves both).
  new ResizeObserver(() => {
    if (!open) return;
    measureColumns();
    // Unconditionally, not only when the column count changed: --px is tied to the HEIGHT, so a resize
    // that keeps the columns still moves every card in real px — and the ring's coordinates are real px,
    // so left alone they would go stale and the ring would sit beside the card instead of around it.
    applyLayout(true);
  }).observe(scrollEl);

  // The wheel drives the SELECTION, not the scrollbar. Left native, the grid would slide out from under
  // a selection that stayed where it was — the one thing this layout must never do.
  scrollEl.addEventListener(
    'wheel',
    (event) => {
      if (!open) return;
      event.preventDefault();
      if (sidebar.hasFocus()) return;
      step(event.deltaY > 0 ? 'down' : 'up', false);
    },
    { passive: false },
  );

  return {
    isOpen: () => open,
    open: () => {
      if (open) return;
      show();
      filter = 'all';
      previewFilter = null;
      index = 0;
      games = deps.getGames();
      sidebar.render(sidebarEntries());
      sidebar.reset();
      sidebar.setFocused(true);
      sidebar.animateIn();
      renderSection(false);
    },
    restore: () => {
      if (open) return;
      // With its own entrance, unlike the hand-over OUT of here (see withoutTransition): coming back is
      // the screen arriving, and it should look like it. What made the fade unusable was the carousel
      // rebuilding itself underneath — and that is hidden for as long as this screen is up (styles.css).
      show();
      // The nodes and the scroll position survived the trip, so the screen comes back exactly as it was
      // left — unless a list arrived while it was away, which is where that update finally lands.
      if (stale) {
        stale = false;
        const previousId = selectedGame()?.id ?? null;
        const previousIndex = index;
        syncNodes(false);
        const restored =
          previousId === null ? -1 : shown.findIndex((game) => game.id === previousId);
        index = restored === -1 ? clampIndex(previousIndex, 0, shown.length) : restored;
        measureColumns();
      }
      applyLayout(true);
    },
    close,
    setGames: (list) => {
      games = list;
      // While the screen is away the grid is left alone entirely — see `stale`. Re-flowing it there is
      // both invisible work and, during the fade out to a detail screen, a visible twitch.
      if (!open) {
        stale = true;
        return;
      }
      const previousId = selectedGame()?.id ?? null;
      const previousIndex = index;
      reorderSmoothly(() => syncNodes(true));
      const restored = previousId === null ? -1 : shown.findIndex((game) => game.id === previousId);
      // Held BY IDENTITY: a card going in or out re-orders the whole list, and a positional cursor would
      // silently land on a different game. When the game itself is gone, its old place is the nearest
      // thing to where the user was looking.
      index = restored === -1 ? clampIndex(previousIndex, 0, shown.length) : restored;
      if (shown.length === 0) sidebar.setFocused(true);
      measureColumns();
      applyLayout();
    },
    setBusyGame: (id) => {
      if (id === busyId) return;
      busyId = id;
      if (open) applyLayout();
    },
    setFlipping: (next) => {
      if (next === flipping) return;
      flipping = next;
      if (!flipping) loadWindowArt();
    },
    artFor: (id) => {
      const game = games.find((candidate) => candidate.id === id);
      if (game === undefined) return null;
      return deps.art.get(artKey(game)) ?? null;
    },
    // The column repeats on a hold, exactly as the Settings one does — it is a list like any other, and
    // holding a direction on it is how you get to the actions at its foot without four presses.
    navUp: (repeat = false) => {
      if (sidebar.hasFocus()) {
        sidebar.move(-1);
        return;
      }
      step('up', repeat);
    },
    navDown: (repeat = false) => {
      if (sidebar.hasFocus()) {
        sidebar.move(1);
        return;
      }
      step('down', repeat);
    },
    navLeft: (repeat = false) => {
      // Left off the column is the edge of the screen, as it is on the Settings screen.
      if (sidebar.hasFocus()) {
        if (!repeat) deps.audio.playLimit();
        return;
      }
      step('left', repeat);
    },
    navRight: (repeat = false) => {
      if (sidebar.hasFocus()) {
        if (sidebar.selected()?.kind === 'section') enterGrid();
        else deps.audio.playLimit(); // the actions at its foot lead nowhere sideways
        return;
      }
      step('right', repeat);
    },
    navActivate: () => {
      if (sidebar.hasFocus()) {
        sidebar.activate();
        return;
      }
      activateSelected();
    },
    navBack: () => {
      // Out of the grid, back to the column; out of the column, off the screen — the Settings rule, and
      // the reason Close sits in the column at all.
      if (!sidebar.hasFocus()) {
        deps.audio.play('back');
        leaveGrid();
        return;
      }
      close();
    },
    relocalize: () => {
      sidebar.render(sidebarEntries());
      applyEmpty();
      for (const game of shown) {
        const node = nodeOf(game);
        if (node !== undefined) node.setAttribute('aria-label', game.title);
      }
    },
  };
}
