import { describe, expect, it } from 'vitest';
import {
  activityBusyKind,
  activityStatus,
  busyIds,
  opensSteamDownloads,
  sameIds,
  screenActivityOf,
  statusOf,
} from '../src/renderer/state-view';
import { createTranslator } from '../src/shared/i18n/index';
import type { BrowseInfo, GameInfo } from '../src/shared/types';

const t = createTranslator('en');

const GAME: GameInfo = {
  id: 'g',
  title: 'G',
  lastPlayedAt: null,
  totalPlaySeconds: 0,
  launchCount: 0,
  requiresInstall: false,
  canUninstall: false,
};

const BROWSE: BrowseInfo = {
  id: 'g',
  title: 'G',
  active: true,
  stats: { schemaVersion: 1, totalPlaySeconds: 0, lastPlayedAt: null, launchCount: 0 },
  game: GAME,
};

describe('activityStatus', () => {
  it('names every Steam activity, with the paused percent when Steam gave one', () => {
    expect(activityStatus({ kind: 'steam-installing', paused: false }, t)).toBe('Installing...');
    expect(activityStatus({ kind: 'steam-installing', paused: true }, t)).toBe(
      'Installing paused...',
    );
    expect(
      activityStatus({ kind: 'steam-installing', paused: true, pausedProgress: 0.426 }, t),
    ).toBe('Installing paused on 43%...');
    expect(activityStatus({ kind: 'steam-updating', paused: false }, t)).toBe('Updating...');
    expect(activityStatus({ kind: 'steam-updating', paused: true, pausedProgress: 0.5 }, t)).toBe(
      'Updating paused...',
    );
    expect(activityStatus({ kind: 'steam-uninstalling' }, t)).toBe('Uninstalling...');
  });

  it('a finished pre-load says so instead of a paused percent', () => {
    expect(
      activityStatus(
        { kind: 'steam-installing', paused: true, pausedProgress: 1, preloaded: true },
        t,
      ),
    ).toBe('Pre-load complete');
    expect(
      activityStatus(
        { kind: 'steam-installing', paused: true, pausedProgress: 1, preloaded: true },
        createTranslator('ru'),
      ),
    ).toBe('Предзагрузка завершена');
  });

  it('a ready game says nothing about Steam on its own any more', () => {
    expect(statusOf({ kind: 'ready', game: GAME }, t)).toBe('');
  });
});

describe('activityBusyKind', () => {
  it('shows the gear for an activity and falls back to the session otherwise', () => {
    expect(activityBusyKind({ kind: 'steam-uninstalling' }, { kind: 'ready', game: GAME })).toBe(
      'system',
    );
    expect(activityBusyKind(undefined, { kind: 'ready', game: GAME })).toBe('none');
    expect(activityBusyKind(undefined, { kind: 'launching', game: GAME })).toBe('game');
    expect(
      activityBusyKind(
        { kind: 'steam-installing', paused: false },
        { kind: 'running', game: GAME, since: 0 },
      ),
    ).toBe('system');
  });
});

describe('screenActivityOf', () => {
  it("is the activity of the game on screen, never another game's", () => {
    const activities = { other: { kind: 'steam-uninstalling' } } as const;
    expect(screenActivityOf(BROWSE, activities)).toBeUndefined();
    expect(screenActivityOf(null, activities)).toBeUndefined();
    expect(screenActivityOf(BROWSE, { g: { kind: 'steam-uninstalling' } })).toEqual({
      kind: 'steam-uninstalling',
    });
  });
});

describe('opensSteamDownloads', () => {
  it('holds for a download or an update only', () => {
    expect(opensSteamDownloads({ kind: 'steam-installing', paused: false })).toBe(true);
    expect(opensSteamDownloads({ kind: 'steam-updating', paused: true })).toBe(true);
    expect(opensSteamDownloads({ kind: 'steam-uninstalling' })).toBe(false);
    expect(opensSteamDownloads(undefined)).toBe(false);
  });
});

describe('busyIds', () => {
  it('collects every game with an activity plus the game of a busy session', () => {
    const activities = {
      a: { kind: 'steam-installing', paused: false },
      b: { kind: 'steam-updating', paused: false },
    } as const;
    expect([...busyIds({ kind: 'running', game: GAME, since: 0 }, activities)].sort()).toEqual([
      'a',
      'b',
      'g',
    ]);
    expect([...busyIds({ kind: 'ready', game: GAME }, activities)].sort()).toEqual(['a', 'b']);
    expect(busyIds({ kind: 'idle' }, {}).size).toBe(0);
  });
});

describe('sameIds', () => {
  it('compares the ids regardless of order', () => {
    expect(sameIds(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameIds(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(sameIds(new Set(['a']), new Set(['b']))).toBe(false);
  });
});
