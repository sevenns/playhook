// The left-hand column both settings screens are built around: the sections of the screen, then the
// actions that end it (Save, Discard, Close…).
//
// It exists because a one-column form makes its own actions unreachable. Every screen here is
// bottom-anchored — Save and Close live at the END of the list — so committing anything meant running
// the whole form to the bottom first, every time, on a gamepad. With the sections split off into a
// column of their own, the actions are a fixed handful of steps away from wherever you are, and the pane
// beside them only ever holds the rows of one section.
//
// Movement here is CYCLIC, unlike the pane's: the column is short and closed, so wrapping from the last
// entry to the first is the shortest path to the actions rather than a surprise. The pane stays clamped
// — a long list that wraps loses your place.
import { type AudioController } from './audio.js';
import { createEntrance } from './entrance.js';
import { createScroller } from './screen-scroller.js';
import { wrapIndex } from './index-math.js';

/** One entry of the column: a section of the screen, or an action that ends it. */
export interface SidebarEntry {
  readonly id: string;
  readonly label: string;
  /** A section opens the pane beside it; an action runs and is done. */
  readonly kind: 'section' | 'action';
  /** Destructive (Delete game) — styled apart, like the popup stacks' own danger items. */
  readonly danger?: boolean;
  /** Shown but inert (Save with nothing to save): hiding it would hide the reason too. */
  readonly disabled?: boolean;
}

export interface SidebarDeps {
  readonly audio: AudioController;
  /** A section was selected (moved onto, or activated) — the pane shows it. */
  onSection(id: string, entered: boolean): void;
  /** An action entry was activated. */
  onAction(id: string): void;
}

export interface Sidebar {
  /** Rebuilds the column. Keeps the current selection when that entry still exists. */
  render(entries: readonly SidebarEntry[]): void;
  /** Moves the selection, wrapping at both ends. */
  move(delta: number): void;
  /** Activates the selected entry (A / click). */
  activate(): void;
  /** The selected entry, or undefined for an empty column. */
  selected(): SidebarEntry | undefined;
  /** Whether the COLUMN holds the focus (as opposed to the pane beside it). */
  hasFocus(): boolean;
  setFocused(focused: boolean): void;
  /**
   * Selects an entry by id without announcing it — used to restore a selection after a rebuild, and to
   * deep-link a screen straight to one section. Returns whether the id was there at all: silently doing
   * nothing is how a deep link to a renamed section would go unnoticed.
   */
  select(id: string): boolean;
  /**
   * Puts the selection back on the first entry. A re-opened screen must not resume where the last visit
   * left the column while the pane falls back to section one — the two would then disagree about what is
   * on screen. It does NOT empty the column: the entries survive, so the caller's own "has this changed?"
   * guards stay honest and the screen re-opens with its buttons already there.
   */
  reset(): void;
  /** Replays the staggered entrance on the entries, as the popup stack does when it opens. */
  animateIn(): void;
}

/** How long the staggered entrance runs before the class that drives it is dropped. */
const ENTRANCE_MS = 700;

export function createSidebar(box: HTMLElement, deps: SidebarDeps): Sidebar {
  const scroller = createScroller(box);
  let entries: readonly SidebarEntry[] = [];
  let buttons: readonly HTMLButtonElement[] = [];
  let index = 0;
  let focused = true;
  // The buttons, by entry id. The column is REBUILT on every render — Save's enabled state follows every
  // keystroke — so making that rebuild replace the DOM was a button visibly blinking out and back in
  // under the cursor. Reusing the node for an id that is still there turns the common rebuild into a
  // handful of property writes, and the DOM is only touched when the SET of entries actually moved.
  const nodes = new Map<string, HTMLButtonElement>();
  // Marks the entries themselves, so an entry ADDED by one of those frequent rebuilds does not arrive
  // sliding while the rest of the column sits still — see entrance.ts.
  const entrance = createEntrance(box, '.settings-nav-item', ENTRANCE_MS);

  function paintFocus(instant = false): void {
    buttons.forEach((button, at) => {
      button.classList.toggle('is-focused', focused && at === index);
      // The section the pane is showing stays marked while the focus is in the pane — otherwise the
      // column goes blank the moment you step into the form and nothing says where you are.
      button.classList.toggle(
        'is-current',
        !focused && at === index && entries[at]?.kind === 'section',
      );
    });
    const target = buttons[index];
    if (target !== undefined) scroller.reveal(target, instant);
  }

  function announce(entered: boolean): void {
    const entry = entries[index];
    if (entry?.kind === 'section') deps.onSection(entry.id, entered);
  }

  /** The button for one entry, created on first sight of its id and kept for as long as it is offered. */
  function nodeFor(entry: SidebarEntry): HTMLButtonElement {
    const existing = nodes.get(entry.id);
    if (existing !== undefined) return existing;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-nav-item';
    // The index is resolved at click time rather than captured: the node outlives the render that made it.
    button.addEventListener('click', () => {
      const at = entries.findIndex((candidate) => candidate.id === entry.id);
      if (at === -1) return;
      index = at;
      focused = true;
      paintFocus();
      runSelected();
    });
    nodes.set(entry.id, button);
    return button;
  }

  return {
    render: (next) => {
      const previousId = entries[index]?.id;
      entries = next;
      const restored = previousId === undefined ? -1 : next.findIndex((e) => e.id === previousId);
      index = restored === -1 ? 0 : restored;
      buttons = next.map((entry, at) => {
        const button = nodeFor(entry);
        button.dataset['kind'] = entry.kind;
        button.classList.toggle('is-danger', entry.danger === true);
        button.classList.toggle('is-disabled', entry.disabled === true);
        button.style.setProperty('--nav-index', String(at));
        if (button.textContent !== entry.label) button.textContent = entry.label;
        return button;
      });
      for (const [id, node] of nodes)
        if (!next.some((entry) => entry.id === id)) {
          node.remove();
          nodes.delete(id);
        }
      // In-order sync rather than replaceChildren: re-inserting a node it already holds would restart
      // that button's animation and drop its transition state for nothing. Only what actually moved moves.
      buttons.forEach((button, at) => {
        const current = box.children[at];
        if (current !== button) box.insertBefore(button, current ?? null);
      });
      paintFocus(true);
    },
    move: (delta) => {
      if (entries.length === 0) return;
      const at = wrapIndex(index, delta, entries.length);
      if (at === index) return;
      index = at;
      deps.audio.play('navigate');
      paintFocus();
      // Moving through the column PREVIEWS the section beside it: seeing what you are about to open is
      // the whole reason the column is there.
      announce(false);
    },
    activate: () => runSelected(),
    selected: () => entries[index],
    hasFocus: () => focused,
    setFocused: (value) => {
      focused = value;
      paintFocus();
    },
    select: (id) => {
      const at = entries.findIndex((entry) => entry.id === id);
      if (at === -1) return false;
      index = at;
      // Instant, like reset(): a screen that OPENS on a section must already be there, not glide to it
      // from the top while the user watches.
      paintFocus(true);
      return true;
    },
    reset: () => {
      index = 0;
      paintFocus(true);
    },
    animateIn: () => entrance.play(),
  };

  function runSelected(): void {
    const entry = entries[index];
    if (entry === undefined) return;
    if (entry.kind === 'section') {
      deps.audio.play('button');
      announce(true);
      return;
    }
    if (entry.disabled === true) return;
    deps.onAction(entry.id);
  }
}
