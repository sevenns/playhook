// The Customize screen's artwork viewer and its thumbnails: the lightbox a picture opens in at full size
// (the topmost surface of all — a look at a picture, closed by B or the veil), and the strip of
// thumbnails the artwork rows draw. Both read pictures through ONE seam, `locate`: the screen knows
// where a manifest-relative path's bytes are right now (a card, the PC library, a history game's staging
// directory, the SOURCE side of a pending move), this module only knows how to show them.
import type { AudioController } from './audio.js';
import { req } from './dom.js';
import { applyThumbnails, type RenderedGameRow } from './game-settings-view.js';

/** Where a path's bytes are read from right now, and the cache key that names those bytes. */
export interface AssetSource {
  /**
   * Includes the root (or the history id): the same card-relative STRING can name different bytes in the
   * PC library and on a move's target card, and thumbnails must not conflate them — nor may every history
   * game share the '' key and serve each other's covers.
   */
  readonly key: string;
  /** One invoke, answering the preview URL — null when it cannot be read. */
  read(): Promise<string | null>;
}

export interface AssetLightboxDeps {
  readonly audio: Pick<AudioController, 'play'>;
  /** The screen's answer to "where is this path right now" — null when nowhere (no root yet). */
  locate(path: string): AssetSource | null;
}

export interface AssetLightbox {
  isOpen(): boolean;
  /** Opens the artwork at `path` at full size. Nothing but a look — B (or the veil) closes it. */
  show(path: string): Promise<void>;
  /** The lightbox itself, shared by a file already on the card and a variant still only online. */
  open(url: string, caption: string): void;
  close(options?: { readonly silent?: boolean }): void;
  /** Reads the artwork rows' thumbnails (one invoke per path, cached) and drops them into their rows. */
  refreshThumbnails(rows: readonly RenderedGameRow[]): Promise<void>;
  /** Forgets the thumbnails read so far — a screen re-opened after the files moved starts fresh. */
  clearCache(): void;
}

export function createAssetLightbox(deps: AssetLightboxDeps): AssetLightbox {
  const lightboxEl = req('lightbox');
  const lightboxImage = req<HTMLImageElement>('lightbox-image');
  const lightboxCaption = req('lightbox-caption');
  let open = false;
  /**
   * The thumbnails read so far, by path. Stepping back onto a section re-renders its rows, and reading
   * every picture off the disk again for a strip that has not changed is both a round trip per image and
   * a visible re-decode.
   */
  const thumbnails = new Map<string, string | null>();

  async function thumbnailFor(source: AssetSource): Promise<string | null> {
    const cached = thumbnails.get(source.key);
    if (cached !== undefined) return cached;
    const url = await source.read();
    thumbnails.set(source.key, url);
    return url;
  }

  function openLightbox(url: string, caption: string): void {
    deps.audio.play('popup-open');
    lightboxImage.src = url;
    lightboxCaption.textContent = caption;
    open = true;
    lightboxEl.classList.add('is-open');
    lightboxEl.setAttribute('aria-hidden', 'false');
  }

  function close(options?: { readonly silent?: boolean }): void {
    if (!open) return;
    if (options?.silent !== true) deps.audio.play('popup-close');
    open = false;
    lightboxEl.classList.remove('is-open');
    lightboxEl.setAttribute('aria-hidden', 'true');
    lightboxImage.removeAttribute('src');
  }

  lightboxEl.querySelector<HTMLElement>('.lightbox-veil')?.addEventListener('click', () => {
    close();
  });

  return {
    isOpen: () => open,
    show: async (path) => {
      if (path === '') return;
      const source = deps.locate(path);
      if (source === null) return;
      const url = await source.read();
      if (url === null) return; // a preview that could not be read never became a surface — and never sounds
      openLightbox(url, path);
    },
    open: openLightbox,
    close,
    refreshThumbnails: async (rows) => {
      for (const row of rows) {
        const source = row.row;
        if (source.kind === 'list' && source.preview !== undefined) {
          const urls = await Promise.all(
            source.items.map((item) => {
              const at = deps.locate(item);
              return at === null ? Promise.resolve(null) : thumbnailFor(at);
            }),
          );
          applyThumbnails(row, urls, source.preview, source.items);
        } else if (source.kind === 'path' && source.preview !== undefined) {
          const at = source.value === '' ? null : deps.locate(source.value);
          const url = at === null ? null : await thumbnailFor(at);
          applyThumbnails(row, [url], source.preview, [source.value]);
        }
      }
    },
    clearCache: () => {
      thumbnails.clear();
    },
  };
}
