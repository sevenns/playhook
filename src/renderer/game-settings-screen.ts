// The Customize screen's controller — the launcher's per-game manifest editor, and the fifth surface of
// the UI. It owns the loaded manifest, the form state, the row focus and the stack of surfaces that open
// on top of it, and exposes the SAME six navigation primitives everything else does, so controls.ts only
// has to route to it.
//
// Three things are worth knowing before reading the rest:
//
//  • THE FILE IS THE UNIT, THE GAME IS THE SLOT. gameConfig:read hands over the whole game.json text; the
//    screen finds ITS slot by `id` (never by an index from main — see the plan, Р2), edits that one, and
//    serializes every slot back. A neighbour the form cannot represent is carried through verbatim as a
//    raw slot, so saving one game never destroys another.
//
//  • SAVING IS EXPLICIT. Unlike Settings, a value change writes nothing: every keystroke would mean a
//    write to removable media plus a manifest reload, and an intermediate invalid state cannot be written
//    at all. Save & Apply is gated on the validator; Reset re-reads from disk; leaving while dirty asks.
//
//  • ONE data-overlay, A STACK OF SURFACES. `#app[data-overlay='game-settings']` is a single attribute
//    value carrying every CSS rule that makes this screen visible, so the keyboard and the file picker
//    are NOT overlays of their own (switching the value would extinguish the screen under them). They are
//    surfaces on a stack inside it, and the six primitives are routed to whichever is on top.
import type {
  BrowseInfo,
  ConfigPickKind,
  ConfigPickResult,
  ConfigSaveResult,
  ConfigValidationResult,
  GameConfigReadResult,
  GameConfigSaveRequest,
  ManifestSource,
} from '../shared/types';
import type { Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createHoverGuard } from './hover-guard.js';
import { clampIndex, wrapIndex } from './index-math.js';
import { createScroller, pxUnit } from './screen-scroller.js';
import type { NavSurface } from './nav-surface.js';
import {
  emptyFormModel,
  gamesToText,
  isRawSlot,
  textToGames,
  type GameFormState,
  type InstallType,
  type LaunchMode,
  type ManifestFormModel,
} from './configure-form-model.js';
import {
  buildGameSettingsModel,
  defaultLaunchMode,
  pickKindFor,
  withInstallType,
  withLaunchMode,
  type GameRowId,
  type GameSettingsModel,
  type GameSettingsRow,
} from './game-settings-model.js';
import {
  applyThumbnails,
  isFocusable,
  patchGameRow,
  relocalizeGameRow,
  relocalizeGameSections,
  renderGameSettings,
  screenHeading,
  type RenderedGameRow,
} from './game-settings-view.js';
import { optionLabel, optionLabelNode, rowLabelText, type CoreOption } from './row-view-core.js';

/** Gamepad A doesn't trigger :active — the same press flash the rest of the UI uses. */
const PRESS_MS = 130;
/** How long the screen waits after a change before asking main to validate the text. */
const VALIDATE_DEBOUNCE_MS = 400;
/** Marquee speed for a clipped menu label, in DESIGN px per second (the Settings dropdown's constant). */
const MARQUEE_SPEED_PX_PER_S = 60;

/** What the screen sends to main. A seam, so app.ts owns the window.api wiring. */
export interface GameSettingsScreenApi {
  read(id: string): Promise<GameConfigReadResult>;
  validate(root: string, text: string): Promise<ConfigValidationResult>;
  save(request: GameConfigSaveRequest): Promise<ConfigSaveResult>;
  imagePreview(root: string, path: string): Promise<string | null>;
}

/** The three questions this screen asks through the launcher's shared confirm popup. */
export type GameSettingsConfirm = 'reset' | 'delete' | 'discard';

/** A surface that opens ON TOP of the screen and hands a value back when it is done. */
export interface TextEntrySurface extends NavSurface {
  open(request: {
    readonly value: string;
    readonly mode: 'text' | 'id' | 'number';
    readonly title: string;
    readonly onDone: (value: string) => void;
  }): void;
}

export interface FilePickerSurface extends NavSurface {
  open(request: {
    readonly root: string;
    readonly kind: ConfigPickKind;
    readonly current: string;
    readonly multi: boolean;
    readonly onDone: (result: ConfigPickResult) => void;
  }): void;
}

export interface GameSettingsScreenDeps {
  readonly audio: AudioController;
  getTranslator(): Translator;
  readonly api: GameSettingsScreenApi;
  /** The on-screen keyboard — without it there is no way to type on a gamepad (see the plan, Р4). */
  readonly keyboard: TextEntrySurface;
  /** The in-launcher file browser — the native dialog cannot be driven in Game Mode (Р5). */
  readonly picker: FilePickerSurface;
  /** The screen closed itself (B / Esc / veil) — controls.ts restores the bar focus. */
  onClosed(): void;
  /** Asks the shared confirm popup; the answer arrives back through confirmAccepted. */
  onConfirmRequested(kind: GameSettingsConfirm): void;
  /** Whether the game is running / installing / being force-closed — Delete is hidden then (Р3). */
  isBusy(): boolean;
}

export interface GameSettingsScreen extends NavSurface {
  /** Opens the screen for one game, reading its manifest. */
  open(id: string): void;
  close(): void;
  /** browse:update arrived: the screen closes when its game is gone or no longer playable (Р6.2). */
  applyBrowse(browse: BrowseInfo | null): void;
  /** The confirm popup answered yes for `kind`. */
  confirmAccepted(kind: GameSettingsConfirm): void;
  /** Whether there are unsaved edits (controls.ts wording for the leave confirm). */
  isDirty(): boolean;
  /** Whether the loaded game is a LOCAL one — its save backups outlive a deletion, and the confirm says so. */
  deletesLocalGame(): boolean;
}

/**
 * One level of the column menu. `select` is a list of VALUES — the current one is focused and choosing
 * one is the way out, so it needs no Close. `menu` is a genuine action popup (a path's Browse/Clear, the
 * list editor): it gets a Close entry appended and opens focused on it, which is the rule every action
 * stack in this launcher follows.
 */
interface MenuLevel {
  readonly kind: 'select' | 'menu';
  readonly title: string;
  readonly entries: readonly MenuEntry[];
  focus: number;
}

interface MenuEntry {
  readonly label: string;
  /** Marks the value a dropdown currently holds (underlined, like the Settings dropdown). */
  readonly current?: boolean;
  readonly run: () => void;
}

export function createGameSettingsScreen(deps: GameSettingsScreenDeps): GameSettingsScreen {
  const app = req('app');
  const screen = req('game-settings');
  const veil = screen.querySelector<HTMLElement>('.settings-veil');
  const listEl = req('game-settings-list');
  const headingEl = req('game-settings-heading');
  const menuEl = req('game-settings-options');
  const menuListEl = req('game-settings-options-list');
  const menuVeil = menuEl.querySelector<HTMLElement>('.settings-options-veil');
  const lightboxEl = req('lightbox');
  const lightboxImage = req<HTMLImageElement>('lightbox-image');
  const lightboxCaption = req('lightbox-caption');
  const sourceEl = req('game-settings-source');

  const t = (): Translator => deps.getTranslator();

  let open = false;
  let gameId = '';
  // Where the manifest came from, and the media signature it was read against (the swap guard, Р6.2).
  let origin: {
    readonly root: string;
    readonly source: ManifestSource;
    readonly signature: string;
  } | null = null;
  // Every game in the file. Ours is `slots[slotIndex]`; the others are only ever carried through.
  let slots: GameFormState[] = [];
  let slotIndex = -1;
  let form: ManifestFormModel = emptyFormModel();
  let rest: Readonly<Record<string, unknown>> = {};
  let corrupt: Readonly<Record<string, unknown>> = {};
  let mixed = false;
  let loadedId = '';
  /** The text as it was read. Dirty is "what we would write differs from this". */
  let baseline = '';
  /** Set when OUR slot cannot be represented at all — the screen shows the reason and two ways out. */
  let unreadable: string | null = null;

  let issues: ReadonlyMap<string, string> = new Map();
  let otherIssues: readonly string[] = [];
  /**
   * The problems that were ALREADY in the other games' slots when the screen opened. Save is allowed
   * while they are there — the file is not ours to fix from a per-game screen, and a game that failed to
   * resolve is not even in the carousel — but a NEW one means we introduced it (see the plan, Э4).
   */
  let baselineOtherIssues: ReadonlySet<string> = new Set();
  let ownIssues = false;
  let status: string | null = null;

  let model: GameSettingsModel | null = null;
  let rendered: readonly RenderedGameRow[] = [];
  let focusIndex = 0;
  let validateTimer = 0;
  /** Guards a late answer from a validation whose text is already stale. */
  let validateToken = 0;

  const menuStack: MenuLevel[] = [];
  let menuButtons: readonly HTMLButtonElement[] = [];
  /** The artwork viewer is the topmost surface of all — a look at a picture, closed by B or the veil. */
  let lightboxOpen = false;

  const listScroller = createScroller(listEl);
  const menuScroller = createScroller(menuListEl);
  const hover = createHoverGuard();

  // ── Form state ─────────────────────────────────────────────────────────────

  /** The whole file as it would be written right now. */
  function currentText(): string {
    if (slotIndex < 0) return baseline;
    const next = [...slots];
    next[slotIndex] = { model: form, rest, corrupt };
    return gamesToText(next);
  }

  function dirty(): boolean {
    return unreadable === null && currentText() !== baseline;
  }

  /**
   * Deleting a game is allowed for a local one always, and for a card game only while it is not the last
   * (a card with no manifest is a card the launcher cannot see). Never while the game is busy: the file
   * would lose a game the running launcher still holds a manifest for.
   */
  function canDelete(): boolean {
    if (origin === null || deps.isBusy()) return false;
    return origin.source === 'pc' ? true : slots.length >= 2;
  }

  function canSave(): boolean {
    if (origin === null || unreadable !== null) return false;
    if (ownIssues) return false;
    // A problem in someone else's slot that was NOT there when we opened is one we introduced.
    return otherIssues.every((issue) => baselineOtherIssues.has(issue));
  }

  function currentModel(): GameSettingsModel | null {
    if (origin === null) return null;
    return buildGameSettingsModel(form, {
      source: origin.source,
      root: origin.root,
      loadedId,
      mixed,
      issues,
      otherIssues,
      status,
      canSave: canSave(),
      dirty: dirty(),
      canDelete: canDelete(),
    });
  }

  /** Applies a new form state: repaint, re-validate, and refresh whatever thumbnails changed. */
  function updateForm(next: ManifestFormModel): void {
    form = next;
    render();
    scheduleValidate();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function rowsOf(next: GameSettingsModel): readonly GameSettingsRow[] {
    return next.sections.flatMap((section) => section.rows);
  }

  /** Whether two models describe the same rows in the same order (a patch is enough when they do). */
  function sameComposition(a: GameSettingsModel, b: GameSettingsModel): boolean {
    const ids = (m: GameSettingsModel): string =>
      m.sections.flatMap((section) => section.rows.map((row) => `${row.kind}:${row.id}`)).join('|');
    return ids(a) === ids(b);
  }

  /** Every artwork path the screen currently shows, so a patch can tell whether the strips are stale. */
  function artworkSignature(from: GameSettingsModel): string {
    return rowsOf(from)
      .map((row) => {
        if (row.kind === 'list' && row.preview !== undefined) return row.items.join(',');
        if (row.kind === 'path' && row.preview !== undefined) return row.value;
        return '';
      })
      .join('|');
  }

  function renderMessage(text: string): void {
    listEl.replaceChildren();
    const line = document.createElement('div');
    line.className = 'settings-section-title';
    line.textContent = text;
    listEl.append(line);
    rendered = [];
  }

  function render(): void {
    const next = currentModel();
    headingEl.textContent = screenHeading(next, t());
    sourceEl.textContent = next === null ? '' : `(${rowLabelText(next.source, t())})`;
    if (unreadable !== null) {
      renderUnreadable();
      return;
    }
    if (next === null) {
      model = null;
      renderMessage(t()('gameSettings.loading'));
      return;
    }
    if (model !== null && sameComposition(model, next) && rendered.length > 0) {
      const rows = rowsOf(next);
      const artworkChanged = artworkSignature(model) !== artworkSignature(next);
      rendered.forEach((row, index) => {
        const nextRow = rows[index];
        if (nextRow !== undefined) patchGameRow(row, nextRow, t());
      });
      model = next;
      // A patch keeps the DOM, thumbnails included — so the strip has to be re-read whenever the paths
      // behind it moved. Without this, adding a background to an existing list left the previous strip
      // on screen (the row composition had not changed, so nothing rebuilt).
      if (artworkChanged) void refreshThumbnails();
      return;
    }
    model = next;
    rendered = renderGameSettings(listEl, next, t()).rows;
    focusIndex = nearestFocusable(focusIndex, 1);
    applyRowFocus(true);
    requestAnimationFrame(() => listScroller.fades());
    void refreshThumbnails();
  }

  /**
   * The state for a slot the form cannot show at all. Sending the user off to "edit game.json by hand" is
   * no answer — in Game Mode on a Deck that means "you cannot" — and the JSON tab the old window fell
   * back to no longer exists. So the screen offers the two things that ARE possible from here.
   */
  function renderUnreadable(): void {
    model = null;
    listEl.replaceChildren();
    const section = document.createElement('div');
    section.className = 'settings-section';
    const title = document.createElement('div');
    title.className = 'settings-section-title';
    title.textContent = t()('gameSettings.slotUnreadable', { message: unreadable ?? '' });
    section.append(title);
    listEl.append(section);
    rendered = [];
  }

  /** Reads the artwork rows' thumbnails (one invoke per path) and drops them into their rows. */
  async function refreshThumbnails(): Promise<void> {
    const root = origin?.root;
    if (root === undefined) return;
    for (const row of rendered) {
      const source = row.row;
      if (source.kind === 'list' && source.preview !== undefined) {
        const urls = await Promise.all(
          source.items.map((item) => deps.api.imagePreview(root, item)),
        );
        applyThumbnails(row, urls, source.preview, source.items);
      } else if (source.kind === 'path' && source.preview !== undefined) {
        const url = source.value === '' ? null : await deps.api.imagePreview(root, source.value);
        applyThumbnails(row, [url], source.preview, [source.value]);
      }
    }
  }

  // ── Focus ──────────────────────────────────────────────────────────────────

  /** The nearest focusable row at or after `index`, searching in `direction`; falls back to any. */
  function nearestFocusable(index: number, direction: number): number {
    if (rendered.length === 0) return 0;
    const start = Math.min(Math.max(index, 0), rendered.length - 1);
    for (let i = start; i >= 0 && i < rendered.length; i += direction) {
      const row = rendered[i];
      if (row !== undefined && isFocusable(row.row)) return i;
    }
    for (let i = start; i >= 0 && i < rendered.length; i -= direction) {
      const row = rendered[i];
      if (row !== undefined && isFocusable(row.row)) return i;
    }
    return start;
  }

  function applyRowFocus(instant = false): void {
    rendered.forEach((row, index) => row.el.classList.toggle('is-focused', index === focusIndex));
    const target = rendered[focusIndex];
    if (target === undefined) return;
    listScroller.reveal(target.el, instant);
  }

  /** Steps to the next FOCUSABLE row, walking past the notes and static lines in between. */
  function moveRowFocus(delta: number): void {
    if (rendered.length === 0) return;
    let next = focusIndex;
    for (;;) {
      const stepped = clampIndex(next, delta, rendered.length);
      if (stepped === next) return; // at the edge — no move, no sound
      next = stepped;
      const row = rendered[next];
      if (row !== undefined && isFocusable(row.row)) break;
    }
    focusIndex = next;
    deps.audio.play('navigate');
    applyRowFocus();
  }

  function pressFlash(el: HTMLElement): void {
    el.classList.add('is-pressed');
    window.setTimeout(() => el.classList.remove('is-pressed'), PRESS_MS);
  }

  // ── The column menu (expanded dropdown / row actions / list editing) ────────

  function menuTop(): MenuLevel | undefined {
    return menuStack[menuStack.length - 1];
  }

  function paintMenu(): void {
    const level = menuTop();
    if (level === undefined) {
      menuButtons = [];
      menuListEl.replaceChildren();
      screen.classList.remove('is-options-open');
      menuEl.classList.remove('is-open');
      menuEl.setAttribute('aria-hidden', 'true');
      return;
    }
    const buttons = level.entries.map((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-option';
      button.append(optionLabelNode(entry.label));
      button.classList.toggle('is-current', entry.current === true);
      button.addEventListener('click', () => {
        pressFlash(button);
        level.focus = index;
        entry.run();
      });
      return button;
    });
    menuButtons = buttons;
    menuListEl.replaceChildren(...buttons);
    screen.classList.add('is-options-open');
    menuEl.classList.add('is-open');
    menuEl.setAttribute('aria-hidden', 'false');
    // Measured synchronously: reading clientWidth flushes the layout for the nodes just inserted, which
    // a requestAnimationFrame callback would only reach on the next frame — and never at all in a window
    // that is not painting.
    updateMenuMarquee();
    applyMenuFocus(true);
  }

  /**
   * Marks every entry whose label does not fit as clipped (a soft fade at the cut) and scrolls the
   * FOCUSED one. The labels here are paths and file names, so most of them will not fit — cutting them
   * would leave the user choosing between three items that all read the same.
   */
  function updateMenuMarquee(): void {
    const first = menuButtons[0]?.querySelector<HTMLElement>('.settings-option-clip');
    if (first !== null && first !== undefined && first.clientWidth === 0) {
      requestAnimationFrame(() => updateMenuMarquee());
      return;
    }
    for (const button of menuButtons) {
      const clip = button.querySelector<HTMLElement>('.settings-option-clip');
      const text = button.querySelector<HTMLElement>('.settings-option-text');
      if (clip === null || text === null) continue;
      const overflow = text.scrollWidth - clip.clientWidth;
      const clipped = overflow > 1;
      button.classList.toggle('is-clipped', clipped);
      if (clipped && button.classList.contains('is-focused')) {
        text.style.setProperty('--marquee-shift', `${-overflow}px`);
        text.style.setProperty(
          '--marquee-duration',
          `${Math.max(2, overflow / (MARQUEE_SPEED_PX_PER_S * pxUnit()))}s`,
        );
        button.classList.add('is-scrolling');
      } else {
        button.classList.remove('is-scrolling');
        text.style.removeProperty('--marquee-shift');
        text.style.removeProperty('--marquee-duration');
      }
    }
  }

  function applyMenuFocus(instant = false): void {
    const level = menuTop();
    if (level === undefined) return;
    menuButtons.forEach((button, index) =>
      button.classList.toggle('is-focused', index === level.focus),
    );
    const focused = menuButtons[level.focus];
    if (focused !== undefined) menuScroller.reveal(focused, instant);
    updateMenuMarquee(); // only the focused label moves
  }

  /**
   * Appends the Close entry an action popup ends with, and points the focus at it. Same shape as every
   * popup stack in the launcher: the way out is the default, and it is at the bottom where the thumb is.
   */
  function asMenu(level: {
    readonly title: string;
    readonly entries: readonly MenuEntry[];
  }): MenuLevel {
    const entries: MenuEntry[] = [
      ...level.entries,
      {
        label: t()('launcher.menu.close'),
        run: () => {
          deps.audio.play('back');
          popMenu();
        },
      },
    ];
    return { kind: 'menu', title: level.title, entries, focus: entries.length - 1 };
  }

  function pushMenu(level: MenuLevel): void {
    hover.arm();
    menuStack.push(level);
    paintMenu();
  }

  function popMenu(): void {
    menuStack.pop();
    paintMenu();
  }

  function closeMenus(): void {
    menuStack.length = 0;
    paintMenu();
  }

  /** Replaces the top level in place — used after an edit so the list the user is in stays current. */
  function replaceMenu(level: MenuLevel): void {
    menuStack.pop();
    menuStack.push(level);
    paintMenu();
  }

  // ── Field editing ──────────────────────────────────────────────────────────

  /** Writes one field of the form model by row id. Everything a row can change goes through here. */
  function setField(id: GameRowId, value: string): void {
    switch (id) {
      case 'title': {
        // The id follows the title until the user takes the id over, exactly as the old form did: a slug
        // is a good first guess and a terrible override.
        const slug = slugifyTitle(value);
        const followed = form.id === '' || form.id === slugifyTitle(form.title);
        updateForm({ ...form, title: value, ...(followed ? { id: slug } : {}) });
        return;
      }
      case 'id':
        updateForm({ ...form, id: value });
        return;
      case 'executable':
        updateForm({ ...form, executable: value });
        return;
      case 'pc.executable':
        updateForm({ ...form, pc: { ...form.pc, executable: value } });
        return;
      case 'install.installer':
        updateForm({ ...form, install: { ...form.install, installer: value } });
        return;
      case 'copyInstall.installer':
        updateForm({ ...form, copyInstall: { ...form.copyInstall, installer: value } });
        return;
      case 'steam.appid':
        updateForm({ ...form, steam: { ...form.steam, appid: value } });
        return;
      case 'gridImage':
        updateForm({ ...form, gridImage: value });
        return;
      case 'saveOnCard':
        updateForm({ ...form, saveOnCard: value });
        return;
      case 'pcSavePath':
        updateForm({ ...form, pcSavePath: value });
        return;
      case 'backgroundMusic':
        updateForm({ ...form, backgroundMusic: value });
        return;
      case 'launchTimeoutSec':
        updateForm({ ...form, launchTimeoutSec: value });
        return;
      case 'killTimeoutSec':
        updateForm({ ...form, killTimeoutSec: value });
        return;
      case 'umuGameId':
        updateForm({ ...form, umuGameId: value });
        return;
      default:
        return;
    }
  }

  function setList(id: GameRowId, items: readonly string[]): void {
    switch (id) {
      case 'args':
        updateForm({ ...form, args: items });
        return;
      case 'watchProcesses':
        updateForm({ ...form, watchProcesses: items });
        return;
      case 'heroImage':
        updateForm({ ...form, heroImage: items });
        return;
      case 'winetricks':
        updateForm({ ...form, winetricks: items });
        return;
      case 'install.args':
        updateForm({ ...form, install: { ...form.install, args: items } });
        return;
      case 'install.winetricks':
        updateForm({ ...form, install: { ...form.install, winetricks: items } });
        return;
      default:
        return;
    }
  }

  function toggleField(id: GameRowId): void {
    switch (id) {
      case 'runAsAdmin':
        updateForm({ ...form, runAsAdmin: !form.runAsAdmin });
        return;
      case 'copyToPc':
        updateForm({ ...form, copyToPc: !form.copyToPc });
        return;
      case 'install.runAsAdmin':
        if (form.install.type === 'custom') return; // forced off — the manifest forbids the pair
        updateForm({ ...form, install: { ...form.install, runAsAdmin: !form.install.runAsAdmin } });
        return;
      default:
        return;
    }
  }

  function setSelect(id: GameRowId, value: string): void {
    if (id === 'launchMode') {
      updateForm(withLaunchMode(form, value as LaunchMode));
      return;
    }
    if (id === 'install.type') updateForm(withInstallType(form, value as InstallType));
  }

  /** The title's slug, in the same shape configure-form-model's slugifyId produces. */
  function slugifyTitle(title: string): string {
    return title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // ── Row activation ─────────────────────────────────────────────────────────

  function openSelectMenu(row: Extract<GameSettingsRow, { kind: 'select' }>): void {
    const options: readonly CoreOption[] = row.options;
    pushMenu({
      kind: 'select',
      title: '',
      focus: Math.max(
        0,
        options.findIndex((option) => option.value === row.value),
      ),
      entries: options.map((option) => ({
        label: optionLabel(option, t()),
        current: option.value === row.value,
        run: () => {
          closeMenus();
          deps.audio.play('button');
          setSelect(row.id, option.value);
        },
      })),
    });
  }

  function cycleSelect(row: Extract<GameSettingsRow, { kind: 'select' }>, delta: number): void {
    if (row.options.length === 0) return;
    const current = row.options.findIndex((option) => option.value === row.value);
    const next = wrapIndex(current === -1 ? 0 : current, delta, row.options.length);
    const option = row.options[next];
    if (option === undefined) return;
    deps.audio.play('navigate');
    setSelect(row.id, option.value);
  }

  function stepNumber(row: Extract<GameSettingsRow, { kind: 'number' }>, delta: number): void {
    const parsed = Number.parseInt(row.value, 10);
    const base = Number.isFinite(parsed) ? parsed : 0;
    const next = Math.min(row.max, Math.max(row.min, base + delta * row.step));
    if (String(next) === row.value) return;
    deps.audio.play('navigate');
    setField(row.id, String(next));
  }

  function openKeyboardFor(row: Extract<GameSettingsRow, { kind: 'text' | 'number' }>): void {
    deps.keyboard.open({
      value: row.value,
      mode: row.kind === 'number' ? 'number' : row.id === 'id' ? 'id' : 'text',
      title: rowTitle(row),
      onDone: (value) => setField(row.id, value),
    });
  }

  function rowTitle(row: GameSettingsRow): string {
    if (row.kind === 'note') return '';
    if (row.kind === 'action') return '';
    return 'key' in row.label ? t()(row.label.key) : row.label.text;
  }

  /** A path row's own little menu: browse for a new value, or clear the one it has. */
  function openPathMenu(row: Extract<GameSettingsRow, { kind: 'path' }>): void {
    const entries: MenuEntry[] = [
      { label: t()('gameSettings.browse'), run: () => browseInto(row.id, row.value, false) },
    ];
    if (row.value !== '' && row.preview !== undefined) {
      entries.push({
        label: t()('gameSettings.viewImage'),
        run: () => void showImage(row.value),
      });
    }
    if (row.value !== '') {
      entries.push({
        label: t()('gameSettings.clear'),
        run: () => {
          closeMenus();
          deps.audio.play('button');
          setField(row.id, '');
        },
      });
    }
    pushMenu(asMenu({ title: rowTitle(row), entries }));
  }

  /** Opens the artwork at full size. Nothing but a look — B (or the veil) closes it. */
  async function showImage(relative: string): Promise<void> {
    const root = origin?.root;
    if (root === undefined || relative === '') return;
    const url = await deps.api.imagePreview(root, relative);
    if (url === null) return;
    deps.audio.play('button');
    lightboxImage.src = url;
    lightboxCaption.textContent = relative;
    lightboxOpen = true;
    lightboxEl.classList.add('is-open');
    lightboxEl.setAttribute('aria-hidden', 'false');
  }

  function closeImage(): void {
    if (!lightboxOpen) return;
    lightboxOpen = false;
    lightboxEl.classList.remove('is-open');
    lightboxEl.setAttribute('aria-hidden', 'true');
    lightboxImage.removeAttribute('src');
  }

  /** Opens the file browser for a field and writes what it picked back into the form. */
  function browseInto(
    id: GameRowId,
    current: string,
    multi: boolean,
    onPicked?: (paths: readonly string[]) => void,
  ): void {
    const at = origin;
    if (at === null) return;
    const kind = pickKindFor(id, form.launchMode, at.source);
    if (kind === null) return;
    closeMenus();
    deps.picker.open({
      root: at.root,
      kind,
      current,
      multi,
      onDone: (result) => {
        if (!result.ok) {
          if (!('cancelled' in result)) setStatus(result.message);
          return;
        }
        if (onPicked !== undefined) {
          onPicked(result.paths);
          return;
        }
        const first = result.paths[0];
        if (first !== undefined) setField(id, first);
      },
    });
  }

  // ── List editing (its own level of the column menu) ─────────────────────────

  function openListMenu(row: Extract<GameSettingsRow, { kind: 'list' }>): void {
    pushMenu(buildListLevel(row.id, row.items, row.max, row.preview !== undefined, rowTitle(row)));
  }

  function buildListLevel(
    id: GameRowId,
    items: readonly string[],
    max: number,
    isPath: boolean,
    title: string,
  ): MenuLevel {
    const entries: MenuEntry[] = items.map((item, index) => ({
      label: item,
      run: () => openItemMenu(id, items, index, max, isPath, title),
    }));
    if (max === 0 || items.length < max) {
      entries.push({
        label: t()('gameSettings.listAdd'),
        run: () => {
          if (isPath) {
            browseInto(id, '', max !== 1, (paths) => {
              const room = max === 0 ? paths.length : Math.max(0, max - items.length);
              setList(id, [...items, ...paths.slice(0, room)]);
            });
            return;
          }
          deps.keyboard.open({
            value: '',
            mode: 'text',
            title,
            onDone: (value) => {
              if (value.trim() === '') return;
              const next = [...items, value];
              setList(id, next);
              replaceMenu(buildListLevel(id, next, max, isPath, title));
            },
          });
        },
      });
    }
    return asMenu({ title, entries });
  }

  function openItemMenu(
    id: GameRowId,
    items: readonly string[],
    index: number,
    max: number,
    isPath: boolean,
    title: string,
  ): void {
    const commit = (next: readonly string[]): void => {
      setList(id, next);
      // Back to the list itself, refreshed — the user is usually not done after one change.
      menuStack.pop();
      replaceMenu(buildListLevel(id, next, max, isPath, title));
    };
    const entries: MenuEntry[] = [];
    if (isPath) {
      entries.push({
        label: t()('gameSettings.viewImage'),
        run: () => void showImage(items[index] ?? ''),
      });
    }
    entries.push({
      label: t()('gameSettings.listReplace'),
      run: () => {
        if (isPath) {
          browseInto(id, items[index] ?? '', false, (paths) => {
            const picked = paths[0];
            if (picked === undefined) return;
            setList(
              id,
              items.map((item, i) => (i === index ? picked : item)),
            );
          });
          return;
        }
        deps.keyboard.open({
          value: items[index] ?? '',
          mode: 'text',
          title,
          onDone: (value) => {
            if (value.trim() === '') return;
            commit(items.map((item, i) => (i === index ? value : item)));
          },
        });
      },
    });
    // Reordering is a gamepad gesture here, not a drag: the manifest's order is load-bearing (the first
    // hero image is the one the carousel crops its card from), and a mouse-only affordance would put that
    // out of reach in Game Mode.
    if (index > 0) {
      entries.push({
        label: t()('gameSettings.listMoveUp'),
        run: () => commit(swap(items, index, index - 1)),
      });
    }
    if (index < items.length - 1) {
      entries.push({
        label: t()('gameSettings.listMoveDown'),
        run: () => commit(swap(items, index, index + 1)),
      });
    }
    entries.push({
      label: t()('gameSettings.listRemove'),
      run: () => commit(items.filter((_, i) => i !== index)),
    });
    pushMenu(asMenu({ title: items[index] ?? '', entries }));
  }

  function swap(items: readonly string[], a: number, b: number): readonly string[] {
    const next = [...items];
    const first = next[a];
    const second = next[b];
    if (first === undefined || second === undefined) return items;
    next[a] = second;
    next[b] = first;
    return next;
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  function scheduleValidate(): void {
    if (validateTimer !== 0) window.clearTimeout(validateTimer);
    validateTimer = window.setTimeout(() => {
      validateTimer = 0;
      void runValidate();
    }, VALIDATE_DEBOUNCE_MS);
  }

  /**
   * Asks main to judge the WHOLE file, then splits the verdict in two: the problems inside our slot
   * (mapped onto rows) and the ones in the other games (a summary line). The split is why the issue paths
   * matter — the validator reports a multi-game file's paths as `games.<i>.<field>`.
   */
  async function runValidate(): Promise<void> {
    const at = origin;
    if (at === null || unreadable !== null) return;
    const token = ++validateToken;
    const text = currentText();
    const result = await deps.api.validate(at.root, text);
    if (token !== validateToken) return; // a newer edit already asked
    const own = new Map<string, string>();
    const others: string[] = [];
    if (!result.ok) {
      for (const issue of result.issues) {
        const scoped = /^games\.(\d+)\.(.*)$/.exec(issue.path);
        if (scoped === null) {
          // An unscoped path belongs to the single-game shape — which is ours by definition.
          own.set(issue.path, issue.message);
          continue;
        }
        const index = Number(scoped[1]);
        const field = scoped[2] ?? '';
        if (index === slotIndex) own.set(field, issue.message);
        else others.push(describeOtherIssue(index, field, issue.message));
      }
    }
    issues = own;
    ownIssues = own.size > 0;
    otherIssues = others;
    render();
  }

  /** "Hades (game 3): install.args — expected array" — the other game is named when we can name it. */
  function describeOtherIssue(index: number, field: string, message: string): string {
    const slot = slots[index];
    const title =
      slot !== undefined && !isRawSlot(slot) && slot.model.title !== ''
        ? slot.model.title
        : t()('gameSettings.otherGameUnnamed');
    return t()('gameSettings.otherGameIssue', {
      game: title,
      number: index + 1,
      field: field === '' ? '—' : field,
      message,
    });
  }

  function setStatus(next: string | null): void {
    status = next;
    render();
  }

  // ── Load / save / delete ───────────────────────────────────────────────────

  async function load(id: string): Promise<void> {
    gameId = id;
    origin = null;
    unreadable = null;
    status = null;
    issues = new Map();
    otherIssues = [];
    ownIssues = false;
    render();
    const result = await deps.api.read(id);
    if (!open || gameId !== id) return; // closed (or moved on) while main was reading
    if (!result.ok) {
      origin = null;
      unreadable = result.message;
      render();
      return;
    }
    origin = { root: result.root, source: result.source, signature: result.signature };
    adoptText(result.text);
    await runValidate();
    baselineOtherIssues = new Set(otherIssues);
  }

  /** Parses a whole file into slots and picks OURS out by id. */
  function adoptText(text: string): void {
    baseline = text;
    const parsed = textToGames(text);
    if (!parsed.ok) {
      unreadable = parsed.message;
      render();
      return;
    }
    slots = parsed.games.map((game, index) =>
      game.ok
        ? { model: game.model, rest: game.rest, corrupt: game.corrupt }
        : { raw: parsed.values[index] },
    );
    slotIndex = parsed.games.findIndex((game) => game.ok && game.model.id === gameId);
    const ours = slotIndex === -1 ? undefined : parsed.games[slotIndex];
    if (ours === undefined || !ours.ok) {
      // The file no longer describes the game the carousel showed — main's list and this file disagree,
      // which is a state to report rather than to guess at.
      unreadable = t()('gameSettings.slotNotFound', { id: gameId });
      render();
      return;
    }
    form = ours.model;
    rest = ours.rest;
    corrupt = ours.corrupt;
    mixed = ours.mixed;
    loadedId = ours.model.id;
    unreadable = null;
    focusIndex = 0;
    model = null; // force a full rebuild — the composition is entirely new
    render();
  }

  async function runSave(): Promise<void> {
    const at = origin;
    if (at === null || !canSave()) return;
    const text = currentText();
    setStatus(t()('gameSettings.saving'));
    const result = await deps.api.save({ root: at.root, signature: at.signature, text });
    if (!result.saved) {
      setStatus(result.message);
      return;
    }
    baseline = text;
    // A save while the game is RUNNING writes the file but cannot reload the manifest (the launcher
    // refuses mid-play). That is not a failure — the file on disk is already right and the launcher picks
    // it up on the next read — so it is reported as what it is (see the plan, Р3).
    if (result.applied === 'applied') setStatus(t()('gameSettings.savedApplied'));
    else if (result.applied === 'deferred') setStatus(t()('gameSettings.savedDeferred'));
    else setStatus(t()('gameSettings.savedNotApplied'));
    render();
  }

  /**
   * Deleting is IMMEDIATE, unlike the old window's "remove the slot and save later": a confirmed deletion
   * that leaves the game on screen until some later Save reads as a bug. The slot is cut from the text as
   * READ, so unsaved edits are discarded with it — which the confirm says out loud.
   */
  async function runDelete(): Promise<void> {
    const at = origin;
    if (at === null || slotIndex < 0) return;
    const remaining = slots.filter((_, index) => index !== slotIndex);
    const text = gamesToText(remaining);
    const result = await deps.api.save({ root: at.root, signature: at.signature, text });
    if (!result.saved) {
      setStatus(result.message);
      return;
    }
    baseline = text;
    close();
  }

  function runReset(): void {
    adoptText(baseline);
    status = null;
    void runValidate();
  }

  // ── The six primitives ─────────────────────────────────────────────────────

  /** Which surface the primitives drive right now: the deepest open one wins. */
  function activeSurface(): NavSurface | 'lightbox' | 'menu' | 'form' {
    if (lightboxOpen) return 'lightbox';
    if (deps.keyboard.isOpen()) return deps.keyboard;
    if (deps.picker.isOpen()) return deps.picker;
    if (menuStack.length > 0) return 'menu';
    return 'form';
  }

  function moveMenuFocus(delta: number): void {
    const level = menuTop();
    if (level === undefined || level.entries.length === 0) return;
    const next = wrapIndex(level.focus, delta, level.entries.length);
    if (next === level.focus) return;
    level.focus = next;
    deps.audio.play('navigate');
    applyMenuFocus();
  }

  function navUp(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') return;
    if (surface === 'menu') return moveMenuFocus(-1);
    if (surface === 'form') return moveRowFocus(-1);
    surface.navUp();
  }

  function navDown(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') return;
    if (surface === 'menu') return moveMenuFocus(1);
    if (surface === 'form') return moveRowFocus(1);
    surface.navDown();
  }

  function navHorizontal(delta: number): void {
    const target = rendered[focusIndex];
    if (target === undefined) return;
    const row = target.row;
    if (row.kind === 'toggle') {
      if (row.disabled === true) return;
      deps.audio.play('button');
      toggleField(row.id);
      return;
    }
    if (row.kind === 'select') {
      cycleSelect(row, delta);
      return;
    }
    if (row.kind === 'number') stepNumber(row, delta);
  }

  function navLeft(repeat = false): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') return;
    if (surface === 'menu') {
      // Left leaves a level, the same way it leaves a popup: the column sits on the right edge, so moving
      // off it means "out". A HELD left is ignored, or one press would walk out through every level.
      if (!repeat) {
        deps.audio.play('back');
        popMenu();
      }
      return;
    }
    if (surface === 'form') {
      navHorizontal(-1);
      return;
    }
    surface.navLeft(repeat);
  }

  function navRight(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') return;
    if (surface === 'menu') return;
    if (surface === 'form') {
      navHorizontal(1);
      return;
    }
    surface.navRight();
  }

  function activateRow(target: RenderedGameRow): void {
    const row = target.row;
    switch (row.kind) {
      case 'toggle':
        if (row.disabled === true) return;
        deps.audio.play('button');
        pressFlash(target.el);
        toggleField(row.id);
        return;
      case 'select':
        deps.audio.play('button');
        pressFlash(target.el);
        openSelectMenu(row);
        return;
      case 'text':
      case 'number':
        deps.audio.play('button');
        pressFlash(target.el);
        openKeyboardFor(row);
        return;
      case 'path':
        deps.audio.play('button');
        pressFlash(target.el);
        openPathMenu(row);
        return;
      case 'list':
        deps.audio.play('button');
        pressFlash(target.el);
        openListMenu(row);
        return;
      case 'action':
        if (row.disabled === true) return;
        activateAction(row.id, target);
        return;
      default:
        return;
    }
  }

  function activateAction(id: GameRowId, target: RenderedGameRow): void {
    switch (id) {
      case 'save':
        deps.audio.play('button');
        pressFlash(target.el);
        void runSave();
        return;
      case 'reset':
        deps.audio.play('button');
        pressFlash(target.el);
        deps.onConfirmRequested('reset');
        return;
      case 'delete':
        deps.audio.play('button');
        pressFlash(target.el);
        deps.onConfirmRequested('delete');
        return;
      case 'close':
        navBack();
        return;
      default:
        return;
    }
  }

  function navActivate(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') {
      closeImage();
      return;
    }
    if (surface === 'menu') {
      const level = menuTop();
      const entry = level?.entries[level.focus];
      if (entry === undefined) return;
      deps.audio.play('button');
      entry.run();
      return;
    }
    if (surface === 'form') {
      const target = rendered[focusIndex];
      if (target !== undefined) activateRow(target);
      return;
    }
    surface.navActivate();
  }

  function navBack(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') {
      deps.audio.play('back');
      closeImage();
      return;
    }
    if (surface === 'menu') {
      deps.audio.play('back');
      popMenu();
      return;
    }
    if (surface !== 'form') {
      surface.navBack();
      return;
    }
    deps.audio.play('back');
    if (dirty()) {
      deps.onConfirmRequested('discard');
      return;
    }
    close();
  }

  function close(): void {
    if (!open) return;
    open = false;
    closeImage();
    closeMenus();
    if (validateTimer !== 0) {
      window.clearTimeout(validateTimer);
      validateTimer = 0;
    }
    delete app.dataset['overlay'];
    screen.setAttribute('aria-hidden', 'true');
    deps.onClosed();
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────

  listEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // A thumbnail IS the "show me this picture" affordance for the mouse; the gamepad reaches the same
    // viewer through the row's own menu. Checked before the row, or the click would also open that menu.
    if (target instanceof HTMLElement && target.classList.contains('setting-thumb')) {
      void showImage(target.dataset['path'] ?? '');
      return;
    }
    const rowEl = target.closest<HTMLElement>('.setting-row');
    if (rowEl === null) return;
    const index = rendered.findIndex((row) => row.el === rowEl);
    const entry = rendered[index];
    if (entry === undefined || !isFocusable(entry.row)) return;
    focusIndex = index;
    applyRowFocus();
    const chevronEl = target.closest<HTMLElement>('.setting-chevron');
    if (chevronEl !== null) {
      const delta = chevronEl.dataset['chevron'] === 'prev' ? -1 : 1;
      if (entry.row.kind === 'select') cycleSelect(entry.row, delta);
      else if (entry.row.kind === 'number') stepNumber(entry.row, delta);
      return;
    }
    activateRow(entry);
  });

  lightboxEl.querySelector<HTMLElement>('.lightbox-veil')?.addEventListener('click', () => {
    deps.audio.play('back');
    closeImage();
  });

  veil?.addEventListener('click', () => navBack());
  menuVeil?.addEventListener('click', () => {
    deps.audio.play('back');
    popMenu();
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
      const level = menuTop();
      if (level !== undefined) {
        const button = target.closest<HTMLButtonElement>('.settings-option');
        if (button === null) return;
        const index = menuButtons.indexOf(button);
        if (index === -1 || index === level.focus) return;
        level.focus = index;
        applyMenuFocus();
        return;
      }
      const rowEl = target.closest<HTMLElement>('.setting-row');
      if (rowEl === null) return;
      const index = rendered.findIndex((row) => row.el === rowEl);
      const entry = rendered[index];
      if (index === -1 || index === focusIndex || entry === undefined || !isFocusable(entry.row))
        return;
      focusIndex = index;
      applyRowFocus();
    },
    { passive: true },
  );

  return {
    isOpen: () => open,
    open: (id: string) => {
      if (open) return;
      open = true;
      app.dataset['overlay'] = 'game-settings';
      screen.setAttribute('aria-hidden', 'false');
      hover.arm();
      listScroller.to(0, true);
      focusIndex = 0;
      model = null;
      rendered = [];
      slots = [];
      slotIndex = -1;
      baseline = '';
      baselineOtherIssues = new Set();
      form = emptyFormModel(defaultLaunchMode('card'));
      void load(id);
    },
    close,
    navUp,
    navDown,
    navLeft,
    navRight,
    navActivate,
    navBack,
    isDirty: dirty,
    deletesLocalGame: () => origin?.source === 'pc',
    // The secondary buttons belong to whatever surface is on top, exactly as the six primitives do.
    // controls.ts routes them to the open OVERLAY — that is this screen — so they die here unless they
    // are handed down the stack.
    navSecondary: () => {
      const surface = activeSurface();
      if (typeof surface !== 'string') surface.navSecondary?.();
    },
    navTertiary: () => {
      const surface = activeSurface();
      if (typeof surface !== 'string') surface.navTertiary?.();
    },
    navShoulder: (direction) => {
      const surface = activeSurface();
      if (typeof surface !== 'string') surface.navShoulder?.(direction);
    },
    navCommit: () => {
      const surface = activeSurface();
      if (typeof surface !== 'string') surface.navCommit?.();
    },
    applyBrowse: (browse) => {
      if (!open) return;
      // The card was pulled, or swapped, or the game stopped being playable: the screen is about a file
      // that is no longer reachable, and everything under it (the carousel, the detail screen) has been
      // rebuilt already. Leaving would be worse than closing, so it closes — see the plan, Р6.2.
      if (browse !== null && browse.id === gameId && browse.active) return;
      close();
    },
    confirmAccepted: (kind) => {
      if (kind === 'reset') runReset();
      else if (kind === 'delete') void runDelete();
      else close();
    },
    relocalize: () => {
      if (model !== null) {
        relocalizeGameSections(listEl, model, t());
        for (const row of rendered) relocalizeGameRow(row, t());
        headingEl.textContent = screenHeading(model, t());
      } else {
        render();
      }
      deps.keyboard.relocalize();
      deps.picker.relocalize();
      // A menu's labels are built from the model, so it is rebuilt rather than patched.
      if (menuStack.length > 0) paintMenu();
    },
  };
}
