import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRegistry } from '../src/main/activity-registry';
import {
  GameJobs,
  maxParallelCopyInstalls,
  maxParallelInstallers,
  partialDirOf,
  startVerdict,
  type GameJobsHost,
  type StartContext,
} from '../src/main/game-jobs';
import { StateManager } from '../src/main/state';
import { LaunchAbortedError } from '../src/main/launch-errors';
import { DEFAULT_SETTINGS } from '../src/main/app-settings';
import { createTranslator } from '../src/shared/i18n/index';
import type { ResolvedManifest } from '../src/main/manifest-types';
import type { GameProcess } from '../src/main/platform/types';

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
  fail(error: Error): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  promise.catch(() => undefined);
  return { promise, open: () => open(), fail: (error) => fail(error) };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false,
  );

let tmp: string;

interface Fixture {
  readonly jobs: GameJobs;
  readonly registry: ActivityRegistry;
  readonly state: StateManager;
  readonly journal: string[];
  readonly gates: Map<string, Gate>;
  /** Installer runs that have not exited yet, by game id: open() makes the installer exit. */
  readonly installers: Map<string, Gate>;
  /** Games whose installer writes the executable before it exits. */
  readonly writesExe: Set<string>;
  /** Games whose prefix still needs winetricks. */
  readonly provisions: Set<string>;
  focused: boolean;
  session: string | null;
  interactive: boolean;
}

let fixture: Fixture;

interface BuildOptions {
  readonly maxParallelCopies?: number;
  readonly gamescope?: boolean;
}

function build(options: BuildOptions = {}): Fixture {
  const registry = new ActivityRegistry();
  const state = new StateManager();
  const journal: string[] = [];
  const gates = new Map<string, Gate>();
  const installers = new Map<string, Gate>();
  const writesExe = new Set<string>();
  const provisions = new Set<string>();
  const flags = { focused: false, session: null as string | null, interactive: false };
  const host: GameJobsHost = {
    sessionGameId: () => flags.session,
    onGameChanged: (id) => journal.push(`changed:${id}`),
    isWindowFocused: () => flags.focused,
    sendError: (message) => journal.push(`error:${message}`),
  };
  const procOf = (id: string): GameProcess => ({
    pid: 1,
    isAlive: () => Promise.resolve(true),
    kill: () => {
      journal.push(`kill:${id}`);
      return Promise.resolve();
    },
    dispose: () => journal.push('proc:dispose'),
  });
  const procIds = new WeakMap<GameProcess, string>();
  const jobs = new GameJobs({
    activities: registry,
    state,
    settings: {
      read: () => Promise.resolve({ ...DEFAULT_SETTINGS, disableSilentInstall: flags.interactive }),
    },
    isGamescope: options.gamescope ?? false,
    platform: {
      gameLauncher: {
        prepareInstallDir: (install) => {
          const id = path.basename(install.dir);
          journal.push(`prepare:${id}`);
          return gates.get(id)?.promise ?? Promise.resolve();
        },
        needsProvisioning: (install) => Promise.resolve(provisions.has(path.basename(install.dir))),
        launchInstaller: async (install) => {
          const id = path.basename(install.dir);
          journal.push(`installer:${id}`);
          installers.set(id, gate());
          const proc = procOf(id);
          procIds.set(proc, id);
          return proc;
        },
        resolveUninstaller: () => Promise.resolve(null),
        launchUninstaller: () => Promise.resolve(procOf('uninstaller')),
        uninstallDir: (install) => install.dir,
        prefixCleanupDir: (id) => Promise.resolve(path.join(tmp, 'prefixes', id)),
      },
    },
    processControl: {
      waitForExit: async (proc, signal) => {
        const id = procIds.get(proc);
        const exit = id === undefined ? undefined : installers.get(id);
        if (id === undefined || exit === undefined) return;
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new LaunchAbortedError()), { once: true });
          void exit.promise.then(resolve);
        });
        if (writesExe.has(id)) {
          await fs.mkdir(path.join(tmp, 'installed', id), { recursive: true });
          await fs.writeFile(path.join(tmp, 'installed', id, 'game.exe'), 'exe');
        }
      },
    },
    notifications: {
      notify: (input) => {
        journal.push(`notify:${input.kind}${'reason' in input ? `:${input.reason}` : ''}`);
      },
    },
    getTranslator: () => createTranslator('en'),
    host,
    maxParallelCopies: options.maxParallelCopies ?? 2,
  });
  jobs.init();
  return {
    jobs,
    registry,
    state,
    journal,
    gates,
    installers,
    writesExe,
    provisions,
    get focused() {
      return flags.focused;
    },
    set focused(value: boolean) {
      flags.focused = value;
    },
    get session() {
      return flags.session;
    },
    set session(value: string | null) {
      flags.session = value;
    },
    get interactive() {
      return flags.interactive;
    },
    set interactive(value: boolean) {
      flags.interactive = value;
    },
  };
}

/** A card game installed by running `source/<id>/setup.exe` into `installed/<id>`. */
async function installerGame(id: string, runAsAdmin = false): Promise<ResolvedManifest> {
  const copy = await copyGame(id);
  const dir = path.join(tmp, 'installed', id);
  return {
    ...copy,
    raw: { ...copy.raw, launchTimeoutSec: 1 },
    install: {
      type: 'nsis',
      installerPath: path.join(tmp, 'source', id, 'setup.exe'),
      runAsAdmin,
      args: [],
      winetricks: [],
      dir,
      installerDir: dir,
    },
  };
}

/** A card game installed by copying `source/<id>` (holding game.exe) into `installed/<id>`. */
async function copyGame(id: string, source: 'card' | 'pc' = 'card'): Promise<ResolvedManifest> {
  const from = path.join(tmp, 'source', id);
  await fs.mkdir(path.join(from, 'data'), { recursive: true });
  await fs.writeFile(path.join(from, 'game.exe'), 'exe');
  await fs.writeFile(path.join(from, 'data', 'pak.bin'), 'data');
  const dir = path.join(tmp, 'installed', id);
  return {
    raw: {
      schemaVersion: 1,
      id,
      title: `Game ${id}`,
      executable: 'game.exe',
      args: [],
      runAsAdmin: false,
      launchTimeoutSec: 1,
      killTimeoutSec: 1,
      winetricks: [],
    },
    root: tmp,
    source,
    executablePath: path.join(dir, 'game.exe'),
    cwd: dir,
    install: {
      type: 'copy',
      installerPath: from,
      runAsAdmin: false,
      args: [],
      winetricks: [],
      dir,
      installerDir: dir,
    },
  };
}

const installedExe = (id: string): string => path.join(tmp, 'installed', id, 'game.exe');

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-jobs-'));
  fixture = build();
});

afterEach(async () => {
  await fixture.jobs.abortAll('shutdown');
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GameJobs copy installs', () => {
  it('two copies run side by side and finish independently, each with its own notification', async () => {
    const a = await copyGame('a');
    const b = await copyGame('b');
    fixture.gates.set('a', gate());
    expect(fixture.jobs.startInstall(a)).toBe(true);
    expect(fixture.jobs.startInstall(b)).toBe(true);
    expect(fixture.registry.get('a')).toEqual({ kind: 'installing' });
    await waitFor(() => !fixture.jobs.has('b'), 'b to finish');
    expect(fixture.registry.has('b')).toBe(false);
    expect(await exists(installedExe('b'))).toBe(true);
    expect(fixture.registry.get('a')).toEqual({ kind: 'installing' });
    fixture.gates.get('a')?.open();
    await waitFor(() => !fixture.jobs.anyActive(), 'a to finish');
    expect(await exists(installedExe('a'))).toBe(true);
    expect(fixture.journal.filter((entry) => entry.startsWith('notify:'))).toEqual([
      'notify:game-installed',
      'notify:game-installed',
    ]);
    expect(await exists(partialDirOf(path.join(tmp, 'installed', 'a')))).toBe(false);
  });

  it('a third copy waits as queued under the limit of two and starts when one finishes', async () => {
    const games = await Promise.all(['a', 'b', 'c'].map((id) => copyGame(id)));
    for (const id of ['a', 'b']) fixture.gates.set(id, gate());
    for (const game of games) expect(fixture.jobs.startInstall(game)).toBe(true);
    expect(fixture.registry.get('c')).toEqual({ kind: 'queued' });
    expect(fixture.journal).not.toContain('prepare:c');
    fixture.gates.get('a')?.open();
    await waitFor(() => fixture.journal.includes('prepare:c'), 'c to start');
    await waitFor(() => !fixture.jobs.has('c'), 'c to finish');
    expect(fixture.jobs.has('b')).toBe(true);
    fixture.gates.get('b')?.open();
  });

  it('cancelling a queued copy frees the game at once, silently', async () => {
    const games = await Promise.all(['a', 'b', 'c'].map((id) => copyGame(id)));
    for (const id of ['a', 'b']) fixture.gates.set(id, gate());
    for (const game of games) fixture.jobs.startInstall(game);
    expect(fixture.jobs.cancel('c')).toBe(true);
    expect(fixture.registry.has('c')).toBe(false);
    expect(fixture.jobs.has('c')).toBe(false);
    expect(fixture.journal.filter((entry) => entry.startsWith('notify:'))).toEqual([]);
    for (const id of ['a', 'b']) fixture.gates.get(id)?.open();
  });

  it('cancelling a running copy leaves no executable and no staging dir behind, and says nothing', async () => {
    const a = await copyGame('a');
    fixture.gates.set('a', gate());
    fixture.jobs.startInstall(a);
    fixture.jobs.cancel('a');
    fixture.gates.get('a')?.open();
    await waitFor(() => !fixture.jobs.has('a'), 'the cancelled copy to unwind');
    expect(await exists(installedExe('a'))).toBe(false);
    expect(await exists(partialDirOf(path.join(tmp, 'installed', 'a')))).toBe(false);
    expect(fixture.registry.has('a')).toBe(false);
    expect(fixture.journal.filter((entry) => entry.startsWith('notify:'))).toEqual([]);
  });

  it('a copy stopped because its card was pulled is reported with that reason', async () => {
    const a = await copyGame('a');
    fixture.gates.set('a', gate());
    fixture.jobs.startInstall(a);
    fixture.jobs.abortWhere(
      (job) => job.kind === 'install' && job.source === 'card',
      'card-removed',
    );
    fixture.gates.get('a')?.open();
    await waitFor(() => !fixture.jobs.has('a'), 'the aborted copy to unwind');
    expect(await exists(installedExe('a'))).toBe(false);
    expect(fixture.journal).toContain(
      'notify:game-install-failed:the card was removed before it finished',
    );
  });

  it('a failure in the body clears the activity, notifies, and shows the error only while the window has focus', async () => {
    const a = await copyGame('a');
    fixture.gates.set('a', gate());
    fixture.focused = true;
    fixture.jobs.startInstall(a);
    fixture.gates.get('a')?.fail(new Error('prefix boom'));
    await waitFor(() => !fixture.jobs.has('a'), 'the failed copy to unwind');
    expect(fixture.registry.has('a')).toBe(false);
    expect(fixture.journal).toContain(
      'notify:game-install-failed:failed to copy the game to the PC: prefix boom',
    );
    expect(fixture.journal).toContain('error:failed to copy the game to the PC: prefix boom');

    const b = await copyGame('b');
    fixture.focused = false;
    fixture.gates.set('b', gate());
    fixture.jobs.startInstall(b);
    fixture.gates.get('b')?.fail(new Error('again'));
    await waitFor(() => !fixture.jobs.has('b'), 'the second failed copy to unwind');
    expect(fixture.journal.filter((entry) => entry.startsWith('error:'))).toHaveLength(1);
  });

  it('a copy whose executable is not in the copied files fails without moving anything into place', async () => {
    const a = await copyGame('a');
    await fs.rm(path.join(tmp, 'source', 'a', 'game.exe'));
    fixture.jobs.startInstall(a);
    await waitFor(() => !fixture.jobs.has('a'), 'the copy to fail');
    expect(await exists(path.join(tmp, 'installed', 'a'))).toBe(false);
    expect(fixture.journal.some((entry) => entry.startsWith('notify:game-install-failed:'))).toBe(
      true,
    );
  });

  it('refuses a game that already has an activity, a job, or is the session game', async () => {
    const a = await copyGame('a');
    fixture.registry.set('a', { kind: 'steam-uninstalling' });
    expect(fixture.jobs.startInstall(a)).toBe(false);
    fixture.registry.clear('a');
    fixture.session = 'a';
    expect(fixture.jobs.startInstall(a)).toBe(false);
    fixture.session = null;
    fixture.gates.set('a', gate());
    expect(fixture.jobs.startInstall(a)).toBe(true);
    expect(fixture.jobs.startInstall(a)).toBe(false);
    fixture.gates.get('a')?.open();
  });
});

describe('GameJobs uninstall and prefix cleanup', () => {
  it('uninstall sweeps the install dir and notifies', async () => {
    const a = await copyGame('a');
    await fs.mkdir(path.join(tmp, 'installed', 'a'), { recursive: true });
    await fs.writeFile(installedExe('a'), 'exe');
    expect(fixture.jobs.startUninstall(a)).toBe(true);
    expect(fixture.registry.get('a')).toEqual({ kind: 'uninstalling' });
    await waitFor(() => !fixture.jobs.has('a'), 'the uninstall to finish');
    expect(await exists(path.join(tmp, 'installed', 'a'))).toBe(false);
    expect(fixture.journal).toEqual(['changed:a', 'notify:game-uninstalled']);
  });

  it('an uninstall is not something the user cancels from the launcher', async () => {
    const a = await copyGame('a');
    fixture.jobs.startUninstall(a);
    expect(fixture.jobs.cancel('a')).toBe(false);
    await waitFor(() => !fixture.jobs.has('a'), 'the uninstall to finish');
  });

  it('prefix cleanup removes the prefix without a notification', async () => {
    const a = await copyGame('a');
    const prefix = path.join(tmp, 'prefixes', 'a');
    await fs.mkdir(prefix, { recursive: true });
    fixture.jobs.startPrefixCleanup(a);
    await waitFor(() => !fixture.jobs.has('a'), 'the cleanup to finish');
    expect(await exists(prefix)).toBe(false);
    expect(fixture.journal).toEqual(['changed:a']);
  });
});

describe('GameJobs shutdown', () => {
  it('the activity is gone by the time anyone hears the job ended', async () => {
    const a = await copyGame('a');
    const seen: boolean[] = [];
    fixture.registry.subscribe(() => seen.push(fixture.jobs.anyActive()));
    fixture.jobs.startInstall(a);
    await waitFor(() => !fixture.jobs.has('a'), 'the copy to finish');
    expect(seen).toEqual([true, false]);
  });

  it('abortAll stops everything and resolves only once each job has cleaned up, silently', async () => {
    const games = await Promise.all(['a', 'b', 'c'].map((id) => copyGame(id)));
    for (const id of ['a', 'b']) fixture.gates.set(id, gate());
    for (const game of games) fixture.jobs.startInstall(game);
    const stopped = fixture.jobs.abortAll('shutdown');
    for (const id of ['a', 'b']) fixture.gates.get(id)?.open();
    await stopped;
    expect(fixture.jobs.anyActive()).toBe(false);
    expect(fixture.registry.snapshot()).toEqual({});
    expect(fixture.journal.filter((entry) => entry.startsWith('notify:'))).toEqual([]);
    for (const id of ['a', 'b'])
      expect(await exists(partialDirOf(path.join(tmp, 'installed', id)))).toBe(false);
  });
});

describe('maxParallelCopyInstalls', () => {
  it('reads PLAYHOOK_MAX_PARALLEL_COPY_INSTALLS and falls back to two', () => {
    expect(maxParallelCopyInstalls({})).toBe(2);
    expect(maxParallelCopyInstalls({ PLAYHOOK_MAX_PARALLEL_COPY_INSTALLS: '3' })).toBe(3);
    expect(maxParallelCopyInstalls({ PLAYHOOK_MAX_PARALLEL_COPY_INSTALLS: '0' })).toBe(2);
  });
});

const SESSION_GAME = {
  id: 'session',
  title: 'Session',
  lastPlayedAt: null,
  totalPlaySeconds: 0,
  launchCount: 0,
  requiresInstall: false,
  canUninstall: false,
} as const;

const installed = (id: string): string => path.join(tmp, 'installed', id);

describe('GameJobs installer runs', () => {
  it('runs the installer in the background and finishes once the executable is there, marker gone', async () => {
    const a = await installerGame('a');
    fixture.writesExe.add('a');
    expect(fixture.jobs.startInstall(a)).toBe(true);
    await waitFor(() => fixture.installers.has('a'), 'the installer to start');
    expect(fixture.registry.get('a')).toEqual({ kind: 'installing' });
    expect(await exists(path.join(installed('a'), '.playhook-installing'))).toBe(true);
    fixture.installers.get('a')?.open();
    await waitFor(() => !fixture.jobs.has('a'), 'the install to finish');
    expect(fixture.journal).toContain('notify:game-installed');
    expect(await exists(installedExe('a'))).toBe(true);
    expect(await exists(path.join(installed('a'), '.playhook-installing'))).toBe(false);
  });

  it('an installer that exits without the executable fails after the grace poll and sweeps the dir', async () => {
    const a = await installerGame('a');
    fixture.jobs.startInstall(a);
    await waitFor(() => fixture.installers.has('a'), 'the installer to start');
    fixture.installers.get('a')?.open();
    await waitFor(() => !fixture.jobs.has('a'), 'the install to give up');
    expect(fixture.journal).toContain(
      'notify:game-install-failed:installation did not complete (the game executable did not appear)',
    );
    expect(await exists(installed('a'))).toBe(false);
  });

  it('a second installer waits for the first under the default limit of one', async () => {
    const a = await installerGame('a');
    const b = await installerGame('b');
    fixture.writesExe.add('a');
    fixture.writesExe.add('b');
    fixture.jobs.startInstall(a);
    fixture.jobs.startInstall(b);
    await waitFor(() => fixture.installers.has('a'), 'the first installer');
    expect(fixture.registry.get('b')).toEqual({ kind: 'queued' });
    expect(fixture.journal).not.toContain('installer:b');
    fixture.installers.get('a')?.open();
    await waitFor(
      () => fixture.installers.has('b'),
      'the second installer to start after the first',
    );
    fixture.installers.get('b')?.open();
    await waitFor(() => !fixture.jobs.anyActive(), 'both installs to finish');
  });

  it('an interactive installer waits for the session to end, then starts on its own', async () => {
    const a = await installerGame('a');
    fixture.interactive = true;
    fixture.writesExe.add('a');
    fixture.state.set({ kind: 'running', game: SESSION_GAME, since: 0 });
    fixture.jobs.startInstall(a);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(fixture.registry.get('a')).toEqual({ kind: 'queued' });
    expect(fixture.journal).not.toContain('installer:a');
    fixture.state.set({ kind: 'syncing-out', game: SESSION_GAME });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(fixture.journal).not.toContain('installer:a');
    fixture.state.set({ kind: 'ready', game: SESSION_GAME });
    await waitFor(
      () => fixture.installers.has('a'),
      'the installer to start once the session ended',
    );
    fixture.installers.get('a')?.open();
  });

  it('an elevated installer waits for the session even when silent', async () => {
    const a = await installerGame('a', true);
    fixture.state.set({ kind: 'launching', game: SESSION_GAME });
    fixture.jobs.startInstall(a);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(fixture.journal).not.toContain('installer:a');
    fixture.state.set({ kind: 'ready', game: SESSION_GAME });
    await waitFor(() => fixture.installers.has('a'), 'the elevated installer after the session');
    fixture.installers.get('a')?.open();
  });

  it('a silent installer starts during a session away from gamescope', async () => {
    const a = await installerGame('a');
    fixture.state.set({ kind: 'running', game: SESSION_GAME, since: 0 });
    fixture.jobs.startInstall(a);
    await waitFor(
      () => fixture.installers.has('a'),
      'the silent installer to start during the session',
    );
    fixture.installers.get('a')?.open();
  });

  it('cancelling a running installer kills it and sweeps the install dir', async () => {
    const a = await installerGame('a');
    fixture.jobs.startInstall(a);
    await waitFor(() => fixture.installers.has('a'), 'the installer to start');
    fixture.jobs.cancel('a');
    await waitFor(() => !fixture.jobs.has('a'), 'the cancelled install to unwind');
    expect(fixture.journal).toContain('kill:a');
    expect(await exists(installed('a'))).toBe(false);
    expect(fixture.journal.filter((entry) => entry.startsWith('notify:'))).toEqual([]);
  });
});

describe('GameJobs under gamescope', () => {
  beforeEach(() => {
    fixture = build({ gamescope: true });
    fixture.state.set({ kind: 'running', game: SESSION_GAME, since: 0 });
  });

  it('holds every installer while a game runs, even a silent one', async () => {
    const a = await installerGame('a');
    fixture.jobs.startInstall(a);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(fixture.journal).not.toContain('installer:a');
    fixture.state.set({ kind: 'ready', game: SESSION_GAME });
    await waitFor(() => fixture.installers.has('a'), 'the installer once the game is over');
    fixture.installers.get('a')?.open();
  });

  it('holds a copy whose prefix still needs winetricks, and lets one that does not through', async () => {
    const a = await copyGame('a');
    const b = await copyGame('b');
    fixture.provisions.add('a');
    fixture.jobs.startInstall(a);
    fixture.jobs.startInstall(b);
    await waitFor(() => !fixture.jobs.has('b'), 'the copy without winetricks to finish');
    expect(fixture.journal).not.toContain('prepare:a');
    fixture.state.set({ kind: 'ready', game: SESSION_GAME });
    await waitFor(() => !fixture.jobs.has('a'), 'the held copy once the game is over');
  });
});

describe('startVerdict', () => {
  const ctx = (patch: Partial<StartContext> = {}): StartContext => ({
    session: 'free',
    gamescope: false,
    elevated: false,
    runningInLane: 0,
    laneLimit: 1,
    ...patch,
  });

  it('removals always start', () => {
    expect(startVerdict('uninstall', {}, ctx({ session: 'running', gamescope: true }))).toBe(
      'start',
    );
    expect(startVerdict('prefix-cleanup', {}, ctx({ runningInLane: 5 }))).toBe('start');
  });

  it('a full lane waits', () => {
    expect(startVerdict('copy', {}, ctx({ runningInLane: 1 }))).toBe('wait');
    expect(startVerdict('installer', {}, ctx({ runningInLane: 1 }))).toBe('wait');
  });

  it('an installer asks whether it is interactive only when a session is up', () => {
    expect(startVerdict('installer', {}, ctx())).toBe('start');
    expect(startVerdict('installer', {}, ctx({ session: 'active' }))).toBe('learn');
    expect(startVerdict('installer', { interactive: true }, ctx({ session: 'active' }))).toBe(
      'wait',
    );
    expect(startVerdict('installer', { interactive: false }, ctx({ session: 'running' }))).toBe(
      'start',
    );
    expect(
      startVerdict('installer', { interactive: false }, ctx({ session: 'active', elevated: true })),
    ).toBe('wait');
  });

  it('under gamescope a running game holds every installer and a copy that provisions', () => {
    const gamescope = ctx({ session: 'running', gamescope: true });
    expect(startVerdict('installer', { interactive: false }, gamescope)).toBe('wait');
    expect(startVerdict('copy', {}, gamescope)).toBe('learn');
    expect(startVerdict('copy', { provisions: true }, gamescope)).toBe('wait');
    expect(startVerdict('copy', { provisions: false }, gamescope)).toBe('start');
    expect(
      startVerdict(
        'installer',
        { interactive: false },
        ctx({ session: 'active', gamescope: true }),
      ),
    ).toBe('start');
  });
});

describe('maxParallelInstallers', () => {
  it('reads PLAYHOOK_MAX_PARALLEL_INSTALLERS and falls back to one', () => {
    expect(maxParallelInstallers({})).toBe(1);
    expect(maxParallelInstallers({ PLAYHOOK_MAX_PARALLEL_INSTALLERS: '2' })).toBe(2);
  });
});
