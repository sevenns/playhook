// Configure-game window renderer (Fluent UI Web Components v3 + CodeMirror 6). Edits/initializes a
// card's game.json: pick a card, edit raw JSON (with schema-aware completion, hover docs and inline
// linting), Save & Apply without restarting the app. main owns all fs/validation — this is stateless UI.
//
// Fluent import channel mirrors settings.ts: each `*/define.js` side-effect import registers just the
// element we use, and setTheme comes from the same `@fluentui/web-components` index.
import '@fluentui/web-components/text/define.js';
import '@fluentui/web-components/button/define.js';
import '@fluentui/web-components/field/define.js';
import '@fluentui/web-components/radio/define.js';
import '@fluentui/web-components/radio-group/define.js';
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

function setGroupValue(el: HTMLElement, value: string): void {
  (el as HTMLElement & { value?: string }).value = value;
}

function readGroupValue(el: HTMLElement): string | null {
  const raw = (el as HTMLElement & { value?: unknown }).value;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

const titlebarIcon = req<HTMLImageElement>('titlebar-icon');
const titlebarSubtitle = req('titlebar-subtitle');
const driveGroup = req('drive-group');
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
      // Selection highlight (double-click word select, drag select). basicSetup draws the selection on its
      // own layer BEHIND the text, so it needs an explicit, opaque-enough background or it's invisible.
      // A fixed semi-transparent blue reads clearly on BOTH themes (a Fluent brand token was too pale) and
      // `!important` beats CodeMirror's baseTheme default. The text stays readable (the layer is behind it).
      '.cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
        background: 'rgba(51, 144, 236, 0.4) !important',
      },
      '&.cm-focused .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionBackground':
        {
          background: 'rgba(51, 144, 236, 0.55) !important',
        },
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
    ok.textContent = 'Config is valid.';
    issuesEl.append(ok);
    // Changing `id` moves the game's PC stats to a fresh key → a "new" game with zero playtime.
    const id = parseId(text);
    if (loadedId !== null && id !== null && id !== loadedId) {
      const warn = document.createElement('div');
      warn.className = 'warning';
      warn.textContent = `Warning: id changed (${loadedId} → ${id}). Playtime stats are keyed by id and will reset for the new id.`;
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
function confirmDialog(message: string, okLabel: string): Promise<boolean> {
  confirmMessage.textContent = message;
  confirmOk.textContent = okLabel;
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
// The list is pushed every 2s while the window is visible. Rebuilding the fluent-radio DOM on every push
// wiped the current selection (fresh elements lose the checked state), so we ONLY rebuild when the list
// actually changed (signature compare) and reconcile the selection on every push without touching the DOM.
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
    driveGroup.replaceChildren();
    driveEmpty.hidden = false;
    setDisabled(driveGroup, true);
    // The selected card is gone (or none was ever present) → block editing, keep the text.
    onSelectedGone();
    return;
  }
  driveEmpty.hidden = true;

  const sig = drivesSignature(list);
  if (sig !== lastDrivesSig) {
    lastDrivesSig = sig;
    rebuildRadios(list);
  }
  reconcileSelection(list);
}

function rebuildRadios(list: readonly DriveCandidate[]): void {
  driveGroup.replaceChildren();
  for (const candidate of list) {
    const field = document.createElement('fluent-field');
    field.setAttribute('label-position', 'after');
    const radio = document.createElement('fluent-radio');
    radio.setAttribute('slot', 'input');
    (radio as HTMLElement & { value?: string }).value = candidate.root;
    const label = document.createElement('label');
    label.setAttribute('slot', 'label');
    label.textContent = candidate.label;
    field.append(radio, label);
    driveGroup.append(field);
  }
  // A lone card auto-selects and the group is disabled (nothing to choose).
  setDisabled(driveGroup, list.length === 1);
}

function reconcileSelection(list: readonly DriveCandidate[]): void {
  const stillPresent = selectedRoot !== null && list.some((d) => d.root === selectedRoot);
  if (stillPresent && selectedRoot !== null) {
    // Keep the current selection; a card that had vanished and came back unblocks (text preserved).
    setGroupValue(driveGroup, selectedRoot);
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
    setGroupValue(driveGroup, pick.root);
    void selectDrive(pick.root, false);
  }
}

function onSelectedGone(): void {
  blocked = true;
  setEditable(false);
  setTemplatesDisabled(true);
  updateSaveEnabled();
  setStatus('The selected card is no longer available. Your text is kept.');
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
// auto-selection). Loads the card's game.json (or clears the editor for a blank drive).
async function selectDrive(root: string, confirmDirty: boolean): Promise<void> {
  if (root === selectedRoot && !blocked) return;
  if (confirmDirty && dirty) {
    const ok = await confirmDialog('Discard unsaved changes and switch cards?', 'Discard');
    if (!ok) {
      if (selectedRoot !== null) setGroupValue(driveGroup, selectedRoot); // revert the radio
      return;
    }
  }
  selectedRoot = root;
  if (blocked) unblock();
  await loadDrive(root);
}

async function loadDrive(root: string): Promise<void> {
  const candidate = drives.find((d) => d.root === root);
  if (candidate === undefined) return;
  if (!candidate.hasManifest) {
    // Blank drive: empty editor, invite a template. loadedId null → no id-change warning.
    loadedId = null;
    setEditorText('', true);
    setStatus('Blank drive — pick a template to start.');
    return;
  }
  const result = await window.configureApi.readConfig(root);
  if (!result.ok) {
    loadedId = null;
    setStatus(`Could not read game.json: ${result.message}`);
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
    const ok = await confirmDialog('Replace current config with the template?', 'Replace');
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
    setStatus('Fix the JSON syntax errors before formatting.');
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
  setStatus('Saving…');
  const result = await window.configureApi.saveConfig(root, text);
  if (!result.saved) {
    setStatus(`Not saved: ${result.message}`);
    updateSaveEnabled();
    return;
  }
  dirty = false;
  loadedId = parseId(text);
  switch (result.applied) {
    case 'applied':
      setStatus('Applied. The launcher was updated.');
      break;
    case 'deferred':
      setStatus('Saved. It will load shortly, or after the active card is removed.');
      break;
    case 'failed':
      setStatus(`Saved, but the manifest was rejected: ${result.message ?? 'unknown reason'}`);
      break;
  }
  updateSaveEnabled();
}

// Reverts unsaved edits by re-reading game.json from the card (labelled "Reset").
async function onReset(): Promise<void> {
  if (selectedRoot === null || blocked) return;
  if (dirty) {
    const ok = await confirmDialog('Discard unsaved changes and reset from the card?', 'Discard');
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

driveGroup.addEventListener('change', () => {
  const value = readGroupValue(driveGroup);
  if (value !== null) void selectDrive(value, true);
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

async function init(): Promise<void> {
  window.configureApi.onDrivesUpdate(renderDrives);
  const [settings, schema, drivesList, icon, version] = await Promise.all([
    window.configureApi.getSettings(),
    window.configureApi.getSchema(),
    window.configureApi.getDrives(),
    window.configureApi.getAppIcon(),
    window.configureApi.getAppVersion(),
  ]);
  applyTheme(settings.theme);
  if (icon !== '') titlebarIcon.src = icon;
  else titlebarIcon.hidden = true;
  // Title bar: [icon] Playhook · "(version) — Configure game" (unified with the settings window).
  titlebarSubtitle.textContent = `(${version}) — Configure game`;
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
}

void init();
