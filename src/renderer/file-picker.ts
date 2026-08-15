// The in-launcher file browser — a surface of the Customize screen, and the replacement for a native
// dialog that cannot be used here at all: `dialog.showOpenDialog` over a fullscreen/kiosk window takes no
// gamepad input, and in Game Mode it is simply a dead end.
//
// It is READ-ONLY and unrestricted on purpose: where to browse is the user's business, and the commonest
// install path there is (`…/steamapps/common`) is a system directory by any definition. What is guarded
// is what main ACCEPTS back — the type/extension checks and the import limits live there, where a
// renderer cannot talk its way past them (see the plan, Р5.1/Р5.2).
//
// Two columns: the starting points on the left (the card, this PC, the home folder, every mounted
// volume), the current directory on the right. Left/right move between them, up/down inside one, A enters
// a folder or picks a file, B goes up a level and — at the top — leaves.
import type {
  ConfigPickKind,
  ConfigPickResult,
  DirEntry,
  DirRoot,
  ListDirResult,
} from '../shared/types';
import type { Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createHoverGuard } from './hover-guard.js';
import { clampIndex } from './index-math.js';
import { createScroller } from './screen-scroller.js';
import type { FilePickerSurface } from './game-settings-screen.js';

/** What the picker asks main. A seam, so app.ts owns the window.api wiring. */
export interface FilePickerApi {
  listDir(request: {
    readonly path?: string;
    readonly root?: string;
    readonly kind?: ConfigPickKind;
    readonly current?: string;
  }): Promise<ListDirResult>;
  acceptPaths(request: {
    readonly root: string;
    readonly kind: ConfigPickKind;
    readonly paths: readonly string[];
  }): Promise<ConfigPickResult>;
}

export interface FilePickerDeps {
  readonly audio: AudioController;
  getTranslator(): Translator;
  readonly api: FilePickerApi;
}

/** Which column the focus is in. */
type Column = 'roots' | 'entries';

export function createFilePicker(deps: FilePickerDeps): FilePickerSurface {
  const root = req('file-picker');
  const titleEl = req('picker-title');
  const pathEl = req('picker-path');
  const rootsEl = req('picker-roots');
  const entriesEl = req('picker-entries');
  const legendEl = req('picker-legend');

  const t = (): Translator => deps.getTranslator();
  const entriesScroller = createScroller(entriesEl);
  const hover = createHoverGuard();

  let open = false;
  let request: {
    readonly root: string;
    readonly kind: ConfigPickKind;
    readonly multi: boolean;
    readonly onDone: (result: ConfigPickResult) => void;
  } | null = null;

  let here = '';
  let parent: string | null = null;
  let entries: readonly DirEntry[] = [];
  let roots: readonly DirRoot[] = [];
  /** Multi-select (hero images): the files ticked so far, in the order they were ticked. */
  let picked: string[] = [];

  let column: Column = 'entries';
  let entryIndex = 0;
  let rootIndex = 0;
  let rootButtons: HTMLButtonElement[] = [];
  let entryButtons: HTMLButtonElement[] = [];
  /**
   * Where the last visit ENDED, per field kind, kept for the lifetime of the screen: picking three hero
   * images one after another must not start at the top of the filesystem each time.
   *
   * Per KIND, not one shared value — otherwise browsing the card for an executable would leave the PC
   * save-path picker opening on the card, which is nowhere near where a save folder lives.
   */
  const lastVisited = new Map<ConfigPickKind, string>();

  function wantsDirectory(): boolean {
    const kind = request?.kind;
    return kind === 'directory' || kind === 'pc-save' || kind === 'pc-save-local';
  }

  function paintRoots(): void {
    rootButtons = roots.map((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'picker-item is-dir';
      button.textContent = entry.label;
      button.addEventListener('click', () => {
        column = 'roots';
        rootIndex = index;
        applyFocus();
        void go(entry.path);
      });
      return button;
    });
    rootsEl.replaceChildren(...rootButtons);
  }

  function paintEntries(): void {
    pathEl.textContent = here;
    const items: HTMLButtonElement[] = [];
    // 2: the way OUT, as a row. Backing out with B walks up one directory at a time, which after six
    // steps into a Steam library is six presses to change your mind — this is one.
    const cancelItem = document.createElement('button');
    cancelItem.type = 'button';
    cancelItem.className = 'picker-item is-cancel';
    cancelItem.textContent = t()('picker.cancel');
    cancelItem.addEventListener('click', () => cancel());
    items.push(cancelItem);
    // "Up one level" is a row of its own rather than a bare B: a mouse user has no B, and the gesture is
    // the one the browser is used for most.
    if (parent !== null) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'picker-item is-dir';
      up.textContent = t()('picker.up');
      up.addEventListener('click', () => {
        if (parent !== null) void go(parent);
      });
      items.push(up);
    }
    // A folder field can pick the folder it is standing IN — there is no other way to name it.
    if (wantsDirectory()) {
      const useThis = document.createElement('button');
      useThis.type = 'button';
      useThis.className = 'picker-item';
      useThis.textContent = t()('picker.useThisFolder');
      useThis.addEventListener('click', () => void accept([here]));
      items.push(useThis);
    }
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `picker-item is-${entry.kind}`;
      button.textContent = entry.name;
      const full = join(here, entry.name);
      button.classList.toggle('is-picked', picked.includes(full));
      button.addEventListener('click', () => void activatePath(entry, full));
      items.push(button);
    }
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'picker-empty';
      empty.textContent = t()('picker.empty');
      entriesEl.replaceChildren(empty);
      entryButtons = [];
      return;
    }
    entryButtons = items;
    entriesEl.replaceChildren(...items);
  }

  /** How many leading rows are not directory entries (Cancel, Up, Use this folder). */
  function leadingRows(): number {
    return 1 + (parent !== null ? 1 : 0) + (wantsDirectory() ? 1 : 0);
  }

  /** Joins a directory and a name in whatever separator the directory already uses. */
  function join(directory: string, name: string): string {
    const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
    return directory.endsWith(separator)
      ? `${directory}${name}`
      : `${directory}${separator}${name}`;
  }

  function applyFocus(): void {
    rootButtons.forEach((button, index) =>
      button.classList.toggle('is-focused', column === 'roots' && index === rootIndex),
    );
    entryButtons.forEach((button, index) =>
      button.classList.toggle('is-focused', column === 'entries' && index === entryIndex),
    );
    if (column === 'entries') {
      const focused = entryButtons[entryIndex];
      if (focused !== undefined) entriesScroller.reveal(focused);
    } else {
      rootButtons[rootIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }

  async function go(path: string | undefined): Promise<void> {
    const at = request;
    if (at === null) return;
    const remembered = lastVisited.get(at.kind);
    const result = await deps.api.listDir(
      path === undefined
        ? {
            root: at.root,
            kind: at.kind,
            ...(remembered !== undefined ? { path: remembered } : {}),
          }
        : { path, root: at.root, kind: at.kind },
    );
    roots = result.roots;
    paintRoots();
    if (!result.ok) {
      pathEl.textContent = result.message;
      entries = [];
      entryButtons = [];
      entriesEl.replaceChildren();
      return;
    }
    here = result.path;
    lastVisited.set(at.kind, result.path);
    parent = result.parent;
    entries = result.entries;
    column = 'entries';
    paintEntries();
    // The focus lands on the first real ENTRY, past the Cancel / Up / Use-this-folder rows: those are
    // ways out, and a picker that opens on its own exit button is a picker you have to walk down first.
    entryIndex = entries.length > 0 ? leadingRows() : Math.max(0, entryButtons.length - 1);
    applyFocus();
    entriesScroller.to(0, true);
  }

  async function activatePath(entry: DirEntry, full: string): Promise<void> {
    if (entry.kind === 'dir') {
      deps.audio.play('button');
      await go(full);
      return;
    }
    if (wantsDirectory()) return; // a folder field has no use for a file
    if (request?.multi === true) {
      // X ticks and unticks; A on a file in multi mode ticks it and finishes, which is the one-image case.
      deps.audio.play('button');
      await accept([...picked.filter((item) => item !== full), full]);
      return;
    }
    deps.audio.play('button');
    await accept([full]);
  }

  function togglePick(full: string): void {
    if (picked.includes(full)) picked = picked.filter((item) => item !== full);
    else picked.push(full);
    deps.audio.play('navigate');
    paintEntries();
    applyFocus();
  }

  /** Hands the absolute path(s) to main, which turns them into what the manifest field stores. */
  async function accept(paths: readonly string[]): Promise<void> {
    const at = request;
    if (at === null) return;
    const result = await deps.api.acceptPaths({ root: at.root, kind: at.kind, paths });
    if (!result.ok && !('cancelled' in result)) {
      // A rejection is not an exit: the user is standing in the folder they picked from, and the message
      // tells them what to pick instead.
      pathEl.textContent = result.message;
      deps.audio.play('back');
      return;
    }
    hide();
    at.onDone(result);
  }

  function hide(): void {
    if (!open) return;
    open = false;
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
  }

  function cancel(): void {
    const at = request;
    hide();
    at?.onDone({ ok: false, cancelled: true });
  }

  function move(delta: number): void {
    hover.arm();
    if (column === 'roots') {
      const next = clampIndex(rootIndex, delta, rootButtons.length);
      if (next === rootIndex) return;
      rootIndex = next;
    } else {
      const next = clampIndex(entryIndex, delta, entryButtons.length);
      if (next === entryIndex) return;
      entryIndex = next;
    }
    deps.audio.play('navigate');
    applyFocus();
  }

  function focusedEntry(): { readonly entry: DirEntry; readonly full: string } | null {
    const entry = entries[entryIndex - leadingRows()];
    if (entry === undefined) return null;
    return { entry, full: join(here, entry.name) };
  }

  root.querySelector<HTMLElement>('.picker-veil')?.addEventListener('click', () => {
    deps.audio.play('back');
    cancel();
  });

  window.addEventListener(
    'mousemove',
    (event) => {
      hover.track(event.clientX, event.clientY);
      if (!open) return;
      if (document.documentElement.classList.contains('cursor-hidden')) return;
      if (!hover.awake(event.clientX, event.clientY)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('.picker-item');
      if (button === null) return;
      const inEntries = entryButtons.indexOf(button);
      if (inEntries !== -1) {
        if (column === 'entries' && inEntries === entryIndex) return;
        column = 'entries';
        entryIndex = inEntries;
        applyFocus();
        return;
      }
      const inRoots = rootButtons.indexOf(button);
      if (inRoots === -1) return;
      if (column === 'roots' && inRoots === rootIndex) return;
      column = 'roots';
      rootIndex = inRoots;
      applyFocus();
    },
    { passive: true },
  );

  function updateChrome(): void {
    legendEl.textContent = t()(request?.multi === true ? 'picker.legendMulti' : 'picker.legend');
  }

  return {
    isOpen: () => open,
    open: (next) => {
      request = {
        root: next.root,
        kind: next.kind,
        multi: next.multi,
        onDone: next.onDone,
      };
      picked = [];
      open = true;
      titleEl.textContent = t()('picker.title');
      updateChrome();
      root.classList.add('is-open');
      root.setAttribute('aria-hidden', 'false');
      hover.arm();
      // No explicit path: main picks the starting point from the field and its current value, unless this
      // field has already been browsed once this session (see lastVisited).
      void go(lastVisited.get(next.kind));
    },
    navUp: () => move(-1),
    navDown: () => move(1),
    navLeft: () => {
      hover.arm();
      if (column === 'entries' && rootButtons.length > 0) {
        column = 'roots';
        deps.audio.play('navigate');
        applyFocus();
      }
    },
    navRight: () => {
      hover.arm();
      if (column === 'roots' && entryButtons.length > 0) {
        column = 'entries';
        deps.audio.play('navigate');
        applyFocus();
      }
    },
    navActivate: () => {
      hover.arm();
      if (column === 'roots') {
        const target = roots[rootIndex];
        if (target === undefined) return;
        deps.audio.play('button');
        void go(target.path);
        return;
      }
      const button = entryButtons[entryIndex];
      if (button === undefined) return;
      button.click();
    },
    navBack: () => {
      hover.arm();
      deps.audio.play('back');
      if (parent !== null && column === 'entries') {
        void go(parent);
        return;
      }
      cancel();
    },
    /** X ticks a file in multi mode — the one gesture a single-select browser has no need for. */
    navSecondary: () => {
      if (request?.multi !== true || column !== 'entries') return;
      const focused = focusedEntry();
      if (focused === null || focused.entry.kind !== 'file') return;
      togglePick(focused.full);
    },
    relocalize: () => {
      if (!open) return;
      titleEl.textContent = t()('picker.title');
      updateChrome();
      paintRoots();
      paintEntries();
      applyFocus();
    },
  };
}
