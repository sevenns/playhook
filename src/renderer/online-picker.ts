// "Find online" — one full-screen surface for everything the external sources offer: which game this
// is, its cover, its backgrounds and its soundtrack.
//
// It replaces a stack. The flow used to be a query, then a menu of candidates, then a menu of
// categories, and only then a surface per category (the artwork gallery, and later the soundtrack one).
// Every one of those levels asked a question and then hid the answer behind itself, so choosing a cover
// and then a background meant climbing back out and in again.
//
// The two columns say it without nesting: the LEFT one holds the game, the section, the filters that
// section needs and the actions it can take, and the RIGHT one holds whatever that section is about —
// candidates, pictures, or tracks. Switching sections keeps the game; switching games keeps the screen.
//
// Two rules the sections share, because they are what a picker is for:
//
//  • a tile or a row only ever TICKS. Committing is an action in the sidebar, so one press can never
//    mean both "this one" and "and I am done";
//  • applying does not close the screen. A game usually wants a cover AND backgrounds AND music, and
//    each section applies on its own (the screen behind this one holds the form the paths land in).
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
  type GameCandidate,
  type MetadataResult,
  type MusicAlbum,
  type MusicTrack,
} from '../shared/types';
import type { Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createHoverGuard } from './hover-guard.js';
import { clampIndex } from './index-math.js';
import { createScroller } from './screen-scroller.js';
import type { NavSurface } from './nav-surface.js';

/** Which question the right column is answering right now. */
export type OnlineSection = 'candidates' | 'grid' | 'hero' | 'music';

/** How a set of backgrounds meets the ones the game already has. */
export type HeroApplyMode = 'append' | 'replace';

/** What the surface asks main. A seam, so app.ts owns the window.api wiring (and a test can fake it). */
export interface OnlinePickerApi {
  searchGames(query: string): Promise<MetadataResult<readonly GameCandidate[]>>;
  steamCandidate(appId: number): Promise<MetadataResult<GameCandidate>>;
  artwork(
    candidateKey: string,
    kind: ArtworkKind,
    page: number,
    filter: ArtworkFilter,
  ): Promise<MetadataResult<ArtworkPage>>;
  albums(query: string): Promise<MetadataResult<readonly MusicAlbum[]>>;
  tracks(albumKey: string): Promise<MetadataResult<readonly MusicTrack[]>>;
  /** One track as an audio data: URL — a full download, which is why Listen shows a status line. */
  preview(trackKey: string): Promise<MetadataResult<string>>;
  /** The user left — abort whatever is still downloading for this surface. */
  cancel(): void;
}

/** What applying answered with: the screen owns the form and the files, so it reports back in words. */
export interface ApplyOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export interface OnlinePickerDeps {
  readonly audio: AudioController;
  getTranslator(): Translator;
  readonly api: OnlinePickerApi;
  /** Opens the on-screen keyboard for a new query — the screen owns that surface. */
  editQuery(initial: string, onDone: (query: string) => void): void;
  applyArtwork(
    kind: ArtworkKind,
    variantKeys: readonly string[],
    mode: HeroApplyMode,
  ): Promise<ApplyOutcome>;
  applyTrack(trackKey: string): Promise<ApplyOutcome>;
  /** Writes the candidate's name into the form's Title field. */
  applyTitle(title: string): void;
  /** The user settled on a game — the screen fetches its description, genres and dates from here. */
  onCandidate(candidate: GameCandidate): void;
  /** How many backgrounds the form already holds, which is what makes "add or replace" a question. */
  heroCount(): number;
}

export interface OnlinePickerSurface extends NavSurface {
  /** Closes without applying anything — for the cascade when the whole screen goes. */
  close(): void;
  open(request: {
    /** The title to search for; empty opens the keyboard instead. */
    readonly query: string;
    /** A Steam appid the manifest already names — the one thing a search exists to find. */
    readonly appId?: number;
  }): void;
}

/** Which column holds the focus. */
type Column = 'side' | 'content';

/** One focusable row of the sidebar. Headings are drawn but never focused, so they are not here. */
type SideAction =
  | { readonly kind: 'game' }
  | { readonly kind: 'search' }
  | { readonly kind: 'title' }
  | { readonly kind: 'section'; readonly section: OnlineSection }
  | { readonly kind: 'source'; readonly group: ArtworkSourceGroup }
  | { readonly kind: 'quality'; readonly quality: ArtworkQuality }
  | { readonly kind: 'mode'; readonly mode: HeroApplyMode }
  | { readonly kind: 'album'; readonly album: MusicAlbum }
  | { readonly kind: 'listen' }
  | { readonly kind: 'apply' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'close' };

export function createOnlinePicker(deps: OnlinePickerDeps): OnlinePickerSurface {
  const root = req('online-picker');
  const titleEl = req('online-picker-title');
  const statusEl = req('online-picker-status');
  const sideEl = req('online-picker-side');
  const contentEl = req('online-picker-content');

  const t = (): Translator => deps.getTranslator();
  const scroller = createScroller(contentEl);
  const sideScroller = createScroller(sideEl);
  const hover = createHoverGuard();

  let open = false;
  /** Bumped on every open/close, so a slow answer from a previous visit cannot paint over this one. */
  let visit = 0;
  /** Bumped on every request for the right column, so an answer the user moved past is discarded. */
  let attempt = 0;
  /** The same for auditions, kept apart: starting one must not cancel a list still arriving. */
  let listenAttempt = 0;

  let query = '';
  let candidates: readonly GameCandidate[] = [];
  let candidate: GameCandidate | null = null;
  let section: OnlineSection = 'candidates';

  let variants: readonly ArtworkVariant[] = [];
  let picked: string[] = [];
  let page = 0;
  let hasMore = false;
  let sourceKey = 'all';
  let quality: ArtworkQuality = 'any';
  let heroMode: HeroApplyMode = 'append';

  let albums: readonly MusicAlbum[] = [];
  let albumKey: string | null = null;
  let tracks: readonly MusicTrack[] = [];
  let pickedTrack: string | null = null;
  let listening = false;

  let cells: HTMLButtonElement[] = [];
  let index = 0;
  let column: Column = 'side';
  let sideIndex = 0;
  let actions: SideAction[] = [];
  let sideButtons: HTMLButtonElement[] = [];
  let loading = false;

  function maxPicks(): number {
    return section === 'hero' ? MAX_HERO_IMAGES : 1;
  }

  function artworkKind(): ArtworkKind | null {
    return section === 'grid' || section === 'hero' ? section : null;
  }

  function groups(): readonly ArtworkSourceGroup[] {
    return sourceGroupsFor(artworkKind() ?? 'hero');
  }

  function filter(): ArtworkFilter {
    const group = groups().find((entry) => entry.key === sourceKey);
    return { sources: group?.providers ?? [], quality };
  }

  // ── The sidebar ───────────────────────────────────────────────────────────

  function paintSide(): void {
    actions = [];
    sideButtons = [];
    const nodes: HTMLElement[] = [];
    nodes.push(heading(t()('metadata.game')));
    nodes.push(sideButton({ kind: 'game' }, candidate?.title ?? t()('metadata.noCandidate')));
    nodes.push(sideButton({ kind: 'search' }, t()('metadata.searchAgain')));
    if (candidate !== null) {
      nodes.push(sideButton({ kind: 'title' }, t()('metadata.applyTitle')));
      nodes.push(heading(t()('metadata.sections')));
      nodes.push(sideButton({ kind: 'section', section: 'grid' }, t()('metadata.cover')));
      nodes.push(sideButton({ kind: 'section', section: 'hero' }, t()('metadata.backgrounds')));
      nodes.push(sideButton({ kind: 'section', section: 'music' }, t()('metadata.music')));
    }
    nodes.push(...sectionRows());
    const divider = document.createElement('div');
    divider.className = 'picker-divider';
    nodes.push(divider);
    nodes.push(...actionRows());
    nodes.push(sideButton({ kind: 'close' }, t()('metadata.actionClose')));
    sideEl.replaceChildren(...nodes);
    sideIndex = Math.min(sideIndex, Math.max(0, sideButtons.length - 1));
    paintSideState();
  }

  /** The rows that belong to the open section: the filters for pictures, the albums for music. */
  function sectionRows(): readonly HTMLElement[] {
    const kind = artworkKind();
    if (kind !== null) {
      const nodes: HTMLElement[] = [heading(t()('metadata.filterSource'))];
      for (const group of groups()) {
        nodes.push(sideButton({ kind: 'source', group }, group.label ?? t()('metadata.filterAny')));
      }
      // Backgrounds only: a cover is a portrait 600x900 whatever the source, so a floor named after a
      // screen would empty that gallery rather than narrow it.
      if (kind === 'hero') {
        nodes.push(heading(t()('metadata.filterSize')));
        for (const named of QUALITY_ORDER) {
          nodes.push(
            sideButton(
              { kind: 'quality', quality: named },
              QUALITY_LABEL[named] ?? t()('metadata.filterAny'),
            ),
          );
        }
        // Only when the game HAS backgrounds: with none, "add" and "replace" mean the same thing, and a
        // choice between two identical outcomes is a question nobody should be asked.
        if (deps.heroCount() > 0) {
          nodes.push(heading(t()('metadata.applyMode')));
          nodes.push(sideButton({ kind: 'mode', mode: 'append' }, t()('metadata.heroAppend')));
          nodes.push(sideButton({ kind: 'mode', mode: 'replace' }, t()('metadata.heroReplace')));
        }
      }
      return nodes;
    }
    if (section !== 'music') return [];
    const nodes: HTMLElement[] = [heading(t()('metadata.albums'))];
    for (const album of albums) {
      nodes.push(sideButton({ kind: 'album', album }, albumLabel(album)));
    }
    if (albums.length === 0 && !loading) nodes.push(note(t()('metadata.noAlbums')));
    return nodes;
  }

  /** What the open section can commit. */
  function actionRows(): readonly HTMLElement[] {
    if (section === 'music') {
      return [sideButton({ kind: 'listen' }, ''), sideButton({ kind: 'apply' }, '')];
    }
    if (artworkKind() === null) return [];
    return [sideButton({ kind: 'apply' }, ''), sideButton({ kind: 'clear' }, '')];
  }

  function albumLabel(album: MusicAlbum): string {
    return album.trackCount === undefined ? album.title : `${album.title} (${album.trackCount})`;
  }

  function heading(text: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'metadata-side-heading';
    node.textContent = text;
    return node;
  }

  function note(text: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'picker-empty';
    node.textContent = text;
    return node;
  }

  function sideButton(action: SideAction, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    const plain = action.kind === 'source' || action.kind === 'quality' || action.kind === 'album';
    button.className = plain ? 'picker-item' : 'picker-item is-action';
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

  /** Which rows are switched on, and which ones have nothing to act on yet. */
  function paintSideState(): void {
    for (const [at, action] of actions.entries()) {
      const button = sideButtons[at];
      if (button === undefined) continue;
      const on =
        (action.kind === 'section' && action.section === section) ||
        (action.kind === 'source' && action.group.key === sourceKey) ||
        (action.kind === 'quality' && action.quality === quality) ||
        (action.kind === 'mode' && action.mode === heroMode) ||
        (action.kind === 'album' && action.album.key === albumKey) ||
        (action.kind === 'game' && section === 'candidates');
      button.classList.toggle('is-picked', on);
      if (action.kind === 'apply') {
        button.textContent =
          section === 'music'
            ? t()('metadata.useTrack')
            : t()('metadata.applySelected', { count: String(picked.length) });
        button.classList.toggle('is-disabled', nothingPicked());
      }
      if (action.kind === 'clear') {
        button.textContent = t()('metadata.clearPicked', { count: String(picked.length) });
        button.classList.toggle('is-disabled', picked.length === 0);
      }
      if (action.kind === 'listen') {
        button.textContent = t()(listening ? 'metadata.stopListen' : 'metadata.listen');
        button.classList.toggle('is-disabled', pickedTrack === null && !listening);
      }
    }
  }

  function nothingPicked(): boolean {
    return section === 'music' ? pickedTrack === null : picked.length === 0;
  }

  // ── The right column ──────────────────────────────────────────────────────

  function paintContent(): void {
    cells = [];
    contentEl.classList.toggle('is-grid', artworkKind() !== null);
    if (loading && section !== 'hero' && section !== 'grid') {
      contentEl.replaceChildren(busyNote());
      return;
    }
    if (section === 'candidates') {
      cells = candidates.map((entry, position) => candidateRow(entry, position));
      contentEl.replaceChildren(
        ...(cells.length > 0 ? cells : [note(t()('metadata.nothingFound'))]),
      );
      applyFocus(true);
      return;
    }
    if (section === 'music') {
      cells = tracks.map((track, position) => trackRow(track, position));
      contentEl.replaceChildren(
        ...(cells.length > 0
          ? cells
          : [note(t()(albumKey === null ? 'metadata.pickAlbum' : 'metadata.noTracks'))]),
      );
      applyPicked();
      applyFocus(true);
      return;
    }
    cells = variants.map((variant, position) => tile(variant, position));
    if (needsTail()) cells.push(tailTile());
    contentEl.replaceChildren(...(cells.length > 0 ? cells : [note(t()('metadata.noArtwork'))]));
    applyPicked();
    applyFocus(true);
  }

  function candidateRow(entry: GameCandidate, position: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-item music-row';
    const name = document.createElement('span');
    name.className = 'music-row-title';
    name.textContent = entry.title;
    const source = document.createElement('span');
    source.className = 'music-row-size';
    source.textContent = PROVIDER_LABEL[entry.provider];
    button.append(name, source);
    button.addEventListener('click', () => {
      hover.arm();
      column = 'content';
      index = position;
      applyFocus();
      chooseCandidate(entry);
    });
    return button;
  }

  function trackRow(track: MusicTrack, position: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-item music-row';
    const name = document.createElement('span');
    name.className = 'music-row-title';
    name.textContent = track.title;
    const size = document.createElement('span');
    size.className = 'music-row-size';
    size.textContent = track.sizeBytes === undefined ? '' : formatSize(track.sizeBytes);
    button.append(name, size);
    button.addEventListener('click', () => {
      hover.arm();
      column = 'content';
      index = position;
      applyFocus();
      toggleTrack(track);
    });
    return button;
  }

  function tile(variant: ArtworkVariant, position: number): HTMLButtonElement {
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
      column = 'content';
      index = position;
      applyFocus();
      togglePick(variant);
    });
    return button;
  }

  /**
   * The last tile of the grid, and the only one that is not a picture. Two states, one place: while a
   * page is on its way it spins and says so, and once it lands it becomes "load more".
   */
  function tailTile(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'metadata-tile metadata-tile-more';
    button.dataset['kind'] = artworkKind() ?? 'hero';
    const box = document.createElement('span');
    box.className = 'metadata-tile-more-box';
    const caption = document.createElement('span');
    caption.className = 'metadata-tile-caption';
    button.append(box, caption);
    button.addEventListener('click', () => {
      hover.arm();
      column = 'content';
      index = cells.length - 1;
      applyFocus();
      loadMore();
    });
    paintTail(button);
    return button;
  }

  function paintTail(button: HTMLButtonElement): void {
    const box = button.querySelector('.metadata-tile-more-box');
    const caption = button.querySelector('.metadata-tile-caption');
    button.classList.toggle('is-busy', loading);
    if (caption !== null) {
      caption.textContent = t()(loading ? 'metadata.searching' : 'metadata.loadMore');
    }
    if (box === null) return;
    if (!loading) {
      box.replaceChildren();
      box.textContent = '+';
      return;
    }
    const spin = document.createElement('span');
    spin.className = 'metadata-tile-spinner';
    box.replaceChildren(spin);
  }

  function needsTail(): boolean {
    return artworkKind() !== null && (hasMore || loading);
  }

  function isOnTail(): boolean {
    return needsTail() && index === variants.length;
  }

  function busyNote(): HTMLElement {
    const node = document.createElement('div');
    node.className = 'music-busy';
    const spin = document.createElement('span');
    spin.className = 'metadata-tile-spinner';
    const label = document.createElement('span');
    label.textContent = t()('metadata.searching');
    node.append(spin, label);
    return node;
  }

  /** `4.4 MB` — what the source claimed, so a long download is not a surprise. */
  function formatSize(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  /** Proper names, so they are not translated — one per source, never "this or else Steam". */
  const PROVIDER_LABEL: Readonly<Record<ArtworkVariant['provider'], string>> = {
    steam: 'Steam',
    steamgriddb: 'SteamGridDB',
    wallhaven: 'Wallhaven',
    wallpapercave: 'Wallpaper Cave',
    gog: 'GOG',
    khinsider: 'Khinsider',
  };

  function captionOf(variant: ArtworkVariant): string {
    const source = PROVIDER_LABEL[variant.provider];
    if (variant.width === undefined || variant.height === undefined) return source;
    return `${source} · ${variant.width}x${variant.height}`;
  }

  function applyPicked(): void {
    cells.forEach((cell, position) => {
      const key = section === 'music' ? tracks[position]?.key : variants[position]?.key;
      const on =
        section === 'music' ? key === pickedTrack : key !== undefined && picked.includes(key);
      cell.classList.toggle('is-picked', on);
    });
    paintSideState();
  }

  function applyFocus(instant = false): void {
    cells.forEach((cell, position) =>
      cell.classList.toggle('is-focused', column === 'content' && position === index),
    );
    sideButtons.forEach((button, position) =>
      button.classList.toggle('is-focused', column === 'side' && position === sideIndex),
    );
    if (column === 'side') {
      const row = sideButtons[sideIndex];
      if (row !== undefined) sideScroller.reveal(row, instant);
      return;
    }
    const focused = cells[index];
    if (focused !== undefined) scroller.reveal(focused, instant);
  }

  /** How many tiles fit on one row — read back from the layout, which has already answered it. */
  function columns(): number {
    if (artworkKind() === null) return 1;
    const first = cells[0];
    if (first === undefined) return 1;
    const top = first.offsetTop;
    return Math.max(1, cells.filter((cell) => cell.offsetTop === top).length);
  }

  function move(delta: number): void {
    hover.arm();
    const length = column === 'side' ? sideButtons.length : cells.length;
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

  // ── Choosing ──────────────────────────────────────────────────────────────

  function togglePick(variant: ArtworkVariant): void {
    if (picked.includes(variant.key)) {
      picked = picked.filter((key) => key !== variant.key);
      deps.audio.play('navigate');
      applyPicked();
      return;
    }
    if (maxPicks() === 1) picked = [variant.key];
    else if (picked.length >= maxPicks()) {
      deps.audio.playLimit();
      return;
    } else picked.push(variant.key);
    deps.audio.play('navigate');
    applyPicked();
  }

  function toggleTrack(track: MusicTrack): void {
    pickedTrack = pickedTrack === track.key ? null : track.key;
    deps.audio.play('navigate');
    applyPicked();
  }

  function chooseCandidate(entry: GameCandidate): void {
    deps.audio.play('button');
    candidate = entry;
    deps.onCandidate(entry);
    picked = [];
    pickedTrack = null;
    albums = [];
    albumKey = null;
    tracks = [];
    titleEl.textContent = entry.title;
    void showSection('hero');
  }

  /** Moves to a section and loads whatever it needs, keeping everything the other sections hold. */
  async function showSection(next: OnlineSection): Promise<void> {
    section = next;
    index = 0;
    statusEl.textContent = '';
    if (next === 'candidates') {
      paintSide();
      paintContent();
      return;
    }
    if (next === 'music') {
      paintSide();
      paintContent();
      if (albums.length === 0) await loadAlbums();
      return;
    }
    picked = [];
    page = 0;
    hasMore = false;
    variants = [];
    paintSide();
    await loadArtwork(0);
  }

  function runAction(action: SideAction): void {
    if (action.kind === 'game') {
      deps.audio.play('button');
      void showSection('candidates');
      return;
    }
    if (action.kind === 'search') {
      deps.audio.play('button');
      deps.editQuery(query, (value) => {
        const term = value.trim();
        if (term === '') return;
        query = term;
        void search(term);
      });
      return;
    }
    if (action.kind === 'title') {
      const named = candidate;
      if (named === null) {
        deps.audio.playLimit();
        return;
      }
      deps.audio.play('button');
      deps.applyTitle(named.title);
      statusEl.textContent = t()('metadata.applied');
      return;
    }
    if (action.kind === 'section') {
      if (action.section === section) {
        deps.audio.playLimit();
        return;
      }
      deps.audio.play('button');
      void showSection(action.section);
      return;
    }
    if (action.kind === 'source' || action.kind === 'quality') {
      const same =
        action.kind === 'source' ? action.group.key === sourceKey : action.quality === quality;
      if (same) {
        deps.audio.playLimit();
        return;
      }
      if (action.kind === 'source') sourceKey = action.group.key;
      else quality = action.quality;
      deps.audio.play('button');
      deps.api.cancel();
      loading = false;
      index = 0;
      paintSideState();
      void loadArtwork(0);
      return;
    }
    if (action.kind === 'mode') {
      heroMode = action.mode;
      deps.audio.play('navigate');
      paintSideState();
      return;
    }
    if (action.kind === 'album') {
      if (action.album.key === albumKey) {
        deps.audio.playLimit();
        return;
      }
      deps.audio.play('button');
      albumKey = action.album.key;
      paintSideState();
      void loadTracks(action.album.key);
      return;
    }
    if (action.kind === 'listen') {
      if (listening) {
        deps.audio.play('button');
        stopListening();
        return;
      }
      const track = tracks.find((entry) => entry.key === pickedTrack);
      if (track === undefined) {
        deps.audio.playLimit();
        return;
      }
      deps.audio.play('button');
      void listen(track);
      return;
    }
    if (action.kind === 'apply') {
      void apply();
      return;
    }
    if (action.kind === 'clear') {
      if (picked.length === 0) {
        deps.audio.playLimit();
        return;
      }
      picked = [];
      deps.audio.play('navigate');
      applyPicked();
      return;
    }
    deps.audio.play('popup-close');
    hide();
  }

  /**
   * Applying leaves the screen open: a game usually wants a cover AND backgrounds AND a track, and
   * closing after each one would make the second and third a fresh search every time.
   */
  async function apply(): Promise<void> {
    if (nothingPicked()) {
      deps.audio.playLimit();
      return;
    }
    deps.audio.play('button');
    const token = ++attempt;
    const visited = visit;
    statusEl.textContent = t()('metadata.applying');
    const kind = artworkKind();
    const outcome =
      kind === null
        ? await deps.applyTrack(pickedTrack ?? '')
        : await deps.applyArtwork(kind, picked, kind === 'hero' ? heroMode : 'replace');
    if (visited !== visit || token !== attempt) return;
    statusEl.textContent = outcome.message;
    if (!outcome.ok) return;
    // The picks are spent. Backgrounds that were APPENDED keep their meaning ("these are on the game
    // now"), so the mode goes back to appending: a second set adds to the first rather than wiping it.
    if (kind === 'hero') heroMode = 'append';
    picked = [];
    pickedTrack = null;
    applyPicked();
    paintSide();
    applyFocus(true);
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  async function search(term: string): Promise<void> {
    loading = true;
    const token = ++attempt;
    const visited = visit;
    section = 'candidates';
    statusEl.textContent = '';
    titleEl.textContent = term;
    paintSide();
    paintContent();
    const result = await deps.api.searchGames(term);
    if (visited !== visit || token !== attempt) return;
    loading = false;
    if (!result.ok) {
      candidates = [];
      statusEl.textContent = result.message;
      paintContent();
      return;
    }
    candidates = result.value;
    paintContent();
    if (candidates.length > 0) column = 'content';
    applyFocus(true);
  }

  async function byAppId(appId: number): Promise<void> {
    loading = true;
    const token = ++attempt;
    const visited = visit;
    paintContent();
    const result = await deps.api.steamCandidate(appId);
    if (visited !== visit || token !== attempt) return;
    loading = false;
    if (!result.ok) {
      statusEl.textContent = result.message;
      paintContent();
      return;
    }
    // Straight past the candidates: asking "which game is it?" about a game the user identified by
    // appid would be a question with exactly one answer.
    chooseCandidate(result.value);
  }

  async function loadArtwork(nextPage: number): Promise<void> {
    const named = candidate;
    const kind = artworkKind();
    if (named === null || kind === null || loading) return;
    loading = true;
    const token = ++attempt;
    const visited = visit;
    const shownBefore = variants.length;
    statusEl.textContent = '';
    if (nextPage === 0) paintContent();
    else syncTail();
    const result = await deps.api.artwork(named.key, kind, nextPage, filter());
    if (visited !== visit || token !== attempt) return;
    loading = false;
    if (!result.ok) {
      statusEl.textContent = result.message;
      if (nextPage > 0) {
        syncTail();
        return;
      }
      variants = [];
      hasMore = false;
      paintContent();
      return;
    }
    page = nextPage;
    hasMore = result.value.hasMore;
    variants = nextPage === 0 ? result.value.variants : [...variants, ...result.value.variants];
    paintContent();
    if (nextPage === 0) {
      if (variants.length > 0) column = 'content';
      applyFocus(true);
      return;
    }
    index = Math.min(shownBefore, Math.max(0, cells.length - 1));
    applyFocus();
  }

  /** Brings the tail tile in step without rebuilding the grid — a repaint re-decodes every thumbnail. */
  function syncTail(): void {
    const last = cells[cells.length - 1];
    const present = last !== undefined && last.classList.contains('metadata-tile-more');
    if (needsTail() && present && last !== undefined) {
      paintTail(last);
      return;
    }
    if (needsTail() && !present) {
      const tile = tailTile();
      cells.push(tile);
      contentEl.append(tile);
      return;
    }
    if (!needsTail() && present && last !== undefined) {
      cells.pop();
      last.remove();
      if (index >= cells.length) index = Math.max(0, cells.length - 1);
      applyFocus();
    }
  }

  function loadMore(): void {
    if (loading) {
      deps.audio.playLimit();
      return;
    }
    deps.audio.play('button');
    void loadArtwork(page + 1);
  }

  async function loadAlbums(): Promise<void> {
    const named = candidate;
    if (named === null) return;
    loading = true;
    const token = ++attempt;
    const visited = visit;
    paintContent();
    const result = await deps.api.albums(named.title);
    if (visited !== visit || token !== attempt) return;
    loading = false;
    if (!result.ok) {
      albums = [];
      statusEl.textContent = result.message;
      paintSide();
      paintContent();
      return;
    }
    albums = result.value;
    paintSide();
    // One album is no choice at all — opening it saves a press the user would always make.
    const only = albums.length === 1 ? albums[0] : undefined;
    if (only !== undefined) {
      albumKey = only.key;
      paintSideState();
      await loadTracks(only.key);
      return;
    }
    paintContent();
  }

  async function loadTracks(key: string): Promise<void> {
    loading = true;
    const token = ++attempt;
    const visited = visit;
    tracks = [];
    pickedTrack = null;
    index = 0;
    stopListening();
    paintContent();
    const result = await deps.api.tracks(key);
    if (visited !== visit || token !== attempt) return;
    loading = false;
    if (!result.ok) {
      statusEl.textContent = result.message;
      paintContent();
      return;
    }
    tracks = result.value;
    paintContent();
    if (tracks.length > 0) column = 'content';
    applyFocus(true);
  }

  /**
   * Listening downloads the whole track — tens of seconds on a Deck's Wi-Fi — hence the status line,
   * and hence Back being able to abort it.
   */
  async function listen(track: MusicTrack): Promise<void> {
    const token = ++listenAttempt;
    const visited = visit;
    statusEl.textContent = t()('metadata.downloading');
    const result = await deps.api.preview(track.key);
    if (visited !== visit || token !== listenAttempt) return;
    if (!result.ok) {
      statusEl.textContent = result.message;
      return;
    }
    statusEl.textContent = '';
    listening = true;
    deps.audio.setBrowseMusic(result.value, false);
    paintSideState();
  }

  function stopListening(): void {
    listenAttempt += 1; // a download still on its way is no longer wanted
    if (!listening) return;
    listening = false;
    deps.audio.setBrowseMusic(null, false);
    paintSideState();
  }

  function hide(): void {
    if (!open) return;
    open = false;
    visit += 1;
    stopListening();
    candidates = [];
    candidate = null;
    variants = [];
    picked = [];
    tracks = [];
    albums = [];
    albumKey = null;
    pickedTrack = null;
    cells = [];
    actions = [];
    sideButtons = [];
    loading = false;
    sideEl.replaceChildren();
    contentEl.replaceChildren();
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    deps.api.cancel();
  }

  // ── Mouse ─────────────────────────────────────────────────────────────────

  contentEl.addEventListener(
    'mousemove',
    (event) => {
      if (!open) return;
      if (document.documentElement.classList.contains('mouse-asleep')) return;
      if (!hover.awake(event.clientX, event.clientY)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const cell = target.closest<HTMLButtonElement>('.metadata-tile, .picker-item');
      if (cell === null) return;
      const position = cells.indexOf(cell);
      if (position === -1 || (position === index && column === 'content')) return;
      column = 'content';
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
    hide();
  });

  window.addEventListener('mousemove', (event) => hover.track(event.clientX, event.clientY), {
    passive: true,
  });

  return {
    isOpen: () => open,
    close: () => hide(),
    open: (request) => {
      open = true;
      visit += 1;
      query = request.query;
      candidates = [];
      candidate = null;
      section = 'candidates';
      variants = [];
      picked = [];
      tracks = [];
      albums = [];
      albumKey = null;
      pickedTrack = null;
      listening = false;
      page = 0;
      hasMore = false;
      sourceKey = 'all';
      quality = 'any';
      heroMode = 'append';
      index = 0;
      sideIndex = 0;
      column = 'side';
      loading = false;
      deps.audio.play('popup-open');
      titleEl.textContent = request.query;
      statusEl.textContent = '';
      paintSide();
      paintContent();
      root.classList.add('is-open');
      root.setAttribute('aria-hidden', 'false');
      scroller.to(0, true);
      sideScroller.to(0, true);
      hover.arm();
      if (request.appId !== undefined) {
        void byAppId(request.appId);
        return;
      }
      if (request.query.trim() === '') {
        deps.editQuery('', (value) => {
          const term = value.trim();
          if (term === '') return;
          query = term;
          void search(term);
        });
        return;
      }
      void search(request.query);
    },
    navUp: () => move(column === 'side' ? -1 : -columns()),
    navDown: () => move(column === 'side' ? 1 : columns()),
    /** Left walks the row and then steps into the sidebar — a HELD left stops at that wall. */
    navLeft: (repeat) => {
      hover.arm();
      if (column === 'side') {
        deps.audio.playLimit();
        return;
      }
      if (cells.length > 0 && index % Math.max(1, columns()) !== 0) {
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
      if (cells.length === 0) {
        deps.audio.playLimit();
        return;
      }
      column = 'content';
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
      if (isOnTail()) {
        loadMore();
        return;
      }
      if (section === 'candidates') {
        const entry = candidates[index];
        if (entry === undefined) {
          deps.audio.playLimit();
          return;
        }
        chooseCandidate(entry);
        return;
      }
      if (section === 'music') {
        const track = tracks[index];
        if (track === undefined) {
          deps.audio.playLimit();
          return;
        }
        toggleTrack(track);
        return;
      }
      const variant = variants[index];
      if (variant === undefined) {
        deps.audio.playLimit();
        return;
      }
      togglePick(variant);
    },
    navBack: () => {
      deps.audio.play('popup-close');
      hide();
    },
    /** X ticks a picture, or auditions a track — the shortcut each list had before. */
    navSecondary: () => {
      if (column !== 'content') {
        deps.audio.playLimit();
        return;
      }
      if (section === 'music') {
        const track = tracks[index];
        if (track === undefined) {
          deps.audio.playLimit();
          return;
        }
        if (listening) stopListening();
        pickedTrack = track.key;
        applyPicked();
        void listen(track);
        return;
      }
      const variant = variants[index];
      if (variant === undefined) {
        deps.audio.playLimit();
        return;
      }
      togglePick(variant);
    },
    relocalize: () => {
      if (!open) return;
      paintSide();
      paintContent();
      applyFocus(true);
    },
  };
}
