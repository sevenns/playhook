// The Settings screen's controller: the fourth surface of the launcher (see the plan §3). It owns its
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
import type { Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import {
  buildSettingsModel,
  volumePercent,
  type SelectId,
  type SettingsModel,
  type SettingsOption,
  type SettingsRow,
  type ToggleId,
} from './settings-form-model.js';
import {
  optionLabel,
  patchRow,
  relocalizeRow,
  relocalizeSections,
  renderSettings,
  updateAction,
  type RenderedRow,
} from './settings-form-view.js';

/** Gamepad A doesn't trigger :active — the same press flash the rest of the UI uses (controls.ts). */
const PRESS_MS = 130;
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
  setAlwaysShowEmptyScreen(on: boolean): void;
  setDisableSilentInstall(on: boolean): void;
  setSteamAutoLaunch(on: boolean): void;
  setSoundSet(set: string): void;
  setAmbientTrack(track: string | null): void;
  setOnlyGlobalAmbient(on: boolean): void;
  setMusicVolume(volume: number): void;
  setSfxVolume(volume: number): void;
  setLanguage(mode: LanguageMode): void;
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
  /** The screen closed itself (B / Esc / veil click) — controls.ts restores the bar focus. */
  onClosed(): void;
  /** "Reset settings" was activated — controls.ts asks the shared confirm popup. */
  onResetRequested(): void;
}

/** What controls.ts routes into. Mirrors the six primitives, plus open/close and the data pushes. */
export interface SettingsScreen {
  isOpen(): boolean;
  open(): void;
  close(): void;
  navUp(): void;
  navDown(): void;
  navLeft(): void;
  navRight(): void;
  navActivate(): void;
  navBack(): void;
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
  alwaysShowEmptyScreen: (api, value) => api.setAlwaysShowEmptyScreen(value),
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
    case 'alwaysShowEmptyScreen':
      return { ...settings, alwaysShowEmptyScreen: value };
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
  let rendered: readonly RenderedRow[] = [];
  let focusIndex = 0;

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

  function focusedRow(): RenderedRow | undefined {
    return rendered[focusIndex];
  }

  function pressFlash(el: HTMLElement): void {
    el.classList.add('is-pressed');
    window.setTimeout(() => el.classList.remove('is-pressed'), PRESS_MS);
  }

  /**
   * Paints the focus and keeps it on screen. The scroll stays SMOOTH even under a held direction:
   * each scrollIntoView re-targets the running animation from wherever it is, so a burst reads as one
   * continuous glide — where jumping per step (the obvious answer for a repeat) made it stutter.
   */
  function applyRowFocus(): void {
    rendered.forEach((row, index) => row.el.classList.toggle('is-focused', index === focusIndex));
    focusedRow()?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** The loading line, shown until the first snapshot lands (the settings window did the same). */
  function renderLoading(): void {
    listEl.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'settings-section-title';
    loading.textContent = t()('settings.loading');
    listEl.append(loading);
    rendered = [];
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

  function rowsOf(next: SettingsModel): readonly SettingsRow[] {
    return next.sections.flatMap((section) => section.rows);
  }

  /** Rebuilds or patches the list for the current state, keeping the focus index in range. */
  function render(): void {
    const next = currentModel();
    versionEl.textContent = appVersion;
    if (next === null) {
      model = null;
      renderLoading();
      return;
    }
    if (model !== null && sameComposition(model, next) && rendered.length > 0) {
      const rows = rowsOf(next);
      rendered.forEach((row, index) => {
        const nextRow = rows[index];
        // A field being dragged owns its value until the pointer is released — see the module note.
        if (nextRow === undefined || (dragging !== null && dragging.rowIndex === index)) return;
        patchRow(row, nextRow, t());
      });
      model = next;
      return;
    }
    model = next;
    rendered = renderSettings(listEl, next, t()).rows;
    focusIndex = Math.min(Math.max(focusIndex, 0), Math.max(0, rendered.length - 1));
    applyRowFocus();
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
    const valueEl = rendered[rowIndex]?.valueEl;
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
    const rendered_ = rendered[indexOfRow(row.id)];
    if (rowsNext !== null && rendered_ !== undefined) {
      const nextRow = rowsOf(rowsNext)[indexOfRow(row.id)];
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
    return rendered.findIndex((row) => row.row.kind !== 'update-status' && row.row.id === id);
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
    if (next === current) return;
    applyVolume(row, next, true);
  }

  // ── Expanded dropdown ──────────────────────────────────────────────────────

  function closeOptions(): void {
    if (openSelect === null) return;
    openSelect = null;
    optionsEl.classList.remove('is-open');
    optionsEl.setAttribute('aria-hidden', 'true');
    optionsListEl.replaceChildren();
  }

  function applyOptionFocus(): void {
    openSelect?.buttons.forEach((button, index) =>
      button.classList.toggle('is-focused', index === optionIndex),
    );
    openSelect?.buttons[optionIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function chooseOption(rowIndex: number, option: SettingsOption): void {
    const row = rendered[rowIndex]?.row;
    if (row === undefined || row.kind !== 'select') return;
    closeOptions();
    setSelectValue(rowIndex, row, option.value, null);
  }

  function openOptions(rowIndex: number, row: Extract<SettingsRow, { kind: 'select' }>): void {
    const buttons = row.options.map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-option';
      button.textContent = optionLabel(option, t());
      button.classList.toggle('is-current', option.value === row.value);
      button.addEventListener('click', () => {
        pressFlash(button);
        chooseOption(rowIndex, option);
      });
      button.addEventListener('mouseenter', () => {
        optionIndex = row.options.indexOf(option);
        applyOptionFocus();
      });
      return button;
    });
    optionsListEl.replaceChildren(...buttons);
    optionsEl.classList.add('is-open');
    optionsEl.setAttribute('aria-hidden', 'false');
    const current = row.options.findIndex((option) => option.value === row.value);
    optionIndex = current === -1 ? 0 : current;
    openSelect = { rowIndex, buttons };
    applyOptionFocus();
  }

  // ── The six primitives ─────────────────────────────────────────────────────

  function moveRowFocus(delta: number): void {
    if (rendered.length === 0) return;
    const next = Math.min(rendered.length - 1, Math.max(0, focusIndex + delta));
    if (next === focusIndex) return;
    focusIndex = next;
    deps.audio.play('navigate');
    applyRowFocus();
  }

  function moveOptionFocus(delta: number): void {
    if (openSelect === null || openSelect.buttons.length === 0) return;
    const count = openSelect.buttons.length;
    const next = (optionIndex + delta + count) % count;
    if (next === optionIndex) return;
    optionIndex = next;
    deps.audio.play('navigate');
    applyOptionFocus();
  }

  function navUp(): void {
    if (openSelect !== null) moveOptionFocus(-1);
    else moveRowFocus(-1);
  }

  function navDown(): void {
    if (openSelect !== null) moveOptionFocus(1);
    else moveRowFocus(1);
  }

  function navHorizontal(delta: number): void {
    if (openSelect !== null) return; // the expanded list is vertical
    const target = focusedRow();
    if (target === undefined) return;
    const row = target.row;
    if (row.kind === 'toggle') {
      toggleRow(focusIndex, row);
      return;
    }
    if (row.kind === 'select') {
      cycleSelect(focusIndex, row, delta);
      return;
    }
    if (row.kind === 'slider') stepSlider(row, delta);
  }

  function navLeft(): void {
    navHorizontal(-1);
  }

  function navRight(): void {
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
        deps.audio.play('button');
        pressFlash(target.el);
        openOptions(index, row);
        break;
      case 'slider':
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
    if (openSelect !== null) {
      const row = rendered[openSelect.rowIndex]?.row;
      if (row === undefined || row.kind !== 'select') return;
      const option = row.options[optionIndex];
      if (option === undefined) return;
      deps.audio.play('button');
      chooseOption(openSelect.rowIndex, option);
      return;
    }
    const target = focusedRow();
    if (target === undefined) return;
    activateRow(target, focusIndex);
  }

  function close(): void {
    if (!open) return;
    open = false;
    closeOptions();
    delete app.dataset['overlay'];
    screen.setAttribute('aria-hidden', 'true');
    deps.onClosed();
  }

  function navBack(): void {
    if (openSelect !== null) {
      deps.audio.play('back');
      closeOptions();
      return;
    }
    deps.audio.play('back');
    close();
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────

  /** A click inside a row: the chevrons, the row's own button and the slider track act on their own. */
  listEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rowEl = target.closest<HTMLElement>('.setting-row');
    if (rowEl === null) return;
    const index = rendered.findIndex((row) => row.el === rowEl);
    if (index === -1) return;
    const entry = rendered[index];
    if (entry === undefined) return;
    focusIndex = index;
    applyRowFocus();
    const chevronEl = target.closest<HTMLElement>('.setting-chevron');
    if (chevronEl !== null && entry.row.kind === 'select') {
      cycleSelect(index, entry.row, chevronEl.dataset['chevron'] === 'prev' ? -1 : 1);
      return;
    }
    // The track handles its own pointer events (jump + drag) — don't double-act on the click.
    if (target.closest('.setting-track') !== null) return;
    activateRow(entry, index);
  });

  // Hover moves the focus, but ONLY on a real pointer move. Chromium re-fires mouseover whenever an
  // element slides under a still cursor — which the focus scroll does on every step — and acting on that
  // yanked the focus back to the row the pointer happened to be over (the visible "jump back" stutter).
  // Same reason the bar's own handler filters synthetic moves (controls.ts).
  let lastX = -1;
  let lastY = -1;
  listEl.addEventListener(
    'mousemove',
    (event) => {
      if (event.clientX === lastX && event.clientY === lastY) return;
      lastX = event.clientX;
      lastY = event.clientY;
      // The gamepad hides the cursor; a stale hover must not fight its focus (see .text-button:hover).
      if (document.documentElement.classList.contains('cursor-hidden')) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const rowEl = target.closest<HTMLElement>('.setting-row');
      if (rowEl === null) return;
      const index = rendered.findIndex((row) => row.el === rowEl);
      if (index === -1 || index === focusIndex) return;
      focusIndex = index;
      applyRowFocus();
    },
    { passive: true },
  );

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
    const index = rendered.findIndex((row) => row.el === rowEl);
    const entry = rendered[index];
    if (entry === undefined || entry.row.kind !== 'slider') return;
    focusIndex = index;
    applyRowFocus();
    // No transition while the knob follows the cursor — see the plan §3.6.
    track.closest('.setting-slider')?.classList.add('is-dragging');
    dragging = { rowIndex: index, track, pointerId: event.pointerId };
    track.setPointerCapture(event.pointerId);
    applyVolume(entry.row, percentAt(track, event.clientX), false);
  });

  listEl.addEventListener('pointermove', (event) => {
    if (dragging === null || event.pointerId !== dragging.pointerId) return;
    const entry = rendered[dragging.rowIndex];
    if (entry === undefined || entry.row.kind !== 'slider') return;
    applyVolume(entry.row, percentAt(dragging.track, event.clientX), true);
  });

  function endDrag(): void {
    if (dragging === null) return;
    const entry = rendered[dragging.rowIndex];
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
    deps.audio.play('back');
    close();
  });

  optionsVeil?.addEventListener('click', () => {
    deps.audio.play('back');
    closeOptions();
  });

  return {
    isOpen: () => open,
    open: () => {
      if (open) return;
      open = true;
      focusIndex = 0;
      app.dataset['overlay'] = 'settings';
      screen.setAttribute('aria-hidden', 'false');
      // Instant, not smooth: a re-open must START at the top rather than glide there from wherever the
      // previous visit left the list (which showed as a half-cropped first row).
      listEl.scrollTo({ top: 0, behavior: 'instant' });
      render();
      applyRowFocus();
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
      if (model !== null) relocalizeSections(listEl, model, t());
      for (const row of rendered) relocalizeRow(row, t());
      // The expanded list, if any, carries labels too.
      if (openSelect !== null) {
        const row = rendered[openSelect.rowIndex]?.row;
        if (row !== undefined && row.kind === 'select') {
          openSelect.buttons.forEach((button, index) => {
            const option = row.options[index];
            if (option !== undefined) button.textContent = optionLabel(option, t());
          });
        }
      }
    },
    resetSettings: () => deps.api.resetSettings(),
  };
}
