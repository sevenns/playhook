// DOM rendering for the launcher's Settings screen: a SettingsModel in, a list of built rows out. The
// controller (settings-screen.ts) owns navigation and IPC and addresses rows BY INDEX, so this module
// hands back a flat array in screen order alongside the DOM it built.
//
// Two jobs, and the second is the load-bearing one: rows are also PATCHED in place (patchRow) when a new
// AppSettings snapshot arrives. Rebuilding the list on every settings:update would flash the screen and
// restart every transition mid-flight — see the plan's §3.6. A full rebuild is only for a change in the
// row COMPOSITION (steamAvailable arriving).
import type { SettingsModel, SettingsOption, SettingsRow } from './settings-form-model';
import type { Translator } from '../shared/i18n/index';
import type { UpdateStatus } from '../shared/types';

/** One rendered row: the model row it came from plus the nodes the controller updates. */
export interface RenderedRow {
  /** The row's model at render time — patchRow replaces this as values change. */
  row: SettingsRow;
  /** The focusable row element (`.setting-row`); the controller toggles `is-focused` / `is-pressed`. */
  readonly el: HTMLElement;
  /** The value node whose content changes: the select's text, the slider's percent, the status line. */
  readonly valueEl: HTMLElement | null;
  /** The `.text-button` of an action row / the update-status row's primary button. */
  readonly buttonEl: HTMLButtonElement | null;
  /** The slider's filled track, patched as the percent changes. */
  readonly fillEl: HTMLElement | null;
  /** The download progress bar of the update-status row. */
  readonly progressEl: HTMLElement | null;
}

export interface RenderedScreen {
  /** Every focusable row, in screen order — the navigation model is this array's indices. */
  readonly rows: readonly RenderedRow[];
}

/** The label of an option: a translation key for our own words, a literal for bundled proper names. */
export function optionLabel(option: SettingsOption, t: Translator): string {
  return 'labelKey' in option ? t(option.labelKey) : option.label;
}

function div(className: string, text?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The inline check glyph of a toggle. Inline SVG — DOM, not a network resource, so the CSP is fine. */
function checkIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'setting-check');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 12.5 L9.5 18 L20 6.5');
  svg.append(path);
  return svg;
}

/** A left/right chevron of a select row (clickable with the mouse — see settings-screen.ts). */
function chevron(direction: 'prev' | 'next'): HTMLElement {
  const button = document.createElement('span');
  button.className = `setting-chevron is-${direction}`;
  button.dataset['chevron'] = direction;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', direction === 'prev' ? 'M15 4 L7 12 L15 20' : 'M9 4 L17 12 L9 20');
  svg.append(path);
  button.append(svg);
  return button;
}

/** The status line + primary action of the Updates section, per the current UpdateStatus. */
export function updateStatusText(status: UpdateStatus, t: Translator): string {
  switch (status.kind) {
    case 'idle':
      return t('settings.status.idle');
    case 'not-available':
      return t('settings.status.upToDate');
    case 'checking':
      return t('settings.status.checking');
    case 'available':
      return t('settings.status.available', { version: status.version });
    case 'downloading':
      return t('settings.status.downloading', { percent: status.percent });
    case 'downloaded':
      return t('settings.status.downloaded', { version: status.version });
    case 'error':
      // Already localized in main (or a passthrough technical cause) — render as-is.
      return status.message;
    case 'unsupported':
      return t('settings.status.unsupported');
  }
}

/** The Updates row's primary button: its label, and whether it acts at all (null = disabled). */
export interface UpdateAction {
  readonly label: string;
  readonly kind: 'check' | 'download' | 'install' | null;
}

export function updateAction(status: UpdateStatus, t: Translator): UpdateAction | null {
  switch (status.kind) {
    case 'idle':
    case 'not-available':
      return { label: t('settings.action.check'), kind: 'check' };
    case 'checking':
      return { label: t('settings.action.checking'), kind: null };
    case 'available':
      return {
        label: t('settings.action.updateTo', { version: status.version }),
        kind: 'download',
      };
    case 'downloading':
      return { label: t('settings.action.downloading'), kind: null };
    case 'downloaded':
      return { label: t('settings.action.restartInstall'), kind: 'install' };
    case 'error':
      return { label: t('settings.action.retry'), kind: 'check' };
    case 'unsupported':
      return null;
  }
}

function buildToggle(row: Extract<SettingsRow, { kind: 'toggle' }>): {
  readonly control: HTMLElement;
} {
  const control = div('setting-toggle');
  control.append(checkIcon());
  control.classList.toggle('is-on', row.value);
  return { control };
}

function selectedLabel(row: Extract<SettingsRow, { kind: 'select' }>, t: Translator): string {
  const option = row.options.find((candidate) => candidate.value === row.value);
  return option === undefined ? row.value : optionLabel(option, t);
}

/** Builds one row's element. The row's control is built per `kind`; the label side is shared. */
function buildRow(row: SettingsRow, t: Translator): RenderedRow {
  const el = div('setting-row');
  el.dataset['kind'] = row.kind;

  if (row.kind === 'update-status') {
    el.classList.add('setting-row-status');
    const text = div('setting-status-text', updateStatusText(row.status, t));
    const progress = div('setting-progress');
    const bar = div('setting-progress-fill');
    progress.append(bar);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button';
    const action = updateAction(row.status, t);
    button.textContent = action?.label ?? '';
    button.classList.toggle('is-hidden', action === null);
    const body = div('setting-status-body');
    body.append(text, progress);
    el.append(body, button);
    applyProgress(bar, progress, row.status);
    return { row, el, valueEl: text, buttonEl: button, fillEl: null, progressEl: progress };
  }

  // An action row is JUST its button — a label beside it would only repeat the button's own words.
  if (row.kind !== 'action') {
    const label = div('setting-label', t(row.labelKey));
    const labelBox = div('setting-label-box');
    labelBox.append(label);
    if (row.kind === 'toggle' && row.hintKey !== undefined) {
      labelBox.append(div('setting-hint', t(row.hintKey)));
    }
    el.append(labelBox);
  }

  switch (row.kind) {
    case 'toggle': {
      const { control } = buildToggle(row);
      el.append(control);
      return { row, el, valueEl: control, buttonEl: null, fillEl: null, progressEl: null };
    }
    case 'select': {
      const control = div('setting-select');
      const value = div('setting-value', selectedLabel(row, t));
      control.append(chevron('prev'), value, chevron('next'));
      el.append(control);
      return { row, el, valueEl: value, buttonEl: null, fillEl: null, progressEl: null };
    }
    case 'slider': {
      const control = div('setting-slider');
      const track = div('setting-track');
      const fill = div('setting-fill');
      const knob = div('setting-knob');
      track.append(fill, knob);
      const value = div('setting-value', `${row.percent}%`);
      control.append(track, value);
      applySliderPercent(fill, knob, row.percent);
      el.append(control);
      return { row, el, valueEl: value, buttonEl: null, fillEl: fill, progressEl: null };
    }
    case 'action': {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = t(row.labelKey);
      el.append(button);
      return { row, el, valueEl: null, buttonEl: button, fillEl: null, progressEl: null };
    }
  }
}

/** Positions a slider's fill + knob for a 0..100 percent. */
export function applySliderPercent(fill: HTMLElement, knob: HTMLElement, percent: number): void {
  fill.style.width = `${percent}%`;
  knob.style.left = `${percent}%`;
}

/** Shows the download bar only while downloading, and sets its width to the percent. */
function applyProgress(fill: HTMLElement, progress: HTMLElement, status: UpdateStatus): void {
  const downloading = status.kind === 'downloading';
  progress.classList.toggle('is-visible', downloading);
  if (downloading) fill.style.width = `${status.percent}%`;
}

/**
 * Renders the whole model into `container` (replacing its content) and returns the rows in screen order.
 * Section titles are not focusable, so they are absent from the returned list by construction.
 */
export function renderSettings(
  container: HTMLElement,
  model: SettingsModel,
  t: Translator,
): RenderedScreen {
  const rows: RenderedRow[] = [];
  const sections = model.sections.map((section, index) => {
    const sectionEl = div('settings-section');
    // Only the first few sections stagger — past that the delay reads as lag rather than as motion.
    sectionEl.style.setProperty('--section-index', String(Math.min(index, 2)));
    if (section.titleKey !== undefined) {
      sectionEl.append(div('settings-section-title', t(section.titleKey)));
    }
    for (const row of section.rows) {
      const rendered = buildRow(row, t);
      rows.push(rendered);
      sectionEl.append(rendered.el);
    }
    return sectionEl;
  });
  container.replaceChildren(...sections);
  return { rows };
}

/**
 * Applies a new model row onto an already-rendered one, touching only what changed. Same `kind` only —
 * a composition change goes through renderSettings instead.
 */
export function patchRow(rendered: RenderedRow, row: SettingsRow, t: Translator): void {
  rendered.row = row;
  switch (row.kind) {
    case 'toggle':
      rendered.valueEl?.classList.toggle('is-on', row.value);
      break;
    case 'select':
      if (rendered.valueEl !== null) rendered.valueEl.textContent = selectedLabel(row, t);
      break;
    case 'slider': {
      if (rendered.valueEl !== null) rendered.valueEl.textContent = `${row.percent}%`;
      const knob = rendered.el.querySelector<HTMLElement>('.setting-knob');
      if (rendered.fillEl !== null && knob !== null) {
        applySliderPercent(rendered.fillEl, knob, row.percent);
      }
      break;
    }
    case 'action':
      if (rendered.buttonEl !== null) rendered.buttonEl.textContent = t(row.labelKey);
      break;
    case 'update-status': {
      if (rendered.valueEl !== null) rendered.valueEl.textContent = updateStatusText(row.status, t);
      const action = updateAction(row.status, t);
      if (rendered.buttonEl !== null) {
        rendered.buttonEl.textContent = action?.label ?? '';
        rendered.buttonEl.classList.toggle('is-hidden', action === null);
      }
      const fill = rendered.el.querySelector<HTMLElement>('.setting-progress-fill');
      if (fill !== null && rendered.progressEl !== null) {
        applyProgress(fill, rendered.progressEl, row.status);
      }
      break;
    }
  }
}

/** Re-applies the SECTION titles for a new translator (the rows carry their own labels). */
export function relocalizeSections(
  container: HTMLElement,
  model: SettingsModel,
  t: Translator,
): void {
  const sections = [...container.querySelectorAll<HTMLElement>('.settings-section')];
  model.sections.forEach((section, index) => {
    const title = sections[index]?.querySelector<HTMLElement>('.settings-section-title');
    if (title === null || title === undefined || section.titleKey === undefined) return;
    title.textContent = t(section.titleKey);
  });
}

/** Re-applies the row's LABELS for a new translator (values are patched by patchRow). */
export function relocalizeRow(rendered: RenderedRow, t: Translator): void {
  const row = rendered.row;
  if (row.kind !== 'update-status' && row.kind !== 'action') {
    const label = rendered.el.querySelector<HTMLElement>('.setting-label');
    if (label !== null) label.textContent = t(row.labelKey);
    if (row.kind === 'toggle' && row.hintKey !== undefined) {
      const hint = rendered.el.querySelector<HTMLElement>('.setting-hint');
      if (hint !== null) hint.textContent = t(row.hintKey);
    }
  }
  patchRow(rendered, row, t);
}
