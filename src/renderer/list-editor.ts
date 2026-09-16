// The list rows of the Customize screen (args, watchProcesses, backgrounds, winetricks…) are edited in
// levels of the column menu (menu-stack.ts): the list itself, with an Add entry while there is room, and
// a per-item menu — replace, move up / down, remove, and for a picture row a look at it. Reordering is a
// gamepad gesture here, not a drag: the manifest's order is load-bearing (the first hero image is the
// one the carousel crops its card from), and a mouse-only affordance would put that out of reach in
// Game Mode.
import type { Translator } from '../shared/i18n/index.js';
import type { GameRowId, GameSettingsRow } from './game-settings-model.js';
import type { MenuEntry, MenuLevel, MenuStack } from './menu-stack.js';
import type { TextEntrySurface } from './nav-surface.js';

export interface ListEditorDeps {
  readonly menu: Pick<MenuStack, 'push' | 'replace' | 'asMenu'>;
  readonly keyboard: Pick<TextEntrySurface, 'open'>;
  getTranslator(): Translator;
  /** Opens the file browser for a path row and hands back what it picked (see browseInto in the screen). */
  browse(
    id: GameRowId,
    current: string,
    multi: boolean,
    onPicked: (paths: readonly string[]) => void,
  ): void;
  /** Opens the artwork at full size (a picture row's items are paths). */
  showImage(path: string): void;
  /** Writes the list into the form. */
  setList(id: GameRowId, items: readonly string[]): void;
  rowTitle(row: GameSettingsRow): string;
}

export interface ListEditor {
  /** Opens the editor on a list row — the first level of its menu. */
  open(row: Extract<GameSettingsRow, { kind: 'list' }>): void;
}

export function createListEditor(deps: ListEditorDeps): ListEditor {
  const { menu, keyboard } = deps;
  const t = (): Translator => deps.getTranslator();

  function buildListLevel(
    id: GameRowId,
    items: readonly string[],
    max: number,
    isPath: boolean,
    title: string,
  ): MenuLevel {
    const entries: MenuEntry[] = items.map((item, index) => ({
      label: item,
      run: () => openItemMenu(id, items, index, max, isPath, title),
    }));
    if (max === 0 || items.length < max) {
      entries.push({
        label: t()('gameSettings.listAdd'),
        run: () => {
          if (isPath) {
            deps.browse(id, '', max !== 1, (paths) => {
              const room = max === 0 ? paths.length : Math.max(0, max - items.length);
              deps.setList(id, [...items, ...paths.slice(0, room)]);
            });
            return;
          }
          keyboard.open({
            value: '',
            mode: 'text',
            title,
            onDone: (value) => {
              if (value.trim() === '') return;
              const next = [...items, value];
              deps.setList(id, next);
              menu.replace(buildListLevel(id, next, max, isPath, title));
            },
          });
        },
      });
    }
    return menu.asMenu({ title, entries });
  }

  function openItemMenu(
    id: GameRowId,
    items: readonly string[],
    index: number,
    max: number,
    isPath: boolean,
    title: string,
  ): void {
    const commit = (next: readonly string[]): void => {
      deps.setList(id, next);
      // Back to the list itself, refreshed — the user is usually not done after one change.
      menu.replace(buildListLevel(id, next, max, isPath, title), 2);
    };
    const entries: MenuEntry[] = [];
    if (isPath) {
      entries.push({
        label: t()('gameSettings.viewImage'),
        run: () => deps.showImage(items[index] ?? ''),
      });
    }
    entries.push({
      label: t()('gameSettings.listReplace'),
      run: () => {
        if (isPath) {
          deps.browse(id, items[index] ?? '', false, (paths) => {
            const picked = paths[0];
            if (picked === undefined) return;
            deps.setList(
              id,
              items.map((item, i) => (i === index ? picked : item)),
            );
          });
          return;
        }
        keyboard.open({
          value: items[index] ?? '',
          mode: 'text',
          title,
          onDone: (value) => {
            if (value.trim() === '') return;
            commit(items.map((item, i) => (i === index ? value : item)));
          },
        });
      },
    });
    // Reordering is a gamepad gesture here, not a drag: the manifest's order is load-bearing (the first
    // hero image is the one the carousel crops its card from), and a mouse-only affordance would put that
    // out of reach in Game Mode.
    if (index > 0) {
      entries.push({
        label: t()('gameSettings.listMoveUp'),
        run: () => commit(swap(items, index, index - 1)),
      });
    }
    if (index < items.length - 1) {
      entries.push({
        label: t()('gameSettings.listMoveDown'),
        run: () => commit(swap(items, index, index + 1)),
      });
    }
    entries.push({
      label: t()('gameSettings.listRemove'),
      run: () => commit(items.filter((_, i) => i !== index)),
    });
    menu.push(menu.asMenu({ title: items[index] ?? '', entries }));
  }

  function swap(items: readonly string[], a: number, b: number): readonly string[] {
    const next = [...items];
    const first = next[a];
    const second = next[b];
    if (first === undefined || second === undefined) return items;
    next[a] = second;
    next[b] = first;
    return next;
  }

  return {
    open: (row) =>
      menu.push(
        buildListLevel(row.id, row.items, row.max, row.preview !== undefined, deps.rowTitle(row)),
      ),
  };
}
