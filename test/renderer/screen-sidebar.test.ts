import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSidebar, type Sidebar, type SidebarEntry } from '../../src/renderer/screen-sidebar';
import { req } from '../../src/renderer/dom';
import { loadFixture } from './helpers/fixture';
import { fakeAudio, type FakeAudio } from './helpers/fakes';
import { installRafHarness } from './helpers/raf';

const ENTRIES: readonly SidebarEntry[] = [
  { id: 'general', label: 'General', kind: 'section' },
  { id: 'audio', label: 'Audio', kind: 'section' },
  { id: 'save', label: 'Save', kind: 'action' },
  { id: 'delete', label: 'Delete', kind: 'action', danger: true },
];

interface Harness {
  readonly sidebar: Sidebar;
  readonly box: HTMLElement;
  readonly audio: FakeAudio;
  readonly sections: readonly { readonly id: string; readonly entered: boolean }[];
  readonly actions: readonly string[];
}

function harness(): Harness {
  const audio = fakeAudio();
  const sections: { readonly id: string; readonly entered: boolean }[] = [];
  const actions: string[] = [];
  const box = req('settings-nav');
  const sidebar = createSidebar(box, {
    audio,
    onSection: (id, entered) => {
      sections.push({ id, entered });
    },
    onAction: (id) => {
      actions.push(id);
    },
  });
  return { sidebar, box, audio, sections, actions };
}

const labels = (box: HTMLElement): readonly string[] =>
  [...box.children].map((node) => node.textContent ?? '');

const focused = (box: HTMLElement): string | null =>
  box.querySelector('.is-focused')?.textContent ?? null;

beforeEach(() => {
  loadFixture();
  installRafHarness();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sidebar rendering', () => {
  it('draws every entry as a button carrying its kind and danger flag', () => {
    const { sidebar, box } = harness();
    sidebar.render(ENTRIES);

    expect(labels(box)).toEqual(['General', 'Audio', 'Save', 'Delete']);
    const buttons = [...box.querySelectorAll('button')];
    expect(buttons.map((button) => button.dataset['kind'])).toEqual([
      'section',
      'section',
      'action',
      'action',
    ]);
    expect(buttons[3]?.classList.contains('is-danger')).toBe(true);
    expect(focused(box)).toBe('General');
  });

  it('keeps the selection on the same entry across a rebuild that reorders nothing', () => {
    const { sidebar, box } = harness();
    sidebar.render(ENTRIES);
    sidebar.move(1);

    sidebar.render([...ENTRIES, { id: 'close', label: 'Close', kind: 'action' }]);

    expect(sidebar.selected()?.id).toBe('audio');
    expect(focused(box)).toBe('Audio');
    expect(labels(box)).toEqual(['General', 'Audio', 'Save', 'Delete', 'Close']);
  });

  it('removes the node of an entry that is gone', () => {
    const { sidebar, box } = harness();
    sidebar.render(ENTRIES);

    sidebar.render(ENTRIES.filter((entry) => entry.id !== 'delete'));

    expect(labels(box)).toEqual(['General', 'Audio', 'Save']);
  });

  it('marks a disabled entry and refuses to run it', () => {
    const { sidebar, box, actions } = harness();
    sidebar.render([
      ...ENTRIES.slice(0, 2),
      { id: 'save', label: 'Save', kind: 'action', disabled: true },
    ]);
    sidebar.move(2);

    sidebar.activate();

    expect(box.querySelectorAll('.is-disabled')).toHaveLength(1);
    expect(actions).toEqual([]);
  });
});

describe('sidebar movement', () => {
  it('moves the focus class with the selection and previews the section it lands on', () => {
    const { sidebar, box, sections, audio } = harness();
    sidebar.render(ENTRIES);

    sidebar.move(1);

    expect(sidebar.selected()?.id).toBe('audio');
    expect(focused(box)).toBe('Audio');
    expect(sections).toEqual([{ id: 'audio', entered: false }]);
    expect(audio.played).toEqual(['navigate']);
  });

  it('wraps from the last entry to the first', () => {
    const { sidebar, box } = harness();
    sidebar.render(ENTRIES);

    sidebar.move(-1);

    expect(sidebar.selected()?.id).toBe('delete');
    expect(focused(box)).toBe('Delete');
  });

  it('announces nothing when the selection lands on an action', () => {
    const { sidebar, sections } = harness();
    sidebar.render(ENTRIES);

    sidebar.move(2);

    expect(sections).toEqual([]);
  });
});

describe('sidebar activation', () => {
  it('enters the selected section', () => {
    const { sidebar, sections, audio } = harness();
    sidebar.render(ENTRIES);

    sidebar.activate();

    expect(sections).toEqual([{ id: 'general', entered: true }]);
    expect(audio.played).toEqual(['button']);
  });

  it('runs the selected action', () => {
    const { sidebar, actions } = harness();
    sidebar.render(ENTRIES);
    sidebar.move(2);

    sidebar.activate();

    expect(actions).toEqual(['save']);
  });

  it('runs the action a click lands on and takes the focus with it', () => {
    const { sidebar, box, actions } = harness();
    sidebar.render(ENTRIES);

    box.querySelectorAll('button')[2]?.click();

    expect(actions).toEqual(['save']);
    expect(focused(box)).toBe('Save');
  });
});

describe('sidebar focus handover', () => {
  it('marks the shown section as current once the pane takes the focus', () => {
    const { sidebar, box } = harness();
    sidebar.render(ENTRIES);
    sidebar.move(1);

    sidebar.setFocused(false);

    expect(sidebar.hasFocus()).toBe(false);
    expect(focused(box)).toBe(null);
    expect(box.querySelector('.is-current')?.textContent).toBe('Audio');
  });

  it('leaves no current mark when the pane is entered from an action', () => {
    const { sidebar, box } = harness();
    sidebar.render(ENTRIES);
    sidebar.move(2);

    sidebar.setFocused(false);

    expect(box.querySelector('.is-current')).toBe(null);
  });
});

describe('sidebar selection by id', () => {
  it('selects a known id silently', () => {
    const { sidebar, box, sections, audio } = harness();
    sidebar.render(ENTRIES);

    expect(sidebar.select('save')).toBe(true);
    expect(focused(box)).toBe('Save');
    expect(sections).toEqual([]);
    expect(audio.played).toEqual([]);
  });

  it('reports an unknown id instead of silently doing nothing', () => {
    const { sidebar, box } = harness();
    sidebar.render(ENTRIES);

    expect(sidebar.select('nowhere')).toBe(false);
    expect(focused(box)).toBe('General');
  });

  it('puts the selection back on the first entry without emptying the column', () => {
    const { sidebar, box } = harness();
    sidebar.render(ENTRIES);
    sidebar.move(2);

    sidebar.reset();

    expect(sidebar.selected()?.id).toBe('general');
    expect(focused(box)).toBe('General');
    expect(labels(box)).toEqual(['General', 'Audio', 'Save', 'Delete']);
  });
});
