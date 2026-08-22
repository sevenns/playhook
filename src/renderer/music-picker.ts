// The soundtrack surface of the "Find online" flow — the artwork gallery's twin, for the one thing the
// sources offer that is not a picture.
//
// It used to be two nested menus (albums, then tracks, then a menu per track). The same two columns the
// gallery settled on say it better: the ALBUMS are the left column — choosing one is the same gesture as
// choosing a source there — and the tracks of whichever album is selected fill the right. Nothing nests,
// so backing out means leaving, not climbing.
//
// A track is chosen the way a picture is: the row ticks, and the sidebar commits. What this has and the
// gallery has not is Listen — auditioning means DOWNLOADING the whole track (there is no stream to be
// had), so it is an explicit action with a status line and a stop, never something a focus change starts.
import { type MetadataResult, type MusicAlbum, type MusicTrack } from '../shared/types';
import type { Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createHoverGuard } from './hover-guard.js';
import { clampIndex } from './index-math.js';
import { createScroller } from './screen-scroller.js';
import type { NavSurface } from './nav-surface.js';

/** What the surface asks main. A seam, so app.ts owns the window.api wiring (and a test can fake it). */
export interface MusicPickerApi {
  albums(query: string): Promise<MetadataResult<readonly MusicAlbum[]>>;
  tracks(albumKey: string): Promise<MetadataResult<readonly MusicTrack[]>>;
  /** One track as an audio data: URL — a full download, which is why Listen shows a status line. */
  preview(trackKey: string): Promise<MetadataResult<string>>;
  /** The user left — abort whatever is still downloading for this surface. */
  cancel(): void;
}

export interface MusicPickerDeps {
  readonly audio: AudioController;
  getTranslator(): Translator;
  readonly api: MusicPickerApi;
}

export interface MusicPickerSurface extends NavSurface {
  /** Closes without answering — for the cascade when the whole screen goes (it stops the audition). */
  close(): void;
  open(request: {
    /** What to search soundtracks for — the candidate's title. */
    readonly query: string;
    /** Shown in the panel header, so the user can tell they picked the right game. */
    readonly title: string;
    /** Null means the user backed out — the caller changes nothing then. */
    readonly onDone: (trackKey: string | null) => void;
  }): void;
}

/** Which column holds the focus. The albums narrow; the tracks answer. */
type Column = 'side' | 'tracks';

/** One focusable row of the sidebar. Headings are drawn but never focused, so they are not here. */
type SideAction =
  | { readonly kind: 'album'; readonly album: MusicAlbum }
  | { readonly kind: 'listen' }
  | { readonly kind: 'apply' }
  | { readonly kind: 'close' };

export function createMusicPicker(deps: MusicPickerDeps): MusicPickerSurface {
  const root = req('music-picker');
  const titleEl = req('music-picker-title');
  const statusEl = req('music-picker-status');
  const sideEl = req('music-picker-side');
  const listEl = req('music-picker-list');

  const t = (): Translator => deps.getTranslator();
  const scroller = createScroller(listEl);
  // The albums column scrolls too: a game with twenty soundtracks fills it past the panel, and without
  // a scroller of its own the focus simply walked off the bottom of the screen.
  const sideScroller = createScroller(sideEl);
  const hover = createHoverGuard();

  let open = false;
  let request: {
    readonly query: string;
    readonly title: string;
    readonly onDone: (trackKey: string | null) => void;
  } | null = null;
  /** Bumped on every open/close, so a slow answer from a previous visit cannot paint over this one. */
  let visit = 0;
  /** Bumped on every list request, so an answer about an album the user has already left is discarded. */
  let attempt = 0;
  /** The same for auditions, kept apart: starting one must not cancel a list that is still arriving. */
  let listenAttempt = 0;
  let albums: readonly MusicAlbum[] = [];
  let albumKey: string | null = null;
  let tracks: readonly MusicTrack[] = [];
  let rows: HTMLButtonElement[] = [];
  let index = 0;
  let column: Column = 'side';
  let sideIndex = 0;
  let actions: SideAction[] = [];
  let sideButtons: HTMLButtonElement[] = [];
  /** The ticked track, if any. One at a time: a game has one background track. */
  let picked: string | null = null;
  /** Whether a track is playing through the browse channel right now. */
  let listening = false;
  /** True while albums or tracks are on their way — the list says so where the rows will appear. */
  let loading = false;

  function paintSide(): void {
    actions = [];
    sideButtons = [];
    const nodes: HTMLElement[] = [heading(t()('metadata.albums'))];
    for (const album of albums) {
      nodes.push(sideButton({ kind: 'album', album }, albumLabel(album)));
    }
    if (albums.length === 0) nodes.push(emptyNote(t()('metadata.noAlbums')));
    const divider = document.createElement('div');
    divider.className = 'picker-divider';
    nodes.push(divider);
    nodes.push(sideButton({ kind: 'listen' }, ''));
    nodes.push(sideButton({ kind: 'apply' }, t()('metadata.useTrack')));
    nodes.push(sideButton({ kind: 'close' }, t()('metadata.actionClose')));
    sideEl.replaceChildren(...nodes);
    sideIndex = Math.min(sideIndex, Math.max(0, sideButtons.length - 1));
    paintActions();
    paintAlbums();
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

  function emptyNote(text: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'picker-empty';
    node.textContent = text;
    return node;
  }

  function sideButton(action: SideAction, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.kind === 'album' ? 'picker-item' : 'picker-item is-action';
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

  /** Listen and Apply both act on a track: they are inert until one is ticked, and say what they will do. */
  function paintActions(): void {
    for (const [at, action] of actions.entries()) {
      const button = sideButtons[at];
      if (button === undefined) continue;
      if (action.kind === 'listen') {
        button.textContent = t()(listening ? 'metadata.stopListen' : 'metadata.listen');
        button.classList.toggle('is-disabled', picked === null && !listening);
      }
      if (action.kind === 'apply') button.classList.toggle('is-disabled', picked === null);
    }
  }

  /** Marks the album whose tracks are on the right. */
  function paintAlbums(): void {
    for (const [at, action] of actions.entries()) {
      const button = sideButtons[at];
      if (button === undefined || action.kind !== 'album') continue;
      button.classList.toggle('is-picked', action.album.key === albumKey);
    }
  }

  function paintTracks(): void {
    rows = tracks.map((track, position) => {
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
        column = 'tracks';
        index = position;
        applyFocus();
        togglePick(track);
      });
      return button;
    });
    listEl.replaceChildren(...rows);
    if (loading) {
      listEl.replaceChildren(busyNote());
      return;
    }
    if (rows.length === 0) {
      listEl.replaceChildren(
        emptyNote(t()(albumKey === null ? 'metadata.pickAlbum' : 'metadata.noTracks')),
      );
    }
    applyPicked();
    applyFocus(true);
  }

  /** What the right column says while main is fetching — the gallery's spinning tile, as a row. */
  function busyNote(): HTMLElement {
    const node = document.createElement('div');
    node.className = 'music-busy';
    const spinner = document.createElement('span');
    spinner.className = 'metadata-tile-spinner';
    const label = document.createElement('span');
    label.textContent = t()('metadata.searching');
    node.append(spinner, label);
    return node;
  }

  /** `4.4 MB` — what the source claimed, so a long download is not a surprise. */
  function formatSize(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function applyPicked(): void {
    rows.forEach((row, position) => {
      row.classList.toggle('is-picked', tracks[position]?.key === picked);
    });
    paintActions();
  }

  function applyFocus(instant = false): void {
    rows.forEach((row, position) =>
      row.classList.toggle('is-focused', column === 'tracks' && position === index),
    );
    sideButtons.forEach((button, position) =>
      button.classList.toggle('is-focused', column === 'side' && position === sideIndex),
    );
    if (column === 'side') {
      const row = sideButtons[sideIndex];
      if (row !== undefined) sideScroller.reveal(row, instant);
      return;
    }
    const focused = rows[index];
    if (focused !== undefined) scroller.reveal(focused, instant);
  }

  function move(delta: number): void {
    hover.arm();
    const length = column === 'side' ? sideButtons.length : rows.length;
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

  /** A ticked track becomes unticked; a fresh one replaces whatever was ticked before. */
  function togglePick(track: MusicTrack): void {
    picked = picked === track.key ? null : track.key;
    deps.audio.play('navigate');
    applyPicked();
  }

  function runAction(action: SideAction): void {
    if (action.kind === 'album') {
      if (action.album.key === albumKey) {
        deps.audio.playLimit();
        return;
      }
      deps.audio.play('button');
      albumKey = action.album.key;
      paintAlbums();
      void loadTracks(action.album.key);
      return;
    }
    if (action.kind === 'listen') {
      if (listening) {
        deps.audio.play('button');
        stopListening();
        return;
      }
      const track = tracks.find((entry) => entry.key === picked);
      if (track === undefined) {
        deps.audio.playLimit();
        return;
      }
      deps.audio.play('button');
      void listen(track);
      return;
    }
    if (action.kind === 'apply') {
      if (picked === null) {
        deps.audio.playLimit();
        return;
      }
      deps.audio.play('button');
      finish(picked);
      return;
    }
    deps.audio.play('popup-close');
    finish(null);
  }

  async function loadAlbums(): Promise<void> {
    const at = request;
    if (at === null) return;
    loading = true;
    attempt += 1;
    const token = attempt;
    const visited = visit;
    statusEl.textContent = '';
    paintTracks();
    const result = await deps.api.albums(at.query);
    if (visited !== visit || token !== attempt) return;
    loading = false;
    if (!result.ok) {
      statusEl.textContent = result.message;
      albums = [];
      paintSide();
      paintTracks();
      return;
    }
    albums = result.value;
    paintSide();
    // One album is no choice at all — opening it saves the user a press they would always make.
    const only = albums.length === 1 ? albums[0] : undefined;
    if (only !== undefined) {
      albumKey = only.key;
      paintAlbums();
      void loadTracks(only.key);
      return;
    }
    paintTracks();
  }

  async function loadTracks(key: string): Promise<void> {
    loading = true;
    attempt += 1;
    const token = attempt;
    const visited = visit;
    statusEl.textContent = '';
    tracks = [];
    picked = null;
    index = 0;
    stopListening();
    paintTracks();
    const result = await deps.api.tracks(key);
    if (visited !== visit || token !== attempt) return;
    loading = false;
    if (!result.ok) {
      statusEl.textContent = result.message;
      paintTracks();
      return;
    }
    tracks = result.value;
    paintTracks();
    if (tracks.length > 0) column = 'tracks';
    applyFocus(true);
  }

  /**
   * Listening downloads the whole track, which on a Deck's Wi-Fi is tens of seconds — hence the status
   * line, and hence Back being able to abort it (the surface cancels everything on the way out).
   */
  async function listen(track: MusicTrack): Promise<void> {
    listenAttempt += 1;
    const token = listenAttempt;
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
    paintActions();
  }

  /** Stops an audition and hands the browse channel back to whatever was playing before it. */
  function stopListening(): void {
    listenAttempt += 1; // a download still on its way is no longer wanted
    if (!listening) return;
    listening = false;
    deps.audio.setBrowseMusic(null, false);
    paintActions();
  }

  function finish(trackKey: string | null): void {
    const done = request?.onDone;
    hide();
    done?.(trackKey);
  }

  function hide(): void {
    if (!open) return;
    open = false;
    visit += 1;
    stopListening();
    request = null;
    albums = [];
    albumKey = null;
    tracks = [];
    rows = [];
    actions = [];
    sideButtons = [];
    picked = null;
    loading = false;
    sideEl.replaceChildren();
    listEl.replaceChildren();
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    deps.api.cancel();
  }

  listEl.addEventListener(
    'mousemove',
    (event) => {
      if (!open) return;
      if (document.documentElement.classList.contains('mouse-asleep')) return;
      if (!hover.awake(event.clientX, event.clientY)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest<HTMLButtonElement>('.music-row');
      if (row === null) return;
      const position = rows.indexOf(row);
      if (position === -1 || (position === index && column === 'tracks')) return;
      column = 'tracks';
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
    finish(null);
  });

  window.addEventListener('mousemove', (event) => hover.track(event.clientX, event.clientY), {
    passive: true,
  });

  return {
    isOpen: () => open,
    close: () => hide(),
    open: (next) => {
      request = next;
      open = true;
      visit += 1;
      albums = [];
      albumKey = null;
      tracks = [];
      rows = [];
      picked = null;
      listening = false;
      index = 0;
      sideIndex = 0;
      column = 'side';
      deps.audio.play('popup-open');
      titleEl.textContent = next.title;
      statusEl.textContent = '';
      paintSide();
      root.classList.add('is-open');
      root.setAttribute('aria-hidden', 'false');
      scroller.to(0, true);
      sideScroller.to(0, true);
      hover.arm();
      void loadAlbums();
    },
    navUp: () => move(-1),
    navDown: () => move(1),
    /** Left leaves the tracks for the albums; a HELD left stops at that wall rather than crossing it. */
    navLeft: (repeat) => {
      hover.arm();
      if (column === 'side') {
        deps.audio.playLimit();
        return;
      }
      if (repeat === true) return;
      column = 'side';
      deps.audio.play('navigate');
      applyFocus();
    },
    navRight: () => {
      hover.arm();
      if (column === 'tracks' || rows.length === 0) {
        deps.audio.playLimit();
        return;
      }
      column = 'tracks';
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
      const track = tracks[index];
      if (track === undefined) {
        deps.audio.playLimit();
        return;
      }
      togglePick(track);
    },
    navBack: () => {
      deps.audio.play('popup-close');
      finish(null);
    },
    /** X auditions the focused track — the shortcut the old track list had, kept for the gamepad. */
    navSecondary: () => {
      const track = column === 'tracks' ? tracks[index] : undefined;
      if (track === undefined) {
        deps.audio.playLimit();
        return;
      }
      if (listening) stopListening();
      picked = track.key;
      applyPicked();
      void listen(track);
    },
    relocalize: () => {
      if (!open) return;
      paintSide();
      paintTracks();
      applyFocus(true);
    },
  };
}
