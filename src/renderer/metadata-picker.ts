// The artwork gallery of the "Find online" flow — a surface of the Customize screen, alongside the
// on-screen keyboard and the file browser.
//
// It shows what the sources offer for one game and lets the user pick: a cover is one choice, the hero
// backgrounds are up to MAX_HERO_IMAGES of them. Every tile is a data: URL main already downloaded and
// encoded — the renderer has no network of its own and its CSP admits no other image source — and every
// tile is addressed by an opaque variant key, which is all that travels back to main.
//
// Modelled on file-picker.ts (same panel, same "A chooses, B leaves, X ticks" grammar), with a grid of
// pictures where that one has a list of names: the question here is which picture, and only a picture
// can answer it.
import { MAX_HERO_IMAGES, type ArtworkKind, type ArtworkVariant } from '../shared/types';
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
  ): Promise<
    | { readonly ok: true; readonly value: readonly ArtworkVariant[] }
    | { readonly ok: false; readonly message: string }
  >;
  /** The user left — abort whatever is still downloading for this surface. */
  cancel(): void;
}

export interface MetadataPickerDeps {
  readonly audio: AudioController;
  getTranslator(): Translator;
  readonly api: MetadataPickerApi;
  /** Shows one variant at full size in the screen's lightbox (which sits above this surface). */
  onPreview(variantKey: string): void;
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

export function createMetadataPicker(deps: MetadataPickerDeps): MetadataPickerSurface {
  const root = req('metadata-picker');
  const titleEl = req('metadata-picker-title');
  const statusEl = req('metadata-picker-status');
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
  let variants: readonly ArtworkVariant[] = [];
  let tiles: HTMLButtonElement[] = [];
  let index = 0;
  /** Ticked variants, in the order they were ticked — that order becomes the hero rotation. */
  let picked: string[] = [];

  /** How many backgrounds a game may have; a cover is a single choice. */
  function maxPicks(): number {
    return request?.kind === 'hero' ? MAX_HERO_IMAGES : 1;
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
        index = position;
        applyFocus();
        choose(variant);
      });
      return button;
    });
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
   * What each source is called on a tile. Proper names, so they are not translated — and spelled out per
   * source rather than "SteamGridDB or else Steam", which is how every GOG and wallpaper picture came to
   * be labelled Steam.
   */
  const PROVIDER_LABEL: Readonly<Record<ArtworkVariant['provider'], string>> = {
    steam: 'Steam',
    steamgriddb: 'SteamGridDB',
    wallhaven: 'Wallhaven',
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
  }

  function applyFocus(instant = false): void {
    tiles.forEach((tile, position) => tile.classList.toggle('is-focused', position === index));
    const focused = tiles[index];
    if (focused !== undefined) scroller.reveal(focused, instant);
  }

  function move(delta: number): void {
    hover.arm();
    if (tiles.length === 0) {
      deps.audio.playLimit();
      return;
    }
    const next = clampIndex(index, delta, tiles.length);
    if (next === index) {
      deps.audio.playLimit();
      return;
    }
    index = next;
    deps.audio.play('navigate');
    applyFocus();
  }

  /** A ticked variant becomes untucked; a fresh one is added unless the slot count is already full. */
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
    gridEl.replaceChildren();
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    deps.api.cancel();
  }

  async function load(): Promise<void> {
    const at = request;
    if (at === null) return;
    const token = visit;
    statusEl.textContent = t()('metadata.searching');
    const result = await deps.api.artwork(at.candidateKey, at.kind);
    if (token !== visit) return; // the surface was closed (or reopened) while main was fetching
    if (!result.ok) {
      variants = [];
      statusEl.textContent = result.message;
      paint();
      return;
    }
    variants = result.value;
    statusEl.textContent = variants.length === 0 ? t()('metadata.noArtwork') : '';
    paint();
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
      if (position === -1 || position === index) return;
      index = position;
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
      deps.audio.play('popup-open');
      titleEl.textContent = next.title;
      legendEl.textContent = t()(
        next.kind === 'hero' ? 'metadata.pickerLegendMulti' : 'metadata.pickerLegend',
      );
      gridEl.replaceChildren();
      root.classList.add('is-open');
      root.setAttribute('aria-hidden', 'false');
      scroller.to(0, true);
      hover.arm();
      void load();
    },
    navUp: () => move(-columns()),
    navDown: () => move(columns()),
    navLeft: () => move(-1),
    navRight: () => move(1),
    navActivate: () => {
      hover.arm();
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
      const variant = variants[index];
      if (variant === undefined || maxPicks() === 1) {
        deps.audio.playLimit();
        return;
      }
      togglePick(variant);
    },
    /** Y opens the focused variant at full size — a thumbnail cannot answer "is this the right one?". */
    navTertiary: () => {
      const variant = variants[index];
      if (variant === undefined) {
        deps.audio.playLimit();
        return;
      }
      deps.onPreview(variant.key);
    },
    relocalize: () => {
      if (!open) return;
      legendEl.textContent = t()(
        request?.kind === 'hero' ? 'metadata.pickerLegendMulti' : 'metadata.pickerLegend',
      );
      if (variants.length === 0 && statusEl.textContent !== '') {
        statusEl.textContent = t()('metadata.noArtwork');
      }
    },
  };
}
