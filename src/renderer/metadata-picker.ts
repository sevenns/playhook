// The artwork gallery of the "Find online" flow — a surface of the Customize screen, alongside the
// on-screen keyboard and the file browser.
//
// It shows what the sources offer for one game and lets the user pick: a cover is one choice, the hero
// backgrounds are up to MAX_HERO_IMAGES of them. Every tile is a data: URL main already downloaded and
// encoded — the renderer has no network of its own and its CSP admits no other image source — and every
// tile is addressed by an opaque variant key, which is all that travels back to main.
//
// Modelled on file-picker.ts (same panel, same two columns, same "A chooses, B leaves, X ticks"
// grammar), with a grid of pictures where that one has a list of names: the question here is which
// picture, and only a picture can answer it.
//
// The left column is what keeps that question answerable. Two wallpaper sites and two stores together
// offer more than anyone will look through, so the sidebar narrows it — by source and by size — and
// carries the actions a MOUSE has no gesture for: A commits a multi-select, and a tile whose click
// already means "tick" has no second gesture to spare for it.
import {
  QUALITY_LABEL,
  QUALITY_ORDER,
  sourceGroupsFor,
  type ArtworkQuality,
  type ArtworkSourceGroup,
} from '../shared/artwork-filter.js';
import {
  MAX_HERO_IMAGES,
  type ArtworkFilter,
  type ArtworkKind,
  type ArtworkPage,
  type ArtworkVariant,
} from '../shared/types';
import type { Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createHoverGuard } from './hover-guard.js';
import { clampIndex } from './index-math.js';
import { createScroller } from './screen-scroller.js';
import type { NavSurface } from './nav-surface.js';

/** What the gallery asks main. A seam, so app.ts owns the window.api wiring (and a test can fake it). */
export interface MetadataPickerApi {
  artwork(
    candidateKey: string,
    kind: ArtworkKind,
    page: number,
    filter: ArtworkFilter,
  ): Promise<
    | { readonly ok: true; readonly value: ArtworkPage }
    | { readonly ok: false; readonly message: string }
  >;
  /** The user left — abort whatever is still downloading for this surface. */
  cancel(): void;
}

export interface MetadataPickerDeps {
  readonly audio: AudioController;
  getTranslator(): Translator;
  readonly api: MetadataPickerApi;
}

export interface MetadataPickerSurface extends NavSurface {
  open(request: {
    readonly candidateKey: string;
    readonly kind: ArtworkKind;
    /** The game's title, shown in the panel header so the user can tell they picked the right one. */
    readonly title: string;
    /** An empty list means the user backed out — the caller changes nothing then. */
    readonly onDone: (variantKeys: readonly string[]) => void;
  }): void;
}

/** Which column holds the focus. The sidebar filters and acts; the grid answers the question. */
type Column = 'side' | 'grid';

/** One focusable row of the sidebar. Headings are drawn but never focused, so they are not here. */
type SideAction =
  | { readonly kind: 'source'; readonly group: ArtworkSourceGroup }
  | { readonly kind: 'quality'; readonly quality: ArtworkQuality }
  | { readonly kind: 'apply' }
  | { readonly kind: 'close' };

export function createMetadataPicker(deps: MetadataPickerDeps): MetadataPickerSurface {
  const root = req('metadata-picker');
  const titleEl = req('metadata-picker-title');
  const statusEl = req('metadata-picker-status');
  const sideEl = req('metadata-picker-side');
  const gridEl = req('metadata-picker-grid');
  const legendEl = req('metadata-picker-legend');

  const t = (): Translator => deps.getTranslator();
  const scroller = createScroller(gridEl);
  const hover = createHoverGuard();

  let open = false;
  let request: {
    readonly candidateKey: string;
    readonly kind: ArtworkKind;
    readonly title: string;
    readonly onDone: (variantKeys: readonly string[]) => void;
  } | null = null;
  /** Bumped on every open/close, so a slow answer from a previous visit cannot paint over this one. */
  let visit = 0;
  /** Bumped on every request, so an answer to a filter the user has already changed is discarded. */
  let attempt = 0;
  let variants: readonly ArtworkVariant[] = [];
  let tiles: HTMLButtonElement[] = [];
  let index = 0;
  let column: Column = 'grid';
  let sideIndex = 0;
  let actions: SideAction[] = [];
  let sideButtons: HTMLButtonElement[] = [];
  /** Ticked variants, in the order they were ticked — that order becomes the hero rotation. */
  let picked: string[] = [];
  /** Which page was last asked for, and whether the sources said another one exists behind it. */
  let page = 0;
  let hasMore = false;
  /** True while a page is in flight — the "load more" tile must not queue a second request. */
  let loading = false;
  /** The sidebar's two answers. They travel with every request and starting over on a change. */
  let sourceKey = 'all';
  let quality: ArtworkQuality = 'any';

  /** How many backgrounds a game may have; a cover is a single choice. */
  function maxPicks(): number {
    return request?.kind === 'hero' ? MAX_HERO_IMAGES : 1;
  }

  function groups(): readonly ArtworkSourceGroup[] {
    return sourceGroupsFor(request?.kind ?? 'hero');
  }

  function filter(): ArtworkFilter {
    const group = groups().find((entry) => entry.key === sourceKey);
    return { sources: group?.providers ?? [], quality };
  }

  /**
   * How many tiles fit on one row, read back from the layout rather than computed: the grid is a CSS
   * `auto-fill`, so the browser has already answered this question and re-deriving it here would be a
   * second answer to keep in step.
   */
  function columns(): number {
    const first = tiles[0];
    if (first === undefined) return 1;
    const top = first.offsetTop;
    const inRow = tiles.filter((tile) => tile.offsetTop === top).length;
    return Math.max(1, inRow);
  }

  function paint(): void {
    tiles = variants.map((variant, position) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'metadata-tile';
      button.dataset['kind'] = variant.kind;
      const image = document.createElement('img');
      image.className = 'metadata-tile-image';
      image.src = variant.thumbDataUrl;
      image.alt = '';
      const caption = document.createElement('span');
      caption.className = 'metadata-tile-caption';
      caption.textContent = captionOf(variant);
      button.append(image, caption);
      button.addEventListener('click', () => {
        hover.arm();
        column = 'grid';
        index = position;
        applyFocus();
        // A mouse has no second button here (the gamepad ticks with X), so in a multi-select gallery a
        // click TICKS and the sidebar's Apply commits. A single-choice gallery keeps the one-click
        // gesture: there is nothing to accumulate, so asking for a second press would be ceremony.
        if (maxPicks() > 1) togglePick(variant);
        else choose(variant);
      });
      return button;
    });
    if (hasMore) tiles.push(moreTile());
    gridEl.replaceChildren(...tiles);
    if (tiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'picker-empty';
      empty.textContent = t()('metadata.noArtwork');
      gridEl.replaceChildren(empty);
    }
    applyPicked();
    applyFocus(true);
  }

  /**
   * The last tile of the grid, and the only one that is not a picture: the sources hold far more than
   * fits on a screen, and most of a wallpaper site's answer is not what this user wants. It sits WHERE
   * the next thumbnail would be, so the gesture that reaches it is the one the user is already making —
   * and it is absent altogether when there is nothing left to fetch.
   */
  function moreTile(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'metadata-tile metadata-tile-more';
    button.dataset['kind'] = request?.kind ?? 'hero';
    const box = document.createElement('span');
    box.className = 'metadata-tile-more-box';
    box.textContent = '+';
    const caption = document.createElement('span');
    caption.className = 'metadata-tile-caption';
    caption.textContent = t()('metadata.loadMore');
    button.append(box, caption);
    button.addEventListener('click', () => {
      hover.arm();
      column = 'grid';
      index = tiles.length - 1;
      applyFocus();
      loadMore();
    });
    return button;
  }

  /** Whether the focus is on the "load more" tile — the one position `variants` has no entry for. */
  function isOnMore(): boolean {
    return hasMore && index === variants.length;
  }

  function loadMore(): void {
    if (loading) {
      deps.audio.playLimit();
      return;
    }
    deps.audio.play('button');
    void load(page + 1);
  }

  /** The sidebar: the two filters, then the actions a mouse cannot otherwise reach. */
  function paintSide(): void {
    actions = [];
    sideButtons = [];
    const nodes: HTMLElement[] = [heading(t()('metadata.filterSource'))];
    for (const group of groups()) {
      nodes.push(sideButton({ kind: 'source', group }, group.label ?? t()('metadata.filterAny')));
    }
    // Backgrounds only. A cover is a portrait 600x900 whatever the source, so a floor named after a
    // screen would empty that gallery rather than narrow it.
    if (request?.kind === 'hero') {
      nodes.push(heading(t()('metadata.filterSize')));
      for (const named of QUALITY_ORDER) {
        nodes.push(
          sideButton(
            { kind: 'quality', quality: named },
            QUALITY_LABEL[named] ?? t()('metadata.filterAny'),
          ),
        );
      }
    }
    const divider = document.createElement('div');
    divider.className = 'picker-divider';
    nodes.push(divider);
    if (maxPicks() > 1) nodes.push(sideButton({ kind: 'apply' }, ''));
    nodes.push(sideButton({ kind: 'close' }, t()('metadata.actionClose')));
    sideEl.replaceChildren(...nodes);
    sideIndex = Math.min(sideIndex, Math.max(0, sideButtons.length - 1));
    paintApply();
  }

  function heading(text: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'metadata-side-heading';
    node.textContent = text;
    return node;
  }

  function sideButton(action: SideAction, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      action.kind === 'source' || action.kind === 'quality'
        ? 'picker-item'
        : 'picker-item is-action';
    button.textContent = label;
    const position = actions.length;
    actions.push(action);
    sideButtons.push(button);
    button.addEventListener('click', () => {
      hover.arm();
      column = 'side';
      sideIndex = position;
      applyFocus();
      runAction(action);
    });
    return button;
  }

  /** What a sidebar row does. Changing a filter starts the gallery over; the ticks survive it. */
  function runAction(action: SideAction): void {
    if (action.kind === 'source') {
      if (sourceKey === action.group.key) {
        deps.audio.playLimit();
        return;
      }
      sourceKey = action.group.key;
      deps.audio.play('button');
      refilter();
      return;
    }
    if (action.kind === 'quality') {
      if (quality === action.quality) {
        deps.audio.playLimit();
        return;
      }
      quality = action.quality;
      deps.audio.play('button');
      refilter();
      return;
    }
    if (action.kind === 'apply') {
      if (picked.length === 0) {
        deps.audio.playLimit();
        return;
      }
      deps.audio.play('button');
      finish(picked.slice(0, maxPicks()));
      return;
    }
    deps.audio.play('popup-close');
    finish([]);
  }

  /**
   * A filter changed: whatever is still downloading belongs to the answer the user just replaced, so it
   * is cancelled and the gallery starts at page 0. The ticks are kept — picking one background per
   * source is exactly what the filter is for, and main resolves a key long after its tile is gone.
   */
  function refilter(): void {
    deps.api.cancel();
    loading = false;
    index = 0;
    void load(0);
    paintFilters();
  }

  /** Marks the two rows that are switched on. */
  function paintFilters(): void {
    actions.forEach((action, position) => {
      const button = sideButtons[position];
      if (button === undefined) return;
      const on =
        (action.kind === 'source' && action.group.key === sourceKey) ||
        (action.kind === 'quality' && action.quality === quality);
      button.classList.toggle('is-picked', on);
    });
  }

  /**
   * What each source is called on a tile. Proper names, so they are not translated — and spelled out per
   * source rather than "SteamGridDB or else Steam", which is how every GOG and wallpaper picture came to
   * be labelled Steam.
   */
  const PROVIDER_LABEL: Readonly<Record<ArtworkVariant['provider'], string>> = {
    steam: 'Steam',
    steamgriddb: 'SteamGridDB',
    wallhaven: 'Wallhaven',
    wallpapercave: 'Wallpaper Cave',
    gog: 'GOG',
    khinsider: 'Khinsider',
  };

  /** The source and, when it says so, the size — the two things that tell two similar tiles apart. */
  function captionOf(variant: ArtworkVariant): string {
    const source = PROVIDER_LABEL[variant.provider];
    if (variant.width === undefined || variant.height === undefined) return source;
    return `${source} · ${variant.width}x${variant.height}`;
  }

  function applyPicked(): void {
    tiles.forEach((tile, position) => {
      const key = variants[position]?.key;
      tile.classList.toggle('is-picked', key !== undefined && picked.includes(key));
    });
    paintApply();
  }

  /** The Apply row: present only where there is something to accumulate, inert until there is. */
  function paintApply(): void {
    const at = actions.findIndex((action) => action.kind === 'apply');
    const button = at === -1 ? undefined : sideButtons[at];
    if (button === undefined) return;
    button.textContent = t()('metadata.applySelected', { count: String(picked.length) });
    button.classList.toggle('is-disabled', picked.length === 0);
  }

  function applyFocus(instant = false): void {
    tiles.forEach((tile, position) =>
      tile.classList.toggle('is-focused', column === 'grid' && position === index),
    );
    sideButtons.forEach((button, position) =>
      button.classList.toggle('is-focused', column === 'side' && position === sideIndex),
    );
    if (column !== 'grid') return;
    const focused = tiles[index];
    if (focused !== undefined) scroller.reveal(focused, instant);
  }

  function move(delta: number): void {
    hover.arm();
    const length = column === 'side' ? sideButtons.length : tiles.length;
    const at = column === 'side' ? sideIndex : index;
    if (length === 0) {
      deps.audio.playLimit();
      return;
    }
    const next = clampIndex(at, delta, length);
    if (next === at) {
      deps.audio.playLimit();
      return;
    }
    if (column === 'side') sideIndex = next;
    else index = next;
    deps.audio.play('navigate');
    applyFocus();
  }

  /** A ticked variant becomes unticked; a fresh one is added unless the slot count is already full. */
  function togglePick(variant: ArtworkVariant): void {
    if (picked.includes(variant.key)) {
      picked = picked.filter((key) => key !== variant.key);
      deps.audio.play('navigate');
      applyPicked();
      return;
    }
    if (picked.length >= maxPicks()) {
      deps.audio.playLimit();
      return;
    }
    picked.push(variant.key);
    deps.audio.play('navigate');
    applyPicked();
  }

  /** A on a tile: the single-choice case picks it outright, the multi one ticks it and finishes. */
  function choose(variant: ArtworkVariant): void {
    deps.audio.play('button');
    const chosen = picked.includes(variant.key) ? picked : [...picked, variant.key];
    finish(chosen.slice(0, maxPicks()));
  }

  function finish(variantKeys: readonly string[]): void {
    const done = request?.onDone;
    hide();
    done?.(variantKeys);
  }

  function hide(): void {
    if (!open) return;
    open = false;
    visit += 1;
    request = null;
    variants = [];
    picked = [];
    tiles = [];
    actions = [];
    sideButtons = [];
    page = 0;
    hasMore = false;
    loading = false;
    gridEl.replaceChildren();
    sideEl.replaceChildren();
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    deps.api.cancel();
  }

  /**
   * One page into the grid. Page 0 replaces what is on screen; a later page is APPENDED, keeps the ticks
   * the user has already made, and moves the focus to the first picture it brought — that is what they
   * pressed for. A failed later page leaves the gallery standing and says so in the status line.
   */
  async function load(nextPage: number): Promise<void> {
    const at = request;
    if (at === null || loading) return;
    loading = true;
    attempt += 1;
    const token = attempt;
    const visited = visit;
    const shownBefore = variants.length;
    statusEl.textContent = t()('metadata.searching');
    const result = await deps.api.artwork(at.candidateKey, at.kind, nextPage, filter());
    // Closed, reopened, or asked again under another filter while main was fetching.
    if (visited !== visit || token !== attempt) return;
    loading = false;
    if (!result.ok) {
      statusEl.textContent = result.message;
      if (nextPage > 0) return;
      variants = [];
      hasMore = false;
      paint();
      return;
    }
    page = nextPage;
    hasMore = result.value.hasMore;
    variants = nextPage === 0 ? result.value.variants : [...variants, ...result.value.variants];
    statusEl.textContent = variants.length === 0 ? t()('metadata.noArtwork') : '';
    // Nothing came back — a filter can be narrow enough to empty the gallery, and the way out of that is
    // the sidebar, so the focus goes there rather than onto a grid with nothing in it.
    if (variants.length === 0 && !hasMore) column = 'side';
    paint();
    if (nextPage === 0) return;
    index = Math.min(shownBefore, Math.max(0, tiles.length - 1));
    applyFocus();
  }

  gridEl.addEventListener(
    'mousemove',
    (event) => {
      if (!open) return;
      if (document.documentElement.classList.contains('mouse-asleep')) return;
      if (!hover.awake(event.clientX, event.clientY)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const tile = target.closest<HTMLButtonElement>('.metadata-tile');
      if (tile === null) return;
      const position = tiles.indexOf(tile);
      if (position === -1 || (position === index && column === 'grid')) return;
      column = 'grid';
      index = position;
      applyFocus();
    },
    { passive: true },
  );

  sideEl.addEventListener(
    'mousemove',
    (event) => {
      if (!open) return;
      if (document.documentElement.classList.contains('mouse-asleep')) return;
      if (!hover.awake(event.clientX, event.clientY)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('.picker-item');
      if (button === null) return;
      const position = sideButtons.indexOf(button);
      if (position === -1 || (position === sideIndex && column === 'side')) return;
      column = 'side';
      sideIndex = position;
      applyFocus();
    },
    { passive: true },
  );

  root.querySelector<HTMLElement>('.picker-veil')?.addEventListener('click', () => {
    deps.audio.play('popup-close');
    finish([]);
  });

  window.addEventListener('mousemove', (event) => hover.track(event.clientX, event.clientY), {
    passive: true,
  });

  return {
    isOpen: () => open,
    open: (next) => {
      request = next;
      open = true;
      visit += 1;
      variants = [];
      picked = [];
      index = 0;
      column = 'grid';
      sideIndex = 0;
      page = 0;
      hasMore = false;
      loading = false;
      sourceKey = 'all';
      quality = 'any';
      deps.audio.play('popup-open');
      titleEl.textContent = next.title;
      legendEl.textContent = t()(
        next.kind === 'hero' ? 'metadata.pickerLegendMulti' : 'metadata.pickerLegend',
      );
      paintSide();
      paintFilters();
      gridEl.replaceChildren();
      root.classList.add('is-open');
      root.setAttribute('aria-hidden', 'false');
      scroller.to(0, true);
      hover.arm();
      void load(0);
    },
    navUp: () => move(column === 'side' ? -1 : -columns()),
    navDown: () => move(column === 'side' ? 1 : columns()),
    /**
     * Left walks the row and then steps into the sidebar — but a HELD left stops at the wall, the same
     * rule the library grid follows: crossing into another surface is a press of its own, not something
     * a hold should carry the focus through.
     */
    navLeft: (repeat) => {
      hover.arm();
      if (column === 'side') {
        deps.audio.playLimit();
        return;
      }
      if (tiles.length > 0 && index % Math.max(1, columns()) !== 0) {
        move(-1);
        return;
      }
      if (repeat === true) return;
      column = 'side';
      deps.audio.play('navigate');
      applyFocus();
    },
    navRight: () => {
      hover.arm();
      if (column !== 'side') {
        move(1);
        return;
      }
      if (tiles.length === 0) {
        deps.audio.playLimit(); // nothing to walk into — the gallery came back empty
        return;
      }
      column = 'grid';
      deps.audio.play('navigate');
      applyFocus();
    },
    navActivate: () => {
      hover.arm();
      if (column === 'side') {
        const action = actions[sideIndex];
        if (action === undefined) {
          deps.audio.playLimit();
          return;
        }
        runAction(action);
        return;
      }
      if (isOnMore()) {
        loadMore();
        return;
      }
      const variant = variants[index];
      if (variant === undefined) {
        deps.audio.playLimit();
        return;
      }
      choose(variant);
    },
    navBack: () => {
      deps.audio.play('popup-close');
      finish([]);
    },
    /** X ticks a background, the one gesture a single-choice gallery has no use for. */
    navSecondary: () => {
      const variant = column === 'grid' ? variants[index] : undefined;
      if (variant === undefined || maxPicks() === 1) {
        deps.audio.playLimit();
        return;
      }
      togglePick(variant);
    },
    relocalize: () => {
      if (!open) return;
      legendEl.textContent = t()(
        request?.kind === 'hero' ? 'metadata.pickerLegendMulti' : 'metadata.pickerLegend',
      );
      if (variants.length === 0 && statusEl.textContent !== '') {
        statusEl.textContent = t()('metadata.noArtwork');
      }
      paintSide();
      paintFilters();
      applyFocus(true);
      const more = tiles[variants.length];
      if (more !== undefined && more.classList.contains('metadata-tile-more')) {
        const caption = more.querySelector('.metadata-tile-caption');
        if (caption !== null) caption.textContent = t()('metadata.loadMore');
      }
    },
  };
}
