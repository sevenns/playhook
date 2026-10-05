import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRegistry } from '../src/main/activity-registry';
import {
  GameJobs,
  maxParallelCopyInstalls,
  partialDirOf,
  type GameJobsHost,
} from '../src/main/game-jobs';
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
  readonly journal: string[];
  readonly gates: Map<string, Gate>;
  focused: boolean;
  session: string | null;
}

let fixture: Fixture;

function build(maxParallelCopies = 2): Fixture {
  const registry = new ActivityRegistry();
  const journal: string[] = [];
  const gates = new Map<string, Gate>();
  const state = { focused: false, session: null as string | null };
  const host: GameJobsHost = {
    sessionGameId: () => state.session,
    onGameChanged: (id) => journal.push(`changed:${id}`),
    isWindowFocused: () => state.focused,
    sendError: (message) => journal.push(`error:${message}`),
  };
  const proc: GameProcess = {
    pid: 1,
    isAlive: () => Promise.resolve(true),
    kill: () => Promise.resolve(),
    dispose: () => journal.push('proc:dispose'),
  };
  const jobs = new GameJobs({
    activities: registry,
    platform: {
      gameLauncher: {
        prepareInstallDir: (install) => {
          const id = path.basename(install.dir);
          journal.push(`prepare:${id}`);
          return gates.get(id)?.promise ?? Promise.resolve();
        },
        resolveUninstaller: () => Promise.resolve(null),
        launchUninstaller: () => Promise.resolve(proc),
        uninstallDir: (install) => install.dir,
        prefixCleanupDir: (id) => Promise.resolve(path.join(tmp, 'prefixes', id)),
      },
    },
    processControl: { waitForExit: () => Promise.resolve() },
    notifications: {
      notify: (input) => {
        journal.push(`notify:${input.kind}${'reason' in input ? `:${input.reason}` : ''}`);
      },
    },
    getTranslator: () => createTranslator('en'),
    host,
    maxParallelCopies,
  });
  return {
    jobs,
    registry,
    journal,
    gates,
    get focused() {
      return state.focused;
    },
    set focused(value: boolean) {
      state.focused = value;
    },
    get session() {
      return state.session;
    },
    set session(value: string | null) {
      state.session = value;
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
