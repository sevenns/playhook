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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { ActivityRegistry } from '../src/main/activity-registry';
import type { ActivityMap } from '../src/shared/activity';
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
  /** The id main last put on screen (`browse:update`), or null for the empty screen. */
  readonly browsedId: () => string | null;
  /** Drops a game from what the fake PC library reads next — the file after a delete was saved. */
  readonly removeLocalGame: (id: string) => void;
  /** Every game's activity (the controller's registry). */
  readonly activities: ActivityRegistry;
  /** Holds every copy install at its prepare step until the returned release is called. */
  readonly holdCopies: () => () => void;
  /** What the fake watcher was given for `onRemove` - the card being pulled. */
  readonly remove: () => void;
  /** Rewrites the Steam game's `.acf` - the way Steam reports a download starting or finishing. */
  readonly setSteamState: (state: SteamAcfState) => Promise<void>;
}

type SteamAcfState = 'installed' | 'downloading' | 'absent';

type Mode = 'normal' | 'install' | 'copy' | 'prefix-cleanup' | 'steam';

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
  /**
   * Extra local games listed AFTER the default one in the library file, with when each was last played —
   * the row orders by that, so the file's first game need not be the row's.
   */
  readonly extraGames?: readonly { readonly id: string; readonly lastPlayedAt: string }[];
  /** What the Steam game's `.acf` says at startup (steam mode only; installed by default). */
  readonly steamState?: SteamAcfState;
  /** Where the copy-mode game comes from (`pc` by default): a `card` one is stopped when the card goes. */
  readonly copySource?: 'card' | 'pc';
}

const STEAM_APPID = 480;

/** Writes the one library's `.acf` of `appid`: StateFlags 4 is fully installed, 1026 a download. */
async function writeSteamAcf(root: string, appid: number, state: SteamAcfState): Promise<void> {
  if (state === 'absent') {
    await fs.rm(path.join(root, 'steamapps', `appmanifest_${appid}.acf`), { force: true });
    return;
  }
  const flags = state === 'installed' ? 4 : 1026;
  await fs.writeFile(
    path.join(root, 'steamapps', `appmanifest_${appid}.acf`),
    `"AppState"\n{\n\t"appid"\t\t"${appid}"\n\t"StateFlags"\t\t"${flags}"\n}\n`,
  );
}

/** A Steam root whose one library reports `appid` in `state` - enough for steamInstallStatus. */
async function fakeSteamRoot(tmp: string, appid: number, state: SteamAcfState): Promise<string> {
  const root = path.join(tmp, 'steam');
  await fs.mkdir(path.join(root, 'steamapps'), { recursive: true });
  await writeSteamAcf(root, appid, state);
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
  if (opts.mode === 'copy') await fs.writeFile(path.join(gameDir, 'game.exe'), '');
  const steamRoot =
    opts.mode === 'steam' ? await fakeSteamRoot(tmp, STEAM_APPID, opts.steamState ?? 'installed') : null;
  const executablePath =
    opts.mode === 'install' || opts.mode === 'copy'
      ? path.join(installDir, 'game.exe')
      : path.join(gameDir, 'game.exe');
  const baseRaw = {
    schemaVersion: 1,
    id: 'g1',
    title: 'Game One',
    args: [],
    runAsAdmin: false,
    launchTimeoutSec: 1,
    killTimeoutSec: 1,
    winetricks: [],
  } as const;
  const manifest: ResolvedManifest = {
    raw: {
      ...baseRaw,
      ...(opts.mode === 'steam' ? { steam: { appid: STEAM_APPID } } : { executable: 'game.exe' }),
    },
    root: gameDir,
    source: opts.mode === 'copy' ? (opts.copySource ?? 'pc') : 'pc',
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
    ...(opts.mode === 'copy'
      ? {
          install: {
            type: 'copy' as const,
            installerPath: gameDir,
            runAsAdmin: false,
            args: [],
            winetricks: [],
            dir: installDir,
            installerDir: installDir,
          },
        }
      : {}),
  };

  // The extra games are never Steam ones, whatever the mode: two games sharing one appid would both be
  // "the game Steam is busy with".
  const plainManifest: ResolvedManifest = {
    raw: { ...baseRaw, executable: 'game.exe' },
    root: gameDir,
    source: 'pc',
    executablePath: path.join(gameDir, 'game.exe'),
    cwd: gameDir,
  };
  const lastPlayed = new Map((opts.extraGames ?? []).map((game) => [game.id, game.lastPlayedAt]));
  let localGames: readonly ResolvedManifest[] = [
    manifest,
    ...(opts.extraGames ?? []).map(
      (game): ResolvedManifest => ({
        ...plainManifest,
        raw: { ...plainManifest.raw, id: game.id, title: game.id },
      }),
    ),
  ];
  let browsedId: string | null = null;

  const journal: string[] = [];
  const state = new StateManager();
  state.subscribe((next) => journal.push(`state:${next.kind}`));
  const activities = new ActivityRegistry();
  let lastActivities: ActivityMap = {};
  activities.subscribe((next) => {
    for (const id of new Set([...Object.keys(lastActivities), ...Object.keys(next)])) {
      const kind = next[id]?.kind ?? 'clear';
      if (kind !== (lastActivities[id]?.kind ?? 'clear')) journal.push(`activity:${id}:${kind}`);
    }
    lastActivities = next;
  });
  const h: {
    failStats: boolean;
    exitRequested: boolean;
    installerWritesExe: boolean;
    failAt: FailPoint | null;
    release: (() => void) | null;
    insert: (root: string) => void;
    remove: () => void;
    copyHold: Promise<void>;
  } = {
    failStats: false,
    exitRequested: false,
    installerWritesExe: false,
    failAt: null,
    release: null,
    insert: () => undefined,
    remove: () => undefined,
    copyHold: Promise.resolve(),
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
  const readStats = (id?: string): Promise<Stats> =>
    h.failStats
      ? Promise.reject(new Error('stats boom'))
      : Promise.resolve({
          ...ZERO_STATS,
          lastPlayedAt: (id === undefined ? undefined : lastPlayed.get(id)) ?? null,
        });

  const window: ControllerWindow = {
    send: (channel, payload) => {
      if (channel === IPC.errorShow) journal.push('send:error');
      if (channel === IPC.browseUpdate) browsedId = browseIdOf(payload);
    },
    showAndFocus: () => journal.push('window:showAndFocus'),
    hide: () => journal.push('window:hide'),
    isShown: () => true,
    isFocused: () => false,
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
    read: () => Promise.resolve({ manifests: localGames, intact: true }),
    gcOrphans: () => Promise.resolve(),
  };
  const watcher: ControllerWatcher = {
    onInsert: (handler) => {
      h.insert = handler;
    },
    onRemove: (handler) => {
      h.remove = () => handler('');
    },
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
      prepareInstallDir: () => h.copyHold,
      needsProvisioning: () => Promise.resolve(false),
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
    activities,
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
    browsedId: () => browsedId,
    removeLocalGame: (id) => {
      localGames = localGames.filter((game) => game.raw.id !== id);
    },
    activities,
    holdCopies: () => {
      let release: () => void = () => undefined;
      h.copyHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    remove: () => h.remove(),
    setSteamState: async (next) => {
      if (steamRoot !== null) await writeSteamAcf(steamRoot, STEAM_APPID, next);
    },
  };
}

function browseIdOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('id' in payload)) return null;
  return typeof payload.id === 'string' ? payload.id : null;
}

function fire(channel: string, ...args: readonly unknown[]): void {
  const listener = ipcMain.listeners.get(channel);
  if (listener === undefined) throw new Error(`no listener registered for ${channel}`);
  listener(undefined, ...args);
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
    const flippedToPlay = (built: Harness): boolean => {
      const state = built.state.get();
      return state.kind === 'ready' && !state.game.requiresInstall;
    };

    it('success: a background job, a game-installed notification, no session state and no window', async () => {
      h = await harness({ mode: 'install' });
      const built = h;
      built.installerWritesExe = true;
      fire(IPC.actionLaunch);
      await reached(built.journal, 'activity:g1:installing');
      built.exit();
      await waitFor(() => flippedToPlay(built), 'the game to flip to Play');
      expect(built.journal).toEqual([
        'activity:g1:installing',
        'notify:game-installed',
        'proc:dispose',
        'activity:g1:clear',
        'state:ready',
      ]);
    });

    it('the installer cannot start: a failed-install notification, still on Install', async () => {
      h = await harness({ mode: 'install' });
      const built = h;
      built.failAt = 'installer';
      fire(IPC.actionLaunch);
      await reached(built.journal, 'activity:g1:clear');
      expect(built.journal.filter((entry) => entry !== 'state:ready')).toEqual([
        'activity:g1:installing',
        'notify:game-install-failed',
        'activity:g1:clear',
      ]);
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { requiresInstall: true } });
    });

    it('the installer exits without the executable: installIncomplete after the grace poll, still on Install', async () => {
      h = await harness({ mode: 'install' });
      const built = h;
      fire(IPC.actionLaunch);
      await reached(built.journal, 'activity:g1:installing');
      built.exit();
      // launchTimeoutSec is 1: the poll for the executable gives up after a second.
      await reached(built.journal, 'activity:g1:clear');
      expect(built.journal.filter((entry) => entry !== 'state:ready')).toEqual([
        'activity:g1:installing',
        'notify:game-install-failed',
        'proc:dispose',
        'activity:g1:clear',
      ]);
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { requiresInstall: true } });
    });

    it('shutdown mid-install stops the job silently and releases the installer', async () => {
      h = await harness({ mode: 'install' });
      const built = h;
      fire(IPC.actionLaunch);
      await reached(built.journal, 'activity:g1:installing');
      await waitFor(() => fsSync.existsSync(path.join(built.tmp, 'installed', '.playhook-installing')), 'the installer run');
      built.controller.shutdown();
      await reached(built.journal, 'activity:g1:clear');
      expect(built.journal.filter((entry) => entry !== 'state:ready')).toEqual([
        'activity:g1:installing',
        'proc:dispose',
        'activity:g1:clear',
      ]);
    });
  });

  describe('install marker', () => {
    it('an installer run that never finished leaves the game on Install even with its executable there', async () => {
      h = await harness({ mode: 'install' });
      const built = h;
      await fs.mkdir(path.join(built.tmp, 'installed'), { recursive: true });
      await fs.writeFile(path.join(built.tmp, 'installed', 'game.exe'), '');
      await fs.writeFile(path.join(built.tmp, 'installed', '.playhook-installing'), '');
      await built.controller.reloadPcLibrary();
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { requiresInstall: true } });
      await fs.rm(path.join(built.tmp, 'installed', '.playhook-installing'));
      await built.controller.reloadPcLibrary();
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { requiresInstall: false } });
    });

    it('a finished installer run takes its marker away', async () => {
      h = await harness({ mode: 'install' });
      const built = h;
      built.installerWritesExe = true;
      fire(IPC.actionLaunch);
      const marker = path.join(built.tmp, 'installed', '.playhook-installing');
      await waitFor(() => fsSync.existsSync(marker), 'the install marker');
      built.exit();
      await waitFor(() => {
        const state = built.state.get();
        return state.kind === 'ready' && !state.game.requiresInstall;
      }, 'the game to flip to Play');
      expect(fsSync.existsSync(marker)).toBe(false);
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

    const flippedToInstall = (built: Harness): boolean => {
      const state = built.state.get();
      return state.kind === 'ready' && state.game.requiresInstall;
    };

    it('success: a background job, a game-uninstalled notification, no session state and no window', async () => {
      h = await installed();
      const built = h;
      fire(IPC.actionUninstall);
      await waitFor(() => flippedToInstall(built), 'the game to flip back to Install');
      expect(built.journal).toEqual([
        'activity:g1:uninstalling',
        'notify:game-uninstalled',
        'activity:g1:clear',
        'state:ready',
      ]);
    });

    it('a sweep that keeps failing is reported as a failed uninstall, and Uninstall stays offered', async () => {
      h = await installed(unremovable(os.tmpdir()));
      const built = h;
      fire(IPC.actionUninstall);
      await reached(built.journal, 'activity:g1:clear');
      expect(built.journal.filter((entry) => !entry.startsWith('state:'))).toEqual([
        'activity:g1:uninstalling',
        'notify:game-uninstall-failed',
        'activity:g1:clear',
      ]);
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { canUninstall: true } });
    });

    it('with an uninstaller: it runs first and is released by the job, then the sweep', async () => {
      h = await installed(undefined, true);
      const built = h;
      fire(IPC.actionUninstall);
      await reached(built.journal, 'uninstaller:launch');
      built.exit();
      await waitFor(() => flippedToInstall(built), 'the game to flip back to Install');
      expect(built.journal).toEqual([
        'activity:g1:uninstalling',
        'uninstaller:launch',
        'notify:game-uninstalled',
        'proc:dispose',
        'activity:g1:clear',
        'state:ready',
      ]);
    });

    it('an uninstaller that fails to start is non-fatal: the sweep still runs and the game is gone', async () => {
      h = await installed(undefined, true);
      const built = h;
      h.failAt = 'uninstaller';
      fire(IPC.actionUninstall);
      await waitFor(() => flippedToInstall(built), 'the game to flip back to Install');
      expect(built.journal).toContain('notify:game-uninstalled');
    });

    it('a card swap does not stop an uninstall: it targets the PC and finishes on its own', async () => {
      h = await installed(undefined, true);
      const built = h;
      fire(IPC.actionUninstall);
      await reached(built.journal, 'uninstaller:launch');
      built.insert(swapRoot);
      await reached(built.journal, 'state:error');
      built.exit();
      await reached(built.journal, 'activity:g1:clear');
      expect(built.journal).toContain('notify:game-uninstalled');
      await expect(fs.stat(path.join(built.tmp, 'installed', 'game.exe'))).rejects.toThrow();
    });

    it('shutdown during the directory sweep stops the job silently', async () => {
      h = await installed(unremovable(os.tmpdir()));
      const built = h;
      fire(IPC.actionUninstall);
      await reached(built.journal, 'activity:g1:uninstalling');
      built.controller.shutdown();
      await reached(built.journal, 'activity:g1:clear');
      expect(built.journal.filter((entry) => !entry.startsWith('state:'))).toEqual([
        'activity:g1:uninstalling',
        'activity:g1:clear',
      ]);
    });
  });

  describe('copy install', () => {
    const otherSelected = (built: Harness): boolean => {
      const state = built.state.get();
      return state.kind === 'ready' && state.game.id === 'other';
    };

    async function selectThenLaunch(built: Harness, id: string): Promise<void> {
      built.journal.length = 0;
      fire(IPC.actionSelect, id);
      await reached(built.journal, 'state:ready');
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      fire(IPC.actionLaunch);
    }

    it('runs as a background job: an activity, a notification, no session state and no window', async () => {
      h = await harness({ mode: 'copy' });
      const built = h;
      fire(IPC.actionLaunch);
      await waitFor(() => {
        const state = built.state.get();
        return state.kind === 'ready' && !state.game.requiresInstall;
      }, 'the game to flip to Play');
      expect(built.journal).toEqual([
        'activity:g1:installing',
        'notify:game-installed',
        'activity:g1:clear',
        'state:ready',
      ]);
      await expect(fs.stat(path.join(built.tmp, 'installed', 'game.exe'))).resolves.toBeDefined();
    });

    it('another game launches and runs a full session while the copy is in flight, untouched by its end', async () => {
      h = await harness({
        mode: 'copy',
        extraGames: [{ id: 'other', lastPlayedAt: '2026-10-01T00:00:00.000Z' }],
      });
      const built = h;
      const release = built.holdCopies();
      await selectThenLaunch(built, 'g1');
      await reached(built.journal, 'activity:g1:installing');
      await selectThenLaunch(built, 'other');
      await reached(built.journal, 'state:running');
      release();
      await reached(built.journal, 'activity:g1:clear');
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(built.journal).toEqual([
        'state:ready',
        'state:syncing-in',
        'state:launching',
        'state:running',
        'notify:game-installed',
        'activity:g1:clear',
      ]);
      expect(built.state.get()).toMatchObject({ kind: 'running', game: { id: 'other' } });
      built.exit();
      await settled(built.journal, 'proc:dispose');
      expect(built.journal).not.toContain('state:installing');
      expect(otherSelected(built)).toBe(true);
    });

    it('pulling the card during a busy session still stops the card copy', async () => {
      h = await harness({
        mode: 'copy',
        copySource: 'card',
        extraGames: [{ id: 'other', lastPlayedAt: '2026-10-01T00:00:00.000Z' }],
      });
      const built = h;
      const release = built.holdCopies();
      const cardGame = built.controller.findManifest('g1');
      if (cardGame === null) throw new Error('the card game is missing');
      built.controller.jobs.startInstall(cardGame);
      await reached(built.journal, 'activity:g1:installing');
      await selectThenLaunch(built, 'other');
      await reached(built.journal, 'state:running');
      built.remove();
      release();
      await reached(built.journal, 'activity:g1:clear');
      expect(built.journal).toContain('notify:game-install-failed');
      expect(built.state.get()).toMatchObject({ kind: 'running', game: { id: 'other' } });
      await expect(fs.stat(path.join(built.tmp, 'installed', 'game.exe'))).rejects.toThrow();
      built.exit();
      await settled(built.journal, 'proc:dispose');
    });

    it('a staging dir left by a killed launcher is swept when the library is read', async () => {
      h = await harness({ mode: 'copy' });
      const built = h;
      const partial = path.join(built.tmp, 'installed.partial');
      await fs.mkdir(partial, { recursive: true });
      await fs.writeFile(path.join(partial, 'game.exe'), '');
      await built.controller.reloadPcLibrary();
      await waitFor(() => !fsSync.existsSync(partial), 'the orphaned staging dir to go');
    });

    it('a reload that drops the game stops its copy', async () => {
      h = await harness({
        mode: 'copy',
        extraGames: [{ id: 'other', lastPlayedAt: '2026-09-01T00:00:00.000Z' }],
      });
      const built = h;
      const release = built.holdCopies();
      await selectThenLaunch(built, 'g1');
      await reached(built.journal, 'activity:g1:installing');
      built.removeLocalGame('g1');
      await built.controller.reloadPcLibrary();
      release();
      await reached(built.journal, 'activity:g1:clear');
      expect(built.journal).toContain('notify:game-install-failed');
      await expect(fs.stat(path.join(built.tmp, 'installed', 'game.exe'))).rejects.toThrow();
    });
  });

  describe('local game removed', () => {
    it('retargets to the first game of the ROW, not of the library file', async () => {
      h = await harness({
        mode: 'normal',
        extraGames: [
          { id: 'older', lastPlayedAt: '2026-09-01T00:00:00.000Z' },
          { id: 'newest', lastPlayedAt: '2026-10-01T00:00:00.000Z' },
        ],
      });
      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { id: 'newest' } });

      h.removeLocalGame('newest');
      await h.controller.reloadPcLibrary();

      expect(h.state.get()).toMatchObject({ kind: 'ready', game: { id: 'older' } });
      expect(h.browsedId()).toBe('older');
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

    it('uninstall is fire-and-forget: opens steam://uninstall and shows "Uninstalling…" as an activity, not a state', async () => {
      h = await harness({ mode: 'steam' });
      const built = h;
      fire(IPC.actionUninstall);
      await waitFor(() => shell.opened.length > 0, 'the steam://uninstall URI');
      expect(shell.opened).toEqual([`steam://uninstall/${STEAM_APPID}`]);
      await waitFor(() => built.activities.has('g1'), 'the optimistic steam-uninstalling activity');
      expect(built.activities.get('g1')).toEqual({ kind: 'steam-uninstalling' });
      expect(built.journal).toEqual(['activity:g1:steam-uninstalling']);
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { canUninstall: true } });
    });

    it('a second Uninstall while Steam is removing the game is ignored', async () => {
      h = await harness({ mode: 'steam' });
      const built = h;
      fire(IPC.actionUninstall);
      await waitFor(() => built.activities.has('g1'), 'the steam-uninstalling activity');
      fire(IPC.actionUninstall);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(shell.opened).toEqual([`steam://uninstall/${STEAM_APPID}`]);
    });
  });

  describe('steam activities', () => {
    beforeEach(() => {
      process.env['PLAYHOOK_STEAM_POLL_MS'] = '20';
    });
    afterEach(() => {
      delete process.env['PLAYHOOK_STEAM_POLL_MS'];
    });

    const downloading = (built: Harness): boolean => built.activities.get('g1')?.kind === 'steam-installing';
    const pause = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

    it('a download in flight at startup shows up as an activity without selecting the game', async () => {
      h = await harness({
        mode: 'steam',
        steamState: 'downloading',
        extraGames: [{ id: 'other', lastPlayedAt: '2026-10-01T00:00:00.000Z' }],
      });
      const built = h;
      await waitFor(() => downloading(built), 'the steam-installing activity');
      expect(built.activities.get('g1')).toEqual({ kind: 'steam-installing', paused: false });
      expect(built.journal.filter((entry) => entry.startsWith('state:'))).toEqual([]);
    });

    it('selecting another game while one downloads goes through, and the download keeps its activity', async () => {
      h = await harness({
        mode: 'steam',
        steamState: 'downloading',
        extraGames: [{ id: 'other', lastPlayedAt: '2026-10-01T00:00:00.000Z' }],
      });
      const built = h;
      fire(IPC.actionSelect, 'g1');
      await waitFor(() => built.state.get().kind === 'ready' && built.browsedId() === 'g1', 'g1 selected');
      await waitFor(() => downloading(built), 'the steam-installing activity');

      fire(IPC.actionSelect, 'other');
      await waitFor(() => {
        const state = built.state.get();
        return state.kind === 'ready' && state.game.id === 'other';
      }, 'the selection to move onto the other game');

      expect(downloading(built)).toBe(true);
    });

    it('another game launches and runs while one downloads; the finished download notifies without touching the session', async () => {
      h = await harness({
        mode: 'steam',
        steamState: 'downloading',
        extraGames: [{ id: 'other', lastPlayedAt: '2026-10-01T00:00:00.000Z' }],
      });
      const built = h;
      await waitFor(() => downloading(built), 'the steam-installing activity');
      built.journal.length = 0;
      fire(IPC.actionSelect, 'other');
      await reached(built.journal, 'state:ready');
      await pause(50);
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { id: 'other' } });
      built.journal.length = 0;

      fire(IPC.actionLaunch);
      await reached(built.journal, 'state:running');
      await built.setSteamState('installed');
      await reached(built.journal, 'notify:game-installed');
      await pause(100);

      const afterRunning = built.journal.slice(built.journal.indexOf('state:running') + 1);
      expect(afterRunning).toEqual(['activity:g1:clear', 'notify:game-installed']);
      expect(built.state.get()).toMatchObject({ kind: 'running', game: { id: 'other' } });
      built.exit();
      await settled(built.journal, 'proc:dispose');
    });

    it('a game with an activity is not launched', async () => {
      h = await harness({ mode: 'steam', steamState: 'downloading' });
      const built = h;
      await waitFor(() => downloading(built), 'the steam-installing activity');
      built.journal.length = 0;
      fire(IPC.actionLaunch);
      await pause(50);
      expect(shell.opened).toEqual([]);
      expect(built.journal.filter((entry) => entry !== 'state:ready')).toEqual([]);
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { id: 'g1' } });
    });

    it('the selected game finishing its download flips to Play and notifies once', async () => {
      h = await harness({ mode: 'steam', steamState: 'downloading' });
      const built = h;
      await waitFor(() => downloading(built), 'the steam-installing activity');
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { id: 'g1', requiresInstall: true } });
      await built.setSteamState('installed');
      await reached(built.journal, 'notify:game-installed');
      await waitFor(() => {
        const state = built.state.get();
        return state.kind === 'ready' && !state.game.requiresInstall;
      }, 'the game to flip to Play');
      await pause(100);
      expect(built.journal.filter((entry) => entry.startsWith('notify:'))).toEqual(['notify:game-installed']);
    });

    it('an update of an installed game reads as updating and finishes without a notification', async () => {
      h = await harness({ mode: 'steam' });
      const built = h;
      await built.setSteamState('downloading');
      await waitFor(() => built.activities.get('g1')?.kind === 'steam-updating', 'the steam-updating activity');
      await built.setSteamState('installed');
      await waitFor(() => !built.activities.has('g1'), 'the update to finish');
      await pause(100);
      expect(built.journal.filter((entry) => entry.startsWith('notify:'))).toEqual([]);
    });
  });

  describe('actions by id', () => {
    const pause = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

    /** Launches the plain 'other' game and waits until it runs: the session the actions happen beside. */
    async function runOther(built: Harness): Promise<void> {
      built.journal.length = 0;
      fire(IPC.actionSelect, 'other');
      await reached(built.journal, 'state:ready');
      await pause(30);
      fire(IPC.actionLaunch, 'other');
      await reached(built.journal, 'state:running');
      built.journal.length = 0;
    }

    const OTHER = [{ id: 'other', lastPlayedAt: '2026-10-01T00:00:00.000Z' }] as const;

    it('while another game runs, Install for an uninstalled game starts a background job and leaves the session alone', async () => {
      h = await harness({ mode: 'install', extraGames: OTHER });
      const built = h;
      await runOther(built);
      fire(IPC.actionLaunch, 'g1');
      await reached(built.journal, 'activity:g1:installing');
      await pause(30);
      expect(built.journal.filter((entry) => entry.startsWith('state:'))).toEqual([]);
      expect(built.state.get()).toMatchObject({ kind: 'running', game: { id: 'other' } });
    });

    it('two quick presses for the same game make one job', async () => {
      h = await harness({ mode: 'install', extraGames: OTHER });
      const built = h;
      await runOther(built);
      fire(IPC.actionLaunch, 'g1');
      fire(IPC.actionLaunch, 'g1');
      await reached(built.journal, 'activity:g1:installing');
      await pause(50);
      expect(built.journal.filter((entry) => entry === 'activity:g1:installing')).toHaveLength(1);
    });

    it('while another game runs, Play for an installed game does nothing at all', async () => {
      h = await harness({ mode: 'normal', extraGames: OTHER });
      const built = h;
      await runOther(built);
      fire(IPC.actionLaunch, 'g1');
      await pause(50);
      expect(built.journal).toEqual([]);
      expect(built.state.get()).toMatchObject({ kind: 'running', game: { id: 'other' } });
    });

    it("while another game runs, Uninstall works for that game and is refused for the session's own", async () => {
      h = await harness({ mode: 'install', extraGames: OTHER });
      const built = h;
      await fs.mkdir(path.join(built.tmp, 'installed'), { recursive: true });
      await fs.writeFile(path.join(built.tmp, 'installed', 'game.exe'), '');
      await built.controller.reloadPcLibrary();
      await runOther(built);
      fire(IPC.actionUninstall, 'other');
      fire(IPC.actionUninstall, 'g1');
      await reached(built.journal, 'notify:game-uninstalled');
      expect(built.journal.some((entry) => entry.startsWith('activity:other'))).toBe(false);
      expect(built.state.get()).toMatchObject({ kind: 'running', game: { id: 'other' } });
    });

    it('a game whose source is gone is refused', async () => {
      h = await harness({ mode: 'copy', copySource: 'card', extraGames: OTHER });
      const built = h;
      await runOther(built);
      fire(IPC.actionLaunch, 'g1');
      await pause(50);
      expect(built.journal).toEqual([]);
    });

    it("while another game runs, a Steam game's Install and Uninstall go to Steam and leave the state alone", async () => {
      h = await harness({ mode: 'steam', steamState: 'absent', extraGames: OTHER });
      const built = h;
      await runOther(built);
      fire(IPC.actionLaunch, 'g1');
      await waitFor(() => shell.opened.length > 0, 'the steam://install URI');
      expect(shell.opened).toEqual([`steam://install/${STEAM_APPID}`]);
      await built.setSteamState('installed');
      await waitFor(() => built.journal.includes('activity:g1:clear') || !built.activities.has('g1'), 'Steam to settle');
      fire(IPC.actionUninstall, 'g1');
      await waitFor(() => shell.opened.length > 1, 'the steam://uninstall URI');
      expect(shell.opened[1]).toBe(`steam://uninstall/${STEAM_APPID}`);
      await waitFor(() => built.activities.get('g1')?.kind === 'steam-uninstalling', 'the uninstalling activity');
      expect(built.journal.filter((entry) => entry.startsWith('state:'))).toEqual([]);
      expect(built.state.get()).toMatchObject({ kind: 'running', game: { id: 'other' } });
    });

    it('with the session free, an action for a game that is not selected selects it first', async () => {
      h = await harness({ mode: 'install', extraGames: OTHER });
      const built = h;
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { id: 'other' } });
      fire(IPC.actionLaunch, 'g1');
      await reached(built.journal, 'activity:g1:installing');
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { id: 'g1' } });
    });
  });

  describe('prefix cleanup', () => {
    it('success: a background job, Uninstall gone afterwards, no notification and no window', async () => {
      h = await harness({ mode: 'prefix-cleanup' });
      const built = h;
      expect(built.state.get()).toMatchObject({ kind: 'ready', game: { prefixCleanupOnly: true } });
      fire(IPC.actionUninstall);
      await waitFor(() => {
        const state = built.state.get();
        return state.kind === 'ready' && !state.game.canUninstall;
      }, 'Uninstall to disappear');
      expect(built.journal).toEqual(['activity:g1:uninstalling', 'activity:g1:clear', 'state:ready']);
    });

    it('a prefix that cannot be removed is reported as a failed uninstall', async () => {
      h = await harness({ mode: 'prefix-cleanup', sweepDir: unremovable(os.tmpdir()) });
      const built = h;
      fire(IPC.actionUninstall);
      await reached(built.journal, 'activity:g1:clear');
      expect(built.journal.filter((entry) => !entry.startsWith('state:'))).toEqual([
        'activity:g1:uninstalling',
        'notify:game-uninstall-failed',
        'activity:g1:clear',
      ]);
    });

    it('shutdown during the sweep stops the job silently', async () => {
      h = await harness({ mode: 'prefix-cleanup', sweepDir: unremovable(os.tmpdir()) });
      const built = h;
      fire(IPC.actionUninstall);
      await reached(built.journal, 'activity:g1:uninstalling');
      built.controller.shutdown();
      await reached(built.journal, 'activity:g1:clear');
      expect(built.journal.filter((entry) => !entry.startsWith('state:'))).toEqual([
        'activity:g1:uninstalling',
        'activity:g1:clear',
      ]);
    });
  });
});
