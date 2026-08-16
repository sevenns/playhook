// DOM rendering for the launcher's Settings screen: a SettingsModel in, a list of built rows out. The
// controller (settings-screen.ts) owns navigation and IPC and addresses rows BY INDEX, so this module
// hands back a flat array in screen order alongside the DOM it built.
//
// Two jobs, and the second is the load-bearing one: rows are also PATCHED in place (patchRow) when a new
// AppSettings snapshot arrives. Rebuilding the list on every settings:update would flash the screen and
// restart every transition mid-flight — see the plan's §3.6. A full rebuild is only for a change in the
// row COMPOSITION (steamAvailable arriving).
//
// Everything but the Updates row is drawn by row-view-core, which the Customize screen shares: this
// module is now the Settings-specific half (the status line, its progress bar and its primary button).
import type { SettingsModel, SettingsRow } from './settings-form-model';
import type { Translator } from '../shared/i18n/index';
import type { UpdateStatus } from '../shared/types';
import {
  buildCoreRow,
  div,
  patchCoreRow,
  relocalizeCoreRow,
  type CoreRendered,
} from './row-view-core';

export { optionLabel, optionLabelNode, applySliderPercent } from './row-view-core';

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

/** Shows the download bar only while downloading, and sets its width to the percent. */
function applyProgress(fill: HTMLElement, progress: HTMLElement, status: UpdateStatus): void {
  const downloading = status.kind === 'downloading';
  progress.classList.toggle('is-visible', downloading);
  if (downloading) fill.style.width = `${status.percent}%`;
}

/** The Updates row — this screen's own kind, with a status line, a progress bar and a button. */
function buildStatusRow(status: UpdateStatus, t: Translator): CoreRendered & { progressEl: HTMLElement } {
  const el = div('setting-row');
  el.dataset['kind'] = 'update-status';
  el.classList.add('setting-row-status');
  const text = div('setting-status-text', updateStatusText(status, t));
  const progress = div('setting-progress');
  const bar = div('setting-progress-fill');
  progress.append(bar);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-button';
  const action = updateAction(status, t);
  button.textContent = action?.label ?? '';
  button.classList.toggle('is-hidden', action === null);
  const body = div('setting-status-body');
  body.append(text, progress);
  el.append(body, button);
  applyProgress(bar, progress, status);
  return { el, valueEl: text, buttonEl: button, fillEl: null, progressEl: progress };
}

/** Builds one row's element: the Updates row here, everything else in row-view-core. */
function buildRow(row: SettingsRow, t: Translator): RenderedRow {
  if (row.kind === 'update-status') {
    return { row, ...buildStatusRow(row.status, t) };
  }
  const core = buildCoreRow(row, t);
  return { row, ...core, progressEl: null };
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
  const sections = model.sections.map((section) => {
    const sectionEl = div('settings-section');
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
  if (row.kind !== 'update-status') {
    patchCoreRow(rendered, row, t);
    return;
  }
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
  if (row.kind === 'update-status') {
    patchRow(rendered, row, t);
    return;
  }
  relocalizeCoreRow(rendered, row, t);
}
