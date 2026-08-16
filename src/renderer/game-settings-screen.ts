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
  SfxName,
  ConfigPickKind,
  ConfigPickResult,
  ConfigRootReadResult,
  ConfigSaveResult,
  ConfigValidationResult,
  DriveCandidate,
  GameConfigReadResult,
  GameConfigSaveRequest,
  ManifestSource,
} from '../shared/types';
import type { MessageKey, Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createHoverGuard } from './hover-guard.js';
import { clampIndex, wrapIndex } from './index-math.js';
import { createScroller, pxUnit } from './screen-scroller.js';
import { createSidebar, type SidebarEntry } from './screen-sidebar.js';
import type { NavSurface } from './nav-surface.js';
import {
  emptyFormModel,
  gamesToText,
  isRawSlot,
  slotsWithNewGame,
  textToGames,
  type GameFormState,
  type InstallType,
  type LaunchMode,
  type ManifestFormModel,
} from './configure-form-model.js';
import {
  buildGameSettingsModel,
  carryFormAcrossSources,
  defaultLaunchMode,
  hasSourceBoundValues,
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
  /** Where a new game may be added — the cards plus the PC library (add mode only). */
  sources(): Promise<readonly DriveCandidate[]>;
  /** One root's manifest, for adding a game to it — it may carry no game yet (add mode only). */
  readRoot(root: string): Promise<ConfigRootReadResult>;
  /**
   * Drops the game's HISTORY record — its card in the carousel and the artwork copied to this PC. Only
   * ever sent after the game has left the manifest: main refuses to forget a game that is available.
   */
  forgetHistory(id: string): void;
}

/**
 * The questions this screen asks through the launcher's shared confirm popup. Deleting is TWO of them:
 * `delete` removes the game from the manifest and leaves its card in the history, `delete-history` takes
 * the card too. Which one arrives back is the user's answer to the second question — see controls.ts.
 */
export type GameSettingsConfirm =
  | 'reset'
  | 'delete'
  | 'delete-history'
  | 'discard'
  | 'switch-source';

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
    /** The root-relative sub-directory this field is measured from, when it has one (see baseFor). */
    readonly base?: string;
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
  /** A game was added AND applied: the launcher's library has it now, so the carousel goes to it. */
  onAdded(id: string): void;
}

export interface GameSettingsScreen extends NavSurface {
  /** Opens the screen for one game, reading its manifest. */
  open(id: string): void;
  /** Opens the same screen with no game behind it — the form CREATES one (see `mode`). */
  openNew(): void;
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
  /** Which sound this entry makes. One runner plays it, so a press and a click sound identical. */
  readonly sound?: SfxName;
  readonly run: () => void;
}

export function createGameSettingsScreen(deps: GameSettingsScreenDeps): GameSettingsScreen {
  const app = req('app');
  const screen = req('game-settings');
  const veil = screen.querySelector<HTMLElement>('.settings-veil');
  const listEl = req('game-settings-list');
  const navEl = req('game-settings-nav');
  const statusEl = req('game-settings-status');
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
  /**
   * What this visit is doing: editing the game named by `gameId`, or creating one. It decides the
   * heading, the Save wording, which actions the column offers, and — in a dozen small places below —
   * which half of a branch runs. Explicit, because "no gameId" is true of a screen that is still loading.
   */
  let mode: 'edit' | 'add' = 'edit';
  /** Where a new game may go. Loaded once per add visit; empty in edit mode. */
  let sources: readonly DriveCandidate[] = [];
  /** The root a pending "switch the source?" confirm is about — applied when the answer comes back. */
  let pendingSource: string | null = null;
  /**
   * The root an adoptRoot is currently reading, and the guard that keeps a late answer from overwriting a
   * newer one. Stepping the source row with the D-pad can start a second read before the first lands, and
   * the two would otherwise race — the slower one wins and the form ends up describing another root.
   */
  let adoptingRoot: string | null = null;
  let adoptToken = 0;
  // Where the manifest came from, and the media signature it was read against (the swap guard, Р6.2).
  let origin: {
    readonly root: string;
    readonly source: ManifestSource;
    readonly signature: string;
    /** Read alongside the manifest — main answers it, the renderer never asks the OS itself. */
    readonly windows: boolean;
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
  /** The rows of the SELECTED section only — the pane shows one section at a time. */
  let rendered: readonly RenderedGameRow[] = [];
  let focusIndex = 0;
  /** Which titled section the pane is showing, by its translation key. */
  let sectionKey: MessageKey | null = null;
  /** …and which one the pane is actually showing. The two differ for as long as a preview is pending. */
  let paneKey: MessageKey | null = null;
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

  /**
   * The section column. It carries this screen's actions too — Save, Discard edits, Delete, Close —
   * which is the whole point: they used to sit under six sections of form, so committing an edit meant
   * scrolling past every field you had just finished with.
   */
  const sidebar = createSidebar(navEl, {
    audio: deps.audio,
    onSection: (id, entered) => {
      sectionKey = id as MessageKey;
      if (entered) {
        enterPane();
        return;
      }
      schedulePreview();
    },
    onAction: (id) => runAction(id as GameRowId),
  });

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

  /** The source row's options: one per candidate root, labelled the way the picker labels them. */
  function sourceOptions(): readonly CoreOption[] {
    return sources.map((candidate) => ({ value: candidate.root, label: candidate.label }));
  }

  function currentModel(): GameSettingsModel | null {
    if (origin === null) return null;
    const at = origin.root;
    return buildGameSettingsModel(form, {
      mode,
      sources: mode === 'add' ? sourceOptions() : [],
      sourceLabel: sources.find((candidate) => candidate.root === at)?.label ?? null,
      source: origin.source,
      windows: origin.windows,
      root: origin.root,
      loadedId,
      mixed,
      issues,
      otherIssues,
      status,
      canSave: canSave(),
      dirty: dirty(),
      // A game that does not exist yet cannot be deleted — and for the PC library canDelete() says yes
      // to anything, so without this the column would offer "Delete game" on the Add screen.
      canDelete: mode === 'edit' && canDelete(),
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
      visibleRows(m)
        .map((row) => `${row.kind}:${row.id}`)
        .join('|');
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

  /** How long the staggered row entrance runs — the class is dropped once it is over. */
  const ENTRANCE_MS = 700;
  /** The stagger stops counting here: past a handful of rows the wave is a wait, not a wave. */
  const ENTRANCE_STEPS = 8;
  let entranceTimer = 0;

  /** Arms the one-shot entrance animation (see .settings-list.is-entering in styles.css). */
  function armEntrance(): void {
    if (entranceTimer !== 0) window.clearTimeout(entranceTimer);
    // Off and on around a forced reflow, so a caller that did not rebuild the rows still gets a replay.
    listEl.classList.remove('is-entering');
    void listEl.offsetWidth;
    listEl.classList.add('is-entering');
    entranceTimer = window.setTimeout(() => {
      entranceTimer = 0;
      listEl.classList.remove('is-entering');
    }, ENTRANCE_MS);
  }

  /**
   * How long the pane waits before showing the section the column moved onto. A held direction walks
   * through the column faster than that, so the pane is drawn ONCE, when the movement stops, instead of
   * being torn down and rebuilt — thumbnails and all — at every step.
   */
  const PREVIEW_MS = 120;
  let previewTimer = 0;

  function schedulePreview(): void {
    if (previewTimer !== 0) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = 0;
      renderPane();
    }, PREVIEW_MS);
  }

  /**
   * Brings the pane up to date with the selected section NOW, cancelling a pending preview. Anything that
   * reads the rendered rows has to call this first — including the paths that never scheduled a preview
   * at all: a MOUSE click on a section activates it without ever moving onto it, and that used to leave
   * the focus stepping into the section the pane was showing before.
   */
  function flushPreview(): void {
    if (previewTimer !== 0) {
      window.clearTimeout(previewTimer);
      previewTimer = 0;
    }
    if (paneKey !== sectionKey) renderPane();
  }

  /** A section that HAS a title — i.e. one the column can name and the pane can show. */
  interface TitledSection {
    readonly titleKey: MessageKey;
    readonly rows: readonly GameSettingsRow[];
  }

  function titledSections(from: GameSettingsModel): readonly TitledSection[] {
    return from.sections.flatMap((section) => {
      const key = section.titleKey;
      return key === undefined ? [] : [{ titleKey: key, rows: section.rows }];
    });
  }

  function currentSection(from: GameSettingsModel): TitledSection | undefined {
    const titled = titledSections(from);
    return titled.find((section) => section.titleKey === sectionKey) ?? titled[0];
  }

  /** The rows that are NOT in any titled section: this screen's actions and its notes. */
  function trailingRows(from: GameSettingsModel): readonly GameSettingsRow[] {
    return from.sections.filter((s) => s.titleKey === undefined).flatMap((s) => s.rows);
  }

  /**
   * The column: the sections, then the actions. The NOTES that share the model's last section stay out
   * of it — they are the screen's own feedback (what the last save did, why Save is unavailable), so
   * they go under both columns where they are readable from anywhere.
   */
  /**
   * What the column WOULD show — so it is only rebuilt when that actually changed. `null` means "nothing
   * is known about what is on screen", which is NOT the same as "it is empty": a re-opened screen that
   * confuses the two skips the rebuild and keeps whatever the last visit left in the DOM.
   */
  let columnSignature: string | null = null;

  function renderColumn(from: GameSettingsModel): void {
    const entries = columnEntries(from);
    const signature = entries
      .map((entry) => `${entry.id}:${entry.label}:${entry.disabled === true ? '1' : '0'}`)
      .join('|');
    // Save's enabled state follows every keystroke, so this runs constantly — rebuilding the buttons
    // each time would drop the hover state and flicker under the cursor for no reason.
    if (signature === columnSignature) return;
    columnSignature = signature;
    sidebar.render(entries);
  }

  function columnEntries(from: GameSettingsModel): readonly SidebarEntry[] {
    return [
      ...titledSections(from).map((section) => ({
        id: section.titleKey,
        label: t()(section.titleKey),
        kind: 'section' as const,
      })),
      ...trailingRows(from).flatMap((row) =>
        row.kind === 'action'
          ? [
              {
                id: row.id,
                label: rowLabelText(row.label, t()),
                kind: 'action' as const,
                ...(row.danger === true ? { danger: true } : {}),
                ...(row.disabled === true ? { disabled: true } : {}),
              },
            ]
          : [],
      ),
    ];
  }

  /** The same, for the status strip — and the same reason for the null. */
  let statusSignature: string | null = null;

  /** The notes, under both columns. */
  function renderStatus(from: GameSettingsModel): void {
    const notes = trailingRows(from).flatMap((row) => (row.kind === 'note' ? [row] : []));
    const signature = notes.map((note) => `${note.tone}:${rowLabelText(note.text, t())}`).join('|');
    if (signature === statusSignature) return;
    statusSignature = signature;
    statusEl.replaceChildren(
      ...notes.map((note) => {
        const el = document.createElement('div');
        el.className = `setting-row setting-row-note is-inert is-${note.tone}`;
        const text = document.createElement('div');
        text.className = 'setting-note-text';
        text.textContent = rowLabelText(note.text, t());
        el.append(text);
        return el;
      }),
    );
  }

  function render(): void {
    // A pending preview means `rendered` belongs to the section BEFORE the one sectionKey now names —
    // patching it against the new section's values would write them into the old section's rows.
    flushPreview();
    const next = currentModel();
    headingEl.textContent = screenHeading(
      next,
      t(),
      mode === 'add' ? 'gameSettings.addTitle' : undefined,
    );
    // Source first, then the game — it reads as a location and its contents ("E:\ · Hades"). The
    // parentheses went with the swap: a parenthetical is an aside, and an aside cannot come first.
    sourceEl.textContent = next === null ? '' : `${rowLabelText(next.source, t())} ·`;
    if (unreadable !== null) {
      renderUnreadable();
      return;
    }
    if (next === null) {
      model = null;
      renderMessage(t()('gameSettings.loading'));
      return;
    }
    const previous = model;
    model = next;
    // The column carries Save's own enabled state, so it follows every edit — unlike the Settings
    // screen's, whose entries only change when a section appears.
    renderColumn(next);
    renderStatus(next);
    if (previous !== null && sameComposition(previous, next) && rendered.length > 0) {
      const rows = visibleRows(next);
      const artworkChanged = artworkSignature(previous) !== artworkSignature(next);
      rendered.forEach((row, index) => {
        const nextRow = rows[index];
        if (nextRow !== undefined) patchGameRow(row, nextRow, t());
      });
      // A patch keeps the DOM, thumbnails included — so the strip has to be re-read whenever the paths
      // behind it moved. Without this, adding a background to an existing list left the previous strip
      // on screen (the row composition had not changed, so nothing rebuilt).
      if (artworkChanged) void refreshThumbnails();
      return;
    }
    renderPane();
  }

  /** The rows the pane currently shows — one section's worth. */
  function visibleRows(from: GameSettingsModel): readonly GameSettingsRow[] {
    return currentSection(from)?.rows ?? [];
  }

  function renderPane(): void {
    const from = model;
    if (from === null) return;
    const section = currentSection(from);
    if (section === undefined) return;
    sectionKey = section.titleKey;
    paneKey = section.titleKey;
    // WITHOUT its title: the column beside it already names the section, and printing the name again at
    // the top of the pane says the same thing twice.
    rendered = renderGameSettings(
      listEl,
      { ...from, sections: [{ rows: section.rows }] },
      t(),
    ).rows;
    rendered.forEach((row, at) =>
      row.el.style.setProperty('--row-index', String(Math.min(at, ENTRANCE_STEPS))),
    );
    armEntrance();
    focusIndex = nearestFocusable(focusIndex, 1);
    applyRowFocus(true);
    listScroller.to(0, true);
    requestAnimationFrame(() => listScroller.fades());
    void refreshThumbnails();
  }

  /** Hands the focus from the column to the pane, at its first focusable row. */
  function enterPane(): void {
    flushPreview(); // whatever the column last moved onto is what the focus is stepping into
    if (rendered.length === 0) return;
    sidebar.setFocused(false);
    focusIndex = nearestFocusable(0, 1);
    hover.arm();
    applyRowFocus();
  }

  /** …and back. The column is the only place the screen can be left from. */
  function leavePane(): void {
    closeMenus();
    sidebar.setFocused(true);
    hover.arm();
    applyRowFocus();
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

  /**
   * The thumbnails read so far, by path. Stepping back onto a section re-renders its rows, and reading
   * every picture off the disk again for a strip that has not changed is both a round trip per image and
   * a visible re-decode. Emptied on open, so a screen re-opened after the files moved starts fresh.
   */
  const thumbnails = new Map<string, string | null>();

  async function thumbnailFor(root: string, path: string): Promise<string | null> {
    const cached = thumbnails.get(path);
    if (cached !== undefined) return cached;
    const url = await deps.api.imagePreview(root, path);
    thumbnails.set(path, url);
    return url;
  }

  /** Reads the artwork rows' thumbnails (one invoke per path) and drops them into their rows. */
  async function refreshThumbnails(): Promise<void> {
    const root = origin?.root;
    if (root === undefined) return;
    for (const row of rendered) {
      const source = row.row;
      if (source.kind === 'list' && source.preview !== undefined) {
        const urls = await Promise.all(source.items.map((item) => thumbnailFor(root, item)));
        applyThumbnails(row, urls, source.preview, source.items);
      } else if (source.kind === 'path' && source.preview !== undefined) {
        const url = source.value === '' ? null : await thumbnailFor(root, source.value);
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
    const active = !sidebar.hasFocus();
    // The pane widens to the left while it holds the focus (see .settings-list in styles.css).
    listEl.classList.toggle('is-active', active);
    rendered.forEach((row, index) =>
      row.el.classList.toggle('is-focused', active && index === focusIndex),
    );
    if (!active) return;
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
        runEntry(entry);
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

  /** Plays an entry's sound exactly once, then runs it. The only way an entry is ever triggered. */
  function runEntry(entry: MenuEntry): void {
    deps.audio.play(entry.sound ?? 'button');
    entry.run();
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
      { label: t()('launcher.menu.close'), sound: 'back', run: () => popMenu() },
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
        // Lower case wherever it comes from, so the field agrees with the slug a title proposes — the
        // keyboard already refuses to type anything else (osk.ts).
        updateForm({ ...form, id: value.toLowerCase() });
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
    if (id === 'source') {
      requestSource(value);
      return;
    }
    if (id === 'launchMode') {
      updateForm(withLaunchMode(form, value as LaunchMode));
      return;
    }
    if (id === 'install.type') updateForm(withInstallType(form, value as InstallType));
  }

  /**
   * Steps the source row by `delta`, wrapping like every other select. Measured from the root being
   * ADOPTED when a read is still in flight, so a quick second press moves on rather than re-asking for
   * the same neighbour. A step that would cost something still raises the confirm — and the popup takes
   * the input while it is up, so a HELD direction cannot stack a queue of questions behind it.
   */
  function cycleSource(delta: number): void {
    if (sources.length === 0) return;
    const current = adoptingRoot ?? origin?.root ?? '';
    const at = sources.findIndex((candidate) => candidate.root === current);
    const next = sources[wrapIndex(at === -1 ? 0 : at, delta, sources.length)];
    if (next === undefined || next.root === current) return;
    deps.audio.play('navigate');
    requestSource(next.root);
  }

  /**
   * Moves the new game to another root, asking first only when the move would COST something: the paths
   * and the install block are read against a root, so they cannot travel with it (see
   * carryFormAcrossSources). With nothing but a name typed there is nothing to warn about.
   */
  function requestSource(root: string): void {
    if (root === (adoptingRoot ?? origin?.root)) return;
    if (hasSourceBoundValues(form)) {
      pendingSource = root;
      deps.onConfirmRequested('switch-source');
      return;
    }
    void adoptRoot(root);
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
          setSelect(row.id, option.value);
        },
      })),
    });
  }

  function cycleSelect(row: Extract<GameSettingsRow, { kind: 'select' }>, delta: number): void {
    // The source steps through the CANDIDATES, not through the row's own value: a step starts a root read,
    // and until it lands the row still shows the previous root — so stepping again would keep landing on
    // the same neighbour instead of walking down the list.
    if (row.id === 'source') {
      cycleSource(delta);
      return;
    }
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
    const entries: MenuEntry[] = [];
    if (row.value !== '' && row.preview !== undefined) {
      entries.push({
        label: t()('gameSettings.viewImage'),
        run: () => void showImage(row.value),
      });
    }
    entries.push({
      label: t()('gameSettings.browse'),
      run: () => browseInto(row.id, row.value, false),
    });
    if (row.value !== '') {
      entries.push({
        label: t()('gameSettings.clear'),
        run: () => {
          closeMenus();
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

  /**
   * Opens the file browser for a field and writes what it picked back into the form.
   *
   * The menu it was opened FROM stays underneath. Closing it up front made backing out of the browser
   * land on the form instead of on the popup the user was in — one press undoing two levels, which is
   * not what back means anywhere else here. The menu is dismissed only once a value has actually been
   * chosen, because then there is nothing left to go back to.
   */
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
    deps.picker.open({
      root: at.root,
      kind,
      current,
      multi,
      ...(baseFor(id) !== null ? { base: baseFor(id) ?? '' } : {}),
      onDone: (result) => {
        if (!result.ok) {
          if (!('cancelled' in result)) setStatus(result.message);
          // Cancelled (or refused): the popup is still up, and the focus goes back to it.
          applyMenuFocus();
          return;
        }
        closeMenus();
        if (onPicked !== undefined) {
          onPicked(result.paths);
          return;
        }
        const first = result.paths[0];
        if (first !== undefined) setField(id, first);
      },
    });
  }

  /**
   * The sub-directory a field's paths are relative to, when it is not the root itself.
   *
   * Only "move game to PC" has one, and it is not cosmetic: with the checkbox on, the manifest resolves
   * `executable` under the INSTALL directory, which receives the contents of the game folder named
   * below it (manifest.ts, `<installDir>/<executable>`). A card-relative path would carry that folder's
   * own name as a prefix and point one level too deep — so the browser both starts there and measures
   * from there.
   */
  function baseFor(id: GameRowId): string | null {
    if (id !== 'executable') return null;
    if (form.launchMode !== 'executable' || !form.copyToPc) return null;
    return form.copyInstall.installer === '' ? null : form.copyInstall.installer;
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
    origin = {
      root: result.root,
      source: result.source,
      signature: result.signature,
      windows: result.windows,
    };
    adoptText(result.text);
    await runValidate();
    baselineOtherIssues = new Set(otherIssues);
  }

  /**
   * Add mode's counterpart of `load`: the roots a game may be added to, and then the one it starts on —
   * the active card if a card is inserted, this PC otherwise. The card is where the user's attention
   * already is (they just plugged it in); the library is the one root that is always there.
   */
  async function loadSources(): Promise<void> {
    const list = await deps.api.sources();
    if (!open || mode !== 'add') return; // closed (or reopened for a game) while main was listing
    sources = list;
    const card = list.find((candidate) => candidate.kind === 'card' && candidate.isActive);
    const first = card ?? list.find((candidate) => candidate.kind === 'pc') ?? list[0];
    if (first === undefined) {
      setStatus(t()('errors.driveUnavailable'));
      return;
    }
    await adoptRoot(first.root);
  }

  /**
   * Points the add form at one root: reads what that root already carries, appends the new game as a slot
   * of its own (see slotsWithNewGame) and re-validates. On a SWITCH the half-filled form travels with it,
   * minus everything that was measured against the old root.
   */
  async function adoptRoot(root: string): Promise<void> {
    const carried = origin === null ? null : form;
    const token = ++adoptToken;
    adoptingRoot = root;
    setStatus(null);
    const result = await deps.api.readRoot(root);
    // A newer step already asked for another root — this answer describes a place the user has left.
    if (!open || mode !== 'add' || token !== adoptToken) return;
    adoptingRoot = null;
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    origin = {
      root: result.root,
      source: result.source,
      signature: result.signature,
      windows: result.windows,
    };
    const blankMode = defaultLaunchMode(result.source);
    const parsed = slotsWithNewGame(result.hasManifest ? result.text : null, blankMode);
    if (!parsed.ok) {
      unreadable = parsed.message;
      render();
      return;
    }
    slots = [...parsed.slots];
    slotIndex = parsed.index;
    form =
      carried === null ? emptyFormModel(blankMode) : carryFormAcrossSources(carried, result.source);
    rest = {};
    corrupt = {};
    mixed = false;
    loadedId = '';
    unreadable = null;
    // Exactly as in edit mode: the baseline is the file as the screen would write it RIGHT NOW, so
    // `dirty` means "the user typed something" rather than "the screen appended an empty game".
    baseline = currentText();
    focusIndex = 0;
    model = null;
    render();
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
   * The Add button. The write is the same one Save makes — the difference is what happens after it, and
   * that follows what main could DO with the file:
   *
   *  • `applied` — the manifest was re-read, so the game exists in the library now: leave the screen and
   *    take the carousel to it;
   *  • `deferred` — it went to a card that is not the active one, so there is nothing to go to. The
   *    screen still closes (keeping the user on a form about a finished job says nothing), and main
   *    posts the notification that says where the game went;
   *  • `failed` — written, but the reload was refused. That is an error to read, so the screen stays.
   */
  async function runAdd(): Promise<void> {
    const at = origin;
    if (at === null || !canSave()) return;
    const text = currentText();
    const addedId = form.id;
    setStatus(t()('gameSettings.saving'));
    const result = await deps.api.save({ root: at.root, signature: at.signature, text });
    if (!result.saved) {
      setStatus(result.message);
      return;
    }
    baseline = text;
    if (result.applied === 'failed') {
      setStatus(result.message ?? t()('gameSettings.savedNotApplied'));
      await resyncAfterWrite(at.root, addedId);
      return;
    }
    close();
    if (result.applied === 'applied') deps.onAdded(addedId);
  }

  /**
   * Re-reads the root after a write the launcher could not apply, so a second Add is possible at all: the
   * root's signature carries the new id now, and the swap guard would refuse a retry against the one the
   * screen opened with. The game that was just written comes back with the others and is dropped from
   * them — it is the slot the form is still editing, and keeping both would write it twice.
   */
  async function resyncAfterWrite(root: string, writtenId: string): Promise<void> {
    const token = ++adoptToken;
    const result = await deps.api.readRoot(root);
    // The same guard adoptRoot uses: the user may have moved the game to another root meanwhile, and
    // this answer is about the one they left.
    if (!open || mode !== 'add' || token !== adoptToken || !result.ok) return;
    const parsed = slotsWithNewGame(result.hasManifest ? result.text : null, form.launchMode);
    if (!parsed.ok) return;
    const others = parsed.slots.filter(
      (slot, index) => index !== parsed.index && (isRawSlot(slot) || slot.model.id !== writtenId),
    );
    origin = {
      root: result.root,
      source: result.source,
      signature: result.signature,
      windows: result.windows,
    };
    slots = [...others, { model: form, rest, corrupt }];
    slotIndex = others.length;
    baseline = currentText();
    render();
    await runValidate();
  }

  /**
   * Deleting is IMMEDIATE, unlike the old window's "remove the slot and save later": a confirmed deletion
   * that leaves the game on screen until some later Save reads as a bug. The slot is cut from the text as
   * READ, so unsaved edits are discarded with it — which the confirm says out loud.
   */
  async function runDelete(forgetHistory: boolean): Promise<void> {
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
    // Only now: main refuses to forget a game it can still see in a manifest, and the save resolves once
    // that manifest has been re-read — so this is the first moment the request can be honoured.
    if (forgetHistory) deps.api.forgetHistory(gameId);
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
    if (surface === 'form') return sidebar.hasFocus() ? sidebar.move(-1) : moveRowFocus(-1);
    surface.navUp();
  }

  function navDown(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') return;
    if (surface === 'menu') return moveMenuFocus(1);
    if (surface === 'form') return sidebar.hasFocus() ? sidebar.move(1) : moveRowFocus(1);
    surface.navDown();
  }

  function navHorizontal(delta: number): void {
    // From the column, RIGHT steps into the pane. Left is NOT its mirror there: inside the pane it
    // belongs to the selects and the number steppers, so leaving is B.
    if (sidebar.hasFocus()) {
      if (delta > 0 && sidebar.selected()?.kind === 'section') enterPane();
      return;
    }
    const target = rendered[focusIndex];
    if (target === undefined) return;
    const row = target.row;
    // A checkbox is NOT stepped through: left/right belong to the rows that have a range to move along
    // (the selects, the steppers), and a two-state row answered them by flipping — so a walk across the
    // form changed a setting on the way past. A checkbox is switched with A, and only with A.
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
        // Actions live in the column now; a row of this kind should never reach the pane.
        return;
      default:
        return;
    }
  }

  /** The screen's actions, now that they live in the column rather than at the end of the form. */
  function runAction(id: GameRowId): void {
    switch (id) {
      case 'save':
        deps.audio.play('button');
        if (mode === 'add') void runAdd();
        else void runSave();
        return;
      case 'reset':
        // Neither action exists in add mode's column — but the column is not the only way in (a stale
        // model, a click), and both would act on a game that does not exist.
        if (mode === 'add') return;
        deps.audio.play('button');
        deps.onConfirmRequested('reset');
        return;
      case 'delete':
        if (mode === 'add') return;
        deps.audio.play('button');
        deps.onConfirmRequested('delete');
        return;
      case 'close':
        // The same question B asks from the column: leaving with unsaved edits is confirmed first.
        leaveScreen();
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
      runEntry(entry);
      return;
    }
    if (surface === 'form') {
      if (sidebar.hasFocus()) {
        sidebar.activate();
        return;
      }
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
    // Out of the pane, back to the column; out of the column, off the screen — which is where the
    // unsaved-edits question belongs, since the column is the only way out.
    if (!sidebar.hasFocus()) {
      leavePane();
      return;
    }
    leaveScreen();
  }

  /** Leaves the screen, asking first when there is anything to lose. */
  function leaveScreen(): void {
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
    if (entranceTimer !== 0) {
      window.clearTimeout(entranceTimer);
      entranceTimer = 0;
    }
    if (previewTimer !== 0) {
      window.clearTimeout(previewTimer);
      previewTimer = 0;
    }
    listEl.classList.remove('is-entering');
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
    sidebar.setFocused(false);
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
      if (document.documentElement.classList.contains('mouse-asleep')) return;
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
      if (index === -1 || entry === undefined || !isFocusable(entry.row)) return;
      if (index === focusIndex && !sidebar.hasFocus()) return;
      sidebar.setFocused(false);
      focusIndex = index;
      applyRowFocus();
    },
    { passive: true },
  );

  /**
   * Everything a fresh visit starts from, whichever way the screen was opened. Extracted because
   * `openNew` must repeat ALL of it — a visit that inherited half the previous one's state is the kind of
   * bug that only shows up on the second open.
   */
  function resetScreenState(): void {
    open = true;
    app.dataset['overlay'] = 'game-settings';
    screen.setAttribute('aria-hidden', 'false');
    sidebar.reset(); // a re-opened screen starts at the first section, column and pane together
    sidebar.setFocused(true); // the screen opens on its table of contents, not inside a section
    sidebar.animateIn();
    sectionKey = null;
    paneKey = null;
    // NOT '': an empty string is a real signature (a column with no entries, a strip with no notes),
    // and starting a visit on it made the guards claim the screen already showed that. A game left with
    // "fix the errors first" under it then kept that line for every game opened after — the strip was
    // empty in the model and empty in the guard, so nothing ever rewrote the DOM.
    columnSignature = null;
    statusSignature = null;
    hover.arm();
    thumbnails.clear();
    listScroller.to(0, true);
    focusIndex = 0;
    model = null;
    rendered = [];
    slots = [];
    slotIndex = -1;
    baseline = '';
    baselineOtherIssues = new Set();
    sources = [];
    pendingSource = null;
    adoptingRoot = null;
    form = emptyFormModel(defaultLaunchMode('card'));
  }

  return {
    isOpen: () => open,
    open: (id: string) => {
      if (open) return;
      mode = 'edit';
      resetScreenState();
      void load(id);
    },
    openNew: () => {
      if (open) return;
      mode = 'add';
      gameId = '';
      origin = null;
      unreadable = null;
      status = null;
      issues = new Map();
      otherIssues = [];
      ownIssues = false;
      resetScreenState();
      render();
      void loadSources();
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
    navSecondary: (repeat = false) => {
      const surface = activeSurface();
      if (typeof surface !== 'string') surface.navSecondary?.(repeat);
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
      // Add mode has no game of its own, so every browse push would match `gameId === ''` and close the
      // screen the moment anything at all changed in the carousel.
      if (mode === 'add') return;
      // The card was pulled, or swapped, or the game stopped being playable: the screen is about a file
      // that is no longer reachable, and everything under it (the carousel, the detail screen) has been
      // rebuilt already. Leaving would be worse than closing, so it closes — see the plan, Р6.2.
      if (browse !== null && browse.id === gameId && browse.active) return;
      close();
    },
    // Spelled out one kind at a time: a catch-all `else close()` would silently turn any confirm added
    // later into "leave the screen", and nothing in the types would object.
    confirmAccepted: (kind) => {
      if (kind === 'reset') runReset();
      else if (kind === 'delete') void runDelete(false);
      else if (kind === 'delete-history') void runDelete(true);
      else if (kind === 'discard') close();
      else if (kind === 'switch-source') {
        const root = pendingSource;
        pendingSource = null;
        if (root !== null) void adoptRoot(root);
      }
    },
    relocalize: () => {
      if (model !== null) {
        const section = currentSection(model);
        if (section !== undefined) {
          relocalizeGameSections(listEl, { ...model, sections: [section] }, t());
        }
        for (const row of rendered) relocalizeGameRow(row, t());
        headingEl.textContent = screenHeading(model, t());
        sourceEl.textContent = `${rowLabelText(model.source, t())} ·`;
        // The column and the status strip ARE labels — rebuilt, not patched.
        renderColumn(model);
        renderStatus(model);
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
