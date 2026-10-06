// The "Find online" surface's stateless pieces: the nodes and captions that depend on nothing but their
// arguments. The screen itself (online-picker.ts) owns the state and the wiring; what is here can be
// read, and tested, without either.
import type { ArtworkVariant, MusicAlbum } from '../shared/types.js';
import type { Translator } from '../shared/i18n/index.js';

export function albumLabel(album: MusicAlbum): string {
  return album.trackCount === undefined ? album.title : `${album.title} (${album.trackCount})`;
}

export function heading(text: string): HTMLElement {
  const node = document.createElement('div');
  node.className = 'metadata-side-heading';
  node.textContent = text;
  return node;
}

export function hint(text: string): HTMLElement {
  const node = document.createElement('div');
  node.className = 'picker-empty';
  node.textContent = text;
  return node;
}

/** The wait a section shows while its first answer is out: a spinner and one word. */
export function busyNote(t: Translator): HTMLElement {
  const node = document.createElement('div');
  node.className = 'music-busy';
  const spin = document.createElement('span');
  spin.className = 'metadata-tile-spinner';
  const label = document.createElement('span');
  label.textContent = t('metadata.searching');
  node.append(spin, label);
  return node;
}

/** `4.4 MB` — what the source claimed, so a long download is not a surprise. */
export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Proper names, so they are not translated — one per source, never "this or else Steam". */
export const PROVIDER_LABEL: Readonly<Record<ArtworkVariant['provider'], string>> = {
  steam: 'Steam',
  steamgriddb: 'SteamGridDB',
  wallhaven: 'Wallhaven',
  wallpapercave: 'Wallpaper Cave',
  gog: 'GOG',
  khinsider: 'Khinsider',
};

export function captionOf(variant: ArtworkVariant): string {
  const source = PROVIDER_LABEL[variant.provider];
  if (variant.width === undefined || variant.height === undefined) return source;
  return `${source} · ${variant.width}x${variant.height}`;
}
