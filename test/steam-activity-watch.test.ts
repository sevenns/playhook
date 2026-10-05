import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRegistry } from '../src/main/activity-registry';
import {
  SteamActivityWatch,
  steamPollIntervalMs,
  type SteamWatchEntry,
} from '../src/main/steam-activity-watch';

type AcfState = 'installed' | 'downloading' | 'paused' | 'absent';

interface Fixture {
  readonly watch: SteamActivityWatch;
  readonly registry: ActivityRegistry;
  readonly events: string[];
  games: SteamWatchEntry[];
  session: string | null;
  clock: number;
  acf(appid: number, state: AcfState, progress?: number): Promise<void>;
}

const A: SteamWatchEntry = { id: 'a', title: 'Game A', appid: 10 };
const B: SteamWatchEntry = { id: 'b', title: 'Game B', appid: 20 };

let root: string;
let fixture: Fixture;

function acfText(appid: number, state: Exclude<AcfState, 'absent'>, progress: number): string {
  const flags = state === 'installed' ? 4 : 1026;
  const result = state === 'paused' ? 4 : 0;
  const staged = Math.round(progress * 100);
  return [
    '"AppState"',
    '{',
    `\t"appid"\t\t"${appid}"`,
    `\t"StateFlags"\t\t"${flags}"`,
    `\t"UpdateResult"\t\t"${result}"`,
    `\t"BytesStaged"\t\t"${staged}"`,
    `\t"BytesToStage"\t\t"100"`,
    '}',
    '',
  ].join('\n');
}

function build(): Fixture {
  const registry = new ActivityRegistry();
  const events: string[] = [];
  const state = {
    games: [A, B],
    session: null as string | null,
    clock: 1_000_000,
  };
  const watch = new SteamActivityWatch(
    {
      listSteamGames: () => state.games,
      registry,
      steamLocator: () => ({ locateSteam: () => Promise.resolve(root) }),
      sessionGameId: () => state.session,
      onGameChanged: (id) => events.push(`changed:${id}`),
      onInstallCompleted: (game) => events.push(`installed:${game.id}`),
      onUninstallCompleted: (game) => events.push(`uninstalled:${game.id}`),
    },
    { intervalMs: 3_600_000, now: () => state.clock },
  );
  return {
    watch,
    registry,
    events,
    get games() {
      return state.games;
    },
    set games(next) {
      state.games = next;
    },
    get session() {
      return state.session;
    },
    set session(next) {
      state.session = next;
    },
    get clock() {
      return state.clock;
    },
    set clock(next) {
      state.clock = next;
    },
    acf: async (appid, acfState, progress = 0.5) => {
      const file = path.join(root, 'steamapps', `appmanifest_${appid}.acf`);
      if (acfState === 'absent') await fs.rm(file, { force: true });
      else await fs.writeFile(file, acfText(appid, acfState, progress));
    },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-steam-watch-'));
  await fs.mkdir(path.join(root, 'steamapps'), { recursive: true });
  fixture = build();
});

afterEach(async () => {
  fixture.watch.stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe('SteamActivityWatch transitions', () => {
  it('first sight: a download becomes an install activity and a change; installed or absent stay silent', async () => {
    await fixture.acf(A.appid, 'downloading');
    await fixture.acf(B.appid, 'installed');
    await fixture.watch.scanNow();
    expect(fixture.registry.snapshot()).toEqual({ a: { kind: 'steam-installing', paused: false } });
    expect(fixture.events).toEqual(['changed:a']);
  });

  it('absent → downloading → installed: an install, one change each way and exactly one notification', async () => {
    await fixture.watch.scanNow();
    expect(fixture.events).toEqual([]);
    await fixture.acf(A.appid, 'downloading');
    await fixture.watch.scanNow();
    await fixture.watch.scanNow();
    expect(fixture.registry.get('a')).toEqual({ kind: 'steam-installing', paused: false });
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    await fixture.watch.scanNow();
    expect(fixture.registry.has('a')).toBe(false);
    expect(fixture.events).toEqual(['changed:a', 'changed:a', 'installed:a']);
  });

  it('installed → downloading is an update, and finishing it notifies nobody', async () => {
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    await fixture.acf(A.appid, 'downloading');
    await fixture.watch.scanNow();
    expect(fixture.registry.get('a')).toEqual({ kind: 'steam-updating', paused: false });
    await fixture.acf(A.appid, 'paused', 0.25);
    await fixture.watch.scanNow();
    expect(fixture.registry.get('a')).toEqual({
      kind: 'steam-updating',
      paused: true,
      pausedProgress: 0.25,
    });
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    expect(fixture.registry.has('a')).toBe(false);
    expect(fixture.events).toEqual(['changed:a', 'changed:a']);
  });

  it('a pause and its percent update the activity without a change event', async () => {
    await fixture.acf(A.appid, 'downloading');
    await fixture.watch.scanNow();
    await fixture.acf(A.appid, 'paused', 0.4);
    await fixture.watch.scanNow();
    expect(fixture.registry.get('a')).toEqual({
      kind: 'steam-installing',
      paused: true,
      pausedProgress: 0.4,
    });
    expect(fixture.events).toEqual(['changed:a']);
  });

  it('absent → installed (installed in Steam directly) is a change without a notification', async () => {
    await fixture.watch.scanNow();
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    expect(fixture.events).toEqual(['changed:a']);
    expect(fixture.registry.snapshot()).toEqual({});
  });

  it('installed → absent without a request of ours is a change without a notification', async () => {
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    await fixture.acf(A.appid, 'absent');
    await fixture.watch.scanNow();
    expect(fixture.events).toEqual(['changed:a']);
  });

  it('two games download at once, and each completion notifies only for its own game', async () => {
    await fixture.acf(A.appid, 'downloading');
    await fixture.acf(B.appid, 'downloading');
    await fixture.watch.scanNow();
    expect(Object.keys(fixture.registry.snapshot()).sort()).toEqual(['a', 'b']);
    await fixture.acf(B.appid, 'installed');
    await fixture.watch.scanNow();
    expect(fixture.registry.snapshot()).toEqual({ a: { kind: 'steam-installing', paused: false } });
    expect(fixture.events.filter((event) => event.startsWith('installed:'))).toEqual([
      'installed:b',
    ]);
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    expect(fixture.events.filter((event) => event.startsWith('installed:'))).toEqual([
      'installed:b',
      'installed:a',
    ]);
  });
});

describe('SteamActivityWatch pre-loads', () => {
  const preloadAcf = (appid: number, downloaded: number): string =>
    [
      '"AppState"',
      '{',
      `\t"appid"\t\t"${appid}"`,
      '\t"StateFlags"\t\t"1026"',
      '\t"buildid"\t\t"0"',
      '\t"UpdateResult"\t\t"25"',
      '\t"BytesToDownload"\t\t"86248618160"',
      `\t"BytesDownloaded"\t\t"${downloaded}"`,
      '\t"BytesToStage"\t\t"128606066"',
      '\t"BytesStaged"\t\t"128606066"',
      '}',
      '',
    ].join('\n');
  const writeAcf = (appid: number, text: string): Promise<void> =>
    fs.writeFile(path.join(root, 'steamapps', `appmanifest_${appid}.acf`), text);

  it('a finished pre-load of an unreleased game (UpdateResult 25, every byte in) is marked as one', async () => {
    await writeAcf(A.appid, preloadAcf(A.appid, 86248618160));
    await fixture.watch.scanNow();
    expect(fixture.registry.get('a')).toEqual({
      kind: 'steam-installing',
      paused: true,
      pausedProgress: 1,
      preloaded: true,
    });
  });

  it('the same result before every byte is in stays an ordinary paused download', async () => {
    await writeAcf(A.appid, preloadAcf(A.appid, 1000));
    await fixture.watch.scanNow();
    expect(fixture.registry.get('a')).toEqual({
      kind: 'steam-installing',
      paused: true,
      pausedProgress: 1,
    });
  });

  it('the release turns the pre-load into an install, with its notification', async () => {
    await writeAcf(A.appid, preloadAcf(A.appid, 86248618160));
    await fixture.watch.scanNow();
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    expect(fixture.registry.has('a')).toBe(false);
    expect(fixture.events).toEqual(['changed:a', 'changed:a', 'installed:a']);
  });
});

describe('SteamActivityWatch and a half-written .acf', () => {
  it('an .acf caught mid-rewrite changes nothing, so the finished download still notifies', async () => {
    await fixture.acf(A.appid, 'downloading');
    await fixture.watch.scanNow();
    await fs.writeFile(path.join(root, 'steamapps', `appmanifest_${A.appid}.acf`), '"AppState"\n{\n');
    await fixture.watch.scanNow();
    expect(fixture.registry.get('a')).toEqual({ kind: 'steam-installing', paused: false });
    expect(fixture.events).toEqual(['changed:a']);
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    expect(fixture.events).toEqual(['changed:a', 'changed:a', 'installed:a']);
  });
});

describe('SteamActivityWatch uninstall requests', () => {
  it('shows uninstalling while the game is still installed, then notifies once it is gone', async () => {
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    fixture.watch.requestUninstall(A.appid);
    await fixture.watch.scanNow();
    expect(fixture.registry.get('a')).toEqual({ kind: 'steam-uninstalling' });
    await fixture.acf(A.appid, 'absent');
    await fixture.watch.scanNow();
    await fixture.watch.scanNow();
    expect(fixture.registry.has('a')).toBe(false);
    expect(fixture.events).toEqual(['changed:a', 'uninstalled:a']);
  });

  it('a request still installed after the timeout is taken as a cancel', async () => {
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    fixture.watch.requestUninstall(A.appid);
    await fixture.watch.scanNow();
    fixture.clock += 60_001;
    await fixture.watch.scanNow();
    expect(fixture.registry.has('a')).toBe(false);
    expect(fixture.events).toEqual([]);
    await fixture.acf(A.appid, 'absent');
    await fixture.watch.scanNow();
    expect(fixture.events).toEqual(['changed:a']);
  });
});

describe('SteamActivityWatch and the session', () => {
  it('the session game gets no activity; its status lands once the session is over', async () => {
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    fixture.session = 'a';
    await fixture.acf(A.appid, 'downloading');
    await fixture.watch.scanNow();
    expect(fixture.registry.has('a')).toBe(false);
    expect(fixture.events).toEqual([]);
    fixture.session = null;
    await fixture.watch.scanNow();
    expect(fixture.registry.get('a')).toEqual({ kind: 'steam-updating', paused: false });
    expect(fixture.events).toEqual(['changed:a']);
  });

  it('an update Steam ran and finished during the session leaves no trace', async () => {
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    fixture.session = 'a';
    await fixture.acf(A.appid, 'downloading');
    await fixture.watch.scanNow();
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    fixture.session = null;
    await fixture.watch.scanNow();
    expect(fixture.registry.snapshot()).toEqual({});
    expect(fixture.events).toEqual([]);
  });
});

describe('SteamActivityWatch bookkeeping', () => {
  it('a game that leaves the list is cleaned out of the registry, the statuses and the requests', async () => {
    await fixture.acf(A.appid, 'downloading');
    await fixture.acf(B.appid, 'installed');
    await fixture.watch.scanNow();
    fixture.watch.requestUninstall(B.appid);
    fixture.games = [];
    await fixture.watch.scanNow();
    expect(fixture.registry.snapshot()).toEqual({});
    fixture.games = [A, B];
    await fixture.acf(B.appid, 'absent');
    await fixture.watch.scanNow();
    expect(fixture.events).toEqual(['changed:a', 'changed:a']);
  });

  it("never clears an activity that is not Steam's", async () => {
    fixture.registry.set('a', { kind: 'installing' });
    await fixture.acf(A.appid, 'installed');
    await fixture.watch.scanNow();
    fixture.games = [];
    await fixture.watch.scanNow();
    expect(fixture.registry.get('a')).toEqual({ kind: 'installing' });
  });

  it('keeps what it knew when Steam cannot be found', async () => {
    await fixture.acf(A.appid, 'downloading');
    await fixture.watch.scanNow();
    await fs.rm(root, { recursive: true, force: true });
    root = path.join(os.tmpdir(), 'playhook-steam-watch-missing');
    const missing = new SteamActivityWatch(
      {
        listSteamGames: () => [A],
        registry: fixture.registry,
        steamLocator: () => ({ locateSteam: () => Promise.resolve(null) }),
        sessionGameId: () => null,
        onGameChanged: () => undefined,
        onInstallCompleted: () => undefined,
        onUninstallCompleted: () => undefined,
      },
      { intervalMs: 3_600_000 },
    );
    await missing.scanNow();
    missing.stop();
    expect(fixture.registry.get('a')).toEqual({ kind: 'steam-installing', paused: false });
  });
});

describe('steamPollIntervalMs', () => {
  it('reads PLAYHOOK_STEAM_POLL_MS and falls back to five seconds', () => {
    expect(steamPollIntervalMs({})).toBe(5000);
    expect(steamPollIntervalMs({ PLAYHOOK_STEAM_POLL_MS: '250' })).toBe(250);
    expect(steamPollIntervalMs({ PLAYHOOK_STEAM_POLL_MS: '0' })).toBe(5000);
    expect(steamPollIntervalMs({ PLAYHOOK_STEAM_POLL_MS: 'soon' })).toBe(5000);
  });
});
