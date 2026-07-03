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
import { setTheme } from '@fluentui/web-components';
import { webDarkTheme, webLightTheme } from '@fluentui/tokens';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, type Extension } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { jsonSchema } from 'codemirror-json-schema';
import type {
  ConfigTemplates,
  DriveCandidate,
  ManifestValidationIssue,
  ThemeMode,
} from '../shared/types';
import { createTranslator, type Locale, type Translator } from '../shared/i18n/index.js';
import { localizeDocument } from './i18n-dom.js';

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
const editorEl = req('editor');
const issuesEl = req('issues');
const saveBtn = req('save');
const statusEl = req('status');
const tplExecutable = req('tpl-executable');
const tplInstaller = req('tpl-installer');
const tplSteam = req('tpl-steam');
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

function onDocChanged(): void {
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

// Replaces the whole document. `fromLoad` marks a programmatic load (not a user edit): clears dirty and
// runs a validation pass, but doesn't treat the change as unsaved.
function setEditorText(text: string, fromLoad: boolean): void {
  if (view === null) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  if (fromLoad) {
    dirty = false;
    void runValidate();
  }
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
let lastValidOk = false;
let blocked = false; // the selected card vanished → editing/saving disabled
let templatesCache: ConfigTemplates | null = null;

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
  const text = getEditorText();
  const result = await window.configureApi.validateConfig(text);
  lastValidOk = result.ok;
  renderIssues(result.ok ? null : result.issues, text);
  updateSaveEnabled();
}

function renderIssues(issues: readonly ManifestValidationIssue[] | null, text: string): void {
  issuesEl.replaceChildren();
  if (issues === null) {
    issuesEl.classList.add('valid');
    const ok = document.createElement('div');
    ok.textContent = translator('configure.configValid');
    issuesEl.append(ok);
    // Changing `id` moves the game's PC stats to a fresh key → a "new" game with zero playtime.
    const id = parseId(text);
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
  const stillPresent = selectedRoot !== null && list.some((d) => d.root === selectedRoot);
  if (stillPresent && selectedRoot !== null) {
    // Keep the current selection; a card that had vanished and came back unblocks (text preserved).
    setDropdownValue(driveGroup, selectedRoot);
    if (blocked) unblock();
    return;
  }
  if (selectedRoot !== null && !stillPresent) {
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
  setTemplatesDisabled(true);
  updateSaveEnabled();
  setStatus(translator('configure.cardGone'));
}

function unblock(): void {
  blocked = false;
  setEditable(true);
  setTemplatesDisabled(false);
  updateSaveEnabled();
  setStatus('');
}

function setTemplatesDisabled(disabled: boolean): void {
  for (const btn of [tplExecutable, tplInstaller, tplSteam]) setDisabled(btn, disabled);
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
  if (!candidate.hasManifest) {
    // Blank drive: empty editor, invite a template. loadedId null → no id-change warning.
    loadedId = null;
    setEditorText('', true);
    setStatus(translator('configure.blankDrive'));
    return;
  }
  const result = await window.configureApi.readConfig(root);
  if (!result.ok) {
    loadedId = null;
    setStatus(translator('configure.couldNotRead', { message: result.message }));
    return;
  }
  loadedId = parseId(result.text);
  setEditorText(result.text, true);
  setStatus('');
}

// ── Templates ─────────────────────────────────────────────────────────────────
async function getTemplates(): Promise<ConfigTemplates> {
  templatesCache ??= await window.configureApi.getTemplates();
  return templatesCache;
}

async function applyTemplate(kind: keyof ConfigTemplates): Promise<void> {
  if (blocked) return;
  const templates = await getTemplates();
  const template = templates[kind];
  const current = getEditorText().trim();
  if (current.length > 0 && current !== template.trim()) {
    const ok = await confirmDialog(translator('configure.confirmReplace'));
    if (!ok) return;
  }
  setEditorText(template, false);
  dirty = true;
  void runValidate();
}

tplExecutable.addEventListener('click', () => void applyTemplate('executable'));
tplInstaller.addEventListener('click', () => void applyTemplate('installer'));
tplSteam.addEventListener('click', () => void applyTemplate('steam'));

// ── Format ─────────────────────────────────────────────────────────────────────
// Pretty-prints the editor JSON (2-space indent) — the in-app "prettier" for fixing indentation. Only
// works on syntactically valid JSON; otherwise it asks the user to fix the errors first.
function onFormat(): void {
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
  setEditorText(formatted, false);
  dirty = true;
  void runValidate();
  setStatus('');
}

// ── Save & Apply / Reset ────────────────────────────────────────────────────────
async function onSave(): Promise<void> {
  if (selectedRoot === null || blocked || !lastValidOk) return;
  const root = selectedRoot;
  const text = getEditorText();
  setDisabled(saveBtn, true);
  setStatus(translator('configure.saving'));
  const result = await window.configureApi.saveConfig(root, text);
  if (!result.saved) {
    setStatus(translator('configure.notSaved', { message: result.message }));
    updateSaveEnabled();
    return;
  }
  dirty = false;
  loadedId = parseId(text);
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
  else void onReset();
});

// The dropdown updates its own display on user selection; selectDrive reverts it if a dirty-switch
// confirm is declined.
wireDropdown(driveGroup, (root) => {
  void selectDrive(root, true);
});

// ── Init ─────────────────────────────────────────────────────────────────────
applyTheme('system'); // best-guess before settings load, to avoid a flash

// The theme is chosen in the settings window and persisted; there is no live cross-window push. The
// window is a hidden/shown singleton, so re-fetch the persisted theme whenever it becomes visible again —
// otherwise a theme change made in settings only took effect after a full app restart.
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
}

async function init(): Promise<void> {
  window.configureApi.onDrivesUpdate(renderDrives);
  window.configureApi.onLanguageUpdate(applyLocale);
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
  renderDrives(drivesList);
  // Seed the locale last so it localizes the freshly-populated DOM and title-bar suffix in one pass.
  applyLocale(locale);
}

void init();
