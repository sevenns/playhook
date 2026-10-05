import { describe, expect, it } from 'vitest';
import {
  activityStatus,
  busyIds,
  opensSteamDownloads,
  sameIds,
  screenActions,
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

describe('screenActions', () => {
  const OTHER: GameInfo = { ...GAME, id: 'other', title: 'Other' };
  const UNINSTALLED: GameInfo = { ...GAME, requiresInstall: true };
  const browsing = (game: GameInfo): BrowseInfo => ({ ...BROWSE, id: game.id, title: game.title, game });
  const running = { kind: 'running', game: OTHER, since: 0 } as const;

  it('an installed free game: Play launches, Uninstall as offered', () => {
    const actions = screenActions({ kind: 'ready', game: GAME }, browsing({ ...GAME, canUninstall: true }), undefined);
    expect(actions).toMatchObject({ canPlay: true, canUninstall: true, canInstall: false, playView: 'play' });
  });

  it('an uninstalled game: Play hidden, Install offered — also while another game runs', () => {
    expect(screenActions({ kind: 'ready', game: UNINSTALLED }, browsing(UNINSTALLED), undefined)).toMatchObject({
      canInstall: true,
      canPlay: false,
      playView: 'hidden',
    });
    expect(screenActions(running, browsing(UNINSTALLED), undefined)).toMatchObject({
      canInstall: true,
      playView: 'hidden',
      canForceClose: false,
    });
  });

  it('an installed game while another one runs: Play shows but never starts it, Uninstall still offered', () => {
    expect(screenActions(running, browsing({ ...GAME, canUninstall: true }), undefined)).toMatchObject({
      canPlay: false,
      canUninstall: true,
      playView: 'play',
      canForceClose: false,
    });
  });

  it("the session's own game: return to it while running, Force close there only", () => {
    expect(screenActions(running, browsing(OTHER), undefined)).toMatchObject({
      canPlay: true,
      canForceClose: true,
      canInstall: false,
      canUninstall: false,
      playView: 'resume',
    });
    expect(screenActions({ ...running, killing: true }, browsing(OTHER), undefined)).toMatchObject({
      canPlay: false,
      canForceClose: false,
      playView: 'spinner',
    });
    expect(screenActions({ kind: 'launching', game: OTHER }, browsing(OTHER), undefined).playView).toBe('spinner');
  });

  it("the game's own activity wins: the gear, Cancel for an install, Play only for Steam's downloads", () => {
    expect(screenActions(running, browsing(GAME), { kind: 'installing' })).toMatchObject({
      playView: 'gear',
      canCancel: true,
      canPlay: false,
    });
    expect(screenActions(running, browsing(GAME), { kind: 'queued', reason: 'session', removal: true })).toMatchObject({
      canCancel: false,
    });
    expect(screenActions({ kind: 'ready', game: GAME }, browsing(GAME), { kind: 'steam-installing', paused: false })).toMatchObject({
      canPlay: true,
      playView: 'gear',
    });
  });

  it('a history game or nothing on screen offers nothing', () => {
    expect(screenActions({ kind: 'ready', game: GAME }, { ...BROWSE, active: false }, undefined)).toMatchObject({
      game: undefined,
      playView: 'hidden',
    });
    expect(screenActions({ kind: 'idle' }, null, undefined).game).toBeUndefined();
  });

  it('never borrows the session game for another game whose info has not arrived', () => {
    expect(screenActions(running, { ...BROWSE, game: undefined }, undefined).game).toBeUndefined();
  });
});

describe('queued statuses', () => {
  it('names what a queued job waits for', () => {
    expect(activityStatus({ kind: 'queued' }, t)).toBe('Waiting to install...');
    expect(activityStatus({ kind: 'queued', reason: 'session' }, t)).toBe('Will install after you quit the game');
    expect(activityStatus({ kind: 'queued', reason: 'session', removal: true }, t)).toBe(
      'Will uninstall after you quit the game',
    );
  });
});
