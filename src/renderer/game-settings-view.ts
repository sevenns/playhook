// DOM rendering for the launcher's Customize screen. The same shape settings-form-view.ts has — a model
// in, a flat array of rendered rows out, addressed BY INDEX by the controller — and for the same reason:
// a re-render on every keystroke would restart every transition and lose the scroll position, so a value
// change PATCHES the row that changed and only a change in the row COMPOSITION (a new launch mode, a
// warning appearing) rebuilds the list.
//
// Unlike the Settings view there is no screen-specific row kind here: every kind this screen draws lives
// in row-view-core, which is why this module is as short as it is.
import type { GameSettingsModel, GameSettingsRow } from './game-settings-model';
import type { Translator } from '../shared/i18n/index';
import {
  buildCoreRow,
  div,
  patchCoreRow,
  relocalizeCoreRow,
  rowLabelText,
  type PreviewAspect,
} from './row-view-core';

/** One rendered row: the model row it came from plus the nodes the controller updates. */
export interface RenderedGameRow {
  row: GameSettingsRow;
  readonly el: HTMLElement;
  readonly valueEl: HTMLElement | null;
  readonly buttonEl: HTMLButtonElement | null;
  /** Never used here — no row of this screen is a slider; present so a row IS a CoreRendered. */
  readonly fillEl: null;
  /** The thumbnail strip of an artwork row, filled asynchronously (gameConfig:image-preview). */
  readonly previewEl: HTMLElement | null;
}

export interface RenderedGameScreen {
  readonly rows: readonly RenderedGameRow[];
}

/** Whether a row can hold the focus. A note is text on the screen, not a control. */
export function isFocusable(row: GameSettingsRow): boolean {
  return row.kind !== 'note' && row.kind !== 'static';
}

function buildRow(row: GameSettingsRow, t: Translator): RenderedGameRow {
  const core = buildCoreRow(row, t);
  core.el.dataset['row'] = row.id;
  if (!isFocusable(row)) core.el.classList.add('is-inert');
  let previewEl: HTMLElement | null = null;
  if ((row.kind === 'path' || row.kind === 'list') && row.preview !== undefined) {
    previewEl = div('setting-thumbs');
    core.el.append(previewEl);
  }
  return {
    row,
    el: core.el,
    valueEl: core.valueEl,
    buttonEl: core.buttonEl,
    fillEl: null,
    previewEl,
  };
}

/**
 * Renders the whole model into `container` (replacing its content) and returns the rows in screen order.
 * Section titles are not focusable, so they are absent from the returned list by construction — but the
 * inert rows (statics, notes) ARE in it, so an index still addresses the row the model built.
 */
export function renderGameSettings(
  container: HTMLElement,
  model: GameSettingsModel,
  t: Translator,
): RenderedGameScreen {
  const rows: RenderedGameRow[] = [];
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

/** Applies a new model row onto an already-rendered one. Same `kind` only. */
export function patchGameRow(rendered: RenderedGameRow, row: GameSettingsRow, t: Translator): void {
  rendered.row = row;
  patchCoreRow(rendered, row, t);
}

/** Re-applies the SECTION titles for a new translator (the rows carry their own labels). */
export function relocalizeGameSections(
  container: HTMLElement,
  model: GameSettingsModel,
  t: Translator,
): void {
  const sections = [...container.querySelectorAll<HTMLElement>('.settings-section')];
  model.sections.forEach((section, index) => {
    const title = sections[index]?.querySelector<HTMLElement>('.settings-section-title');
    if (title === null || title === undefined || section.titleKey === undefined) return;
    title.textContent = t(section.titleKey);
  });
}

export function relocalizeGameRow(rendered: RenderedGameRow, t: Translator): void {
  relocalizeCoreRow(rendered, rendered.row, t);
}

/**
 * Fills an artwork row's thumbnail strip with already-decoded data URLs (null = nothing readable). The
 * strip is drawn in the artwork's own shape (`aspect`), and each thumbnail remembers the manifest path
 * it came from so a click can open that picture full size.
 */
export function applyThumbnails(
  rendered: RenderedGameRow,
  urls: readonly (string | null)[],
  aspect: PreviewAspect,
  paths: readonly string[],
): void {
  const box = rendered.previewEl;
  if (box === null) return;
  const thumbs: HTMLImageElement[] = [];
  urls.forEach((url, index) => {
    if (url === null) return;
    const image = document.createElement('img');
    image.className = 'setting-thumb';
    image.src = url;
    image.alt = '';
    image.dataset['path'] = paths[index] ?? '';
    thumbs.push(image);
  });
  box.classList.toggle('is-portrait', aspect === 'portrait');
  box.replaceChildren(...thumbs);
  box.classList.toggle('is-hidden', thumbs.length === 0);
}

/** The screen's heading: the game's own title, or a placeholder while nothing is loaded yet. */
export function screenHeading(model: GameSettingsModel | null, t: Translator): string {
  if (model === null) return t('gameSettings.screenTitle');
  return model.title === '' ? t('gameSettings.screenTitle') : model.title;
}

/** Exported for the controller's own re-localization pass of an expanded dropdown. */
export { rowLabelText };
