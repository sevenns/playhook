// The part of a "column + pane" screen that is the same on both of them (Settings, Customize): the row
// focus, the step from the column into the pane and back, left/right inside the pane, the delayed
// preview of the section the column moved onto, and the split of a model's sections into the titled
// ones (the column) and the rest.
//
// What stays in the screens is everything that knows the ROWS: what a select or a slider does on
// left/right (`stepRow`), how a pane is drawn (`renderPane`), and what closes on the way back to the
// column (`onLeavePane`). The two dropdown mechanisms — the inline list in Settings, the menu stack in
// Customize — are different UX by design and are not shared either.
import type { MessageKey } from '../shared/i18n/index.js';
import type { AudioController } from './audio.js';
import type { HoverGuard } from './hover-guard.js';
import { clampIndex } from './index-math.js';
import type { Scroller } from './screen-scroller.js';
import type { Sidebar } from './screen-sidebar.js';

/** A section that HAS a title — i.e. one the column can name and the pane can show. */
export interface TitledSection<Row> {
  readonly titleKey: MessageKey;
  readonly rows: readonly Row[];
}

/** What a screen model's section looks like from here: rows, and a title when the column offers it. */
export interface SectionLike<Row> {
  readonly titleKey?: MessageKey;
  readonly rows: readonly Row[];
}

/** The titled sections — the ones the column offers. The title-less ones are the screen's own rows. */
export function titledSections<Row>(
  sections: readonly SectionLike<Row>[],
): readonly TitledSection<Row>[] {
  return sections.flatMap((section) => {
    const key = section.titleKey;
    return key === undefined ? [] : [{ titleKey: key, rows: section.rows }];
  });
}

/** The section the pane is showing (by `key`), falling back to the first one. */
export function sectionByKey<Row>(
  sections: readonly SectionLike<Row>[],
  key: MessageKey | null,
): TitledSection<Row> | undefined {
  const titled = titledSections(sections);
  return titled.find((section) => section.titleKey === key) ?? titled[0];
}

/**
 * How long the pane waits before showing the section the column moved onto. A held direction walks
 * through the column faster than that, so the pane is drawn ONCE, when the movement stops, instead of
 * being torn down and rebuilt — thumbnails and all — at every step. Short enough that a single press
 * still reads as instant.
 */
const PREVIEW_MS = 120;

/** A rendered row: its node, and the model row it was drawn from. */
export interface RenderedRowLike<Row> {
  readonly el: HTMLElement;
  readonly row: Row;
}

export interface ListScreenCoreDeps<Row> {
  readonly audio: Pick<AudioController, 'play' | 'playLimit'>;
  /** The pane: it widens to the left while it holds the focus (see .settings-list in styles.css). */
  readonly listEl: HTMLElement;
  readonly sidebar: Pick<Sidebar<MessageKey, string>, 'hasFocus' | 'setFocused' | 'selected'>;
  readonly scroller: Pick<Scroller, 'reveal'>;
  readonly hover: Pick<HoverGuard, 'arm'>;
  /** Whether the focus may rest on a row (the notes and static lines are walked past). */
  isFocusable(row: Row): boolean;
  /** Draws the selected section into the pane — called when a preview lands. */
  renderPane(): void;
  /** Left/right on a row that has a range to move along; false when it has none (the dead end sounds). */
  stepRow(row: Row, delta: number): boolean;
  /** Runs as the focus goes back to the column: whatever was open on top of the pane closes. */
  onLeavePane(): void;
}

export interface ListScreenCore<Row, Rendered extends RenderedRowLike<Row>> {
  /** The rows of the SELECTED section only — the pane shows one section at a time. */
  rendered(): readonly Rendered[];
  setRendered(rows: readonly Rendered[]): void;
  focusIndex(): number;
  setFocusIndex(index: number): void;
  focusedRow(): Rendered | undefined;
  /** The nearest focusable row at or after `index`, searching in `direction`; falls back to any. */
  nearestFocusable(index: number, direction: number): number;
  /** Re-seats the focus on the nearest focusable row after the pane was redrawn. */
  seatFocus(): void;
  /** Paints the focus and keeps it on screen (`instant` skips the glide). */
  applyRowFocus(instant?: boolean): void;
  /** Steps to the next FOCUSABLE row, walking past the notes and static lines in between. */
  moveRowFocus(delta: number): void;
  /** Hands the focus from the column to the pane, at its first focusable row. */
  enterPane(): void;
  /** …and back. The column is the only place the screen can be left from. */
  leavePane(): void;
  /** Left/right: from the column, right steps into the pane; inside it, the row decides. */
  navHorizontal(delta: number): void;

  /** Which titled section the column has SELECTED, by its translation key. */
  sectionKey(): MessageKey | null;
  /** …and which one the pane is actually showing. The two differ for as long as a preview is pending. */
  paneKey(): MessageKey | null;
  selectSection(key: MessageKey | null): void;
  /** The pane now shows `key` — selected and shown agree again. */
  showSection(key: MessageKey): void;
  /** A fresh visit: nothing selected, nothing shown (the previous visit's close dropped its preview). */
  reset(): void;
  /** Arms the delayed preview of the section the column just moved onto. */
  schedulePreview(): void;
  /**
   * Brings the pane up to date with the selected section NOW, cancelling a pending preview. Anything that
   * reads the rendered rows has to call this first — including the paths that never scheduled a preview
   * at all: a MOUSE click on a section activates it without ever moving onto it, and that used to leave
   * the focus stepping into the section the pane was showing before.
   */
  flushPreview(): void;
  /** Drops a pending preview without drawing (the screen is closing). */
  cancelPreview(): void;
}

export function createListScreenCore<Row, Rendered extends RenderedRowLike<Row>>(
  deps: ListScreenCoreDeps<Row>,
): ListScreenCore<Row, Rendered> {
  let rendered: readonly Rendered[] = [];
  let focusIndex = 0;
  let sectionKey: MessageKey | null = null;
  let paneKey: MessageKey | null = null;
  let previewTimer = 0;

  function nearestFocusable(index: number, direction: number): number {
    if (rendered.length === 0) return 0;
    const start = Math.min(Math.max(index, 0), rendered.length - 1);
    for (let i = start; i >= 0 && i < rendered.length; i += direction) {
      const row = rendered[i];
      if (row !== undefined && deps.isFocusable(row.row)) return i;
    }
    for (let i = start; i >= 0 && i < rendered.length; i -= direction) {
      const row = rendered[i];
      if (row !== undefined && deps.isFocusable(row.row)) return i;
    }
    return start;
  }

  /**
   * Paints the focus and keeps it on screen, with a margin: the list starts moving BEFORE the focused
   * row reaches the edge, so there is always a row of context ahead of it and the movement is continuous
   * rather than a jump per step at the boundary.
   */
  function applyRowFocus(instant = false): void {
    const active = !deps.sidebar.hasFocus();
    deps.listEl.classList.toggle('is-active', active);
    rendered.forEach((row, index) =>
      row.el.classList.toggle('is-focused', active && index === focusIndex),
    );
    if (!active) return;
    const target = rendered[focusIndex];
    if (target === undefined) return;
    deps.scroller.reveal(target.el, instant);
  }

  function moveRowFocus(delta: number): void {
    if (rendered.length === 0) return;
    let next = focusIndex;
    for (;;) {
      const stepped = clampIndex(next, delta, rendered.length);
      if (stepped === next) {
        deps.audio.playLimit(); // at the edge: no move, and the dead end says so
        return;
      }
      next = stepped;
      const row = rendered[next];
      if (row !== undefined && deps.isFocusable(row.row)) break;
    }
    focusIndex = next;
    deps.audio.play('navigate');
    applyRowFocus();
  }

  function flushPreview(): void {
    if (previewTimer !== 0) {
      window.clearTimeout(previewTimer);
      previewTimer = 0;
    }
    if (paneKey !== sectionKey) deps.renderPane();
  }

  function enterPane(): void {
    flushPreview(); // whatever the column last moved onto is what the focus is stepping into
    if (rendered.length === 0) return;
    deps.sidebar.setFocused(false);
    focusIndex = nearestFocusable(0, 1);
    deps.hover.arm();
    applyRowFocus();
  }

  function leavePane(): void {
    deps.onLeavePane();
    deps.sidebar.setFocused(true);
    deps.hover.arm();
    applyRowFocus();
  }

  function navHorizontal(delta: number): void {
    // From the column, RIGHT steps into the pane — the direction the layout already suggests. Left is
    // NOT its mirror inside the pane: there it belongs to the rows that have a range (the selects, the
    // sliders, the steppers), so leaving is B.
    if (deps.sidebar.hasFocus()) {
      // Left off the column, and right off anything that is not a section (the actions at its foot),
      // lead nowhere — the column is the edge of the screen in both directions.
      if (delta > 0 && deps.sidebar.selected()?.kind === 'section') enterPane();
      else deps.audio.playLimit();
      return;
    }
    const target = rendered[focusIndex];
    if (target === undefined) return;
    // A checkbox is NOT stepped through: left/right belong to the rows that have a range to move along,
    // and a two-state row answered them by flipping — so a walk across the form changed a setting on the
    // way past. A checkbox is switched with A, and only with A.
    if (deps.stepRow(target.row, delta)) return;
    deps.audio.playLimit(); // a checkbox, a text or a path row has no range to step along
  }

  return {
    rendered: () => rendered,
    setRendered: (rows) => {
      rendered = rows;
    },
    focusIndex: () => focusIndex,
    setFocusIndex: (index) => {
      focusIndex = index;
    },
    focusedRow: () => rendered[focusIndex],
    nearestFocusable,
    seatFocus: () => {
      focusIndex = nearestFocusable(focusIndex, 1);
    },
    applyRowFocus,
    moveRowFocus,
    enterPane,
    leavePane,
    navHorizontal,
    sectionKey: () => sectionKey,
    paneKey: () => paneKey,
    selectSection: (key) => {
      sectionKey = key;
    },
    showSection: (key) => {
      sectionKey = key;
      paneKey = key;
    },
    reset: () => {
      sectionKey = null;
      paneKey = null;
    },
    schedulePreview: () => {
      if (previewTimer !== 0) window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        previewTimer = 0;
        deps.renderPane();
      }, PREVIEW_MS);
    },
    flushPreview,
    cancelPreview: () => {
      if (previewTimer !== 0) {
        window.clearTimeout(previewTimer);
        previewTimer = 0;
      }
    },
  };
}
