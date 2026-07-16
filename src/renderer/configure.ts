// Configure-game window renderer (Fluent UI Web Components v3 + CodeMirror 6). Edits/initializes a
// card's game.json: pick a card, edit raw JSON (with schema-aware completion, hover docs and inline
// linting), Save & Apply without restarting the app. main owns all fs/validation — this is stateless UI.
//
// Fluent import channel mirrors settings.ts: each `*/define.js` side-effect import registers just the
// element we use, and setTheme comes from the same `@fluentui/web-components` index.
import '@fluentui/web-components/text/define.js';
import '@fluentui/web-components/button/define.js';
import '@fluentui/web-components/dropdown/define.js';
import '@fluentui/web-components/listbox/define.js';
import '@fluentui/web-components/option/define.js';
// Additional components used by the interactive form (patterns from settings.ts): field, switch, text-input.
import '@fluentui/web-components/field/define.js';
import '@fluentui/web-components/switch/define.js';
import '@fluentui/web-components/text-input/define.js';
import '@fluentui/web-components/tablist/define.js';
import '@fluentui/web-components/tab/define.js';
import { setTheme } from '@fluentui/web-components';
import { webDarkTheme, webLightTheme } from '@fluentui/tokens';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, type Extension } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { jsonSchema } from 'codemirror-json-schema';
import type {
  ConfigPickKind,
  DriveCandidate,
  ManifestValidationIssue,
  ThemeMode,
} from '../shared/types';
import { createTranslator, type Locale, type Translator } from '../shared/i18n/index.js';
import { localizeDocument } from './i18n-dom.js';
import { FormView, FORM_SECTIONS, type SectionId } from './configure-form-view.js';
import {
  emptyFormModel,
  textToFormModel,
  textToGames,
  gamesToText,
  type ManifestFormModel,
} from './configure-form-model.js';

// The active edit tab: one of the form sections, or the raw JSON editor (advanced). The window is a
// hide-on-close singleton, so this module-level state survives hiding (plan R1/D7 — no AppSettings needed).
type EditTab = SectionId | 'json';

// Translator, refreshed on a language push. The HTML ships English fallback (no blank flash).
let translator: Translator = createTranslator('en');

// ── Theme (copied from settings.ts) ────────────────────────────────────────────
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let systemListener: (() => void) | null = null;
let currentDark = darkQuery.matches;

function isDark(mode: ThemeMode): boolean {
  return mode === 'dark' || (mode === 'system' && darkQuery.matches);
}

function paint(dark: boolean): void {
  currentDark = dark;
  setTheme(dark ? webDarkTheme : webLightTheme);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  window.configureApi.setTitleBarDark(dark);
  // Re-flip CodeMirror's internal dark selectors (the token-based colors update on their own via CSS vars).
  if (view !== null) view.dispatch({ effects: themeCompartment.reconfigure(cmTheme(dark)) });
}

function applyTheme(mode: ThemeMode): void {
  paint(isDark(mode));
  if (systemListener !== null) {
    darkQuery.removeEventListener('change', systemListener);
    systemListener = null;
  }
  if (mode === 'system') {
    systemListener = () => paint(darkQuery.matches);
    darkQuery.addEventListener('change', systemListener);
  }
}

// ── DOM helpers ─────────────────────────────────────────────────────────────
function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} not found`);
  return el as T;
}

function setDisabled(el: HTMLElement, disabled: boolean): void {
  if (disabled) el.setAttribute('disabled', '');
  else el.removeAttribute('disabled');
}

function readGroupValue(el: HTMLElement): string | null {
  const raw = (el as HTMLElement & { value?: unknown }).value;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

// Sets the dropdown's selected option by value. Setting `value` re-runs the component's selectOption,
// which also refreshes the collapsed control text (needed after a relabel). A programmatic set does NOT
// emit a `change` event, so this never re-enters wireDropdown.
function setDropdownValue(group: HTMLElement, value: string): void {
  (group as HTMLElement & { value?: string | null }).value = value;
}

// A user selection emits a single `change` event carrying the new value — no click delegation needed
// (unlike the old radio-group, whose label clicks didn't update `value`). `apply` must be idempotent.
function wireDropdown(group: HTMLElement, apply: (value: string) => void): void {
  group.addEventListener('change', () => {
    const value = readGroupValue(group);
    if (value !== null) apply(value);
  });
}

const titlebarIcon = req<HTMLImageElement>('titlebar-icon');
const titlebarSubtitle = req('titlebar-subtitle');
const driveGroup = req('drive-group');
const driveListbox = req('drive-listbox');
const driveEmpty = req('drive-empty');
const gameSection = req('game-section');
const gameGroup = req('game-group');
const gameListbox = req('game-listbox');
const gameAddBtn = req('game-add');
const gameRemoveBtn = req('game-remove');
const editorEl = req('editor');
const editorSection = req('editor-section');
const formViewEl = req('form-view');
const editTabsEl = req('edit-tabs');
const issuesEl = req('issues');
const saveBtn = req('save');
const resetBtn = req('reset');
const statusEl = req('status');
const confirmVeil = req('confirm-veil');
const confirmMessage = req('confirm-message');
const confirmOk = req('confirm-ok');
const confirmCancel = req('confirm-cancel');

// ── CodeMirror editor ─────────────────────────────────────────────────────────
const themeCompartment = new Compartment();
const editableCompartment = new Compartment();
let view: EditorView | null = null;

// Editor colors sourced from Fluent tokens (global CSS vars published by setTheme) so the editor tracks
// the window theme automatically; the { dark } flag only toggles CodeMirror's own dark selectors.
function cmTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--colorNeutralBackground1)',
        color: 'var(--colorNeutralForeground1)',
        height: '100%',
      },
      '.cm-content': { caretColor: 'var(--colorNeutralForeground1)' },
      '.cm-gutters': {
        backgroundColor: 'var(--colorNeutralBackground2)',
        color: 'var(--colorNeutralForeground3)',
        border: 'none',
      },
      '.cm-activeLine': { backgroundColor: 'var(--colorNeutralBackground1Hover)' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--colorNeutralBackground2Hover)' },
      // NB: the selection-highlight color is set in configure.css (#editor + !important), NOT here —
      // CodeMirror's baseTheme uses a very specific focused selector that a plain theme rule can't beat.
      '&.cm-focused': { outline: 'none' },
    },
    { dark },
  );
}

// True while a PROGRAMMATIC editor write is in flight (a load, a mode-sync, a format). CodeMirror fires
// docChanged synchronously inside dispatch, so this guard stops those writes from being mistaken for a
// user edit and raising a false dirty (plan R4). User typing still flips dirty (the guard is false then).
let suppressDocChanged = false;

function onDocChanged(): void {
  if (suppressDocChanged) return;
  dirty = true;
  scheduleValidate();
}

function buildEditor(doc: string, schemaExt: Extension): void {
  view = new EditorView({
    doc,
    parent: editorEl,
    extensions: [
      basicSetup,
      schemaExt,
      themeCompartment.of(cmTheme(currentDark)),
      editableCompartment.of(EditorView.editable.of(true)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onDocChanged();
      }),
    ],
  });
}

function getEditorText(): string {
  return view?.state.doc.toString() ?? '';
}

// Replaces the whole editor document WITHOUT marking dirty (programmatic write — the caller owns dirty).
function dispatchText(text: string): void {
  if (view === null) return;
  suppressDocChanged = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  suppressDocChanged = false;
}

function setEditable(editable: boolean): void {
  if (view === null) return;
  view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(editable)) });
}

// ── App state ─────────────────────────────────────────────────────────────────
let drives: readonly DriveCandidate[] = [];
let selectedRoot: string | null = null;
let dirty = false;
let loadedId: string | null = null; // id of the last loaded/saved manifest (for the id-change warning)
// Descriptor (root|label|hasManifest) of the drive whose config is currently loaded. The label carries the
// game.json title, so a change means the media at this root was SWAPPED (a card change in the same reader
// keeps the drive letter) — the trigger to reload. null before the first load.
let loadedDriveKey: string | null = null;
let lastValidOk = false;
let blocked = false; // the selected card vanished → editing/saving disabled
let activeTab: EditTab = 'basics'; // a form section is the default (plan R1); 'json' is advanced

// ── Multi-game state (a card can carry several games) ───────────────────────────
// One game.json can hold a single game object (legacy) OR an array of games. The form edits ONE game at a
// time; `games` mirrors the whole file (each slot's model + preserved unknown/corrupt keys + its loaded
// id for the id-change warning), and `activeGameIndex` is the one shown in the form. The ACTIVE game's
// live edits live in `formView`; commitActiveGame() flushes them back into its slot before any whole-file
// operation (serialize, switch game, add/remove).
interface GameSlot {
  model: ManifestFormModel;
  rest: Readonly<Record<string, unknown>>;
  corrupt: Readonly<Record<string, unknown>>;
  mixed: boolean;
  loadedId: string | null;
}
let games: GameSlot[] = [];
let activeGameIndex = 0;

// Created in init() (after all handlers are defined). Owns the interactive form's DOM + state.
let formView: FormView;
// The native fluent-tablist + its fluent-tab children ([Basics]…[Advanced][JSON]), built in init().
type TablistEl = HTMLElement & { activeid?: string };
let tablist: TablistEl;
const tabButtons = new Map<EditTab, HTMLElement>();
// Guards the tablist `change` event against our own programmatic activeid writes (so committing/reverting
// a tab doesn't re-enter the switch logic).
let applyingTab = false;
// Tab order: the form sections, JSON last.
const TAB_ORDER: readonly EditTab[] = [...FORM_SECTIONS.map((s) => s.id), 'json'];

function tabDomId(tab: EditTab): string {
  return `tab-${tab}`;
}
function tabFromDomId(id: string | undefined): EditTab | null {
  if (id === undefined) return null;
  return TAB_ORDER.find((tab) => tabDomId(tab) === id) ?? null;
}

/** True when the raw JSON editor tab is active (vs. a form section tab). */
function jsonActive(): boolean {
  return activeTab === 'json';
}

// The manifest text of the currently active editor (form → the whole games array/object serialized, json
// → raw editor text). In form mode the active game's live edits are flushed into its slot first.
function activeText(): string {
  if (jsonActive()) return getEditorText();
  commitActiveGame();
  if (games.length === 0) return formView.serialize(); // blank drive: a single empty object
  return gamesToText(games);
}

// ── Validation + issues panel ──────────────────────────────────────────────────
let validateTimer: number | null = null;
function scheduleValidate(): void {
  if (validateTimer !== null) window.clearTimeout(validateTimer);
  validateTimer = window.setTimeout(() => void runValidate(), 400);
}

function parseId(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
      const id = parsed.id;
      return typeof id === 'string' ? id : null;
    }
  } catch {
    // not parseable → no id
  }
  return null;
}

async function runValidate(): Promise<void> {
  const text = activeText();
  const result = await window.configureApi.validateConfig(text);
  lastValidOk = result.ok;
  if (result.ok) {
    formView.setFieldErrors(null);
    renderIssues(null, text);
  } else if (!jsonActive()) {
    // Split issues by game. For a single object (games.length ≤ 1) the paths are bare, mapped straight to
    // fields as before. For an array, only the ACTIVE game's issues get their `games.<i>.` prefix stripped
    // and mapped inline; other games' issues (and any root issue) go to the panel, labelled by game.
    const forActive: ManifestValidationIssue[] = [];
    const forPanel: ManifestValidationIssue[] = [];
    const activePrefix = `games.${activeGameIndex}.`;
    for (const issue of result.issues) {
      if (games.length <= 1) {
        forActive.push(issue);
      } else if (issue.path.startsWith(activePrefix)) {
        forActive.push({ path: issue.path.slice(activePrefix.length), message: issue.message });
      } else if (issue.path.startsWith('games.')) {
        forPanel.push(labelOtherGameIssue(issue));
      } else {
        forPanel.push(issue); // a root-level issue (empty array, duplicate id at root, syntax)
      }
    }
    const unmapped = formView.setFieldErrors(forActive);
    renderIssues([...unmapped, ...forPanel], text);
  } else {
    formView.setFieldErrors(null);
    renderIssues(result.issues, text);
  }
  updateSaveEnabled();
}

/** Relabels an issue on a NON-active game for the #issues panel: "Game 3 (Celeste): heroImage is …". */
function labelOtherGameIssue(issue: ManifestValidationIssue): ManifestValidationIssue {
  const match = /^games\.(\d+)\.(.*)$/.exec(issue.path);
  if (match === null) return issue;
  const index = Number(match[1]);
  const slot = games[index];
  const title = slot !== undefined ? gameLabel(slot) : String(index + 1);
  return {
    path: issue.path,
    message: translator('configure.otherGameIssue', { index: index + 1, title, message: issue.message }),
  };
}

function renderIssues(issues: readonly ManifestValidationIssue[] | null, text: string): void {
  issuesEl.replaceChildren();
  if (issues === null) {
    issuesEl.classList.add('valid');
    const ok = document.createElement('div');
    ok.textContent = translator('configure.configValid');
    issuesEl.append(ok);
    // Changing `id` moves the game's PC stats to a fresh key → a "new" game with zero playtime. In form
    // mode the warning is about the ACTIVE game (its live id vs the id it loaded with); in JSON mode we
    // parse the id from the (single-object) text, as before.
    let id: string | null;
    if (jsonActive()) {
      id = parseId(text);
    } else {
      const slot = games[activeGameIndex];
      id = slot !== undefined ? (slot.model.id !== '' ? slot.model.id : null) : parseId(text);
    }
    if (loadedId !== null && id !== null && id !== loadedId) {
      const warn = document.createElement('div');
      warn.className = 'warning';
      warn.textContent = translator('configure.idChangedWarning', { from: loadedId, to: id });
      issuesEl.append(warn);
    }
    return;
  }
  issuesEl.classList.remove('valid');
  for (const issue of issues) {
    const row = document.createElement('div');
    row.className = 'issue';
    const path = document.createElement('span');
    path.className = 'issue-path';
    path.textContent = issue.path;
    row.append(path, document.createTextNode(`: ${issue.message}`));
    issuesEl.append(row);
  }
}

function updateSaveEnabled(): void {
  setDisabled(saveBtn, blocked || selectedRoot === null || !lastValidOk);
  // Reset re-reads the card and is useful even for an invalid config (to discard edits), so it is NOT
  // gated by validity — only by having a card that isn't gone.
  setDisabled(resetBtn, blocked || selectedRoot === null);
}

// ── Status line ─────────────────────────────────────────────────────────────
function setStatus(text: string): void {
  statusEl.textContent = text;
}

// ── Confirm modal ─────────────────────────────────────────────────────────────
let confirmResolve: ((ok: boolean) => void) | null = null;
// Every confirmation asks a yes/no question; the Yes/No button labels are fixed (localized from
// common.yes / common.no via localizeDocument), so callers pass only the message — no per-call verb.
function confirmDialog(message: string): Promise<boolean> {
  confirmMessage.textContent = message;
  confirmVeil.hidden = false;
  confirmOk.focus();
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve;
  });
}
function closeConfirm(ok: boolean): void {
  confirmVeil.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(ok);
}
confirmOk.addEventListener('click', () => closeConfirm(true));
confirmCancel.addEventListener('click', () => closeConfirm(false));
confirmVeil.addEventListener('click', (event) => {
  if (event.target === confirmVeil) closeConfirm(false); // click on the veil = Cancel
});

// ── Drive picker ─────────────────────────────────────────────────────────────
// The list is pushed every 2s while the window is visible. Rebuilding the option DOM on every push would
// drop the current selection (fresh elements start unselected), so we ONLY rebuild when the list actually
// changed (signature compare) and reconcile the selection on every push without touching the DOM.
let lastDrivesSig = '';

function drivesSignature(list: readonly DriveCandidate[]): string {
  return list
    .map((d) => `${d.root}|${d.label}|${d.hasManifest ? 1 : 0}|${d.isActive ? 1 : 0}`)
    .join('¦');
}

// Per-drive descriptor used to detect a media swap at the SAME root: root + the card's CONTENT signature
// (its game ids) + hasManifest. The signature is used rather than the display label because the label can
// be a bare count ("3 games") that two different cards share — and the drive letter never changes, so the
// label alone would miss the swap. isActive is intentionally excluded — it can flap without the card's
// content changing, and shouldn't force a config reload.
function driveKey(candidate: DriveCandidate): string {
  return `${candidate.root}|${candidate.signature}|${candidate.hasManifest ? 1 : 0}`;
}

function renderDrives(list: readonly DriveCandidate[]): void {
  drives = list;

  if (list.length === 0) {
    lastDrivesSig = '';
    driveListbox.replaceChildren();
    driveEmpty.hidden = false;
    setDisabled(driveGroup, true);
    // The selected card is gone (or none was ever present) → block editing, keep the text.
    onSelectedGone();
    return;
  }
  driveEmpty.hidden = true;
  // Re-enable the picker in case a previous empty tick disabled it (a disabled dropdown can't be reopened).
  setDisabled(driveGroup, false);

  const sig = drivesSignature(list);
  const rebuilt = sig !== lastDrivesSig;
  if (rebuilt) {
    lastDrivesSig = sig;
    rebuildOptions(list);
  }
  reconcileSelection(list);
  if (rebuilt) {
    // The dropdown's listbox processes freshly-appended options on its own async init, which can drop a
    // value set during this synchronous render. Re-assert on the next frame (after it settles) so the
    // selection shows immediately. Only after a rebuild (first open / genuine change), not on every poll.
    requestAnimationFrame(() => {
      if (selectedRoot !== null) setDropdownValue(driveGroup, selectedRoot);
    });
  }
}

function rebuildOptions(list: readonly DriveCandidate[]): void {
  const options = list.map((candidate) => {
    const option = document.createElement('fluent-option');
    (option as HTMLElement & { value?: string }).value = candidate.root;
    option.textContent = candidate.label;
    return option;
  });
  driveListbox.replaceChildren(...options);
}

function reconcileSelection(list: readonly DriveCandidate[]): void {
  const current = selectedRoot !== null ? list.find((d) => d.root === selectedRoot) : undefined;
  if (current !== undefined && selectedRoot !== null) {
    setDropdownValue(driveGroup, selectedRoot);
    // The drive letter is unchanged, but the MEDIA behind it may have been swapped (a card change in the
    // same reader keeps the root). driveKey carries the game.json title, so a changed descriptor means a
    // different card → reload its config instead of leaving the previous card's stale content on screen.
    // An UNCHANGED descriptor that merely vanished and came back just unblocks, preserving edits (a flaky
    // reader / the same card re-seated).
    if (driveKey(current) !== loadedDriveKey) {
      if (blocked) unblock();
      void loadDrive(selectedRoot);
    } else if (blocked) {
      unblock();
    }
    return;
  }
  if (selectedRoot !== null) {
    // The selected card disappeared → block, but do NOT wipe the editor.
    onSelectedGone();
  }
  // No valid selection yet → prefer the active card, else the first candidate, and LOAD it.
  const active = list.find((d) => d.isActive);
  const pick = active ?? list[0];
  if (pick !== undefined) {
    setDropdownValue(driveGroup, pick.root);
    void selectDrive(pick.root, false);
  }
}

function onSelectedGone(): void {
  blocked = true;
  setEditable(false);
  setModeTabsDisabled(true);
  applyFormDisabled();
  applyGameControlsDisabled();
  updateSaveEnabled();
  setStatus(translator('configure.cardGone'));
}

function unblock(): void {
  blocked = false;
  setEditable(true);
  setModeTabsDisabled(false);
  applyFormDisabled();
  applyGameControlsDisabled();
  updateSaveEnabled();
  setStatus('');
}

function setModeTabsDisabled(disabled: boolean): void {
  for (const btn of tabButtons.values()) setDisabled(btn, disabled);
}

// The form fields are disabled only when the card is gone (blocked). A blank drive gets an empty, EDITABLE
// game slot to fill in; Save stays blocked by validation until the required fields are there.
function applyFormDisabled(): void {
  formView.setDisabled(blocked);
}

// Switches the active card. `confirmDirty` guards against losing unsaved edits (skipped for the initial
// auto-selection). Loads the card's game.json (or clears the editor for a blank drive). `switching` guards
// against re-entry while a confirm dialog is awaited (a fresh selection racing an in-flight one).
let switching = false;
async function selectDrive(root: string, confirmDirty: boolean): Promise<void> {
  if (root === selectedRoot && !blocked) return;
  if (switching) return;
  switching = true;
  try {
    if (confirmDirty && dirty) {
      const ok = await confirmDialog(translator('configure.confirmSwitch'));
      if (!ok) {
        if (selectedRoot !== null) setDropdownValue(driveGroup, selectedRoot); // revert the selection
        return;
      }
    }
    selectedRoot = root;
    if (blocked) unblock();
    await loadDrive(root);
  } finally {
    switching = false;
  }
}

async function loadDrive(root: string): Promise<void> {
  const candidate = drives.find((d) => d.root === root);
  if (candidate === undefined) return;
  // Record the descriptor we're loading up front (synchronously), so the next poll tick sees an unchanged
  // key and doesn't re-trigger this load while readConfig is still in flight.
  loadedDriveKey = driveKey(candidate);
  if (!candidate.hasManifest) {
    // Blank drive: start with ONE empty, editable game the user fills in (there are no templates any more —
    // the form itself is the authoring surface). Save stays blocked by validation until the required fields
    // are present. loadedId null → no id-change warning.
    loadedId = null;
    dirty = false;
    games = [{ model: emptyFormModel(), rest: {}, corrupt: {}, mixed: false, loadedId: null }];
    activeGameIndex = 0;
    dispatchText(gamesToText(games));
    rebuildGameSelector();
    loadActiveIntoForm();
    applyFormDisabled();
    showTab('basics'); // straight into the form — the first fields to fill are there
    setStatus(translator('configure.blankDrive'));
    void runValidate();
    return;
  }
  const result = await window.configureApi.readConfig(root);
  if (!result.ok) {
    // Not blank but unreadable: ConfigReadResult can't tell "file missing" from other failures (plan D2),
    // so we do NOT substitute an empty game here — just report it and leave the form empty.
    loadedId = null;
    games = [];
    activeGameIndex = 0;
    dispatchText('');
    formView.load(emptyFormModel(), {}, {}, false);
    rebuildGameSelector();
    applyFormDisabled();
    setStatus(translator('configure.couldNotRead', { message: result.message }));
    void runValidate();
    return;
  }
  loadedId = parseId(result.text);
  dirty = false;
  loadText(result.text);
  setStatus('');
}

// Loads manifest text into BOTH editors (raw JSON into CodeMirror, parsed games into the form) so either
// tab is correct on switch. A single object OR an array of games is accepted; if the text doesn't parse
// (or any game element isn't an object) the form can't represent it → the JSON tab is auto-activated with
// the error surfaced by validation (plan R4 / cases).
function loadText(text: string): void {
  dispatchText(text);
  if (loadGamesFromText(text)) {
    showTab(activeTab);
  } else {
    // Unrepresentable (syntax error / non-object element) → the form can't show it; go to the JSON tab.
    games = [];
    activeGameIndex = 0;
    formView.load(emptyFormModel(), {}, {}, false);
    rebuildGameSelector();
    applyFormDisabled();
    showTab('json');
  }
  void runValidate();
}

// ── Multi-game helpers ──────────────────────────────────────────────────────────

/** Parses whole-file text into the `games` slots and loads the first into the form. Returns false when the
 * text can't be represented as a form (syntax error, top-level not object/array, or a non-object element).
 * `keepIndex` preserves the active game (a JSON→form switch); otherwise it resets to the first game. */
function loadGamesFromText(text: string, keepIndex = false): boolean {
  const parsed = textToGames(text);
  if (!parsed.ok || !parsed.games.every((g) => g.ok)) return false;
  const slots: GameSlot[] = [];
  for (const g of parsed.games) {
    if (!g.ok) return false; // narrowed away by the every() above; keeps TS happy
    const loadedGameId = g.model.id !== '' ? g.model.id : null;
    slots.push({ model: g.model, rest: g.rest, corrupt: g.corrupt, mixed: g.mixed, loadedId: loadedGameId });
  }
  games = slots;
  activeGameIndex = keepIndex ? Math.min(activeGameIndex, games.length - 1) : 0;
  rebuildGameSelector();
  loadActiveIntoForm();
  applyFormDisabled();
  return true;
}

/** Flushes the active game's live form edits back into its slot (serialize → re-parse). The form always
 * serializes to valid single-game JSON, so the parse succeeds; on the off chance it doesn't, the slot is
 * left as-is. */
function commitActiveGame(): void {
  const slot = games[activeGameIndex];
  if (slot === undefined) return;
  const parsed = textToFormModel(formView.serialize());
  if (parsed.ok) {
    slot.model = parsed.model;
    slot.rest = parsed.rest;
    slot.corrupt = parsed.corrupt;
  }
}

/** Loads the active game slot into the form. */
function loadActiveIntoForm(): void {
  const slot = games[activeGameIndex];
  if (slot === undefined) {
    formView.load(emptyFormModel(), {}, {}, false);
    return;
  }
  loadedId = slot.loadedId;
  formView.load(slot.model, slot.rest, slot.corrupt, slot.mixed);
}

/** A short human label for a game slot (its title, or a placeholder when untitled). */
function gameLabel(slot: GameSlot): string {
  const title = slot.model.title.trim();
  return title !== '' ? title : translator('configure.untitledGame');
}

/** Rebuilds the game dropdown ("index / count · title") and toggles the row/controls. */
function rebuildGameSelector(): void {
  // The Game row belongs to the section tabs (it picks which game they edit): shown only when the form can
  // represent the file (≥1 slot) AND a form section is active — hidden on the raw JSON tab.
  const show = games.length >= 1 && !jsonActive();
  gameSection.hidden = !show;
  if (!show) return;
  const options = games.map((slot, i) => {
    const option = document.createElement('fluent-option');
    (option as HTMLElement & { value?: string }).value = String(i);
    option.textContent = translator('configure.gameOption', {
      index: i + 1,
      count: games.length,
      title: gameLabel(slot),
    });
    return option;
  });
  gameListbox.replaceChildren(...options);
  setDropdownValue(gameGroup, String(activeGameIndex));
  requestAnimationFrame(() => setDropdownValue(gameGroup, String(activeGameIndex)));
  applyGameControlsDisabled();
}

/** Enables/disables the Game controls: disabled when blocked or on the JSON tab; Remove also needs
 * ≥2 games (a card must keep at least one). */
function applyGameControlsDisabled(): void {
  const disabled = blocked || jsonActive();
  setDisabled(gameGroup, disabled);
  setDisabled(gameAddBtn, disabled);
  setDisabled(gameRemoveBtn, disabled || games.length <= 1);
}

/** Switches the active game (dropdown): flush the current one, load the picked one, keep the section tab. */
function switchGame(index: number): void {
  if (index === activeGameIndex || index < 0 || index >= games.length) return;
  commitActiveGame();
  activeGameIndex = index;
  loadActiveIntoForm();
  applyFormDisabled();
  setDropdownValue(gameGroup, String(index));
  void runValidate();
}

/** A default id not yet used by any game (my-game, my-game-2, …), so the new game doesn't collide. */
function uniqueDefaultId(): string {
  const used = new Set(games.map((g) => g.model.id));
  if (!used.has('my-game')) return 'my-game';
  for (let n = 2; ; n += 1) {
    const candidate = `my-game-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Adds a new, empty game (with a unique default id so the duplicate-id check doesn't fire), switches to
 * it and opens Basics. The user fills it in from the form. */
function onAddGame(): void {
  if (blocked || jsonActive()) return;
  commitActiveGame();
  const model: ManifestFormModel = { ...emptyFormModel(), id: uniqueDefaultId() };
  games.push({ model, rest: {}, corrupt: {}, mixed: false, loadedId: null });
  activeGameIndex = games.length - 1;
  rebuildGameSelector();
  loadActiveIntoForm();
  applyFormDisabled();
  dirty = true;
  showTab('basics');
  void runValidate();
}

/** Removes the current game (confirm) and switches to a neighbour. Refused for the last game (a card can't
 * be empty). */
async function onRemoveGame(): Promise<void> {
  if (blocked || jsonActive() || games.length <= 1) return;
  const ok = await confirmDialog(translator('configure.confirmRemoveGame'));
  if (!ok) return;
  games.splice(activeGameIndex, 1);
  activeGameIndex = Math.min(activeGameIndex, games.length - 1);
  rebuildGameSelector();
  loadActiveIntoForm();
  applyFormDisabled();
  dirty = true;
  void runValidate();
}

// ── Format ─────────────────────────────────────────────────────────────────────
// Pretty-prints the editor JSON (2-space indent) — the in-app "prettier" for fixing indentation. Only
// works on syntactically valid JSON; otherwise it asks the user to fix the errors first.
function onFormat(): void {
  // Format only makes sense for the raw JSON editor — in form mode it is a no-op (plan R8).
  if (!jsonActive()) return;
  if (blocked || view === null) return;
  const text = getEditorText();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    setStatus(translator('configure.fixSyntax'));
    return;
  }
  const formatted = JSON.stringify(parsed, null, 2);
  if (formatted === text) return; // already tidy — nothing to do (and don't flag it dirty)
  dispatchText(formatted);
  dirty = true;
  void runValidate();
  setStatus('');
}

// ── Save & Apply / Reset ────────────────────────────────────────────────────────
async function onSave(): Promise<void> {
  if (selectedRoot === null || blocked || !lastValidOk) return;
  const root = selectedRoot;
  const text = activeText();
  setDisabled(saveBtn, true);
  setStatus(translator('configure.saving'));
  const result = await window.configureApi.saveConfig(root, text);
  if (!result.saved) {
    setStatus(translator('configure.notSaved', { message: result.message }));
    updateSaveEnabled();
    return;
  }
  dirty = false;
  // The card now holds what we saved → each game's loaded id becomes its current id (so the id-change
  // warning re-arms from the saved baseline). In JSON mode we don't have per-game slots — fall back to
  // parsing the single-object id, as before.
  if (jsonActive() || games.length === 0) {
    loadedId = parseId(text);
  } else {
    for (const slot of games) slot.loadedId = slot.model.id !== '' ? slot.model.id : null;
    loadedId = games[activeGameIndex]?.loadedId ?? null;
  }
  switch (result.applied) {
    case 'applied':
      setStatus(translator('configure.applied'));
      break;
    case 'deferred':
      setStatus(translator('configure.deferred'));
      break;
    case 'failed':
      setStatus(
        translator('configure.savedRejected', {
          message: result.message ?? translator('configure.unknownReason'),
        }),
      );
      break;
  }
  updateSaveEnabled();
}

// Reverts unsaved edits by re-reading game.json from the card (labelled "Reset").
async function onReset(): Promise<void> {
  if (selectedRoot === null || blocked) return;
  if (dirty) {
    const ok = await confirmDialog(translator('configure.confirmReset'));
    if (!ok) return;
  }
  await loadDrive(selectedRoot);
}

saveBtn.addEventListener('click', () => void onSave());

// Format / Reset are driven from the editor's native right-click menu (configure-window.ts) via IPC.
window.configureApi.onEditorCommand((command) => {
  if (command === 'format') onFormat();
});

// The dropdown updates its own display on user selection; selectDrive reverts it if a dirty-switch
// confirm is declined.
wireDropdown(driveGroup, (root) => {
  void selectDrive(root, true);
});

// Game picker (multi-game cards): switch the edited game, or add/remove one.
wireDropdown(gameGroup, (value) => {
  const index = Number(value);
  if (Number.isInteger(index)) switchGame(index);
});
gameAddBtn.addEventListener('click', () => onAddGame());
gameRemoveBtn.addEventListener('click', () => void onRemoveGame());

// ── Edit tabs ([Basics][Launch][Hero][Saves][Audio][Advanced][JSON]) ──
// A native fluent-tablist: it renders the tab strip (accent indicator, keyboard nav, ARIA) and fires
// `change` with the new activeid. We manage the panels ourselves in showTab. Labels come from the
// translator (re-applied on a language change via applyLocale → relabelTabs).
function buildEditTabs(): void {
  applyingTab = true; // ignore the tablist's own auto-select `change` during construction
  tablist = document.createElement('fluent-tablist');
  for (const tab of TAB_ORDER) {
    const el = document.createElement('fluent-tab');
    el.setAttribute('slot', 'tab');
    el.id = tabDomId(tab);
    tabButtons.set(tab, el);
    tablist.append(el);
  }
  tablist.addEventListener('change', () => {
    if (applyingTab) return; // our own programmatic activeid write
    const target = tabFromDomId(tablist.activeid);
    if (target !== null && target !== activeTab) switchTab(target);
  });
  editTabsEl.append(tablist);
  relabelTabs();
  applyingTab = false;
}

function relabelTabs(): void {
  for (const section of FORM_SECTIONS) {
    tabButtons.get(section.id)?.replaceChildren(translator(section.labelKey));
  }
  tabButtons.get('json')?.replaceChildren(translator('configure.tabJson'));
}

// Points the tablist strip at `tab` without triggering the change→switch logic (a commit or a revert).
function setStripActive(tab: EditTab): void {
  applyingTab = true;
  tablist.activeid = tabDomId(tab);
  applyingTab = false;
}

// Reflects `activeTab` onto the DOM: the right panel (a form section / the JSON editor) plus the tab
// strip. Does NOT convert content — that is switchTab's job on a form↔json crossing.
function showTab(target: EditTab): void {
  activeTab = target;
  const isSection = target !== 'json';
  formViewEl.hidden = !isSection;
  editorSection.hidden = target !== 'json';
  if (isSection) formView.showSection(target);
  setStripActive(target);
  // The Game row follows the section tabs (shown only on a form section).
  rebuildGameSelector();
  // Gate the native "Format" context-menu item: it only applies to the JSON editor.
  window.configureApi.setJsonEditorActive(target === 'json');
}

// Switches tabs, converting content across the form↔json boundary. Form → JSON always works (the model
// serializes). JSON → a form tab only when the text parses as JSON (else a status hint and the strip
// reverts — schema errors are fine, the form exists to fix them, plan R4). Everything else is free (same
// model). Switching never marks dirty (programmatic editor writes are guarded).
function switchTab(target: EditTab): void {
  if (blocked) {
    setStripActive(activeTab);
    return;
  }
  if (target === 'json') {
    // Form → JSON: write the WHOLE file (all games) into the editor.
    dispatchText(activeText());
    formView.setFieldErrors(null);
    showTab('json');
    setStatus('');
    void runValidate();
    return;
  }
  if (jsonActive()) {
    // JSON → form: the editor may hold an object or an array; the form can only show it if every element
    // is an object (else stay on JSON with a hint, as before). Resets to the first game.
    if (!loadGamesFromText(getEditorText())) {
      setStatus(translator('configure.fixSyntaxSwitch'));
      setStripActive(activeTab); // undo the user's tab click
      return;
    }
    applyFormDisabled();
    setStatus('');
    showTab(target);
    void runValidate();
    return;
  }
  // Section ↔ section: same model, just swap the visible panel.
  showTab(target);
}

resetBtn.addEventListener('click', () => void onReset());

// ── Init ─────────────────────────────────────────────────────────────────────
applyTheme('system'); // best-guess before settings load, to avoid a flash

// The theme is chosen in the settings window and persisted, and pushed live to this window via
// onThemeUpdate (see init). This visibilitychange re-fetch stays as a cheap fallback: the window is a
// hidden/shown singleton, so re-reading the persisted theme on show covers any push missed while hidden.
async function refreshTheme(): Promise<void> {
  const settings = await window.configureApi.getSettings();
  applyTheme(settings.theme);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshTheme();
});

// The app version, cached so a language change can re-render the "(version) — Configure game" suffix.
let appVersion = '';
function renderTitlebarSubtitle(): void {
  titlebarSubtitle.textContent = translator('configure.titlebarVersion', { version: appVersion });
}

// A language push (or the initial seed): rebuild the translator, re-localize the static DOM, re-title the
// window (so the HTML <title> doesn't override the taskbar caption) and refresh the subtitle. The
// ephemeral status line and issues panel are NOT re-rendered retroactively — they update on the next event
// (drive labels re-push every 2s; a re-validate happens on the next edit).
function applyLocale(locale: Locale): void {
  translator = createTranslator(locale);
  document.documentElement.lang = locale;
  // "Playhook" is the product name — not translated.
  document.title = `Playhook — ${translator('window.configureGame')}`;
  localizeDocument(translator);
  renderTitlebarSubtitle();
  formView.relabel();
  relabelTabs();
  rebuildGameSelector(); // the game options carry translated "index / count · title" labels
}

async function init(): Promise<void> {
  window.configureApi.onDrivesUpdate(renderDrives);
  window.configureApi.onLanguageUpdate(applyLocale);
  // Live theme push from main (the theme changed in the settings window): applyTheme is idempotent, so
  // this coexists with the visibilitychange re-fetch below (which stays as a cheap fallback).
  window.configureApi.onThemeUpdate(applyTheme);
  const [settings, schema, drivesList, icon, version, locale] = await Promise.all([
    window.configureApi.getSettings(),
    window.configureApi.getSchema(),
    window.configureApi.getDrives(),
    window.configureApi.getAppIcon(),
    window.configureApi.getAppVersion(),
    window.configureApi.getLanguage(),
  ]);
  applyTheme(settings.theme);
  if (icon !== '') titlebarIcon.src = icon;
  else titlebarIcon.hidden = true;
  appVersion = version;
  // Schema-aware editor when the JSON Schema is available; plain JSON otherwise (graceful degradation —
  // syntax highlighting + parse-linting still work, just without field completion/hover).
  let schemaExt: Extension;
  try {
    schemaExt = jsonSchema(schema as Parameters<typeof jsonSchema>[0]);
  } catch {
    schemaExt = json();
  }
  buildEditor('', schemaExt);
  // Build the interactive form and the tab bar, then show the first section before a drive loads into it.
  formView = new FormView({
    root: formViewEl,
    translator: () => translator,
    onChange: () => {
      dirty = true;
      scheduleValidate();
    },
    pickPath: (kind: ConfigPickKind, gameId?: string) =>
      window.configureApi.pickPath(selectedRoot ?? '', kind, gameId),
    imagePreview: (relative: string) => window.configureApi.getImagePreview(selectedRoot ?? '', relative),
    openExternal: (url: string) => window.configureApi.openExternal(url),
    onPickError: (message) => setStatus(message),
  });
  buildEditTabs();
  showTab('basics');
  renderDrives(drivesList);
  // Seed the locale last so it localizes the freshly-populated DOM and title-bar suffix in one pass.
  applyLocale(locale);
}

void init();
