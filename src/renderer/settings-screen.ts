// The Settings screen's controller: the fourth surface of the launcher. It owns its
// own state (the last AppSettings snapshot, the update status, the environment), the row focus, the
// expanded dropdown and the slider drag — and exposes the SAME six navigation primitives the rest of the
// UI uses, so controls.ts only has to route to it. Everything that decides WHAT is on screen lives in
// settings-form-model.ts (pure, unit-tested); the DOM building and patching in settings-form-view.ts.
//
// Two rules earn their own note, because both are easy to lose:
//  • a settings:update arriving mid-drag must NOT move the knob under the cursor — the dragged field
//    ignores incoming values until the pointer is released;
//  • a new snapshot PATCHES the rendered rows; only a change in the row composition (steamAvailable
//    arriving) rebuilds them, and the rebuild keeps the focused index.
import type {
  AppSettings,
  AudioOptions,
  AutoUpdateMode,
  LanguageMode,
  UpdateStatus,
} from '../shared/types';
import type { MessageKey, Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { pressFlash, req } from './dom.js';
import { createEntrance } from './entrance.js';
import { createHoverGuard } from './hover-guard.js';
import { wrapIndex } from './index-math.js';
import { createScroller } from './screen-scroller.js';
import { createSidebar } from './screen-sidebar.js';
import { createListScreenCore, sectionByKey, titledSections } from './list-screen-core.js';
import { updateMarquee } from './marquee.js';
import {
  buildSettingsModel,
  volumePercent,
  type SelectId,
  type SettingsModel,
  type SettingsOption,
  type SettingsRow,
  type TextId,
  type ToggleId,
} from './settings-form-model.js';
import { rowLabelText } from './row-view-core.js';
import type { TextEntrySurface } from './nav-surface.js';
import {
  optionLabel,
  optionLabelNode,
  patchRow,
  relocalizeRow,
  relocalizeSections,
  renderSettings,
  updateAction,
  type RenderedRow,
} from './settings-form-view.js';

/** One keyboard/gamepad step of a volume slider, in percent. */
const VOLUME_STEP = 5;
/** While dragging, main is written at most this often; the release always writes the final value. */
const DRAG_PERSIST_MS = 150;
/** The SFX preview plays at most this often while a volume is being dragged. */
const PREVIEW_THROTTLE_MS = 220;

/** What the screen sends to main. A seam, so app.ts owns the window.api wiring (and tests can fake it). */
export interface SettingsScreenApi {
  setAutoUpdate(mode: AutoUpdateMode): void;
  setPrerelease(on: boolean): void;
  setSummonHotkey(on: boolean): void;
  setPreventScreensaver(on: boolean): void;
  setKeepOpenWithoutCard(on: boolean): void;
  setDisableSilentInstall(on: boolean): void;
  setSteamAutoLaunch(on: boolean): void;
  setSoundSet(set: string): void;
  setAmbientTrack(track: string | null): void;
  setOnlyGlobalAmbient(on: boolean): void;
  setMusicVolume(volume: number): void;
  setSfxVolume(volume: number): void;
  setLanguage(mode: LanguageMode): void;
  /** Store the user's SteamGridDB key ('' clears it). */
  setSteamGridDbKey(key: string): void;
  /** Fire-and-forget: the screen re-renders from the settings:update push, not from the invoke result. */
  resetSettings(): void;
  checkForUpdates(): void;
  downloadUpdate(): void;
  installUpdate(): void;
}

export interface SettingsScreenDeps {
  readonly audio: AudioController;
  getTranslator(): Translator;
  readonly api: SettingsScreenApi;
  /**
   * The on-screen keyboard — this screen has one text field (the SteamGridDB key), and on a gamepad it
   * is the only way to fill it. Shared with the Customize screen: at most one surface is open at a time.
   */
  readonly keyboard: TextEntrySurface;
  /** The screen closed itself (B / Esc / veil click) — controls.ts restores the bar focus. */
  onClosed(): void;
  /** "Reset settings" was activated — controls.ts asks the shared confirm popup. */
  onResetRequested(): void;
}

/** What controls.ts routes into. Mirrors the six primitives, plus open/close and the data pushes. */
export interface SettingsScreen {
  isOpen(): boolean;
  /**
   * `sectionKey` deep-links to one section (an "update ready" notification lands on Updates).
   *
   * `silent` is for an entrance that has ALREADY sounded: the carousel's Settings card plays `button` as
   * it is activated, exactly like entering a game, and the screen's own opening sound would be a second
   * copy of the same one. Reached any other way (that same notification) the screen still speaks for
   * itself — the popup it came out of goes silently there.
   */
  open(sectionKey?: MessageKey, options?: { readonly silent?: boolean }): void;
  close(): void;
  navUp(): void;
  navDown(): void;
  /** `repeat` marks a hold auto-repeat: a held left must not walk out of the expanded list and beyond. */
  navLeft(repeat?: boolean): void;
  navRight(): void;
  navActivate(): void;
  navBack(): void;
  /** X / Y / LB-RB / RT — claimed only while the keyboard is open on top of this screen. */
  navSecondary(repeat?: boolean): void;
  navTertiary(): void;
  navShoulder(direction: -1 | 1): void;
  navCommit(): void;
  /** A new AppSettings snapshot (the single source of truth for every value on screen). */
  applySettings(settings: AppSettings): void;
  applyUpdateStatus(status: UpdateStatus): void;
  /** The environment seeds that arrive once at startup (Steam availability, audio options, version). */
  applyEnv(env: {
    readonly steamAvailable?: boolean;
    readonly audioOptions?: AudioOptions;
    readonly appVersion?: string;
  }): void;
  /** Re-renders every label for the current translator, keeping the focus and the scroll position. */
  relocalize(): void;
  /** Runs the reset (the confirm popup said yes). */
  resetSettings(): void;
}

/** The AppSettings field a toggle writes, and the api call that persists it. */
type ToggleWriter = (api: SettingsScreenApi, value: boolean) => void;

const TOGGLE_WRITERS: Readonly<Record<ToggleId, ToggleWriter>> = {
  prerelease: (api, value) => api.setPrerelease(value),
  summonHotkey: (api, value) => api.setSummonHotkey(value),
  preventScreensaver: (api, value) => api.setPreventScreensaver(value),
  keepOpenWithoutCard: (api, value) => api.setKeepOpenWithoutCard(value),
  disableSilentInstall: (api, value) => api.setDisableSilentInstall(value),
  steamAutoLaunch: (api, value) => api.setSteamAutoLaunch(value),
  onlyGlobalAmbient: (api, value) => api.setOnlyGlobalAmbient(value),
};

/** Applies a toggle's new value to a settings snapshot, so the screen repaints without a round trip. */
function withToggle(settings: AppSettings, id: ToggleId, value: boolean): AppSettings {
  switch (id) {
    case 'prerelease':
      return { ...settings, allowPrerelease: value };
    case 'summonHotkey':
      return { ...settings, summonHotkeyEnabled: value };
    case 'preventScreensaver':
      return { ...settings, preventScreensaver: value };
    case 'keepOpenWithoutCard':
      return { ...settings, keepOpenWithoutCard: value };
    case 'disableSilentInstall':
      return { ...settings, disableSilentInstall: value };
    case 'steamAutoLaunch':
      return { ...settings, steamAutoLaunch: value };
    case 'onlyGlobalAmbient':
      return { ...settings, onlyGlobalAmbient: value };
  }
}

function withSelect(settings: AppSettings, id: SelectId, value: string): AppSettings {
  switch (id) {
    case 'autoUpdate':
      return { ...settings, autoUpdate: value as AutoUpdateMode };
    case 'language':
      return { ...settings, language: value as LanguageMode };
    case 'soundSet':
      return { ...settings, soundSet: value };
    case 'ambientTrack':
      return { ...settings, ambientTrack: value === '' ? null : value };
  }
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

export function createSettingsScreen(deps: SettingsScreenDeps): SettingsScreen {
  const app = req('app');
  const screen = req('settings');
  const veil = screen.querySelector<HTMLElement>('.settings-veil');
  const listEl = req('settings-list');
  const navEl = req('settings-nav');
  const versionEl = req('settings-version');
  const optionsEl = req('settings-options');
  const optionsListEl = req('settings-options-list');
  const optionsVeil = optionsEl.querySelector<HTMLElement>('.settings-options-veil');

  const t = (): Translator => deps.getTranslator();

  let open = false;
  // null until the first settings:request answers — the screen shows the loading line meanwhile.
  let settings: AppSettings | null = null;
  let updateStatus: UpdateStatus = { kind: 'idle' };
  let steamAvailable = false;
  let audioOptions: AudioOptions = { soundSets: [], ambientTracks: [] };
  let appVersion = '';

  let model: SettingsModel | null = null;

  // The expanded dropdown: which row it belongs to, its option buttons and the focused option.
  let openSelect: {
    readonly rowIndex: number;
    readonly buttons: readonly HTMLButtonElement[];
  } | null = null;
  let optionIndex = 0;

  // Slider drag: the field being dragged ignores incoming pushes until the pointer is released.
  let dragging: {
    readonly rowIndex: number;
    readonly track: HTMLElement;
    readonly pointerId: number;
  } | null = null;
  let lastPersistAt = 0;
  let lastPreviewAt = 0;

  // Both scrolling surfaces of this screen use the shared scroller (screen-scroller.ts) — the settings
  // list and the expanded dropdown — so they behave identically, and so do the other screens.
  const listScroller = createScroller(listEl);

  /**
   * The section column. Selecting a section shows it in the pane; ACTIVATING one moves the focus there,
   * which is the only way in — so B is always "back to the column", and the way out of the screen is
   * from the column alone.
   */
  const sidebar = createSidebar<MessageKey, 'reset' | 'close'>(navEl, {
    audio: deps.audio,
    onSection: (id, entered) => {
      core.selectSection(id);
      if (entered) {
        core.enterPane();
        return;
      }
      core.schedulePreview();
    },
    onAction: (id) => {
      if (id === 'reset') {
        deps.audio.play('button');
        deps.onResetRequested();
        return;
      }
      // Closing is a LEAVING gesture, and close() plays `back` for it — one gesture, one sound. A
      // `button` here made the column's Close the only button in the app that sounded twice.
      navBack();
    },
  });
  const optionsScroller = createScroller(optionsListEl);
  const hover = createHoverGuard();

  /** The row focus, the column ⇄ pane steps and the delayed section preview — shared with Customize. */
  const core = createListScreenCore<SettingsRow, RenderedRow>({
    audio: deps.audio,
    listEl,
    sidebar,
    scroller: listScroller,
    hover,
    isFocusable: () => true,
    renderPane: () => renderPane(),
    stepRow: (row, delta) => {
      if (row.kind === 'select') {
        cycleSelect(core.focusIndex(), row, delta);
        return true;
      }
      if (row.kind === 'slider') {
        stepSlider(row, delta);
        return true;
      }
      return false;
    },
    onLeavePane: () => closeOptions(),
  });

  /** The loading line, shown until the first snapshot lands (the settings window did the same). */
  function renderLoading(): void {
    listEl.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'settings-section-title';
    loading.textContent = t()('settings.loading');
    listEl.append(loading);
    core.setRendered([]);
  }

  function currentModel(): SettingsModel | null {
    if (settings === null) return null;
    return buildSettingsModel(settings, {
      steamAvailable,
      audioOptions,
      appVersion,
      updateStatus,
    });
  }

  /** Whether two models describe the same rows in the same order (a patch is enough when they do). */
  function sameComposition(a: SettingsModel, b: SettingsModel): boolean {
    const ids = (m: SettingsModel): string =>
      m.sections
        .flatMap((section) =>
          section.rows.map((row) => (row.kind === 'update-status' ? 'status' : row.id)),
        )
        .join('|');
    return ids(a) === ids(b);
  }

  /** How long the staggered row entrance runs — the marks come off once it is over. */
  const ENTRANCE_MS = 700;
  /** The stagger stops counting here: past a handful of rows the wave is a wait, not a wave. */
  const ENTRANCE_STEPS = 8;
  /** The one-shot entrance (see .setting-row.is-entering in styles.css, and entrance.ts for the shape). */
  const entrance = createEntrance(listEl, '.setting-row', ENTRANCE_MS);

  /** Rebuilds or patches the screen for the current state, keeping the focus index in range. */
  function render(): void {
    // A pending preview means `rendered` belongs to the section BEFORE the one sectionKey now names —
    // patching it against the new section's values would write them into the old section's rows.
    core.flushPreview();
    const next = currentModel();
    versionEl.textContent = appVersion;
    if (next === null) {
      model = null;
      renderLoading();
      return;
    }
    const previous = model;
    model = next;
    renderColumn(next);
    if (previous !== null && sameComposition(previous, next) && core.rendered().length > 0) {
      const rows = visibleRows(next);
      core.rendered().forEach((row, index) => {
        const nextRow = rows[index];
        // A field being dragged owns its value until the pointer is released — see the module note.
        if (nextRow === undefined || (dragging !== null && dragging.rowIndex === index)) return;
        patchRow(row, nextRow, t());
      });
      return;
    }
    renderPane();
  }

  /**
   * The column: one entry per titled section, then the screen's actions. The actions come from the
   * title-less section the model already ends with — the same one that used to sit at the bottom of the
   * scroll, which is exactly what made them hard to reach.
   */
  function renderColumn(from: SettingsModel): void {
    sidebar.render([
      ...titledSections(from.sections).map((section) => ({
        id: section.titleKey,
        label: t()(section.titleKey),
        kind: 'section' as const,
      })),
      ...from.sections
        .filter((section) => section.titleKey === undefined)
        .flatMap((section) => section.rows)
        .flatMap((row) =>
          row.kind === 'action'
            ? [{ id: row.id, label: rowLabelText(row.label, t()), kind: 'action' as const }]
            : [],
        ),
    ]);
  }

  /** The rows the pane currently shows — one section's worth. */
  function visibleRows(from: SettingsModel): readonly SettingsRow[] {
    return sectionByKey(from.sections, core.sectionKey())?.rows ?? [];
  }

  /** Draws the selected section into the pane. The column is rebuilt separately (its entries change far
   *  less often than the values inside a section do). */
  function renderPane(): void {
    const from = model;
    if (from === null) return;
    const section = sectionByKey(from.sections, core.sectionKey());
    if (section === undefined) return;
    core.showSection(section.titleKey);
    // WITHOUT its title: the column beside it already names the section, and printing the name again at
    // the top of the pane says the same thing twice.
    core.setRendered(
      renderSettings(listEl, { ...from, sections: [{ rows: section.rows }] }, t()).rows,
    );
    core.rendered().forEach((row, at) =>
      row.el.style.setProperty('--row-index', String(Math.min(at, ENTRANCE_STEPS))),
    );
    entrance.play();
    core.seatFocus();
    core.applyRowFocus(true);
    listScroller.to(0, true);
    // The rows were inserted THIS tick, so scrollHeight is still the pre-layout value — the fades would
    // be computed against a list that "doesn't scroll yet". Re-run them once the layout has settled.
    requestAnimationFrame(() => listScroller.fades());
  }

  /**
   * Opens the screen ON a given section instead of the first one — the route an "update ready"
   * notification takes to the Updates section.
   *
   * It runs AFTER the column has been built (render → renderColumn): `sidebar.select` on an empty column
   * silently does nothing, and that failure would have been invisible for this very deep link, since
   * Updates happens to be the first section anyway and the fallback lands on it by accident.
   */
  function selectSection(key: MessageKey): void {
    if (!sidebar.select(key)) {
      console.warn(`[settings] no "${key}" section to open on — falling back to the first one`);
      return;
    }
    core.selectSection(key);
    renderPane();
  }

  // ── Value changes ──────────────────────────────────────────────────────────

  /** Applies a locally-known new settings state and repaints, ahead of main's echo. */
  function applyLocal(next: AppSettings): void {
    settings = next;
    render();
  }

  function toggleRow(index: number, row: Extract<SettingsRow, { kind: 'toggle' }>): void {
    if (settings === null) return;
    const value = !row.value;
    TOGGLE_WRITERS[row.id](deps.api, value);
    deps.audio.play('button');
    applyLocal(withToggle(settings, row.id, value));
    void index;
  }

  /**
   * Opens the keyboard on the REAL key rather than on the masked value the row shows — editing a field
   * whose content is dots would mean retyping the whole key to change one character.
   */
  function openKeyboardFor(row: Extract<SettingsRow, { kind: 'text' }>): void {
    if (settings === null) return;
    deps.keyboard.open({
      value: currentText(settings, row.id),
      mode: 'text',
      title: rowLabelText(row.label, t()),
      onDone: (value) => persistText(row.id, value),
    });
  }

  function currentText(snapshot: AppSettings, id: TextId): string {
    switch (id) {
      case 'steamGridDbKey':
        return snapshot.steamGridDbApiKey;
    }
  }

  function persistText(id: TextId, value: string): void {
    if (settings === null) return;
    const trimmed = value.trim();
    switch (id) {
      case 'steamGridDbKey':
        deps.api.setSteamGridDbKey(trimmed);
        applyLocal({ ...settings, steamGridDbApiKey: trimmed });
        break;
    }
  }

  function persistSelect(id: SelectId, value: string): void {
    switch (id) {
      case 'autoUpdate':
        deps.api.setAutoUpdate(value as AutoUpdateMode);
        break;
      case 'language':
        deps.api.setLanguage(value as LanguageMode);
        break;
      case 'soundSet':
        deps.api.setSoundSet(value);
        break;
      case 'ambientTrack':
        deps.api.setAmbientTrack(value === '' ? null : value);
        break;
    }
  }

  /** Moves a dropdown to another value, animating the text in the direction of the press. */
  function setSelectValue(
    rowIndex: number,
    row: Extract<SettingsRow, { kind: 'select' }>,
    value: string,
    direction: 'prev' | 'next' | null,
  ): void {
    if (settings === null || value === row.value) return;
    const valueEl = core.rendered()[rowIndex]?.valueEl;
    if (valueEl !== null && valueEl !== undefined && direction !== null) {
      valueEl.classList.add(direction === 'prev' ? 'is-shift-prev' : 'is-shift-next');
      window.setTimeout(() => valueEl.classList.remove('is-shift-prev', 'is-shift-next'), 120);
    }
    persistSelect(row.id, value);
    deps.audio.play('navigate');
    applyLocal(withSelect(settings, row.id, value));
  }

  /** Cycles a dropdown by one step, wrapping — the fast gamepad path that never expands the list. */
  function cycleSelect(
    rowIndex: number,
    row: Extract<SettingsRow, { kind: 'select' }>,
    delta: number,
  ): void {
    if (row.options.length === 0) return;
    const current = row.options.findIndex((option) => option.value === row.value);
    const base = current === -1 ? 0 : current;
    const next = (base + delta + row.options.length) % row.options.length;
    const option = row.options[next];
    if (option === undefined) return;
    setSelectValue(rowIndex, row, option.value, delta > 0 ? 'next' : 'prev');
  }

  /** Applies a volume LOCALLY first (the preview must sound at the new level), then persists it. */
  function applyVolume(
    row: Extract<SettingsRow, { kind: 'slider' }>,
    percent: number,
    throttle: boolean,
  ): void {
    if (settings === null) return;
    const clamped = clampPercent(percent);
    const volume = clamped / 100;
    if (row.id === 'sfxVolume') deps.audio.setSfxVolume(volume);
    else deps.audio.setMusicVolume(volume);
    const next: AppSettings =
      row.id === 'sfxVolume'
        ? { ...settings, sfxVolume: volume }
        : { ...settings, musicVolume: volume };
    settings = next;
    const rowsNext = currentModel();
    const rendered_ = core.rendered()[indexOfRow(row.id)];
    if (rowsNext !== null && rendered_ !== undefined) {
      const nextRow = visibleRows(rowsNext)[indexOfRow(row.id)];
      if (nextRow !== undefined) patchRow(rendered_, nextRow, t());
      model = rowsNext;
    }
    const now = performance.now();
    if (!throttle || now - lastPersistAt >= DRAG_PERSIST_MS) {
      lastPersistAt = now;
      if (row.id === 'sfxVolume') deps.api.setSfxVolume(volume);
      else deps.api.setMusicVolume(volume);
    }
    // Only the SFX slider previews itself: the music volume is already audible on the running track.
    if (row.id === 'sfxVolume' && now - lastPreviewAt >= PREVIEW_THROTTLE_MS) {
      lastPreviewAt = now;
      deps.audio.play('navigate');
    }
  }

  /** The rendered index of a slider row (both ids are unique across the screen). */
  function indexOfRow(id: string): number {
    return core.rendered().findIndex((row) => row.row.kind !== 'update-status' && row.row.id === id);
  }

  /** Writes the final value of a drag / a key step, bypassing the throttle. */
  function persistVolume(row: Extract<SettingsRow, { kind: 'slider' }>): void {
    if (settings === null) return;
    const volume = row.id === 'sfxVolume' ? settings.sfxVolume : settings.musicVolume;
    if (row.id === 'sfxVolume') deps.api.setSfxVolume(volume);
    else deps.api.setMusicVolume(volume);
  }

  function stepSlider(row: Extract<SettingsRow, { kind: 'slider' }>, delta: number): void {
    const current =
      settings === null
        ? row.percent
        : volumePercent(row.id === 'sfxVolume' ? settings.sfxVolume : settings.musicVolume);
    const next = clampPercent(current + delta * VOLUME_STEP);
    if (next === current) {
      deps.audio.playLimit(); // already at 0 % / 100 %
      return;
    }
    applyVolume(row, next, true);
  }

  // ── Expanded dropdown ──────────────────────────────────────────────────────

  function closeOptions(options?: { readonly silent?: boolean }): void {
    if (openSelect === null) return;
    // `silent` for the cascade out of close(): the screen going away is one popup-close, not two.
    if (options?.silent !== true) deps.audio.play('popup-close');
    openSelect = null;
    screen.classList.remove('is-options-open');
    optionsEl.classList.remove('is-open');
    optionsEl.setAttribute('aria-hidden', 'true');
    optionsListEl.replaceChildren();
  }

  function applyOptionFocus(instant = false): void {
    openSelect?.buttons.forEach((button, index) =>
      button.classList.toggle('is-focused', index === optionIndex),
    );
    const focused = openSelect?.buttons[optionIndex];
    if (focused !== undefined) optionsScroller.reveal(focused, instant);
    updateMarquee(() => openSelect?.buttons ?? []); // only the focused label moves
  }

  function chooseOption(rowIndex: number, option: SettingsOption): void {
    const row = core.rendered()[rowIndex]?.row;
    if (row === undefined || row.kind !== 'select') return;
    closeOptions();
    setSelectValue(rowIndex, row, option.value, null);
  }

  function openOptions(rowIndex: number, row: Extract<SettingsRow, { kind: 'select' }>): void {
    const buttons = row.options.map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-option';
      button.append(optionLabelNode(optionLabel(option, t())));
      button.classList.toggle('is-current', option.value === row.value);
      button.addEventListener('click', () => {
        pressFlash(button);
        chooseOption(rowIndex, option);
      });
      return button;
    });
    deps.audio.play('popup-open');
    optionsListEl.replaceChildren(...buttons);
    screen.classList.add('is-options-open'); // switches the frost on (no fade — see styles.css)
    optionsEl.classList.add('is-open');
    // Measured synchronously: reading clientWidth flushes the layout for the nodes just inserted, which
    // a requestAnimationFrame callback would only get around to on the next frame — and never at all in
    // a window that isn't painting. A label that doesn't fit gets the distance it must travel to show
    // its start, and the marquee (CSS, focused option only) runs off that.
    updateMarquee(() => openSelect?.buttons ?? []);
    optionsEl.setAttribute('aria-hidden', 'false');
    const current = row.options.findIndex((option) => option.value === row.value);
    optionIndex = current === -1 ? 0 : current;
    openSelect = { rowIndex, buttons };
    applyOptionFocus();
  }

  // ── The six primitives ─────────────────────────────────────────────────────

  function moveOptionFocus(delta: number): void {
    if (openSelect === null || openSelect.buttons.length === 0) return;
    const next = wrapIndex(optionIndex, delta, openSelect.buttons.length);
    if (next === optionIndex) return;
    optionIndex = next;
    deps.audio.play('navigate');
    applyOptionFocus();
  }

  /**
   * The keyboard opens ON TOP of this screen, so while it is up every primitive belongs to it — the same
   * stack rule the Customize screen follows for its own sub-surfaces.
   */
  function keyboardSurface(): TextEntrySurface | null {
    return deps.keyboard.isOpen() ? deps.keyboard : null;
  }

  function navUp(): void {
    const keyboard = keyboardSurface();
    if (keyboard !== null) return keyboard.navUp();
    armHover(); // last input wins — see the mousemove handler
    if (openSelect !== null) moveOptionFocus(-1);
    else if (sidebar.hasFocus()) sidebar.move(-1);
    else core.moveRowFocus(-1);
  }

  function navDown(): void {
    const keyboard = keyboardSurface();
    if (keyboard !== null) return keyboard.navDown();
    armHover();
    if (openSelect !== null) moveOptionFocus(1);
    else if (sidebar.hasFocus()) sidebar.move(1);
    else core.moveRowFocus(1);
  }

  function navHorizontal(delta: number): void {
    armHover();
    if (openSelect !== null) return; // handled by navLeft — the expanded list is otherwise vertical
    core.navHorizontal(delta);
  }

  function navLeft(repeat = false): void {
    const keyboard = keyboardSurface();
    if (keyboard !== null) return keyboard.navLeft(repeat);
    armHover();
    // Left leaves the expanded list, the same way it leaves a popup (controls.ts): its column sits on the
    // right edge, so moving left off it means "out". A HELD left is ignored, or the same press would
    // close the list and then start cycling the row's value behind it.
    if (openSelect !== null) {
      if (!repeat) closeOptions();
      return;
    }
    navHorizontal(-1);
  }

  function navRight(): void {
    const keyboard = keyboardSurface();
    if (keyboard !== null) return keyboard.navRight();
    navHorizontal(1);
  }

  function activateRow(target: RenderedRow, index: number): void {
    const row = target.row;
    switch (row.kind) {
      case 'toggle':
        pressFlash(target.el);
        toggleRow(index, row);
        break;
      case 'select':
        // Two sounds, deliberately: `button` is the row being pressed, `popup-open` (openOptions) is the
        // list appearing — the same pair a launcher card plays when it opens its surface.
        deps.audio.play('button');
        pressFlash(target.el);
        openOptions(index, row);
        break;
      case 'slider':
        deps.audio.playLimit(); // a slider is moved with left/right, and A has nothing to press on it
        break;
      case 'text':
        deps.audio.play('button');
        pressFlash(target.el);
        openKeyboardFor(row);
        break;
      case 'action':
        if (row.id === 'close') {
          navBack();
          break;
        }
        deps.audio.play('button');
        pressFlash(target.el);
        deps.onResetRequested();
        break;
      case 'update-status': {
        const action = updateAction(row.status, t());
        if (action === null || action.kind === null) return;
        deps.audio.play('button');
        pressFlash(target.el);
        if (action.kind === 'check') deps.api.checkForUpdates();
        else if (action.kind === 'download') deps.api.downloadUpdate();
        else deps.api.installUpdate();
        break;
      }
    }
  }

  function navActivate(): void {
    const keyboard = keyboardSurface();
    if (keyboard !== null) return keyboard.navActivate();
    armHover();
    if (openSelect === null && sidebar.hasFocus()) {
      sidebar.activate();
      return;
    }
    if (openSelect !== null) {
      const row = core.rendered()[openSelect.rowIndex]?.row;
      if (row === undefined || row.kind !== 'select') return;
      const option = row.options[optionIndex];
      if (option === undefined) return;
      chooseOption(openSelect.rowIndex, option);
      return;
    }
    const target = core.focusedRow();
    if (target === undefined) return;
    activateRow(target, core.focusIndex());
  }

  function close(): void {
    if (!open) return;
    open = false;
    deps.audio.play('back');
    closeOptions({ silent: true }); // leaving the screen takes the dropdown with it — one sound, not two
    deps.keyboard.close(); // …and the keyboard, which lives outside every screen (see #osk in index.html)
    entrance.cancel();
    core.cancelPreview();
    delete app.dataset['overlay'];
    screen.setAttribute('aria-hidden', 'true');
    deps.onClosed();
  }

  function navBack(): void {
    const keyboard = keyboardSurface();
    if (keyboard !== null) return keyboard.navBack();
    armHover();
    if (openSelect !== null) {
      closeOptions();
      return;
    }
    // Out of the pane, back to the column; out of the column, off the screen. The screen can only be
    // left from the column, which is also where Reset and Close live — so leaving is never a surprise.
    // Only the step INSIDE the screen keeps `back`; leaving it is a popup closing, and close() says so.
    if (!sidebar.hasFocus()) {
      deps.audio.play('back');
      core.leavePane();
      return;
    }
    close();
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────

  /** A click inside a row: the chevrons, the row's own button and the slider track act on their own. */
  listEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rowEl = target.closest<HTMLElement>('.setting-row');
    if (rowEl === null) return;
    const index = core.rendered().findIndex((row) => row.el === rowEl);
    if (index === -1) return;
    const entry = core.rendered()[index];
    if (entry === undefined) return;
    sidebar.setFocused(false);
    core.setFocusIndex(index);
    core.applyRowFocus();
    const chevronEl = target.closest<HTMLElement>('.setting-chevron');
    if (chevronEl !== null && entry.row.kind === 'select') {
      cycleSelect(index, entry.row, chevronEl.dataset['chevron'] === 'prev' ? -1 : 1);
      return;
    }
    // The track handles its own pointer events (jump + drag) — don't double-act on the click.
    if (target.closest('.setting-track') !== null) return;
    activateRow(entry, index);
  });

  /** The percent a pointer at `clientX` picks on `track`. */
  function percentAt(track: HTMLElement, clientX: number): number {
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return clampPercent(((clientX - rect.left) / rect.width) * 100);
  }

  listEl.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const track = target.closest<HTMLElement>('.setting-track');
    if (track === null) return;
    const rowEl = track.closest<HTMLElement>('.setting-row');
    if (rowEl === null) return;
    const index = core.rendered().findIndex((row) => row.el === rowEl);
    const entry = core.rendered()[index];
    if (entry === undefined || entry.row.kind !== 'slider') return;
    core.setFocusIndex(index);
    core.applyRowFocus();
    // No transition while the knob follows the cursor: it would lag behind the pointer.
    track.closest('.setting-slider')?.classList.add('is-dragging');
    dragging = { rowIndex: index, track, pointerId: event.pointerId };
    track.setPointerCapture(event.pointerId);
    applyVolume(entry.row, percentAt(track, event.clientX), false);
  });

  listEl.addEventListener('pointermove', (event) => {
    if (dragging === null || event.pointerId !== dragging.pointerId) return;
    const entry = core.rendered()[dragging.rowIndex];
    if (entry === undefined || entry.row.kind !== 'slider') return;
    applyVolume(entry.row, percentAt(dragging.track, event.clientX), true);
  });

  function endDrag(): void {
    if (dragging === null) return;
    const entry = core.rendered()[dragging.rowIndex];
    dragging.track.closest('.setting-slider')?.classList.remove('is-dragging');
    const held = dragging;
    dragging = null;
    if (held.track.hasPointerCapture(held.pointerId))
      held.track.releasePointerCapture(held.pointerId);
    if (entry !== undefined && entry.row.kind === 'slider') persistVolume(entry.row);
    render(); // any push held back during the drag lands now
  }

  listEl.addEventListener('pointerup', endDrag);
  listEl.addEventListener('pointercancel', endDrag);

  veil?.addEventListener('click', () => {
    close();
  });

  /**
   * Hover, for both the row list and the expanded dropdown. WHEN it is allowed to move the focus is the
   * shared hover guard's job (hover-guard.ts) — it keeps tracking the pointer while the screen is closed,
   * so opening can arm it at wherever the cursor happens to rest. The gamepad's cursor-hide is a separate
   * reason to ignore hover, and it is checked too: a hidden cursor must never fight the focus it is not
   * driving.
   */
  let pointerX = -1;
  let pointerY = -1;

  /** Called whenever a surface opens: hover sleeps until the pointer leaves this spot. */
  function armHover(): void {
    hover.arm();
  }

  window.addEventListener(
    'mousemove',
    (event) => {
      const moved = event.clientX !== pointerX || event.clientY !== pointerY;
      pointerX = event.clientX;
      pointerY = event.clientY;
      hover.track(event.clientX, event.clientY);
      if (!moved || !open) return;
      if (document.documentElement.classList.contains('mouse-asleep')) return;
      if (!hover.awake(event.clientX, event.clientY)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (openSelect !== null) {
        const button = target.closest<HTMLButtonElement>('.settings-option');
        if (button === null) return;
        const index = openSelect.buttons.indexOf(button);
        if (index === -1 || index === optionIndex) return;
        optionIndex = index;
        applyOptionFocus();
        return;
      }
      const rowEl = target.closest<HTMLElement>('.setting-row');
      if (rowEl === null) return;
      const index = core.rendered().findIndex((row) => row.el === rowEl);
      if (index === -1 || (index === core.focusIndex() && !sidebar.hasFocus())) return;
      sidebar.setFocused(false);
      core.setFocusIndex(index);
      core.applyRowFocus();
    },
    { passive: true },
  );

  optionsVeil?.addEventListener('click', () => {
    closeOptions();
  });

  return {
    isOpen: () => open,
    open: (section?: MessageKey, options?: { readonly silent?: boolean }) => {
      if (open) return;
      open = true;
      if (options?.silent !== true) deps.audio.play('button');
      core.setFocusIndex(0);
      app.dataset['overlay'] = 'settings';
      screen.setAttribute('aria-hidden', 'false');
      sidebar.reset(); // a re-opened screen starts at the first section, column and pane together
      core.reset();
      // …and the pane is REBUILT rather than patched: the rows still in it belong to whichever section
      // the last visit ended on, and patching those with section one's values crosses the two.
      core.setRendered([]);
      sidebar.setFocused(true); // the screen opens on its table of contents, not inside a section
      sidebar.animateIn();
      armHover(); // same as the dropdown: the screen appears under wherever the mouse happens to rest
      // Instant, not animated: a re-open must START at the top rather than glide there from wherever
      // the previous visit left the list (which showed as a half-cropped first row).
      listScroller.to(0, true);
      render();
      if (section !== undefined) selectSection(section);
      core.applyRowFocus(true);
    },
    close,
    navUp,
    navDown,
    navLeft,
    navRight,
    navActivate,
    navBack,
    applySettings: (next: AppSettings) => {
      settings = next;
      render();
    },
    applyUpdateStatus: (status: UpdateStatus) => {
      updateStatus = status;
      render();
    },
    applyEnv: (env) => {
      if (env.steamAvailable !== undefined) steamAvailable = env.steamAvailable;
      if (env.audioOptions !== undefined) audioOptions = env.audioOptions;
      if (env.appVersion !== undefined) appVersion = env.appVersion;
      render();
    },
    relocalize: () => {
      versionEl.textContent = appVersion;
      if (settings === null) {
        renderLoading();
        return;
      }
      if (model !== null) {
        const section = sectionByKey(model.sections, core.sectionKey());
        if (section !== undefined)
          relocalizeSections(listEl, { ...model, sections: [section] }, t());
        // The column IS labels, so it is rebuilt rather than patched — it keeps its selection by id.
        renderColumn(model);
      }
      for (const row of core.rendered()) relocalizeRow(row, t());
      // The expanded list, if any, carries labels too.
      if (openSelect !== null) {
        const row = core.rendered()[openSelect.rowIndex]?.row;
        if (row !== undefined && row.kind === 'select') {
          openSelect.buttons.forEach((button, index) => {
            const option = row.options[index];
            const text = button.querySelector<HTMLElement>('.settings-option-text');
            if (option !== undefined && text !== null) text.textContent = optionLabel(option, t());
          });
          updateMarquee(() => openSelect?.buttons ?? []);
        }
      }
    },
    // X / Y / the shoulders / RT belong to whatever surface is on top — here that is only ever the
    // keyboard (Backspace, Shift, its layout switch and "commit"). With nothing above the form they mean
    // nothing, and say so with the dead-end sound, exactly as the Customize screen does one level down.
    navSecondary: (repeat = false) => {
      const keyboard = keyboardSurface();
      if (keyboard?.navSecondary === undefined) {
        if (!repeat) deps.audio.playLimit();
        return;
      }
      keyboard.navSecondary(repeat);
    },
    navTertiary: () => {
      const keyboard = keyboardSurface();
      if (keyboard?.navTertiary === undefined) {
        deps.audio.playLimit();
        return;
      }
      keyboard.navTertiary();
    },
    navShoulder: (direction) => {
      const keyboard = keyboardSurface();
      if (keyboard?.navShoulder === undefined) {
        deps.audio.playLimit();
        return;
      }
      keyboard.navShoulder(direction);
    },
    navCommit: () => {
      const keyboard = keyboardSurface();
      if (keyboard?.navCommit === undefined) {
        deps.audio.playLimit();
        return;
      }
      keyboard.navCommit();
    },
    resetSettings: () => deps.api.resetSettings(),
  };
}
