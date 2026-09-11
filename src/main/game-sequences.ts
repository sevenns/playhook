// The game's process lifecycle: the launch / install / uninstall / prefix-cleanup sequences, the Steam
// pair (fire-and-forget), the force-close, and the save sync around a session. Split out of
// GameController, which keeps the card session (insert / remove / collision) and DISPATCHES here from
// the renderer's actions; what the sequences need back from it (GameInfo, the ready transition, "is this
// game's source still there") comes through the SequenceHost seam. The save sync a session is bracketed
// with lives in save-sync-flow.ts.
//
// The four blocking sequences share one scaffold, `runSequence`: launchInFlight + an AbortController for
// the span, the entering state, the LaunchAbortedError guard (a card swap or shutdown unwinds silently),
// `failSequence` for anything else, and a finally that releases the owned process, clears the flags and
// replays a card that was swapped in mid-flight. Launch alone adds to the finally (the lock and the
// running-game fields) through `onFinally`.
import path from 'node:path';
import fse from 'fs-extra';
import { type AppState, type GameInfo, type Stats } from '../shared/types';
import type { ResolvedCopyInstall, ResolvedManifest } from './manifest-types';
import { type Translator } from '../shared/i18n/index';
import { type ControllerDeps } from './controller-deps';
import { findCaseInsensitiveName } from './manifest';
import { LaunchAbortedError } from './launch-errors';
import { openSteamUri } from './steam-uri';
import { type GameProcess, type Platform, type ProcessMonitor } from './platform';
import { normalizeImageNames } from './image-names';
import { type SteamInstallWatch } from './steam-install-watch';
import { type SaveSyncFlow } from './save-sync-flow';
import { removeWithRetry } from './uninstaller.win32';
import { describe, delay } from './util';
import { log } from './logger';

// Grace-poll cadence after the installer exits, waiting for the game executable to appear.
const INSTALL_POLL_INTERVAL_MS = 1000;

// Force-close verification: after issuing the kills, a `taskkill /F` (or TerminateProcess) returns
// BEFORE the process actually leaves tasklist — a killed process in teardown still shows for a beat, and
// a launcher/wrapper can take longer (the very reason the exit waiters debounce). So we don't judge on a
// single instant snapshot: poll the targets over a window bounded by the manifest's killTimeoutSec
// (default 60s), succeeding as soon as they're all gone, and only reporting killFailed if something is
// STILL alive when the window elapses (a genuine failure, e.g. an elevated handle without
// PROCESS_TERMINATE rights). The poll cadence between snapshots:
const KILL_VERIFY_INTERVAL_MS = 500;

// For a runAsAdmin (elevated) game, the non-elevated kill can't touch its high-integrity processes. We
// give that first attempt a short grace to prove itself (a normal game dies well within this), and only
// if the targets survive it do we escalate to an elevated taskkill (one UAC prompt). Kept short so the
// UAC prompt isn't needlessly delayed for a game that genuinely needs it.
const KILL_ELEVATE_GRACE_SEC = 3;

/** What the sequences need back from the controller: the card session's answers and its transitions. */
export interface SequenceHost {
  /** The single "active" manifest — the selected game (see GameController.current). */
  current(): ResolvedManifest | null;
  buildGameInfo(manifest: ResolvedManifest, stats: Stats): Promise<GameInfo>;
  /** The single entry point for the `ready` state. */
  enterReady(info: GameInfo): void;
  sourceAvailable(manifest: ResolvedManifest): boolean;
  currentSourceAvailable(): boolean;
  sourceAvailableFor(id: string): boolean;
  /** The "the card went away while we were busy" landing. */
  cardGoneAfterSequence(): void;
  browseToUnlessPinned(id: string): Promise<void>;
  refreshLibrary(): void;
  /** Caches a game's reconciled stats (the per-id cache behind the carousel order). */
  rememberStats(id: string, stats: Stats): void;
  /** Sends a transient error to the renderer to surface in the error popup. */
  sendError(message: string): void;
  /** Replays a card insertion that was deferred while a sequence was in flight. */
  onInsert(root: string): Promise<void>;
}

export type SequenceDeps = Pick<
  ControllerDeps,
  | 'state'
  | 'window'
  | 'stats'
  | 'store'
  | 'library'
  | 'settings'
  | 'notifications'
  | 'platform'
  | 'processControl'
  | 'getTranslator'
> & {
  readonly steamWatch: Pick<SteamInstallWatch, 'start' | 'stop' | 'requestUninstall'>;
  /** The card↔PC save sync the launch sequence brackets the game with. */
  readonly saveSync: Pick<SaveSyncFlow, 'resolvePcSavePath' | 'runSaveSync' | 'performSyncOut'>;
  readonly host: SequenceHost;
};

type SequencePhase = 'launch' | 'install' | 'uninstall';

/** The process a sequence spawned, if any — held by reference so the shared finally can dispose it. */
interface OwnedProcess {
  proc: GameProcess | null;
}

export class GameSequences {
  // True while a game is launching/running: main is "locked" on that game — a game switch is refused and
  // the carousel cannot enter another game's detail as actionable (its guard is `kind==='ready'`).
  private locked = false;
  private launchInFlight = false;
  private abort: AbortController | null = null;
  // A card swapped in WHILE a launch/install was in flight: DriveWatcher can swap without an
  // empty tick, so we stash the new root, abort the in-flight sequence, and replay onInsert from its
  // finally (after launchInFlight clears) — otherwise the aborted sequence could set state over the new card.
  private pendingRoot: string | null = null;
  // Image names (lower-case *.exe basenames) of the currently-running game, captured on entry to
  // `running` so a Play press in that state can find and raise the game's window (return-to-game). Null
  // whenever no game is running; reset in the launch sequence's finally. Matched by image name rather than
  // pid so it covers all backends uniformly, incl. elevated games a non-elevated tasklist can't see.
  private runningImageNames: readonly string[] | null = null;
  // The owned GameProcess of the currently-running game, kept so a force-close can terminate it directly:
  // the elevated HANDLE (invisible to taskkill) or the normal pid tree. A REFERENCE to the same object
  // disposed in the launch sequence's finally (the single owner) — set alongside runningImageNames on
  // entry to `running` (normal/elevated + watched branches; null for steam, which owns no process),
  // cleared in that same finally. Never disposed from here.
  private runningProc: GameProcess | null = null;
  // A force-close (onKillRequested) is underway. Local try/finally flag (mirrors reloadInFlight, NOT the
  // launch sequence's finally — a kill has its own short-lived lifecycle) so a double Yes / repeat is a no-op.
  private killInFlight = false;
  // The installing/launching state to restore once winetricks provisioning ends. Null when not
  // provisioning. The "Configuring Proton" screen + its rotating funny suffix are the renderer's job.
  private protonConfigPriorState: AppState | null = null;

  constructor(private readonly deps: SequenceDeps) {}

  private get host(): SequenceHost {
    return this.deps.host;
  }

  /** The current translator (a message is fixed at the language of the moment it is generated). */
  private get t(): Translator {
    return this.deps.getTranslator();
  }

  /** The platform process monitor (win32 tasklist / linux /proc), threaded into the launcher + waits. */
  private get monitor(): ProcessMonitor {
    return this.deps.platform.processMonitor;
  }

  /** The platform game launcher (win32 spawn/ShellExecuteEx / linux umu-run/Proton). */
  private get launcher(): Platform['gameLauncher'] {
    return this.deps.platform.gameLauncher;
  }

  // ── What the controller reads back ──────────────────────────────────────────

  /** True for the whole span of a blocking sequence (launch / install / uninstall / prefix cleanup). */
  get inFlight(): boolean {
    return this.launchInFlight;
  }

  /** True while main is locked on a launching/running game (a game switch is refused). */
  get isLocked(): boolean {
    return this.locked;
  }

  /** Releases the lock — the card session's own cleanup (a card cleared or re-read) does this too. */
  unlock(): void {
    this.locked = false;
  }

  /** Image names of the running game for return-to-game; null whenever no game is running. */
  get runningGameImageNames(): readonly string[] | null {
    return this.runningImageNames;
  }

  /**
   * A card was swapped in mid-flight: stash its root and abort the running sequence; the finally replays
   * the insertion once the sequence has unwound.
   */
  deferInsert(root: string): void {
    this.pendingRoot = root;
    this.abort?.abort();
  }

  /** Aborts whatever sequence is in flight (application exit). */
  abortInFlight(): void {
    this.abort?.abort();
  }

  // ── Provisioning + liveness helpers ─────────────────────────────────────

  /**
   * Linux prefix provisioning (winetricks) started/finished — the launcher's onProvisioning callback
   * On start: stash the current installing/launching state and show the rotating "Configuring
   * Proton" screen. On finish: stop the rotation and restore the stashed state (the launch/install
   * sequence then continues from where it was). No-op on win32 (the launcher never fires this).
   */
  private setProvisioning(active: boolean, game: GameInfo): void {
    if (active) {
      this.protonConfigPriorState = this.deps.state.get();
      this.deps.state.set({ kind: 'configuringProton', game });
    } else if (this.protonConfigPriorState !== null) {
      this.deps.state.set(this.protonConfigPriorState);
      this.protonConfigPriorState = null;
    }
  }

  /** True if any of the given image names is currently running (fresh snapshot; empty list → false). */
  private async anyTargetAlive(targets: readonly string[]): Promise<boolean> {
    if (targets.length === 0) return false;
    const snapshot = await this.monitor.snapshot();
    return targets.some((name) => snapshot.hasImageName(name));
  }

  // ── Force-close ─────────────────────────────────────────────────────────────

  /**
   * Force-close the running game (More → Force close → confirmed Yes). Flips the running snapshot into its
   * `killing` sub-state (the launcher shows "Force closing…" and hides the Force close button), kills the
   * main executable AND every watchProcess, then lets the EXISTING exit waiters (waitForExit /
   * waitForWatchedExit) notice the processes vanish and carry the flow through syncing-out → sync → ready
   * — no state machine of its own. Guarded by the running state + a killInFlight flag (double Yes /
   * repeat is a no-op).
   *
   * A non-elevated launcher can't terminate a runAsAdmin game's high-integrity processes (taskkill →
   * ACCESS_DENIED, the ShellExecuteEx HANDLE lacks PROCESS_TERMINATE). So for a runAsAdmin game, if the
   * targets survive a short grace, we escalate to ONE elevated `taskkill /F /T /IM …` (a single UAC
   * prompt). Non-elevated games never trigger UAC.
   *
   * Success is judged by FACT, not command exit codes: a "not found" from taskkill just means the target
   * is already dead (success). After the kills we verify over a WINDOW bounded by killTimeoutSec (a killed
   * process lingers in tasklist for a beat, so a single instant snapshot would false-positive): success as
   * soon as the targets are gone (the `killing` indicator stays until an exit waiter advances the flow).
   * If something is still alive when the window elapses, we DROP back to plain running (the game is still
   * up) and surface a soft errors.killFailed.
   */
  async onKillRequested(): Promise<void> {
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'running') return; // only meaningful while a game is running
    if (this.killInFlight) return; // a force-close is already underway (double Yes / repeat)
    const manifest = this.host.current();
    if (manifest === null) return; // defensive: `running` always has a current manifest
    this.killInFlight = true;
    // Show "Force closing…" and hide the Force close button immediately (cleared back on failure).
    this.deps.state.set({ ...snapshot, killing: true });
    try {
      // Steam mode is tracked/killed by SteamAppId (native + Proton games), with no owned pid and no
      // elevation (the schema forbids runAsAdmin there). Every other mode kills the owned process + the
      // target image names, escalating to an elevated taskkill for a runAsAdmin game. Both end in the same
      // fact-based verdict below (stillAlive).
      let stillAlive: boolean;
      if (manifest.steam !== undefined) {
        const appid = manifest.steam.appid;
        const names = manifest.raw.watchProcesses ?? [];
        log.info(`[kill] force-close requested id=${manifest.raw.id} steam appid=${appid}`);
        await this.monitor.killSteamGame(appid, names);
        stillAlive = await this.steamGameStillAlive(appid, names, manifest.raw.killTimeoutSec);
      } else {
        // Targets are computed HERE from this.current, leaving runningImageNames untouched: a union there
        // would regress return-to-game (focusGameWindow picks the first Z-order match — the launcher name
        // could steal focus from the game).
        const targets = normalizeImageNames([
          manifest.executablePath,
          ...(manifest.raw.watchProcesses ?? []),
        ]);
        log.info(`[kill] force-close requested id=${manifest.raw.id} targets=[${targets.join(',')}]`);

        // 1. Terminate the owned process (elevated HANDLE, or the normal pid tree with an isAlive re-check
        //    inside kill()). In the watched path this is usually the already-dead launcher — its "not
        //    found" is normal, not an error.
        const proc = this.runningProc;
        if (proc !== null) {
          try {
            await proc.kill();
          } catch (cause) {
            log.warn('[kill] owned-process kill failed (continuing to kill by name):', describe(cause));
          }
        }

        // 2. Kill each target image by name (non-elevated): win32 `taskkill /F /IM`, linux SIGTERM/SIGKILL
        //    to every /proc match. Failures are normal ("not found" = already dead).
        await this.monitor.killByName(targets);

        // 2b. Elevated escalation (runAsAdmin games only). A non-elevated taskkill / the ShellExecuteEx
        //     HANDLE can't terminate high-integrity processes, so if the targets survive a short grace we
        //     run ONE elevated `taskkill /F /T /IM …` (a single UAC prompt). Non-elevated games never reach
        //     here (no UAC for them). A declined UAC just leaves the targets up → killFailed below.
        if (manifest.raw.runAsAdmin && (await this.killTargetsStillAlive(targets, proc, KILL_ELEVATE_GRACE_SEC))) {
          log.info(`[kill] elevated game survived non-elevated kill id=${manifest.raw.id} — escalating to elevated taskkill (UAC)`);
          this.monitor.killImagesElevated(targets);
        }

        // 3. Fact-based verdict over a window bounded by killTimeoutSec (a killed process lingers for a
        //    beat — a single instant snapshot would false-positive).
        stillAlive = await this.killTargetsStillAlive(targets, proc, manifest.raw.killTimeoutSec);
      }

      // killFailed only if something is STILL alive when the window elapsed.
      if (stillAlive) {
        log.warn(`[kill] targets still alive after force-close id=${manifest.raw.id} — reporting killFailed`);
        // The game is still up → back to plain running (status "Running…", Force close button returns),
        // then surface the error. Re-read in case a waiter advanced the state (then leave it be).
        const current = this.deps.state.get();
        if (current.kind === 'running') this.deps.state.set({ ...current, killing: false });
        this.host.sendError(this.t('errors.killFailed'));
      } else {
        log.info(`[kill] force-close done id=${manifest.raw.id} — exit waiters will finish the flow`);
      }
    } finally {
      this.killInFlight = false;
    }
  }

  /**
   * Polls the kill targets for up to `timeoutSec`, returning false (success — everything is gone) as soon
   * as no target image is present AND the owned process (elevated HANDLE / normal pid) is dead, OR once an
   * exit waiter has already advanced the state out of `running` (it saw the exit → definitely killed).
   * Returns true only if something is still alive when the window elapses — a genuine failure.
   */
  private async killTargetsStillAlive(
    targets: readonly string[],
    proc: GameProcess | null,
    timeoutSec: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      // An exit waiter that already left `running` proves the process is gone — treat as killed.
      if (this.deps.state.get().kind !== 'running') return false;
      const ownedAlive = proc !== null && (await proc.isAlive());
      if (!ownedAlive && !(await this.anyTargetAlive(targets))) return false;
      if (Date.now() >= deadline) return true; // window elapsed and something is still alive → real fail
      await delay(KILL_VERIFY_INTERVAL_MS);
    }
  }

  /**
   * Steam-mode analogue of killTargetsStillAlive: polls the monitor's SteamAppId signal (linux) / watch
   * names (win32) until the game is gone or the window elapses. Returns true only if it is STILL running.
   */
  private async steamGameStillAlive(
    appid: number,
    watchNames: readonly string[],
    timeoutSec: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      if (this.deps.state.get().kind !== 'running') return false; // an exit waiter already left `running`
      if (!(await this.monitor.isSteamGameRunning(appid, watchNames))) return false;
      if (Date.now() >= deadline) return true;
      await delay(KILL_VERIFY_INTERVAL_MS);
    }
  }

  // ── Steam (fire-and-forget: Steam runs the download / removal itself) ───────

  /**
   * Steam install action: fire-and-forget. Opens `steam://install/<appid>` (Steam shows its own dialog
   * and the download — possibly hours/GBs) and returns WITHOUT entering a blocking `installing` state.
   * We stay on the `ready` ("Install") screen; the background re-detect poller (started by enterReady)
   * flips the button to "Play" once Steam's .acf reports the game fully installed. Steam itself collapses
   * repeated `steam://install` calls, so no debounce is needed. Pre-checks `steamLocator.locateSteam()`: openExternal
   * doesn't reliably reject when steam:// is unregistered.
   */
  async runSteamInstall(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const appid = manifest.steam?.appid;
    if (appid === undefined) return; // defensive: onLaunchRequested only calls this in steam mode
    if ((await this.deps.platform.steamLocator.locateSteam()) === null) {
      this.host.sendError(this.t('errors.steamNotInstalled'));
      return;
    }
    try {
      await openSteamUri(`steam://install/${appid}`);
      log.info(`[steam-install] opened steam://install/${appid} id=${manifest.raw.id}`);
    } catch (cause) {
      this.host.sendError(this.t('errors.steamOpenInstall', { cause: describe(cause) }));
      return;
    }
    // Ensure the re-detect poller is running so the button flips to "Play" when the download completes
    // (no-op if already running; info confirms this is a steam game still requiring install).
    if (info.installVia === 'steam' && info.requiresInstall && this.host.sourceAvailableFor(info.id)) {
      this.deps.steamWatch.start();
    }
  }

  /**
   * Steam uninstall action: fire-and-forget, mirroring runSteamInstall. Opens `steam://uninstall/<appid>`
   * (Steam shows its own confirmation/removal UI) and returns WITHOUT a blocking `uninstalling` state. We
   * stay on the `ready` ("Play"/"Uninstall") screen; the background poller flips the button back to
   * "Install" once Steam removes the .acf. Pre-checks `steamLocator.locateSteam()`.
   */
  async runSteamUninstall(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const appid = manifest.steam?.appid;
    if (appid === undefined) return; // defensive: onUninstallRequested only calls this in steam mode
    if ((await this.deps.platform.steamLocator.locateSteam()) === null) {
      this.host.sendError(this.t('errors.steamNotInstalled'));
      return;
    }
    try {
      await openSteamUri(`steam://uninstall/${appid}`);
      log.info(`[steam-uninstall] opened steam://uninstall/${appid} id=${manifest.raw.id}`);
    } catch (cause) {
      this.host.sendError(this.t('errors.steamOpenUninstall', { cause: describe(cause) }));
      return;
    }
    // Optimistically show "Uninstalling…": record the request and flip the UI. The poller clears it when
    // the .acf is gone (→ Install) or on timeout (assumed cancel → back to Play/Uninstall). enterReady
    // (re)arms the poller for the inserted steam card.
    this.deps.steamWatch.requestUninstall(appid);
    this.host.enterReady({ ...info, steamUninstalling: true, canUninstall: false });
  }

  // ── The blocking sequences ──────────────────────────────────────────────────

  /**
   * The scaffold every blocking sequence runs inside. Sets launchInFlight and the AbortController for
   * the span, enters `entering` for the game, then runs `body`. A LaunchAbortedError (a card swap or
   * shutdown) unwinds silently; any other error is a `failSequence` for `phase`. The finally releases the
   * process `body` handed into `owned`, clears the flags, runs `onFinally` (launch's running-game
   * fields), and last replays a card that was swapped in mid-flight, now that launchInFlight has cleared.
   */
  private async runSequence(
    phase: SequencePhase,
    entering: 'syncing-in' | 'installing' | 'uninstalling',
    info: GameInfo,
    body: (abort: AbortController, owned: OwnedProcess) => Promise<void>,
    onFinally?: () => void,
  ): Promise<void> {
    this.launchInFlight = true;
    const abort = new AbortController();
    this.abort = abort;
    const owned: OwnedProcess = { proc: null };
    try {
      this.deps.state.set({ kind: entering, game: info });
      await body(abort, owned);
    } catch (cause) {
      if (cause instanceof LaunchAbortedError) return; // aborted by shutdown or a card swap
      this.failSequence(phase, info, describe(cause));
    } finally {
      // Release the elevated HANDLE (no-op for the normal spawn path).
      owned.proc?.dispose();
      this.launchInFlight = false;
      this.abort = null;
      onFinally?.();
      // Replay a card that was swapped in mid-flight, now that launchInFlight has cleared.
      this.resumePendingInsert();
    }
  }

  /**
   * Clears a normal executable game's Wine prefix (Linux). No installer/uninstaller is involved — the game
   * lives on the card, its only PC footprint is the prefix — so this is just the directory sweep + the same
   * card-swap / rebuild-info handling as runUninstallSequence, minus the uninstaller run.
   */
  async runPrefixCleanupSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const dir = await this.deps.platform.gameLauncher.prefixCleanupDir(manifest.raw.id);
    if (dir === null) return; // defensive: canUninstall was set only when the prefix existed
    const { window, stats } = this.deps;
    await this.runSequence('uninstall', 'uninstalling', info, async (abort) => {
      await removeWithRetry(dir, abort.signal);
      if (abort.signal.aborted) return;
      // Card yanked mid-cleanup (this targets the PC, so it completed): idle + hide, like runUninstall.
      // A local game's source cannot go away, so it always continues to the rebuild below.
      if (!this.host.sourceAvailable(manifest)) {
        this.host.cardGoneAfterSequence();
        return;
      }
      // Prefix gone → prefixCleanupDir now returns null → canUninstall recomputes false → "Uninstall"
      // disappears, leaving just "Play".
      const currentStats = await stats.read(manifest.raw.id);
      const updatedInfo = await this.host.buildGameInfo(manifest, currentStats);
      log.info(`[prefix-cleanup] removed "${dir}" id=${manifest.raw.id}`);
      this.host.enterReady(updatedInfo);
      window.showAndFocus();
    });
  }

  async runLaunchSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const { state, window, stats } = this.deps;
    // Lock the launcher on this game for the launching→running span: a game switch is refused and the
    // switching the card's game is refused. Cleared in the finally alongside the other running-scoped fields.
    this.locked = true;
    await this.runSequence(
      'launch',
      'syncing-in',
      info,
      async (abort, owned) => {
        // 1. Change-based sync before the game (phase = sync-in). No longer a blind card→PC: if the PC
        // saves changed since the last sync (e.g. played on another PC last, or this PC is newer) they are
        // NOT overwritten — the changed side wins (see save-sync change-detection). The old card→PC is only
        // the first-run fallback (no baseline yet).
        if (manifest.pcSavePath !== undefined && manifest.saveOnCardPath !== undefined) {
          // Resolve the deferred pcSavePath to this game's save location. null → nothing to sync
          // with at all (a steam game with no compatdata) — a logged no-op.
          const pcSave = await this.deps.saveSync.resolvePcSavePath(manifest);
          if (pcSave === null) {
            log.info(
              `[sync-in] pcSavePath "${manifest.pcSavePath}" not resolvable yet — skipping sync`,
            );
          } else {
            // A MISSING prefix is not a reason to skip: the launch below creates it, and the card's saves
            // must be in place before the game reads them (e.g. after an uninstall wiped the prefix). The
            // copy targets the prefix path directly — launchGame ensureDir's that prefix anyway — and
            // runSaveSync drops the stale baseline so the empty PC side can't erase the card.
            try {
              log.info(
                `[sync-in] change-based sync between card "${manifest.saveOnCardPath}" and PC "${pcSave.path}"${pcSave.containerExists ? '' : ' (prefix absent — restoring from card)'}`,
              );
              // Soft catch: sync-in can now WRITE to the card (change-detection may pick PC→card) — a new
              // failure point BEFORE launch (a full / write-protected / slow card). The launch never depended
              // on a card write before, so keep it that way: log and start the game regardless (mirrors sync-out).
              await this.deps.saveSync.runSaveSync(
                manifest,
                manifest.saveOnCardPath,
                pcSave.path,
                'card-to-pc',
                pcSave.containerExists,
              );
            } catch (cause) {
              log.warn('[sync-in] change-based sync failed, launching anyway:', describe(cause));
            }
          }
        }

        // 2/3/4. launch, then wait for the game to appear and to exit. THREE backends:
        //  - steam: open steam://rungameid (no proc of ours); wait by watched names only (launcherPid=null).
        //  - watched (launcher/wrapper, manifest.watchProcesses): the game is a SEPARATE process; we wait
        //    for one of the watched image names to appear (HANDOFF — the launcher may live on in its menu),
        //    then track that process's presence for exit.
        //  - normal: the spawned pid IS the game; wait for that pid to appear, then disappear.
        // Running-phase note (all paths): gamepad input is ignored (outside ready). The window stays put —
        // the game takes the foreground on its own and simply covers the launcher, which avoids the jerky
        // hide/show flash. We grab the foreground back in step 6 once the game exits. The global Start+Back
        // hotkey is intentionally a no-op while running, so there's nothing to re-summon.
        const watchProcesses = manifest.raw.watchProcesses;
        let since: number;
        if (manifest.steam !== undefined) {
          state.set({ kind: 'launching', game: info });
          // Pre-check: openExternal doesn't reliably reject when steam:// is unregistered, so gate the
          // launch on Steam actually being installed instead of relying on a reject.
          if ((await this.deps.platform.steamLocator.locateSteam()) === null) {
            this.failSequence('launch', info, this.t('errors.steamNotInstalled'));
            return;
          }
          try {
            await openSteamUri(`steam://rungameid/${manifest.steam.appid}`);
          } catch (cause) {
            this.failSequence('launch', info, this.t('errors.launchViaSteam', { cause: describe(cause) }));
            return;
          }
          // Track by SteamAppId (via the monitor): on linux that reads /proc environ, so native-Linux AND
          // Proton games are detected regardless of their binary name; on win32 it maps to the watch names.
          const { started } = await this.deps.processControl.waitForSteamStart(
            manifest.steam.appid,
            watchProcesses ?? [],
            manifest.raw.launchTimeoutSec,
            this.monitor,
            abort.signal,
          );
          if (!started) {
            // Known MVP limitation: a Steam cold-start or an auto-update before launch may not fit
            // launchTimeoutSec → the game-process never appears in the window. We can't tell that apart
            // from "didn't start", so we return quietly (recommend a larger launchTimeoutSec).
            log.info(
              `[launch] steam game never appeared within ${manifest.raw.launchTimeoutSec}s id=${manifest.raw.id} (cold-start/update?)`,
            );
            this.abandonWatchedLaunch(info);
            return;
          }
          since = Date.now();
          this.runningImageNames = normalizeImageNames(watchProcesses ?? []);
          // Steam owns no process of ours (steam://rungameid returns instantly) — a force-close relies on
          // taskkill /IM over the watchProcesses alone.
          this.runningProc = null;
          state.set({ kind: 'running', game: info, since });
          log.info(`[launch] running (steam) id=${manifest.raw.id} appid=${manifest.steam.appid}`);
          await this.deps.processControl.waitForSteamExit(manifest.steam.appid, watchProcesses ?? [], this.monitor, abort.signal);
          log.info(`[launch] exited (steam) id=${manifest.raw.id}`);
        } else {
          // 2. launch → GameProcess (spawn, or elevated ShellExecuteEx per manifest.runAsAdmin)
          state.set({ kind: 'launching', game: info });
          let proc: GameProcess;
          try {
            proc = await this.launcher.launchGame(manifest, (active) => this.setProvisioning(active, info));
          } catch (cause) {
            this.failSequence('launch', info, this.t('errors.launchGame', { cause: describe(cause) }));
            return;
          }
          // Handed to the scaffold so `finally` can dispose the kept HANDLE (elevated path).
          owned.proc = proc;
          if (watchProcesses !== undefined && watchProcesses.length > 0) {
            const { started } = await this.deps.processControl.waitForWatchedStart(
              proc.pid,
              watchProcesses,
              manifest.raw.launchTimeoutSec,
              this.monitor,
              abort.signal,
            );
            if (!started) {
              // The user closed the launcher without playing, or the game never became visible (often an
              // elevated/anticheat launcher — see README). Neither a failure nor a play session.
              this.abandonWatchedLaunch(info);
              return;
            }
            // The watched game is up: start the clock now (more accurate than the launcher's spawn time).
            since = Date.now();
            this.runningImageNames = normalizeImageNames(watchProcesses);
            // The spawned launcher (proc) — usually already dead here; kept so a force-close can also take
            // down its pid tree. The game itself is killed by taskkill /IM over the watchProcesses.
            this.runningProc = proc;
            state.set({ kind: 'running', game: info, since });
            log.info(`[launch] running (watched) id=${manifest.raw.id} watch=${watchProcesses.join(',')}`);
            await this.deps.processControl.waitForWatchedExit(watchProcesses, this.monitor, abort.signal);
            log.info(`[launch] exited (watched) id=${manifest.raw.id}`);
          } else {
            const started = await this.deps.processControl.waitForStart(proc, manifest.raw.launchTimeoutSec, abort.signal);
            if (!started) {
              this.failSequence('launch', info, this.t('errors.gameDidNotStart'));
              return;
            }
            since = Date.now();
            // normal AND elevated share this branch (differing only by manifest.raw.runAsAdmin): the game
            // IS the spawned exe, so its image name is the executable's basename.
            this.runningImageNames = normalizeImageNames([manifest.executablePath]);
            // The game process itself — a force-close terminates it directly (elevated: via the HANDLE
            // invisible to taskkill; normal: its pid tree with an isAlive re-check inside kill()).
            this.runningProc = proc;
            state.set({ kind: 'running', game: info, since });
            log.info(`[launch] running id=${manifest.raw.id} pid=${proc.pid}`);
            await this.deps.processControl.waitForExit(proc, abort.signal);
            log.info(`[launch] exited id=${manifest.raw.id} pid=${proc.pid}`);
          }
        }

        // 5. game closed → write stats to the PC (source of truth)
        const playSeconds = (Date.now() - since) / 1000;
        const updatedStats = await stats.recordPlay(manifest.raw.id, playSeconds);
        const updatedInfo = await this.host.buildGameInfo(manifest, updatedStats);
        // The history's cached stats follow the authority, and the game may have just EARNED its place in
        // the carousel (an inserted-but-never-played game is not listed until now).
        await this.deps.library.noteLaunch(manifest.raw.id, updatedStats);
        // Before the refresh, not after: the card's own games are ordered by these very dates, and this
        // game has just become the most recently played one.
        this.host.rememberStats(manifest.raw.id, updatedStats);
        this.host.refreshLibrary();

        // 6. PC→SD + stats copy (or pending-flush, if the card is already gone). The game just exited,
        // so reclaim the foreground (forceForeground) to surface the launcher over Steam/desktop.
        state.set({ kind: 'syncing-out', game: updatedInfo });
        window.showAndFocus(true);
        await this.deps.saveSync.performSyncOut(manifest, updatedStats);

        // 7. done
        this.host.enterReady(updatedInfo);
        // Refresh what's on screen too: the play time / launch count the detail screen shows just changed.
        await this.host.browseToUnlessPinned(manifest.raw.id);
        window.showAndFocus();
      },
      () => {
        // The game is done → unlock (switching the card's game is allowed again).
        this.locked = false;
        // The game is no longer running → forget its image names (return-to-game only applies while running).
        this.runningImageNames = null;
        // Drop the owned-process reference (proc.dispose() in the scaffold is the single owner-side release;
        // this is just the reference the force-close used while running).
        this.runningProc = null;
      },
    );
  }

  /**
   * Runs the installer for an install-mode game that isn't installed yet (mirrors runLaunchSequence's
   * infrastructure: launchInFlight/abort, the LaunchAbortedError guard, the pendingRoot replay).
   * Pre-cleans the install dir, runs the installer silently, then grace-polls for the executable —
   * on success the button becomes "Play"; otherwise we stay on "Install" and surface the reason.
   */
  async runInstallSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const install = manifest.install;
    if (install === undefined) return; // defensive: onLaunchRequested only calls this in install mode
    const { window, stats } = this.deps;
    await this.runSequence('install', 'installing', info, async (abort, owned) => {
      // Pre-clean: a partial install left by a previous failed attempt could carry a stale <exe> →
      // a bogus "Play". We're (re)installing anyway, so a clean directory is safe.
      await fse.remove(install.dir);

      if (install.type === 'copy') {
        // "Move game to PC": no installer to run — copy the card's game directory into the install dir.
        if (!(await this.runCopyInstall(install, manifest, info, abort))) return;
      } else {
        // Silent by default; a user who enabled "disable silent installer mode" gets the visible wizard
        // (needed for repacks that skip a crack/patch step under silent — `skipifsilent`).
        const silent = !(await this.deps.settings.read()).disableSilentInstall;
        let proc: GameProcess;
        try {
          proc = await this.launcher.launchInstaller(install, silent, (active) =>
            this.setProvisioning(active, info),
          );
        } catch (cause) {
          this.failSequence('install', info, this.t('errors.startInstaller', { cause: describe(cause) }));
          return;
        }
        owned.proc = proc;

        // Wait for the installer to exit, then grace-poll for the executable: some installers (often
        // custom wrappers) fork a child and exit early, so <exe> may appear shortly AFTER waitForExit.
        await this.deps.processControl.waitForExit(proc, abort.signal);
        const installed = await this.pollForExecutable(
          manifest.executablePath,
          manifest.raw.launchTimeoutSec,
          abort.signal,
        );
        if (!installed) {
          this.failSequence('install', info, this.t('errors.installIncomplete'));
          return;
        }
      }

      // Installed: rebuild GameInfo so requiresInstall recomputes to false (the executable now exists),
      // flipping the button back to "Play". The next press launches normally from the install dir.
      const currentStats = await stats.read(manifest.raw.id);
      const installedInfo = await this.host.buildGameInfo(manifest, currentStats);
      log.info(`[install] completed id=${manifest.raw.id} dir="${install.dir}"`);
      this.host.enterReady(installedInfo);
      // The "install finished" cue belongs to the notification now (its own `notify` sound). It used to
      // be a bare "play" sound pushed straight to the renderer from here — two sounds would now land on
      // the same moment, and that one also chirped from a hidden window while a game was running.
      this.deps.notifications.notify({
        kind: 'game-installed',
        gameId: manifest.raw.id,
        gameTitle: installedInfo.title,
      });
      window.showAndFocus();
    });
  }

  /**
   * The `copy` install type ("move game to PC"): instead of running an installer, copy the game
   * directory from the card into the app-controlled install dir. Called by runInstallSequence, which
   * owns the state/abort infrastructure and the shared tail — this only covers copy's own steps.
   *
   * Returns true when the game is in place and the caller should finish the sequence; false when it must
   * stop (a failure was already surfaced, or the sequence was aborted and must unwind silently).
   */
  private async runCopyInstall(
    install: ResolvedCopyInstall,
    manifest: ResolvedManifest,
    info: GameInfo,
    abort: AbortController,
  ): Promise<boolean> {
    // Prepare the destination's environment BEFORE the files land in it (linux: create + provision the
    // Wine prefix; win32: no-op). This is what launchInstaller does implicitly on the installer path —
    // without it a copied game would sit in a bare prefix with none of the baseline runtimes that the
    // installer it originally came from would have pulled in. A failure here propagates to the caller's
    // catch (it is an environment fault, like a failed installer launch).
    await this.launcher.prepareInstallDir(install, (active) => this.setProvisioning(active, info));

    try {
      // `dereference: false` — copy symlinks as symlinks (a game's own internal links stay internal).
      await fse.copy(install.installerPath, install.dir, { dereference: false });
    } catch (cause) {
      // fse.copy takes no AbortSignal, so a card swap mid-copy surfaces as a plain ENOENT (the source
      // vanished) rather than a LaunchAbortedError. Check the flag before reporting: the new card is
      // already on screen, and an error popup about the old one over it would be nonsense.
      if (abort.signal.aborted) return false;
      this.failSequence('install', info, this.t('errors.copyGameFailed', { cause: describe(cause) }));
      return false;
    }

    // Same reason as in runUninstallSequence: the copy itself isn't interruptible, so check the abort
    // flag manually before touching any state.
    if (abort.signal.aborted) return false;

    // A single existence check, not pollForExecutable: the grace-poll exists for installers that fork a
    // child and exit early, whereas fse.copy is done when it resolves. Polling would only add
    // launchTimeoutSec of waiting on an already-known-bad path.
    if (!(await fse.pathExists(manifest.executablePath))) {
      // The usual cause is a wrong source root: `executable` is card-relative in the form, but here it
      // resolves inside the copied directory. Second most likely on linux: a Windows-authored card whose
      // exe case doesn't match the files copied onto a case-sensitive FS — say so instead of "not found".
      const shown = manifest.raw.executable ?? path.basename(manifest.executablePath);
      const found = await findCaseInsensitiveName(manifest.executablePath);
      this.failSequence(
        'install',
        info,
        found !== null
          ? this.t('errors.copyExeNotFoundCase', { path: shown, found })
          : this.t('errors.copyExeNotFound', { path: shown }),
      );
      return false;
    }

    log.info(
      `[install] copied id=${manifest.raw.id} from="${install.installerPath}" to="${install.dir}"`,
    );
    return true;
  }

  /**
   * Polls for the game executable to appear within `timeoutSec` (grace window after the installer
   * exits). Throws LaunchAbortedError if aborted, so a mid-install card swap unwinds WITHOUT
   * setting state over the new card — never returns false on abort.
   */
  private async pollForExecutable(
    executablePath: string,
    timeoutSec: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      if (signal.aborted) throw new LaunchAbortedError();
      if (await fse.pathExists(executablePath)) return true;
      if (Date.now() >= deadline) return false;
      await delay(INSTALL_POLL_INTERVAL_MS);
    }
  }

  /**
   * Uninstalls an installed install-mode game (mirrors runInstallSequence's infrastructure:
   * launchInFlight/abort, the LaunchAbortedError guard, the pendingRoot replay). Runs the game's own
   * uninstaller (best-effort — it cleans the registry/shortcuts), then ALWAYS sweeps the app-controlled
   * install dir, so on success the executable is gone → requiresInstall recomputes true → "Install".
   */
  async runUninstallSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const install = manifest.install;
    if (install === undefined) return; // defensive: onUninstallRequested only calls this in install mode
    const { window, stats } = this.deps;
    await this.runSequence('uninstall', 'uninstalling', info, async (abort, owned) => {
      // Run the game's own uninstaller if we can resolve one (FS search → registry fallback). Any
      // launch/wait failure is NON-fatal: we log it and fall through to the directory sweep. Only a
      // LaunchAbortedError (from waitForExit on a card swap) propagates to unwind cleanly.
      //
      // `copy` is skipped entirely: nothing was installed, so there is no uninstaller of OURS to run.
      // A copied game directory is one that was installed on some OTHER machine, so any `unins*.exe`
      // inside it belongs to that install — running it would clean a foreign registry and might pop a
      // wizard. Straight to the sweep instead (which is the whole uninstall for copy).
      if (install.type !== 'copy') {
        const target = await this.launcher.resolveUninstaller(install);
        if (target !== null) {
          try {
            const proc = await this.launcher.launchUninstaller(target);
            owned.proc = proc;
            await this.deps.processControl.waitForExit(proc, abort.signal);
          } catch (cause) {
            if (cause instanceof LaunchAbortedError) throw cause;
            log.warn(`[uninstall] uninstaller failed, continuing to cleanup: ${describe(cause)}`);
          }
        }
      }

      // Sweep the platform's uninstall target — after the uninstaller, and as the fallback when no target
      // was resolved (custom / nothing found). win32: the install dir. linux: the whole per-game Wine
      // prefix (game files + provisioned runtimes), so the full disk footprint is reclaimed.
      const uninstallDir = this.launcher.uninstallDir(install);
      await removeWithRetry(uninstallDir, abort.signal);

      // fse.remove is NOT interrupted by the signal (unlike waitForExit), so check the abort flag
      // manually — strictly BEFORE reading cardPresent / rebuilding info — so a mid-uninstall card swap
      // doesn't set state over the new card (the finally → resumePendingInsert handles it).
      if (abort.signal.aborted) return;

      // The card may have been yanked during the uninstall (it targets the PC, so it completed): no card
      // → idle + hide, mirroring abandonWatchedLaunch / onRemove's cleanup.
      if (!this.host.sourceAvailable(manifest)) {
        this.host.cardGoneAfterSequence();
        return;
      }

      // Done: rebuild GameInfo so requiresInstall recomputes true and canUninstall false (the executable
      // is gone) → the button flips back to "Install" and "Uninstall" disappears.
      const currentStats = await stats.read(manifest.raw.id);
      const updatedInfo = await this.host.buildGameInfo(manifest, currentStats);
      log.info(`[uninstall] completed id=${manifest.raw.id} removed="${uninstallDir}"`);
      this.host.enterReady(updatedInfo);
      this.deps.notifications.notify({
        kind: 'game-uninstalled',
        gameId: manifest.raw.id,
        gameTitle: updatedInfo.title,
      });
      window.showAndFocus();
    });
  }

  /** Replays a card insertion deferred during an in-flight launch/install. No-op if none pending. */
  private resumePendingInsert(): void {
    const root = this.pendingRoot;
    if (root === null) return;
    this.pendingRoot = null;
    void this.host.onInsert(root);
  }

  /**
   * A launch/install/uninstall attempt failed: return to the 'ready' screen with the SAME info and
   * surface the reason in the error popup. The info is unchanged, so the flags recompute to the pre-attempt
   * button (launch → "Play", failed install → still "Install", failed uninstall → still "Uninstall"); the
   * user can read the error, close it (B / veil) and retry. Only the log prefix differs per phase.
   */
  private failSequence(phase: 'launch' | 'install' | 'uninstall', game: GameInfo, message: string): void {
    log.warn(`[${phase}] failed: ${message}`);
    this.host.enterReady(game);
    this.deps.window.showAndFocus();
    this.host.sendError(message);
  }

  /**
   * The watched-launcher path ended without the game ever becoming visible: the user closed the launcher
   * without playing, or the game runs elevated / as a service and `tasklist` can't see it. This is
   * neither a failure nor a play session — we do NOT call stats.recordPlay (it would bump launchCount and
   * lastPlayedAt for a 0s session) and we do NOT surface an error popup. Back to the normal screen; if the
   * card is already gone, go idle and hide, mirroring onRemove's cleanup.
   */
  private abandonWatchedLaunch(game: GameInfo): void {
    log.info('[launch] watched game never appeared — returning without recording a session');
    if (!this.host.currentSourceAvailable()) {
      this.deps.steamWatch.stop();
      this.host.cardGoneAfterSequence();
      return;
    }
    this.host.enterReady(game);
    this.deps.window.showAndFocus();
  }
}
