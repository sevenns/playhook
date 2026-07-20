// buildTrayMenu — the tray had no test at all before the Steam item arrived. Worth covering now: the
// item's three states and, above all, that it is ABSENT (not merely disabled) where the feature does not
// exist, so nothing about a Steam Deck ever shows up on a Windows tray.
import { describe, it, expect, vi } from 'vitest';
import { buildTrayMenu, type TrayCallbacks, type TraySteamState } from '../src/main/tray';
import { createTranslator } from '../src/shared/i18n/index';

interface MenuItemView {
  readonly label?: string;
  readonly enabled?: boolean;
  readonly type?: string;
  readonly click?: () => void;
}

const t = createTranslator('en');

function callbacks(): TrayCallbacks & { readonly onToggleSteamShortcut: ReturnType<typeof vi.fn> } {
  return {
    onShow: vi.fn(),
    onOpenConfigureGame: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleSteamShortcut: vi.fn(),
    onQuit: vi.fn(),
  };
}

/** The stub's Menu.buildFromTemplate returns the template, so the menu IS the item list. */
function items(steam: TraySteamState, cb: TrayCallbacks = callbacks()): readonly MenuItemView[] {
  return buildTrayMenu(t, cb, steam) as unknown as readonly MenuItemView[];
}

const labels = (steam: TraySteamState): readonly (string | undefined)[] =>
  items(steam).map((item) => item.label);

describe('buildTrayMenu — Steam item visibility', () => {
  it('omits the item entirely when the feature is unavailable (Windows / non-AppImage run)', () => {
    const menu = labels({ visible: false, registered: false, busy: false });
    expect(menu).toEqual(['Show launcher', 'Configure game', 'Settings', undefined, 'Quit']);
    expect(menu).not.toContain('Add to Steam');
  });

  it('places the item directly under "Show launcher"', () => {
    expect(labels({ visible: true, registered: false, busy: false })).toEqual([
      'Show launcher',
      'Add to Steam',
      'Configure game',
      'Settings',
      undefined,
      'Quit',
    ]);
  });
});

describe('buildTrayMenu — Steam item states', () => {
  it('offers Add when no shortcut is registered', () => {
    const item = items({ visible: true, registered: false, busy: false })[1];
    expect(item?.label).toBe('Add to Steam');
    expect(item?.enabled).toBe(true);
  });

  it('offers Remove once a shortcut is registered', () => {
    const item = items({ visible: true, registered: true, busy: false })[1];
    expect(item?.label).toBe('Remove from Steam');
    expect(item?.enabled).toBe(true);
  });

  it('is disabled while busy, so a second click cannot start a second write', () => {
    const item = items({ visible: true, registered: false, busy: true })[1];
    expect(item?.label).toBe('Working…');
    expect(item?.enabled).toBe(false);
  });

  it('busy wins over registered (a removal in flight also reads "Working…")', () => {
    expect(items({ visible: true, registered: true, busy: true })[1]?.label).toBe('Working…');
  });
});

describe('buildTrayMenu — wiring', () => {
  it('routes the item to onToggleSteamShortcut', () => {
    const cb = callbacks();
    items({ visible: true, registered: false, busy: false }, cb)[1]?.click?.();
    expect(cb.onToggleSteamShortcut).toHaveBeenCalledTimes(1);
  });

  it('translates the item (ru)', () => {
    const menu = buildTrayMenu(createTranslator('ru'), callbacks(), {
      visible: true,
      registered: true,
      busy: false,
    }) as unknown as readonly MenuItemView[];
    expect(menu[1]?.label).toBe('Убрать из Steam');
  });
});
