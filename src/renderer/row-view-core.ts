// The row vocabulary shared by the launcher's list screens (Settings and Customize): the label type, the
// dropdown option type, and the DOM builders/patchers for the row kinds both screens draw. Everything
// here is generic over the row `id`, so each screen keeps its own literal-union ids (and the exhaustive
// switches that come with them) while the DOM lives in one place.
//
// Two generalizations over the Settings-only original:
//  • `id` is a type PARAMETER (defaulting to `string`), not a fixed union — a `CoreToggleRow<ToggleId>`
//    is still assignable to the `CoreToggleRow` these functions take, because `id` is readonly;
//  • a label is `{ key }` OR `{ text }`. Settings labels are all translation keys; Customize labels are
//    in the main dynamic (a path, a value, an item number), which no MessageKey can express.
import type { MessageKey, Translator } from '../shared/i18n/index';

/** A row label: our own words (translated) or a value that is what it is (a path, a title, a number). */
export type RowLabel = { readonly key: MessageKey } | { readonly text: string };

export function rowLabelText(label: RowLabel, t: Translator): string {
  return 'key' in label ? t(label.key) : label.text;
}

/**
 * One dropdown option. Its label is either a translation key (`system`, `No ambience`) or a literal —
 * sound sets and ambience tracks are proper names of bundled files and are never translated.
 */
export type CoreOption =
  | { readonly value: string; readonly labelKey: MessageKey }
  | { readonly value: string; readonly label: string };

/** The label of an option: a translation key for our own words, a literal for bundled proper names. */
export function optionLabel(option: CoreOption, t: Translator): string {
  return 'labelKey' in option ? t(option.labelKey) : option.label;
}

/**
 * Builds an option's label as a clipped, scrollable line: `button > .settings-option-clip >
 * .settings-option-text`. A label wider than the column is NOT ellipsized — the bundled font renders the
 * ellipsis as three vertically-centred dots, and a cut-off word is worse than a moving one anyway. The
 * clip fades at both edges and the focused option's text slides to reveal its start (styles.css).
 */
export function optionLabelNode(text: string): HTMLElement {
  const clip = document.createElement('span');
  clip.className = 'settings-option-clip';
  const inner = document.createElement('span');
  inner.className = 'settings-option-text';
  inner.textContent = text;
  clip.append(inner);
  return clip;
}

/**
 * The shape a row's thumbnails are drawn in. It is the ARTWORK's own shape, not a uniform tile: a hero
 * background is 16:9 and the carousel card is a 600x900 portrait, and cropping one into the other's box
 * is exactly the misreading a preview is there to prevent.
 */
export type PreviewAspect = 'wide' | 'portrait';

export function div(className: string, text?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * What every labelled row carries. `error` is the field's own validation problem, ALREADY localized (it
 * comes from main's validator, which speaks the user's language): shown inside the row rather than in a
 * list at the bottom, because a per-game form has thirty fields and "install.args: expected array" is
 * useless when you cannot see which row it means.
 */
interface LabeledRow<Id extends string> {
  readonly id: Id;
  readonly label: RowLabel;
  readonly hint?: RowLabel;
  readonly error?: string;
}

export interface CoreToggleRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'toggle';
  readonly value: boolean;
  /** A toggle the current state forces (install.runAsAdmin under a `custom` installer) — shown, inert. */
  readonly disabled?: boolean;
}

export interface CoreSelectRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'select';
  readonly value: string;
  readonly options: readonly CoreOption[];
}

export interface CoreSliderRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'slider';
  /** 0..100, rounded — the display unit; the controller divides by 100 before it persists. */
  readonly percent: number;
}

export interface CoreActionRow<Id extends string = string> {
  readonly kind: 'action';
  readonly id: Id;
  readonly label: RowLabel;
  /** Marks a destructive action (Delete game) — styled apart from the neutral ones. */
  readonly danger?: boolean;
  /** Shown but inert (Save while the validator is unhappy) — hiding it would hide WHY it cannot run. */
  readonly disabled?: boolean;
}

/** A free-text field. The value is edited through the on-screen keyboard, never typed into the row. */
export interface CoreTextRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'text';
  readonly value: string;
  /** Shown greyed in place of an empty value ("not set", "auto"). */
  readonly placeholder?: RowLabel;
}

/** A number field: ‹ value › steps it, A opens the keyboard in numeric mode. */
export interface CoreNumberRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'number';
  /** Kept as TEXT, like the form model: '' means "omitted", which no number can express. */
  readonly value: string;
  readonly placeholder?: RowLabel;
  readonly step: number;
  readonly min: number;
  readonly max: number;
}

/** A path field: the current value plus Browse / Clear, both reached from the row's own sub-actions. */
export interface CorePathRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'path';
  readonly value: string;
  readonly placeholder?: RowLabel;
  /** Draw the value as a thumbnail as well (hero / grid artwork), in the artwork's own proportions. */
  readonly preview?: PreviewAspect;
}

/** A list field (args, watchProcesses, winetricks, heroImage): opens its own editing surface. */
export interface CoreListRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'list';
  readonly items: readonly string[];
  /** 0 = unlimited. heroImage caps at MAX_HERO_IMAGES. */
  readonly max: number;
  /** Shown greyed for an empty list ("nothing yet"). */
  readonly placeholder?: RowLabel;
  readonly preview?: PreviewAspect;
}

/** A read-only line: schemaVersion, the game's source (card / This PC). Not focusable. */
export interface CoreStaticRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'static';
  readonly value: RowLabel;
}

/** A free-standing message inside the list (the `mixed` banner, the id-change warning, an error). */
export interface CoreNoteRow<Id extends string = string> {
  readonly kind: 'note';
  readonly id: Id;
  readonly text: RowLabel;
  readonly tone: 'info' | 'warning' | 'error';
}

export type CoreRow<Id extends string = string> =
  | CoreToggleRow<Id>
  | CoreSelectRow<Id>
  | CoreSliderRow<Id>
  | CoreActionRow<Id>
  | CoreTextRow<Id>
  | CoreNumberRow<Id>
  | CorePathRow<Id>
  | CoreListRow<Id>
  | CoreStaticRow<Id>
  | CoreNoteRow<Id>;

/** The nodes a controller updates after a row has been built. */
export interface CoreRendered {
  readonly el: HTMLElement;
  /** The value node whose content changes: the select's text, the slider's percent, a path. */
  readonly valueEl: HTMLElement | null;
  /** The `.text-button` of an action row. */
  readonly buttonEl: HTMLButtonElement | null;
  /** The slider's filled track. */
  readonly fillEl: HTMLElement | null;
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

/** A left/right chevron of a select / number row (clickable with the mouse). */
export function chevron(direction: 'prev' | 'next'): HTMLElement {
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

function selectedLabel(row: CoreSelectRow, t: Translator): string {
  const option = row.options.find((candidate) => candidate.value === row.value);
  return option === undefined ? row.value : optionLabel(option, t);
}

/** Positions a slider's fill + knob for a 0..100 percent. */
export function applySliderPercent(fill: HTMLElement, knob: HTMLElement, percent: number): void {
  fill.style.width = `${percent}%`;
  knob.style.left = `${percent}%`;
}

/** What a value cell shows: the value, or the placeholder when the value is empty. */
function valueOrPlaceholder(
  value: string,
  placeholder: RowLabel | undefined,
  t: Translator,
): { readonly text: string; readonly empty: boolean } {
  if (value !== '') return { text: value, empty: false };
  return { text: placeholder === undefined ? '' : rowLabelText(placeholder, t), empty: true };
}

/** The summary a list row shows in place of its items: "3 items" is useless, the items are not. */
function listSummary(row: CoreListRow, t: Translator): string {
  if (row.items.length > 0) return row.items.join(', ');
  return row.placeholder === undefined ? '' : rowLabelText(row.placeholder, t);
}

/** The label side of a row (absent for the kinds that are nothing but their own control). */
function appendLabelBox(el: HTMLElement, row: CoreRow, t: Translator): void {
  if (row.kind === 'action' || row.kind === 'note') return;
  const labelBox = div('setting-label-box');
  labelBox.append(div('setting-label', rowLabelText(row.label, t)));
  if (row.hint !== undefined) labelBox.append(div('setting-hint', rowLabelText(row.hint, t)));
  const error = div('setting-error', row.error ?? '');
  error.classList.toggle('is-hidden', row.error === undefined);
  labelBox.append(error);
  el.classList.toggle('has-error', row.error !== undefined);
  el.append(labelBox);
}

/** Re-applies a row's error line without rebuilding it (the validator answers on its own schedule). */
function patchError(rendered: CoreRendered, error: string | undefined): void {
  const el = rendered.el.querySelector<HTMLElement>('.setting-error');
  if (el !== null) {
    el.textContent = error ?? '';
    el.classList.toggle('is-hidden', error === undefined);
  }
  rendered.el.classList.toggle('has-error', error !== undefined);
}

/** Builds one row's element. The control is built per `kind`; the label side is shared. */
export function buildCoreRow(row: CoreRow, t: Translator): CoreRendered {
  const el = div('setting-row');
  el.dataset['kind'] = row.kind;
  appendLabelBox(el, row, t);

  switch (row.kind) {
    case 'toggle': {
      const control = div('setting-toggle');
      control.append(checkIcon());
      control.classList.toggle('is-on', row.value);
      el.classList.toggle('is-disabled', row.disabled === true);
      el.append(control);
      return { el, valueEl: control, buttonEl: null, fillEl: null };
    }
    case 'select': {
      const control = div('setting-select');
      const value = div('setting-value', selectedLabel(row, t));
      control.append(chevron('prev'), value, chevron('next'));
      el.append(control);
      return { el, valueEl: value, buttonEl: null, fillEl: null };
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
      return { el, valueEl: value, buttonEl: null, fillEl: fill };
    }
    case 'action': {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = rowLabelText(row.label, t);
      el.classList.toggle('is-danger', row.danger === true);
      el.classList.toggle('is-disabled', row.disabled === true);
      el.append(button);
      return { el, valueEl: null, buttonEl: button, fillEl: null };
    }
    case 'text':
    case 'path': {
      const shown = valueOrPlaceholder(row.value, row.placeholder, t);
      const value = div('setting-value setting-value-wide', shown.text);
      value.classList.toggle('is-empty', shown.empty);
      el.append(value);
      return { el, valueEl: value, buttonEl: null, fillEl: null };
    }
    case 'number': {
      const control = div('setting-select');
      const shown = valueOrPlaceholder(row.value, row.placeholder, t);
      const value = div('setting-value', shown.text);
      value.classList.toggle('is-empty', shown.empty);
      control.append(chevron('prev'), value, chevron('next'));
      el.append(control);
      return { el, valueEl: value, buttonEl: null, fillEl: null };
    }
    case 'list': {
      const value = div('setting-value setting-value-wide', listSummary(row, t));
      value.classList.toggle('is-empty', row.items.length === 0);
      el.append(value);
      return { el, valueEl: value, buttonEl: null, fillEl: null };
    }
    case 'static': {
      const value = div('setting-value setting-value-wide', rowLabelText(row.value, t));
      el.append(value);
      return { el, valueEl: value, buttonEl: null, fillEl: null };
    }
    case 'note': {
      el.classList.add('setting-row-note', `is-${row.tone}`);
      const text = div('setting-note-text', rowLabelText(row.text, t));
      el.append(text);
      return { el, valueEl: text, buttonEl: null, fillEl: null };
    }
  }
}

/**
 * Applies a new model row onto an already-rendered one, touching only what changed. Same `kind` only —
 * a composition change goes through a full re-render instead.
 */
export function patchCoreRow(rendered: CoreRendered, row: CoreRow, t: Translator): void {
  if (row.kind !== 'action' && row.kind !== 'note') patchError(rendered, row.error);
  switch (row.kind) {
    case 'toggle':
      rendered.valueEl?.classList.toggle('is-on', row.value);
      rendered.el.classList.toggle('is-disabled', row.disabled === true);
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
      if (rendered.buttonEl !== null) rendered.buttonEl.textContent = rowLabelText(row.label, t);
      rendered.el.classList.toggle('is-danger', row.danger === true);
      rendered.el.classList.toggle('is-disabled', row.disabled === true);
      break;
    case 'text':
    case 'path':
    case 'number': {
      const shown = valueOrPlaceholder(row.value, row.placeholder, t);
      if (rendered.valueEl !== null) {
        rendered.valueEl.textContent = shown.text;
        rendered.valueEl.classList.toggle('is-empty', shown.empty);
      }
      break;
    }
    case 'list':
      if (rendered.valueEl !== null) {
        rendered.valueEl.textContent = listSummary(row, t);
        rendered.valueEl.classList.toggle('is-empty', row.items.length === 0);
      }
      break;
    case 'static':
      if (rendered.valueEl !== null) rendered.valueEl.textContent = rowLabelText(row.value, t);
      break;
    case 'note':
      if (rendered.valueEl !== null) rendered.valueEl.textContent = rowLabelText(row.text, t);
      break;
  }
}

/** Re-applies a row's LABEL + hint for a new translator (values are patched by patchCoreRow). */
export function relocalizeCoreRow(rendered: CoreRendered, row: CoreRow, t: Translator): void {
  if (row.kind !== 'action' && row.kind !== 'note') {
    const label = rendered.el.querySelector<HTMLElement>('.setting-label');
    if (label !== null) label.textContent = rowLabelText(row.label, t);
    if (row.hint !== undefined) {
      const hint = rendered.el.querySelector<HTMLElement>('.setting-hint');
      if (hint !== null) hint.textContent = rowLabelText(row.hint, t);
    }
  }
  patchCoreRow(rendered, row, t);
}
