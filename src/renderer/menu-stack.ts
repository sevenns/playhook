// The Customize screen's column menu: a STACK of levels painted into one options column — a row's
// expanded dropdown, a path's Browse/Clear, the list editor and its per-item menu, the move-target
// picker. Every level is a list of entries with one focused; the six primitives reach the stack through
// the screen, which routes to it whenever a level is open. It is the launcher's action-popup shape, so
// the rules are the popup's: the way out (Close) is the default focus and sits at the bottom, left and
// B step out one level, the veil pops one level too.
import type { SfxName } from '../shared/types.js';
import type { AudioController } from './audio.js';
import { pressFlash } from './dom.js';
import type { HoverGuard } from './hover-guard.js';
import { wrapIndex } from './index-math.js';
import { updateMarquee } from './marquee.js';
import { optionLabelNode } from './row-view-core.js';
import { createScroller } from './screen-scroller.js';

/**
 * One level of the column menu. `select` is a list of VALUES — the current one is focused and choosing
 * one is the way out, so it needs no Close. `menu` is a genuine action popup (a path's Browse/Clear, the
 * list editor): it gets a Close entry appended and opens focused on it, which is the rule every action
 * stack in this launcher follows.
 */
export interface MenuLevel {
  readonly kind: 'select' | 'menu';
  readonly title: string;
  readonly entries: readonly MenuEntry[];
  focus: number;
  /**
   * What X does on this level, if anything. Only the track list claims it (auditioning the focused
   * track): everywhere else X still means nothing inside a menu and says so with the dead-end sound.
   */
  readonly secondary?: (index: number) => void;
}

export interface MenuEntry {
  readonly label: string;
  /** Marks the value a dropdown currently holds (underlined, like the Settings dropdown). */
  readonly current?: boolean;
  /** Which sound this entry makes. One runner plays it, so a press and a click sound identical.
   *  'none' is for an entry whose own surface speaks for it — opening the file browser or the lightbox,
   *  where the primitive plays popup-open. */
  readonly sound?: SfxName | 'none';
  readonly run: () => void;
}

export interface MenuStackDeps {
  readonly audio: Pick<AudioController, 'play'>;
  /** The screen the column belongs to — it wears `is-options-open` while a level is up. */
  readonly screen: HTMLElement;
  /** The options column (`#…-options`) and the list inside it that the entries are painted into. */
  readonly menuEl: HTMLElement;
  readonly listEl: HTMLElement;
  readonly hover: Pick<HoverGuard, 'arm'>;
  /** The label of the Close entry `asMenu` appends — read live, so it follows the language. */
  closeLabel(): string;
  /**
   * Leaving a level ends whatever it had running: an audition belongs to the track list it was started
   * from, and a download the user has walked away from has nobody left to arrive for.
   */
  onLeave(): void;
}

export interface MenuStack {
  isOpen(): boolean;
  top(): MenuLevel | undefined;
  /**
   * Appends the Close entry an action popup ends with, and points the focus at it. Same shape as every
   * popup stack in the launcher: the way out is the default, and it is at the bottom where the thumb is.
   */
  asMenu(level: {
    readonly title: string;
    readonly entries: readonly MenuEntry[];
    readonly secondary?: (index: number) => void;
  }): MenuLevel;
  push(level: MenuLevel): void;
  /**
   * The single voice of leaving a level, so every way out (B, left, the Close entry, the veil) sounds the
   * same: stepping out of a deeper level is a step INSIDE the menu and keeps `back`; leaving the last one
   * is the menu going away.
   *
   * `keepWork` is for a level the SCREEN closes because it is done with it — a question that has just
   * been answered — rather than one the user backed out of. Leaving is normally the signal to abandon
   * whatever was running, and the answer to a question is immediately followed by acting on it: aborting
   * there would cancel the very download the answer just asked for.
   */
  pop(options?: { readonly keepWork?: boolean }): void;
  /** Drops every level. `silent` for a cascade — the screen closing, or a surface that already played its own close. */
  close(options?: { readonly silent?: boolean }): void;
  /** Replaces the top `depth` levels with one — used after an edit so the list the user is in stays current. */
  replace(level: MenuLevel, depth?: number): void;
  /** Repaints the top level (its labels changed under it — a language switch). */
  paint(): void;
  /** Plays an entry's sound exactly once, then runs it. The only way an entry is ever triggered. */
  runEntry(entry: MenuEntry): void;
  /** Runs the focused entry of the top level. */
  activate(): void;
  moveFocus(delta: number): void;
  applyFocus(instant?: boolean): void;
  /** A pointer moved over `target`: takes the focus onto the entry under it, if that is one. */
  hover(target: Element): void;
}

export function createMenuStack(deps: MenuStackDeps): MenuStack {
  const stack: MenuLevel[] = [];
  let buttons: readonly HTMLButtonElement[] = [];
  const scroller = createScroller(deps.listEl);
  const veil = deps.menuEl.querySelector<HTMLElement>('.settings-options-veil');

  function top(): MenuLevel | undefined {
    return stack[stack.length - 1];
  }

  function runEntry(entry: MenuEntry): void {
    if (entry.sound !== 'none') deps.audio.play(entry.sound ?? 'button');
    entry.run();
  }

  function applyFocus(instant = false): void {
    const level = top();
    if (level === undefined) return;
    buttons.forEach((button, index) =>
      button.classList.toggle('is-focused', index === level.focus),
    );
    const focused = buttons[level.focus];
    if (focused !== undefined) scroller.reveal(focused, instant);
    updateMarquee(() => buttons); // only the focused label moves
  }

  function paint(): void {
    const level = top();
    if (level === undefined) {
      buttons = [];
      deps.listEl.replaceChildren();
      deps.screen.classList.remove('is-options-open');
      deps.menuEl.classList.remove('is-open');
      deps.menuEl.setAttribute('aria-hidden', 'true');
      return;
    }
    const painted = level.entries.map((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-option';
      button.append(optionLabelNode(entry.label));
      button.classList.toggle('is-current', entry.current === true);
      button.addEventListener('click', () => {
        pressFlash(button);
        level.focus = index;
        runEntry(entry);
      });
      return button;
    });
    buttons = painted;
    deps.listEl.replaceChildren(...painted);
    deps.screen.classList.add('is-options-open');
    deps.menuEl.classList.add('is-open');
    deps.menuEl.setAttribute('aria-hidden', 'false');
    // Measured synchronously: reading clientWidth flushes the layout for the nodes just inserted, which
    // a requestAnimationFrame callback would only reach on the next frame — and never at all in a window
    // that is not painting.
    updateMarquee(() => buttons);
    applyFocus(true);
  }

  function pop(options?: { readonly keepWork?: boolean }): void {
    if (stack.length > 0) deps.audio.play(stack.length > 1 ? 'back' : 'popup-close');
    stack.pop();
    if (options?.keepWork !== true) deps.onLeave();
    paint();
  }

  veil?.addEventListener('click', () => {
    pop();
  });

  return {
    isOpen: () => stack.length > 0,
    top,
    asMenu: (level) => {
      const entries: MenuEntry[] = [
        ...level.entries,
        { label: deps.closeLabel(), sound: 'none', run: () => pop() },
      ];
      return {
        kind: 'menu',
        title: level.title,
        entries,
        focus: entries.length - 1,
        ...(level.secondary === undefined ? {} : { secondary: level.secondary }),
      };
    },
    push: (level) => {
      deps.hover.arm();
      // Only the FIRST level is a surface appearing; going deeper is a step inside one already open.
      if (stack.length === 0) deps.audio.play('popup-open');
      stack.push(level);
      paint();
    },
    pop,
    close: (options) => {
      if (stack.length > 0 && options?.silent !== true) deps.audio.play('popup-close');
      stack.length = 0;
      deps.onLeave();
      paint();
    },
    replace: (level, depth = 1) => {
      for (let i = 0; i < depth; i += 1) stack.pop();
      stack.push(level);
      paint();
    },
    paint,
    runEntry,
    activate: () => {
      const level = top();
      const entry = level?.entries[level.focus];
      if (entry === undefined) return;
      runEntry(entry);
    },
    moveFocus: (delta) => {
      const level = top();
      if (level === undefined || level.entries.length === 0) return;
      const next = wrapIndex(level.focus, delta, level.entries.length);
      if (next === level.focus) return;
      level.focus = next;
      deps.audio.play('navigate');
      applyFocus();
    },
    applyFocus,
    hover: (target) => {
      const level = top();
      if (level === undefined) return;
      const button = target.closest<HTMLButtonElement>('.settings-option');
      if (button === null) return;
      const index = buttons.indexOf(button);
      if (index === -1 || index === level.focus) return;
      level.focus = index;
      applyFocus();
    },
  };
}
