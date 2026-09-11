// Characterization tests of the controller's four sequences (prefix cleanup, launch, install, uninstall):
// the order of state transitions, what `failSequence` does, and what each `finally` leaves behind — for a
// success, an error thrown inside the body, and an abort mid-way (a card swap, or shutdown). Written
// BEFORE the sequences were folded into one `runSequence`, so a change in that order shows up here.
//
// The controller is built from fakes on every seam (`ControllerDeps` is interfaces, not classes) and the
// process waits are handed in through `processControl`: the real ones poll on second-long cadences, and
// the fake `waitForExit` is a gate the test opens — or aborts, the way a card swap would.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ipcMain } from './stubs/electron';
import { GameController } from '../src/main/ipc';
import {
  type ControllerDeps,
  type ControllerLibrary,
  type ControllerPcLibrary,
  type ControllerStats,
  type ControllerStore,
  type ControllerWatcher,
  type ControllerWindow,
  type ProcessControl,
} from '../src/main/controller-deps';
import { StateManager } from '../src/main/state';
import { LaunchAbortedError } from '../src/main/launch-errors';
import { DEFAULT_SETTINGS } from '../src/main/app-settings';
import { createTranslator } from '../src/shared/i18n/index';
import type { GameProcess } from '../src/main/game-launcher';
import type { Platform } from '../src/main/platform/types';
import { IPC, type ResolvedManifest, type Stats } from '../src/shared/types';

const ZERO_STATS: Stats = { schemaVersion: 1, totalPlaySeconds: 0, lastPlayedAt: null, launchCount: 0 };

function unexpected(name: string): () => never {
  return () => {
    throw new Error(`unexpected call: ${name}`);
  };
}

/** Yields to the event loop enough times for the chained async work of one action to settle. */
async function flushAsync(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A promise the test releases by hand, that rejects with LaunchAbortedError the moment `signal` fires. */
interface Gate {
  release(): void;
  readonly opened: Promise<void>;
}

function abortableGate(signal: AbortSignal | undefined): Gate {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new LaunchAbortedError());
      return;
    }
    signal?.addEventListener('abort', () => reject(new LaunchAbortedError()), { once: true });
    release = resolve;
  });
  return { release: () => release(), opened };
}

interface Harness {
  readonly controller: GameController;
  readonly state: StateManager;
  /** Every observable effect in order: state kinds, window calls, process disposal, notifications. */
  readonly journal: string[];
  /** What the fake watcher was given for `onInsert` — the way a card swap reaches the controller. */
  readonly insert: (root: string) => void;
  /** Opens the pending `waitForExit` gate (the game / installer "exits"). */
  readonly exit: () => void;
  readonly tmp: string;
  /** The path the fake `stats.read` / `recordPlay` throw on once set — the "error in the body" hook. */
  failStats: boolean;
}

type Mode = 'normal' | 'install' | 'prefix-cleanup';

interface HarnessOptions {
  readonly mode: Mode;
  /** What the launcher reports as the directory to sweep; a NUL byte in it makes every removal fail. */
  readonly sweepDir?: string;
}

async function harness(opts: HarnessOptions): Promise<Harness> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-controller-'));
  const gameDir = path.join(tmp, 'game');
  await fs.mkdir(gameDir, { recursive: true });
  const installDir = path.join(tmp, 'installed');
  const sweepDir = opts.sweepDir ?? installDir;
  const executablePath =
    opts.mode === 'install' ? path.join(installDir, 'game.exe') : path.join(gameDir, 'game.exe');
  const manifest: ResolvedManifest = {
    raw: {
      schemaVersion: 1,
      id: 'g1',
      title: 'Game One',
      executable: 'game.exe',
      args: [],
      runAsAdmin: false,
      launchTimeoutSec: 1,
      killTimeoutSec: 1,
      winetricks: [],
    },
    root: gameDir,
    source: 'pc',
    executablePath,
    cwd: path.dirname(executablePath),
    ...(opts.mode === 'install'
      ? {
          install: {
            type: 'custom' as const,
            installerPath: path.join(gameDir, 'setup.exe'),
            runAsAdmin: false,
            args: [],
            winetricks: [],
            dir: installDir,
            installerDir: installDir,
          },
        }
      : {}),
  };

  const journal: string[] = [];
  const state = new StateManager();
  state.subscribe((next) => journal.push(`state:${next.kind}`));
  const h: { failStats: boolean; exit: () => void; insert: (root: string) => void } = {
    failStats: false,
    exit: () => undefined,
    insert: () => undefined,
  };
  const readStats = (): Promise<Stats> =>
    h.failStats ? Promise.reject(new Error('stats boom')) : Promise.resolve(ZERO_STATS);

  const window: ControllerWindow = {
    send: (channel) => {
      if (channel === IPC.errorShow) journal.push('send:error');
    },
    showAndFocus: () => journal.push('window:showAndFocus'),
    hide: () => journal.push('window:hide'),
    isShown: () => true,
  };
  const store: ControllerStore = {
    getPending: () => Promise.resolve(null),
    clearPending: () => Promise.resolve(),
    readSyncState: () => Promise.resolve(null),
    writeSyncState: () => Promise.resolve(),
    enqueuePcToSd: () => Promise.resolve(),
    hasCardSyncState: () => Promise.resolve(false),
  };
  const stats: ControllerStats = {
    read: readStats,
    readCardStatsMap: () => Promise.resolve({ kind: 'empty' }),
    reconcileWithCard: () => Promise.resolve(ZERO_STATS),
    copyToCard: () => Promise.resolve(),
    recordPlay: () => {
      journal.push('stats:recordPlay');
      return readStats();
    },
  };
  const library: ControllerLibrary = {
    entry: () => null,
    entriesForCarousel: () => [],
    saveFromCard: () => Promise.resolve(),
    noteLaunch: () => Promise.resolve(),
    forget: () => Promise.resolve(false),
    readBrowseAssets: () => Promise.resolve({ hero: null, music: null }),
    readGridThumb: () => Promise.resolve(null),
    clearCollisionAnswers: () => Promise.resolve(),
    markCollisionResolved: () => Promise.resolve(),
    readEditedSlot: () => Promise.resolve(null),
    readCardSlot: () => Promise.resolve(null),
    dropEdits: () => Promise.resolve(),
    takeCardSlot: () => Promise.resolve(''),
    stagedFiles: () => Promise.resolve([]),
    stagedFilePath: (_id, name) => name,
  };
  const pcLibrary: ControllerPcLibrary = {
    read: () => Promise.resolve({ manifests: [manifest], intact: true }),
    gcOrphans: () => Promise.resolve(),
  };
  const watcher: ControllerWatcher = {
    onInsert: (handler) => {
      h.insert = handler;
    },
    onRemove: () => undefined,
    onError: () => undefined,
    stop: () => undefined,
  };
  const proc: GameProcess = {
    pid: 4242,
    isAlive: () => Promise.resolve(true),
    kill: () => Promise.resolve(),
    dispose: () => journal.push('proc:dispose'),
  };
  const platform: Platform = {
    processMonitor: {
      snapshot: unexpected('snapshot'),
      isPidAlive: unexpected('isPidAlive'),
      killTree: unexpected('killTree'),
      killByName: unexpected('killByName'),
      isSteamGameRunning: unexpected('isSteamGameRunning'),
      killSteamGame: unexpected('killSteamGame'),
    },
    steamLocator: { locateSteam: () => Promise.resolve(null) },
    steamShortcuts: {
      supported: false,
      addShortcut: unexpected('addShortcut'),
      removeShortcut: unexpected('removeShortcut'),
      hasShortcut: unexpected('hasShortcut'),
      findForeignShortcuts: unexpected('findForeignShortcuts'),
      writeArtwork: unexpected('writeArtwork'),
      removeArtwork: unexpected('removeArtwork'),
    },
    gameLauncher: {
      launchGame: () => Promise.resolve(proc),
      launchInstaller: () => Promise.resolve(proc),
      prepareInstallDir: () => Promise.resolve(),
      launchUninstaller: unexpected('launchUninstaller'),
      uninstallDir: () => sweepDir,
      prefixCleanupDir: () => Promise.resolve(opts.mode === 'prefix-cleanup' ? sweepDir : null),
    },
    savePathResolver: {
      resolvePcSavePath: () => Promise.resolve(null),
      toManifestPcSavePath: () => null,
    },
    powerBackend: { supported: false, run: unexpected('run'), suspend: unexpected('suspend') },
    removableMounter: { mountAll: () => Promise.resolve() },
    resolveInstallDir: () => null,
  };
  const processControl: ProcessControl = {
    waitForStart: () => Promise.resolve(true),
    waitForExit: (_proc, signal) => {
      const gate = abortableGate(signal);
      h.exit = gate.release;
      return gate.opened;
    },
    waitForWatchedStart: unexpected('waitForWatchedStart'),
    waitForWatchedExit: unexpected('waitForWatchedExit'),
    waitForSteamStart: unexpected('waitForSteamStart'),
    waitForSteamExit: unexpected('waitForSteamExit'),
    killImagesElevated: unexpected('killImagesElevated'),
    focusGameWindow: () => false,
  };
  const deps: ControllerDeps = {
    state,
    window,
    store,
    stats,
    library,
    pcLibrary,
    watcher,
    settings: { read: () => Promise.resolve(DEFAULT_SETTINGS) },
    notifications: {
      notify: (input) => {
        journal.push(`notify:${input.kind}`);
      },
    },
    platform,
    processControl,
    isGamescope: false,
    getTranslator: () => createTranslator('en'),
  };
  const controller = new GameController(deps);
  controller.init();
  await flushAsync();
  expect(state.get().kind).toBe('ready');
  journal.length = 0;
  return {
    controller,
    state,
    journal,
    tmp,
    get failStats() {
      return h.failStats;
    },
    set failStats(value: boolean) {
      h.failStats = value;
    },
    exit: () => h.exit(),
    insert: (root) => h.insert(root),
  };
}

function fire(channel: string): void {
  const listener = ipcMain.listeners.get(channel);
  if (listener === undefined) throw new Error(`no listener registered for ${channel}`);
  listener(undefined);
}

/** A NUL byte makes every fs call on the path throw, so `removeWithRetry` retries (and reads its signal). */
function unremovable(tmp: string): string {
  return path.join(tmp, 'bad\0dir');
}

describe('GameController sequences', () => {
  let h: Harness;
  let swapRoot: string;

  beforeEach(async () => {
    swapRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-swap-'));
  });

  afterEach(async () => {
    h.controller.shutdown();
    await flushAsync();
    await fs.rm(h.tmp, { recursive: true, force: true });
    await fs.rm(swapRoot, { recursive: true, force: true });
  });

  describe('launch', () => {
    it('success: sync-in → launching → running → syncing-out → ready, then the finally releases the process', async () => {
      h = await harness({ mode: 'normal' });
      fire(IPC.actionLaunch);
      await flushAsync();
      expect(h.journal).toEqual(['state:syncing-in', 'state:launching', 'state:running']);
      h.exit();
      await flushAsync();
      expect(h.journal).toEqual([
        'state:syncing-in',
        'state:launching',
        'state:running',
        'stats:recordPlay',
        'state:syncing-out',
        'window:showAndFocus',
        'state:ready',
        'window:showAndFocus',
        'proc:dispose',
      ]);
      expect(h.state.get().kind).toBe('ready');
    });

    it('error in the body: failSequence returns to ready, shows the window and the error, then the finally runs', async () => {
      h = await harness({ mode: 'normal' });
      fire(IPC.actionLaunch);
      await flushAsync();
      h.failStats = true;
      h.exit();
      await flushAsync();
      expect(h.journal).toEqual([
        'state:syncing-in',
        'state:launching',
        'state:running',
        'stats:recordPlay',
        'state:ready',
        'window:showAndFocus',
        'send:error',
        'proc:dispose',
      ]);
    });

    it('card swap mid-run: no state is set by the aborted sequence; the finally releases the process and replays the insert', async () => {
      h = await harness({ mode: 'normal' });
      fire(IPC.actionLaunch);
      await flushAsync();
      h.insert(swapRoot);
      await flushAsync();
      // The swapped-in root has no game.json, so the replayed insert lands on `error` + hide — proof that
      // onInsert ran AFTER the finally (a deferred insert is refused while launchInFlight holds).
      expect(h.journal).toEqual([
        'state:syncing-in',
        'state:launching',
        'state:running',
        'proc:dispose',
        'state:error',
        'window:hide',
      ]);
      // A second Play is accepted again only because the finally cleared launchInFlight / locked.
      expect(h.state.get().kind).toBe('error');
    });

    it('shutdown mid-run: the sequence unwinds silently and leaves the running state alone', async () => {
      h = await harness({ mode: 'normal' });
      fire(IPC.actionLaunch);
      await flushAsync();
      h.controller.shutdown();
      await flushAsync();
      expect(h.journal).toEqual(['state:syncing-in', 'state:launching', 'state:running', 'proc:dispose']);
      expect(h.state.get().kind).toBe('running');
    });
  });

  describe('install', () => {
    it('success: installing → ready, a game-installed notification, then the window', async () => {
      h = await harness({ mode: 'install' });
      fire(IPC.actionLaunch);
      await flushAsync();
      expect(h.journal).toEqual(['state:installing']);
      await fs.mkdir(path.join(h.tmp, 'installed'), { recursive: true });
      await fs.writeFile(path.join(h.tmp, 'installed', 'game.exe'), '');
      h.exit();
      await flushAsync();
      expect(h.journal).toEqual([
        'state:installing',
        'state:ready',
        'notify:game-installed',
        'window:showAndFocus',
        'proc:dispose',
      ]);
    });

    it('error in the body: failSequence keeps the game on Install and reports the cause', async () => {
      h = await harness({ mode: 'install' });
      fire(IPC.actionLaunch);
      await flushAsync();
      await fs.mkdir(path.join(h.tmp, 'installed'), { recursive: true });
      await fs.writeFile(path.join(h.tmp, 'installed', 'game.exe'), '');
      h.failStats = true;
      h.exit();
      await flushAsync();
      expect(h.journal).toEqual([
        'state:installing',
        'state:ready',
        'window:showAndFocus',
        'send:error',
        'proc:dispose',
      ]);
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { requiresInstall: true } });
    });

    it('card swap mid-install: unwinds without touching the state, then replays the insert', async () => {
      h = await harness({ mode: 'install' });
      fire(IPC.actionLaunch);
      await flushAsync();
      h.insert(swapRoot);
      await flushAsync();
      expect(h.journal).toEqual(['state:installing', 'proc:dispose', 'state:error', 'window:hide']);
    });
  });

  describe('uninstall', () => {
    async function installed(sweepDir?: string): Promise<Harness> {
      const built = await harness({ mode: 'install', sweepDir });
      // Reading the library again with the executable in place flips the game to installed.
      await fs.mkdir(path.join(built.tmp, 'installed'), { recursive: true });
      await fs.writeFile(path.join(built.tmp, 'installed', 'game.exe'), '');
      await built.controller.reloadPcLibrary();
      await flushAsync();
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { canUninstall: true } });
      built.journal.length = 0;
      return built;
    }

    it('success: uninstalling → ready, a game-uninstalled notification, then the window', async () => {
      h = await installed();
      fire(IPC.actionUninstall);
      await flushAsync();
      expect(h.journal).toEqual([
        'state:uninstalling',
        'state:ready',
        'notify:game-uninstalled',
        'window:showAndFocus',
      ]);
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { requiresInstall: true } });
    });

    it('error in the body: failSequence returns to ready with Uninstall still offered', async () => {
      h = await installed();
      h.failStats = true;
      fire(IPC.actionUninstall);
      await flushAsync();
      expect(h.journal).toEqual(['state:uninstalling', 'state:ready', 'window:showAndFocus', 'send:error']);
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { canUninstall: true } });
    });

    it('card swap during the directory sweep: the retry loop sees the signal, nothing is set, the insert replays', async () => {
      h = await installed(unremovable(os.tmpdir()));
      fire(IPC.actionUninstall);
      await flushAsync();
      expect(h.journal).toEqual(['state:uninstalling']);
      h.insert(swapRoot);
      // The sweep backs off 300 ms between attempts and only then reads the signal.
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      await flushAsync();
      expect(h.journal).toEqual(['state:uninstalling', 'state:error', 'window:hide']);
    });
  });

  describe('prefix cleanup', () => {
    it('success: uninstalling → ready with Uninstall gone, then the window', async () => {
      h = await harness({ mode: 'prefix-cleanup' });
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { prefixCleanupOnly: true } });
      fire(IPC.actionUninstall);
      await flushAsync();
      expect(h.journal).toEqual(['state:uninstalling', 'state:ready', 'window:showAndFocus']);
    });

    it('error in the body: failSequence returns to ready and reports the cause', async () => {
      h = await harness({ mode: 'prefix-cleanup' });
      h.failStats = true;
      fire(IPC.actionUninstall);
      await flushAsync();
      expect(h.journal).toEqual(['state:uninstalling', 'state:ready', 'window:showAndFocus', 'send:error']);
    });

    it('card swap during the sweep: the retry loop sees the signal, nothing is set, the insert replays', async () => {
      h = await harness({ mode: 'prefix-cleanup', sweepDir: unremovable(os.tmpdir()) });
      fire(IPC.actionUninstall);
      await flushAsync();
      expect(h.journal).toEqual(['state:uninstalling']);
      h.insert(swapRoot);
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      await flushAsync();
      expect(h.journal).toEqual(['state:uninstalling', 'state:error', 'window:hide']);
    });
  });
});
