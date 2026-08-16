// The on-screen keyboard — the only way to type anything in this launcher.
//
// It is not a convenience. The UI has no `<input>` anywhere and its CSS forbids a caret and a selection
// outright, and the Steam Deck's own keyboard is reachable only from a game Steam itself launched — so in
// Game Mode, without this, a text field is a field you can look at. Every character of a game's title,
// its id, its launch arguments and its watched process names comes through here.
//
// Three modes and three layouts, and the pairing matters: `id` is constrained to what the manifest schema
// accepts (`[A-Za-z0-9._-]`) and therefore never offers Cyrillic, while `title` — the game's own visible
// name — must, because a Russian game has a Russian name. `number` is digits and nothing else.
//
// Every control (Shift, Backspace, Space, the layout switch, Done, Cancel) is a KEY on the grid as well
// as a button shortcut, so the keyboard is complete with the d-pad and A alone; the shortcuts (X, Y,
// LB/RB) are the faster path for someone who knows them.
import type { Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createHoverGuard } from './hover-guard.js';
import { clampIndex, wrapIndex } from './index-math.js';
import type { TextEntrySurface } from './game-settings-screen.js';

const PRESS_MS = 130;

export type OskMode = 'text' | 'id' | 'number';
type Layout = 'en' | 'ru' | 'symbols';

type Key =
  | { readonly kind: 'char'; readonly value: string }
  | { readonly kind: 'shift' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'space' }
  | { readonly kind: 'layout' }
  | { readonly kind: 'done' }
  | { readonly kind: 'cancel' };

const char = (value: string): Key => ({ kind: 'char', value });
const chars = (source: string): readonly Key[] => [...source].map(char);

const EN_ROWS: readonly (readonly Key[])[] = [
  chars('1234567890'),
  chars('qwertyuiop'),
  chars('asdfghjkl'),
  chars('zxcvbnm'),
];

const RU_ROWS: readonly (readonly Key[])[] = [
  chars('1234567890'),
  chars('йцукенгшщзхъ'),
  chars('фывапролджэ'),
  chars('ячсмитьбюё'),
];

const SYMBOL_ROWS: readonly (readonly Key[])[] = [
  chars('1234567890'),
  chars('-_.,:;/\\|'),
  chars('!?@#$%^&*~'),
  chars('()[]{}<>+='),
];

/** The `id` schema accepts exactly these punctuation marks, so those are the only ones offered. */
const ID_SYMBOL_ROWS: readonly (readonly Key[])[] = [chars('1234567890'), chars('._-')];

const NUMBER_ROWS: readonly (readonly Key[])[] = [
  chars('123'),
  chars('456'),
  chars('789'),
  chars('0'),
];

export interface OskDeps {
  readonly audio: AudioController;
  getTranslator(): Translator;
}

export function createOsk(deps: OskDeps): TextEntrySurface {
  const root = req('osk');
  const titleEl = req('osk-title');
  const valueEl = req('osk-value');
  const keysEl = req('osk-keys');
  const legendEl = req('osk-legend');

  const t = (): Translator => deps.getTranslator();

  let open = false;
  let mode: OskMode = 'text';
  let layout: Layout = 'en';
  let shifted = false;
  let value = '';
  let title = '';
  let onDone: (value: string) => void = () => undefined;

  let rows: readonly (readonly Key[])[] = [];
  let buttons: HTMLButtonElement[][] = [];
  let rowIndex = 0;
  let colIndex = 0;
  const hover = createHoverGuard();

  /** The layouts this mode offers, in the order LB/RB and the layout key cycle through them. */
  function layoutsFor(current: OskMode): readonly Layout[] {
    if (current === 'number') return ['symbols'];
    if (current === 'id') return ['en', 'symbols'];
    return ['en', 'ru', 'symbols'];
  }

  /** The character rows of the current mode + layout, before the control row is appended. */
  function letterRows(): readonly (readonly Key[])[] {
    if (mode === 'number') return NUMBER_ROWS;
    if (mode === 'id' && layout === 'symbols') return ID_SYMBOL_ROWS;
    if (layout === 'ru') return RU_ROWS;
    if (layout === 'symbols') return SYMBOL_ROWS;
    return EN_ROWS;
  }

  /**
   * Whether this mode + layout has a case to shift at all: the symbol rows and the digits have none, and
   * an id is lower-case by rule (see `insert`), so offering the key there would be offering a key that
   * lies. The legend asks the same question — one answer, two places that must agree.
   */
  function hasShift(): boolean {
    return mode !== 'number' && mode !== 'id' && layout !== 'symbols';
  }

  function controlRow(): readonly Key[] {
    const keys: Key[] = [];
    if (hasShift()) keys.push({ kind: 'shift' });
    if (layoutsFor(mode).length > 1) keys.push({ kind: 'layout' });
    if (mode !== 'number') keys.push({ kind: 'space' });
    keys.push({ kind: 'backspace' }, { kind: 'cancel' }, { kind: 'done' });
    return keys;
  }

  function keyLabel(key: Key): string {
    switch (key.kind) {
      case 'char':
        return shifted ? key.value.toUpperCase() : key.value;
      case 'shift':
        return t()('osk.shift');
      case 'backspace':
        return t()('osk.backspace');
      case 'space':
        return t()('osk.space');
      case 'layout':
        return layoutLabel(nextLayout());
      case 'done':
        return t()('osk.done');
      case 'cancel':
        return t()('osk.cancel');
    }
  }

  function layoutLabel(which: Layout): string {
    if (which === 'en') return 'ABC';
    if (which === 'ru') return 'АБВ';
    return '#+=';
  }

  function nextLayout(): Layout {
    const list = layoutsFor(mode);
    const at = list.indexOf(layout);
    return list[wrapIndex(at === -1 ? 0 : at, 1, list.length)] ?? layout;
  }

  function render(): void {
    rows = [...letterRows(), controlRow()];
    buttons = rows.map((row, r) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'osk-row';
      rowEl.style.setProperty('--osk-row', String(r));
      const rowButtons = row.map((key, c) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'osk-key';
        if (key.kind !== 'char') button.classList.add('is-wide');
        if (key.kind === 'shift' && shifted) button.classList.add('is-active');
        button.textContent = keyLabel(key);
        button.addEventListener('click', () => {
          rowIndex = r;
          colIndex = c;
          applyFocus();
          press(key, button);
        });
        rowEl.append(button);
        return button;
      });
      keysEl.append(rowEl);
      return rowButtons;
    });
    applyFocus();
  }

  function rebuild(): void {
    keysEl.replaceChildren();
    render();
    updateLegend(); // the layout may have changed, and with it whether Shift exists
  }

  function applyFocus(): void {
    rowIndex = clampIndex(rowIndex, 0, rows.length);
    const row = buttons[rowIndex] ?? [];
    colIndex = clampIndex(colIndex, 0, row.length);
    buttons.forEach((rowButtons, r) =>
      rowButtons.forEach((button, c) =>
        button.classList.toggle('is-focused', r === rowIndex && c === colIndex),
      ),
    );
  }

  function paintValue(): void {
    valueEl.textContent = value;
  }

  function pressFlash(el: HTMLElement): void {
    el.classList.add('is-pressed');
    window.setTimeout(() => el.classList.remove('is-pressed'), PRESS_MS);
  }

  function insert(text: string): void {
    // `id` is the manifest's own key for this game on disk; a character the schema rejects would only be
    // reported as an error later, so the keyboard simply does not produce one. Lower case on top of that:
    // the id is compared as written wherever this PC remembers the game by it, so two ids differing only
    // in case are two games — a distinction nobody means to draw. The slug the title proposes is
    // lower-case already, and this makes typing one by hand agree with it.
    const filtered = mode === 'id' ? text.toLowerCase().replace(/[^a-z0-9._-]/g, '') : text;
    if (filtered === '') return;
    value += filtered;
    // Shift is a one-shot, the way a phone keyboard treats it — a name is "Hades", not "HADES".
    if (shifted) {
      shifted = false;
      rebuild();
    }
    paintValue();
  }

  function backspace(): void {
    if (value === '') return;
    value = [...value].slice(0, -1).join('');
    paintValue();
  }

  function press(key: Key, el?: HTMLElement): void {
    if (el !== undefined) pressFlash(el);
    switch (key.kind) {
      case 'char':
        deps.audio.play('navigate');
        insert(shifted ? key.value.toUpperCase() : key.value);
        return;
      case 'shift':
        deps.audio.play('button');
        shifted = !shifted;
        rebuild();
        return;
      case 'backspace':
        deps.audio.play('back');
        backspace();
        return;
      case 'space':
        deps.audio.play('navigate');
        insert(' ');
        return;
      case 'layout':
        deps.audio.play('button');
        switchLayout(1);
        return;
      case 'done':
        deps.audio.play('button');
        confirm();
        return;
      case 'cancel':
        deps.audio.play('back');
        cancel();
        return;
    }
  }

  function switchLayout(direction: -1 | 1): void {
    const list = layoutsFor(mode);
    if (list.length < 2) return;
    const at = list.indexOf(layout);
    layout = list[wrapIndex(at === -1 ? 0 : at, direction, list.length)] ?? layout;
    shifted = false;
    rebuild();
    focusKind('layout');
  }

  /**
   * Puts the focus back on a CONTROL key by what it is, not by where it was. The control row is built
   * per layout — the symbol layouts have no Shift — so the same index means a different key after a
   * switch, and cycling en → ru → symbols would walk the focus off the layout key onto Space.
   */
  function focusKind(kind: Key['kind']): void {
    for (const [r, row] of rows.entries()) {
      const c = row.findIndex((key) => key.kind === kind);
      if (c === -1) continue;
      rowIndex = r;
      colIndex = c;
      applyFocus();
      return;
    }
  }

  function confirm(): void {
    const result = value;
    hide();
    onDone(result);
  }

  function cancel(): void {
    hide();
  }

  function hide(): void {
    if (!open) return;
    open = false;
    if (entranceTimer !== 0) {
      window.clearTimeout(entranceTimer);
      entranceTimer = 0;
    }
    root.classList.remove('is-entering');
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
  }

  /** How long the rows' staggered arrival runs before the class that drives it is dropped. */
  const ENTRANCE_MS = 600;
  let entranceTimer = 0;

  /**
   * Arms the rows' entrance. It has to be a class the keyboard switches on and off rather than a rule off
   * `.is-open`, because the rows are REBUILT far more often than the keyboard opens — every shift, and
   * every shifted character types one and rebuilds them back — and an animation the elements simply
   * inherit on creation would replay through all of that.
   */
  function armEntrance(): void {
    if (entranceTimer !== 0) window.clearTimeout(entranceTimer);
    root.classList.remove('is-entering');
    void root.offsetWidth;
    root.classList.add('is-entering');
    entranceTimer = window.setTimeout(() => {
      entranceTimer = 0;
      root.classList.remove('is-entering');
    }, ENTRANCE_MS);
  }

  function move(rowDelta: number, colDelta: number): void {
    hover.arm();
    if (rowDelta !== 0) {
      const next = clampIndex(rowIndex, rowDelta, rows.length);
      if (next === rowIndex) return;
      // The column is kept PROPORTIONALLY, not by index: the rows are of different lengths, and jumping
      // from the middle of a ten-key row to the end of a four-key one reads as the focus teleporting.
      const from = buttons[rowIndex]?.length ?? 1;
      const to = buttons[next]?.length ?? 1;
      const ratio = from <= 1 ? 0 : colIndex / (from - 1);
      rowIndex = next;
      colIndex = Math.round(ratio * Math.max(0, to - 1));
    } else {
      const row = buttons[rowIndex] ?? [];
      const next = wrapIndex(colIndex, colDelta, row.length);
      if (next === colIndex) return;
      colIndex = next;
    }
    deps.audio.play('navigate');
    applyFocus();
  }

  function focusedKey(): Key | undefined {
    return rows[rowIndex]?.[colIndex];
  }

  /**
   * The legend names the buttons this keyboard ACTUALLY has right now — it is built from the same two
   * conditions the control row is (see controlRow), so it can never promise a key that is not there. A
   * number pad has neither a case to shift nor a second layout to switch to, and listing both was telling
   * the user to press buttons that do nothing.
   */
  function updateLegend(): void {
    const parts: string[] = [t()('osk.legendDelete')];
    if (hasShift()) parts.push(t()('osk.legendShift'));
    if (layoutsFor(mode).length > 1) parts.push(t()('osk.legendLayout'));
    parts.push(t()('osk.legendDone'), t()('osk.legendCancel'));
    const text = parts.join(', ');
    // Rewritten only when it changed: this runs on every rebuild, and a rebuild happens on every shift.
    if (legendEl.textContent !== text) legendEl.textContent = text;
  }

  root.querySelector<HTMLElement>('.osk-veil')?.addEventListener('click', () => {
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
      const button = target.closest<HTMLButtonElement>('.osk-key');
      if (button === null) return;
      for (const [r, rowButtons] of buttons.entries()) {
        const c = rowButtons.indexOf(button);
        if (c === -1) continue;
        if (r === rowIndex && c === colIndex) return;
        rowIndex = r;
        colIndex = c;
        applyFocus();
        return;
      }
    },
    { passive: true },
  );

  /**
   * The physical keyboard writes straight through, which is the whole point of having one. It is a
   * CAPTURE listener that stops the event dead: controls.ts also listens on the window and would read
   * `a` as "move left" and Space as "activate", turning every typed letter into a navigation step.
   */
  window.addEventListener(
    'keydown',
    (event) => {
      if (!open) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key;
      if (key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        confirm();
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
        return;
      }
      if (key === 'Backspace') {
        event.preventDefault();
        event.stopImmediatePropagation();
        backspace();
        return;
      }
      if ([...key].length === 1) {
        event.preventDefault();
        event.stopImmediatePropagation();
        insert(mode === 'number' ? key.replace(/[^0-9-]/g, '') : key);
      }
    },
    { capture: true },
  );

  return {
    isOpen: () => open,
    open: (request) => {
      mode = request.mode;
      value = request.value;
      title = request.title;
      onDone = request.onDone;
      layout = layoutsFor(mode)[0] ?? 'en';
      shifted = false;
      rowIndex = 0;
      colIndex = 0;
      open = true;
      titleEl.textContent = title;
      paintValue();
      updateLegend();
      rebuild();
      hover.arm();
      root.classList.add('is-open');
      armEntrance();
      root.setAttribute('aria-hidden', 'false');
    },
    navUp: () => move(-1, 0),
    navDown: () => move(1, 0),
    navLeft: () => move(0, -1),
    navRight: () => move(0, 1),
    navActivate: () => {
      const key = focusedKey();
      if (key === undefined) return;
      press(key, buttons[rowIndex]?.[colIndex]);
    },
    navBack: () => {
      deps.audio.play('back');
      cancel();
    },
    // X is Backspace and Y is Shift — the two things a typist reaches for constantly, off the grid.
    navSecondary: () => {
      deps.audio.play('back');
      backspace();
    },
    navTertiary: () => {
      if (mode === 'number' || layout === 'symbols') return;
      deps.audio.play('button');
      shifted = !shifted;
      rebuild();
    },
    navShoulder: (direction) => {
      deps.audio.play('button');
      switchLayout(direction);
    },
    navCommit: () => {
      deps.audio.play('button');
      confirm();
    },
    relocalize: () => {
      if (!open) return;
      updateLegend();
      rebuild();
    },
  };
}
