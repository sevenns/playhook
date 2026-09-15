// Characterization tests of the controller's four sequences (prefix cleanup, launch, install, uninstall):
// the order of state transitions, what `failSequence` does, and what each `finally` leaves behind — for a
// success, an error thrown inside the body, and an abort mid-way (a card swap, or shutdown). Written
// BEFORE the sequences were folded into one `runSequence`, so a change in that order shows up here.
//
// The controller is built from fakes on every seam (`ControllerDeps` is interfaces, not classes) and the
// process waits are handed in through `processControl`: the real ones poll on second-long cadences, and
// the fake `waitForExit` is a gate the test opens — or aborts, the way a card swap would.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain, shell } from './stubs/electron';
import { GameController } from '../src/main/game-controller';
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
import type { GameProcess, Platform } from '../src/main/platform/types';
import { IPC, type Stats } from '../src/shared/types';
import type { LaunchTarget, ResolvedManifest } from '../src/main/manifest-types';

const ZERO_STATS: Stats = {
  schemaVersion: 1,
  totalPlaySeconds: 0,
  lastPlayedAt: null,
  launchCount: 0,
};

function unexpected(name: string): () => never {
  return () => {
    throw new Error(`unexpected call: ${name}`);
  };
}

/**
 * Polls until `condition` holds. The sequences touch the real filesystem, so how many event-loop turns a
 * step takes depends on the machine — a fixed number of yields passed here and flaked on CI. The deadline
 * sits under vitest's own 5 s so the message names WHAT was waited for, not just that the test timed out.
 */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits until the journal's LAST entry is `last` — the marker each scenario ends on. */
function settled(journal: readonly string[], last: string): Promise<void> {
  return waitFor(() => journal.at(-1) === last, `journal to end on ${last}`);
}

/** Waits until the journal contains `entry` (an intermediate checkpoint of a scenario). */
function reached(journal: readonly string[], entry: string): Promise<void> {
  return waitFor(() => journal.includes(entry), `journal to reach ${entry}`);
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
  /**
   * Opens the `waitForExit` gate (the game / installer "exits"). Sticky: a sequence reaches its wait only
   * after real fs work (the install pre-clean, a settings read), so an exit requested before the gate
   * exists opens it the moment it is created.
   */
  readonly exit: () => void;
  readonly tmp: string;
  /** The path the fake `stats.read` / `recordPlay` throw on once set — the "error in the body" hook. */
  failStats: boolean;
  /**
   * Makes the fake installer put the game's executable in place — the way a real one does, AFTER the
   * sequence's pre-clean of the install dir (a file written from the test races that clean).
   */
  installerWritesExe: boolean;
  /** Which launcher step fails next — the in-body `failSequence` branches that return early. */
  failAt: FailPoint | null;
}

type Mode = 'normal' | 'install' | 'prefix-cleanup' | 'steam';

/**
 * `launch`: launchGame throws. `start`: the game never appears (waitForStart false). `installer`:
 * launchInstaller throws. `uninstaller`: launchUninstaller throws (non-fatal — the sweep still runs).
 */
type FailPoint = 'launch' | 'start' | 'installer' | 'uninstaller';

interface HarnessOptions {
  readonly mode: Mode;
  /** What the launcher reports as the directory to sweep; a NUL byte in it makes every removal fail. */
  readonly sweepDir?: string;
  /** Whether the install-mode game has an uninstaller of its own (the default resolves none). */
  readonly uninstaller?: boolean;
}

const STEAM_APPID = 480;

/** A Steam root whose one library reports `appid` fully installed — enough for steamInstallStatus. */
async function fakeSteamRoot(tmp: string, appid: number): Promise<string> {
  const root = path.join(tmp, 'steam');
  await fs.mkdir(path.join(root, 'steamapps'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'steamapps', `appmanifest_${appid}.acf`),
    `"AppState"\n{\n\t"appid"\t\t"${appid}"\n\t"StateFlags"\t\t"4"\n}\n`,
  );
  return root;
}

async function harness(opts: HarnessOptions): Promise<Harness> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-controller-'));
  const gameDir = path.join(tmp, 'game');
  await fs.mkdir(gameDir, { recursive: true });
  const installDir = path.join(tmp, 'installed');
  const sweepDir = opts.sweepDir ?? installDir;
  // The prefix a cleanup sweeps exists to begin with — its fake reports it only while it does.
  if (opts.mode === 'prefix-cleanup' && opts.sweepDir === undefined) {
    await fs.mkdir(installDir, { recursive: true });
  }
  const steamRoot = opts.mode === 'steam' ? await fakeSteamRoot(tmp, STEAM_APPID) : null;
  const executablePath =
    opts.mode === 'install' ? path.join(installDir, 'game.exe') : path.join(gameDir, 'game.exe');
  const manifest: ResolvedManifest = {
    raw: {
      schemaVersion: 1,
      id: 'g1',
      title: 'Game One',
      ...(opts.mode === 'steam' ? { steam: { appid: STEAM_APPID } } : { executable: 'game.exe' }),
      args: [],
      runAsAdmin: false,
      launchTimeoutSec: 1,
      killTimeoutSec: 1,
      winetricks: [],
    },
    root: gameDir,
    source: 'pc',
    executablePath: opts.mode === 'steam' ? '' : executablePath,
    cwd: path.dirname(executablePath),
    ...(opts.mode === 'steam' ? { steam: { appid: STEAM_APPID } } : {}),
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
  const h: {
    failStats: boolean;
    exitRequested: boolean;
    installerWritesExe: boolean;
    failAt: FailPoint | null;
    release: (() => void) | null;
    insert: (root: string) => void;
  } = {
    failStats: false,
    exitRequested: false,
    installerWritesExe: false,
    failAt: null,
    release: null,
    insert: () => undefined,
  };
  const failing = (point: FailPoint): boolean => {
    if (h.failAt !== point) return false;
    h.failAt = null;
    return true;
  };
  const uninstallerTarget: LaunchTarget = {
    file: path.join(installDir, 'unins000.exe'),
    args: [],
    cwd: installDir,
    runAsAdmin: false,
  };
  /** The gate `waitForExit` opens: shared by the game, the installer and the uninstaller. */
  const exitGate = (signal: AbortSignal | undefined): Promise<void> => {
    const gate = abortableGate(signal);
    h.release = gate.release;
    if (h.exitRequested) gate.release();
    return gate.opened;
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
      killImagesElevated: unexpected('killImagesElevated'),
    },
    steamLocator: { locateSteam: () => Promise.resolve(steamRoot) },
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
      launchGame: () =>
        failing('launch') ? Promise.reject(new Error('spawn boom')) : Promise.resolve(proc),
      launchInstaller: async () => {
        if (failing('installer')) throw new Error('installer boom');
        if (h.installerWritesExe) {
          await fs.mkdir(installDir, { recursive: true });
          await fs.writeFile(executablePath, '');
        }
        return proc;
      },
      prepareInstallDir: () => Promise.resolve(),
      launchUninstaller: () => {
        journal.push('uninstaller:launch');
        return failing('uninstaller') ? Promise.reject(new Error('uninstaller boom')) : Promise.resolve(proc);
      },
      resolveUninstaller: () => Promise.resolve(opts.uninstaller === true ? uninstallerTarget : null),
      uninstallDir: () => sweepDir,
      // The prefix is reported while it exists — after a sweep it is gone, and so is "Uninstall". A
      // custom sweepDir (the unremovable one) is reported as given: it never exists to begin with.
      prefixCleanupDir: () => {
        if (opts.mode !== 'prefix-cleanup') return Promise.resolve(null);
        if (opts.sweepDir !== undefined) return Promise.resolve(sweepDir);
        return Promise.resolve(fsSync.existsSync(installDir) ? installDir : null);
      },
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
    waitForStart: () => Promise.resolve(!failing('start')),
    waitForExit: (_proc, signal) => exitGate(signal),
    waitForWatchedStart: unexpected('waitForWatchedStart'),
    waitForWatchedExit: unexpected('waitForWatchedExit'),
    waitForSteamStart: () => Promise.resolve({ started: true, pid: null }),
    waitForSteamExit: (_appid, _names, _monitor, signal) => exitGate(signal),
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
  await waitFor(() => state.get().kind === 'ready', 'the initial ready state');
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
    get installerWritesExe() {
      return h.installerWritesExe;
    },
    set installerWritesExe(value: boolean) {
      h.installerWritesExe = value;
    },
    get failAt() {
      return h.failAt;
    },
    set failAt(value: FailPoint | null) {
      h.failAt = value;
    },
    exit: () => {
      h.exitRequested = true;
      h.release?.();
    },
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
  // Null until the test's own harness is built: a harness that fails to build must not leave the previous
  // test's controller for the afterEach to shut down a second time.
  let h: Harness | null = null;
  let swapRoot: string;

  beforeEach(async () => {
    h = null;
    shell.opened.length = 0;
    swapRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-swap-'));
  });

  afterEach(async () => {
    h?.controller.shutdown();
    if (h !== null) await fs.rm(h.tmp, { recursive: true, force: true });
    await fs.rm(swapRoot, { recursive: true, force: true });
  });

  describe('launch', () => {
    it('success: sync-in → launching → running → syncing-out → ready, then the finally releases the process', async () => {
      h = await harness({ mode: 'normal' });
      fire(IPC.actionLaunch);
      await reached(h.journal, 'state:running');
      expect(h.journal).toEqual(['state:syncing-in', 'state:launching', 'state:running']);
      h.exit();
      await settled(h.journal, 'proc:dispose');
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
      // A second Play goes through only because the finally cleared `locked` / launchInFlight. The exit
      // gate is sticky, so the whole session replays at once.
      const firstRun = [...h.journal];
      h.journal.length = 0;
      fire(IPC.actionLaunch);
      await settled(h.journal, 'proc:dispose');
      expect(h.journal).toEqual(firstRun);
    });

    it('launchGame throws: failSequence from inside the body, no process to release, the window and the error shown', async () => {
      h = await harness({ mode: 'normal' });
      h.failAt = 'launch';
      fire(IPC.actionLaunch);
      await settled(h.journal, 'send:error');
      expect(h.journal).toEqual([
        'state:syncing-in',
        'state:launching',
        'state:ready',
        'window:showAndFocus',
        'send:error',
      ]);
      expect(h.state.get().kind).toBe('ready');
      // The early return still went through the finally: Play is accepted again.
      h.journal.length = 0;
      fire(IPC.actionLaunch);
      await reached(h.journal, 'state:running');
      h.exit();
      await settled(h.journal, 'proc:dispose');
    });

    it('the game never appears: gameDidNotStart from inside the body, the spawned process still released', async () => {
      h = await harness({ mode: 'normal' });
      h.failAt = 'start';
      fire(IPC.actionLaunch);
      await settled(h.journal, 'proc:dispose');
      expect(h.journal).toEqual([
        'state:syncing-in',
        'state:launching',
        'state:ready',
        'window:showAndFocus',
        'send:error',
        'proc:dispose',
      ]);
    });

    it('error in the body: failSequence returns to ready, shows the window and the error, then the finally runs', async () => {
      h = await harness({ mode: 'normal' });
      fire(IPC.actionLaunch);
      await reached(h.journal, 'state:running');
      h.failStats = true;
      h.exit();
      await settled(h.journal, 'proc:dispose');
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
      await reached(h.journal, 'state:running');
      h.insert(swapRoot);
      await settled(h.journal, 'window:hide');
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
      await reached(h.journal, 'state:running');
      h.controller.shutdown();
      await settled(h.journal, 'proc:dispose');
      expect(h.journal).toEqual([
        'state:syncing-in',
        'state:launching',
        'state:running',
        'proc:dispose',
      ]);
      expect(h.state.get().kind).toBe('running');
    });
  });

  describe('install', () => {
    it('success: installing → ready, a game-installed notification, then the window', async () => {
      h = await harness({ mode: 'install' });
      h.installerWritesExe = true;
      fire(IPC.actionLaunch);
      await reached(h.journal, 'state:installing');
      expect(h.journal).toEqual(['state:installing']);
      h.exit();
      await settled(h.journal, 'proc:dispose');
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
      h.installerWritesExe = true;
      fire(IPC.actionLaunch);
      await reached(h.journal, 'state:installing');
      h.failStats = true;
      h.exit();
      await settled(h.journal, 'proc:dispose');
      expect(h.journal).toEqual([
        'state:installing',
        'state:ready',
        'window:showAndFocus',
        'send:error',
        'proc:dispose',
      ]);
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { requiresInstall: true } });
    });

    it('the installer cannot start: failSequence from inside the body, still on Install', async () => {
      h = await harness({ mode: 'install' });
      h.failAt = 'installer';
      fire(IPC.actionLaunch);
      await settled(h.journal, 'send:error');
      expect(h.journal).toEqual(['state:installing', 'state:ready', 'window:showAndFocus', 'send:error']);
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { requiresInstall: true } });
    });

    it('the installer exits without the executable: installIncomplete after the grace poll, still on Install', async () => {
      h = await harness({ mode: 'install' });
      fire(IPC.actionLaunch);
      await reached(h.journal, 'state:installing');
      h.exit();
      // launchTimeoutSec is 1: the poll for the executable gives up after a second.
      await settled(h.journal, 'proc:dispose');
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
      await reached(h.journal, 'state:installing');
      h.insert(swapRoot);
      await settled(h.journal, 'window:hide');
      expect(h.journal).toEqual(['state:installing', 'proc:dispose', 'state:error', 'window:hide']);
    });
  });

  describe('uninstall', () => {
    async function installed(sweepDir?: string, uninstaller = false): Promise<Harness> {
      const built = await harness({ mode: 'install', sweepDir, uninstaller });
      // Reading the library again with the executable in place flips the game to installed.
      await fs.mkdir(path.join(built.tmp, 'installed'), { recursive: true });
      await fs.writeFile(path.join(built.tmp, 'installed', 'game.exe'), '');
      await built.controller.reloadPcLibrary();
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { canUninstall: true } });
      built.journal.length = 0;
      return built;
    }

    it('success: uninstalling → ready, a game-uninstalled notification, then the window', async () => {
      h = await installed();
      fire(IPC.actionUninstall);
      await settled(h.journal, 'window:showAndFocus');
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
      await settled(h.journal, 'send:error');
      expect(h.journal).toEqual([
        'state:uninstalling',
        'state:ready',
        'window:showAndFocus',
        'send:error',
      ]);
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { canUninstall: true } });
    });

    it("with an uninstaller: it runs first and is released by the finally, then the sweep", async () => {
      h = await installed(undefined, true);
      fire(IPC.actionUninstall);
      await reached(h.journal, 'uninstaller:launch');
      h.exit();
      await settled(h.journal, 'proc:dispose');
      expect(h.journal).toEqual([
        'state:uninstalling',
        'uninstaller:launch',
        'state:ready',
        'notify:game-uninstalled',
        'window:showAndFocus',
        'proc:dispose',
      ]);
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { requiresInstall: true } });
    });

    it('an uninstaller that fails to start is non-fatal: the sweep still runs and the game is gone', async () => {
      h = await installed(undefined, true);
      h.failAt = 'uninstaller';
      fire(IPC.actionUninstall);
      await settled(h.journal, 'window:showAndFocus');
      expect(h.journal).toEqual([
        'state:uninstalling',
        'uninstaller:launch',
        'state:ready',
        'notify:game-uninstalled',
        'window:showAndFocus',
      ]);
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { requiresInstall: true } });
    });

    it('card swap while the uninstaller runs: the abort is rethrown past the non-fatal catch, nothing is set, the insert replays', async () => {
      h = await installed(undefined, true);
      // The logger mirrors to the console: the catch that swallows an uninstaller failure warns, and the
      // abort must not be reported as one (the sweep's own abort check would otherwise hide the difference).
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      fire(IPC.actionUninstall);
      await reached(h.journal, 'uninstaller:launch');
      h.insert(swapRoot);
      await settled(h.journal, 'window:hide');
      expect(h.journal).toEqual([
        'state:uninstalling',
        'uninstaller:launch',
        'proc:dispose',
        'state:error',
        'window:hide',
      ]);
      const lines = warned.mock.calls.map((call) => String(call[0]));
      warned.mockRestore();
      expect(lines.filter((line) => line.includes('[uninstall] uninstaller failed'))).toEqual([]);
      await expect(fs.stat(path.join(h.tmp, 'installed', 'game.exe'))).resolves.toBeDefined();
    });

    it('card swap during the directory sweep: the retry loop sees the signal, nothing is set, the insert replays', async () => {
      h = await installed(unremovable(os.tmpdir()));
      fire(IPC.actionUninstall);
      await reached(h.journal, 'state:uninstalling');
      expect(h.journal).toEqual(['state:uninstalling']);
      h.insert(swapRoot);
      // The sweep backs off 300 ms between attempts and only then reads the signal.
      await settled(h.journal, 'window:hide');
      expect(h.journal).toEqual(['state:uninstalling', 'state:error', 'window:hide']);
    });
  });

  describe('steam', () => {
    it('launch: opens steam://rungameid, tracks the game by appid, syncs out and returns to ready', async () => {
      h = await harness({ mode: 'steam' });
      expect(h.state.get()).toMatchObject({
        kind: 'ready',
        game: { installVia: 'steam', requiresInstall: false },
      });
      fire(IPC.actionLaunch);
      await reached(h.journal, 'state:running');
      expect(shell.opened).toEqual([`steam://rungameid/${STEAM_APPID}`]);
      h.exit();
      await settled(h.journal, 'window:showAndFocus');
      // No process of ours: nothing to dispose, the finally ends on the window.
      expect(h.journal).toEqual([
        'state:syncing-in',
        'state:launching',
        'state:running',
        'stats:recordPlay',
        'state:syncing-out',
        'window:showAndFocus',
        'state:ready',
        'window:showAndFocus',
      ]);
    });

    it('card swap mid-run: unwinds silently and replays the insert, like the spawned path', async () => {
      h = await harness({ mode: 'steam' });
      fire(IPC.actionLaunch);
      await reached(h.journal, 'state:running');
      h.insert(swapRoot);
      await settled(h.journal, 'window:hide');
      expect(h.journal).toEqual([
        'state:syncing-in',
        'state:launching',
        'state:running',
        'state:error',
        'window:hide',
      ]);
    });

    it('uninstall is fire-and-forget: opens steam://uninstall and shows "Uninstalling…" without a blocking state', async () => {
      h = await harness({ mode: 'steam' });
      fire(IPC.actionUninstall);
      await waitFor(() => shell.opened.length > 0, 'the steam://uninstall URI');
      expect(shell.opened).toEqual([`steam://uninstall/${STEAM_APPID}`]);
      const uninstalling = (): boolean => {
        const state = h?.state.get();
        return state?.kind === 'ready' && state.game.steamUninstalling === true;
      };
      await waitFor(uninstalling, 'the optimistic steamUninstalling flag');
      expect(h.journal).toEqual(['state:ready']);
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { canUninstall: false } });
    });
  });

  describe('prefix cleanup', () => {
    it('success: uninstalling → ready with Uninstall gone, then the window', async () => {
      h = await harness({ mode: 'prefix-cleanup' });
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { prefixCleanupOnly: true } });
      fire(IPC.actionUninstall);
      await settled(h.journal, 'window:showAndFocus');
      expect(h.journal).toEqual(['state:uninstalling', 'state:ready', 'window:showAndFocus']);
      // The prefix is gone, so the rebuilt info no longer offers Uninstall.
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { canUninstall: false } });
    });

    it('error in the body: failSequence returns to ready and reports the cause', async () => {
      h = await harness({ mode: 'prefix-cleanup' });
      h.failStats = true;
      fire(IPC.actionUninstall);
      await settled(h.journal, 'send:error');
      expect(h.journal).toEqual([
        'state:uninstalling',
        'state:ready',
        'window:showAndFocus',
        'send:error',
      ]);
    });

    it('card swap during the sweep: the retry loop sees the signal, nothing is set, the insert replays', async () => {
      h = await harness({ mode: 'prefix-cleanup', sweepDir: unremovable(os.tmpdir()) });
      fire(IPC.actionUninstall);
      await reached(h.journal, 'state:uninstalling');
      expect(h.journal).toEqual(['state:uninstalling']);
      h.insert(swapRoot);
      await settled(h.journal, 'window:hide');
      expect(h.journal).toEqual(['state:uninstalling', 'state:error', 'window:hide']);
    });
  });
});
