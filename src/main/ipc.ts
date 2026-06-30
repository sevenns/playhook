// Flow orchestrator + IPC registration (stages 5/10).
// This is where the state machine lives: the controller listens to drive-watcher, reacts to
// the "Launch" action from the renderer, runs the sequence sync→spawn→wait→sync
// and replicates AppState to the window. All FS/process work happens only here (in main).
import path from 'node:path';
import fse from 'fs-extra';
import { app, ipcMain } from 'electron';
import {
  IPC,
  type AppState,
  type AudioAssets,
  type GameInfo,
  type InstallManifest,
  type LaunchTarget,
  type ResolvedManifest,
  type SfxName,
  type Stats,
} from '../shared/types';
import { type StateManager } from './state';
import { type GameWindow } from './window';
import { type PcStore } from './pc-store';
import { type StatsService } from './stats';
import { type DriveWatcher } from './drive-watcher';
import { readManifest, type ManifestEnv } from './manifest';
import { syncDir } from './save-sync';
import {
  launchGame,
  launchInstaller,
  launchUninstaller,
  waitForExit,
  waitForStart,
  waitForWatchedExit,
  waitForWatchedStart,
  LaunchAbortedError,
  type GameProcess,
} from './game-launcher';
import { findUninstallEntry } from './registry';
import { log } from './logger';

export interface ControllerDeps {
  readonly state: StateManager;
  readonly window: GameWindow;
  readonly store: PcStore;
  readonly stats: StatsService;
  readonly watcher: DriveWatcher;
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Fallback hero background (bundled by copy-assets into dist/wallpaper.png). __dirname is dist/main.
const WALLPAPER_PATH = path.join(__dirname, '../wallpaper.png');

const AUDIO_MIME: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

const SFX_NAMES: readonly SfxName[] = ['play', 'navigate', 'button', 'back'];

// Bundled default UI sounds (in dist/audio, copied by copy-assets). Used per slot when a game.json
// doesn't provide its own sound, so every game has interface sounds out of the box.
const DEFAULT_SFX_FILES: Readonly<Record<SfxName, string>> = {
  play: 'default-play.wav',
  navigate: 'default-move.wav',
  button: 'default-button.wav',
  back: 'default-back.wav',
};

function defaultSfxPath(name: SfxName): string {
  // __dirname at runtime is dist/main; the bundled sounds live in dist/audio.
  return path.join(__dirname, '../audio', DEFAULT_SFX_FILES[name]);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Grace-poll cadence after the installer exits, waiting for the game executable to appear (C1).
const INSTALL_POLL_INTERVAL_MS = 1000;

// Directory removal retries (I5/R-UNINST-SELFCOPY): an Inno uninstaller forks a copy of itself into
// temp and exits early, so right after waitForExit it may still hold `unins000.*` for a moment — a
// few backed-off retries let the lock clear before fse.remove succeeds.
const REMOVE_RETRY_ATTEMPTS = 3;
const REMOVE_RETRY_BASE_MS = 300;

// ── Uninstaller resolution (FS search in the install dir → registry fallback) ──

/** Silent flags we build ourselves per installer family (the same families' silent semantics, minus
 * the dir-key). Never used for `custom` (it has no known silent-uninstall convention). */
function silentUninstallArgs(type: InstallManifest['type']): string[] {
  switch (type) {
    case 'nsis':
      return ['/S'];
    case 'inno':
      return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
    case 'custom':
      return [];
  }
}

/**
 * Step 1 — deterministic FS search for the uninstaller INSIDE the app-controlled install dir (we put
 * it there via the installer's dir-key, so it lives in the root): Inno drops `unins###.exe` (pick the
 * highest if several), NSIS drops `Uninstall.exe`/`uninst*.exe`. `custom` has no known convention → null.
 */
async function findUninstallerInDir(
  dir: string,
  type: InstallManifest['type'],
): Promise<string | null> {
  if (type === 'custom') return null;
  let names: readonly string[];
  try {
    names = await fse.readdir(dir);
  } catch {
    return null;
  }
  if (type === 'inno') {
    const candidates = names.filter((name) => /^unins\d{3}\.exe$/i.test(name)).sort();
    const chosen = candidates.at(-1);
    return chosen !== undefined ? path.join(dir, chosen) : null;
  }
  // nsis: the name is set by the .nsi but is almost always Uninstall.exe / uninst*.exe in the root.
  const match = names.find((name) => /^uninst(all)?.*\.exe$/i.test(name));
  return match !== undefined ? path.join(dir, match) : null;
}

/**
 * Parses a Windows command line into LOGICAL argv tokens following CommandLineToArgvW's backslash/quote
 * rules (2n backslashes + quote → n backslashes and a quote toggle; 2n+1 → n backslashes and a literal
 * quote). Used to split a registry UninstallString into exe + args; the original quoting is dropped (the
 * launcher re-quotes uniformly under verbatim:false).
 */
function parseCommandLine(command: string): string[] {
  const args: string[] = [];
  let arg = '';
  let inQuotes = false;
  let started = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === undefined) break;
    if (ch === '\\') {
      let backslashes = 0;
      while (command[i] === '\\') {
        backslashes += 1;
        i += 1;
      }
      if (command[i] === '"') {
        arg += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          arg += '"'; // escaped literal quote
        } else {
          inQuotes = !inQuotes;
        }
        i += 1;
      } else {
        arg += '\\'.repeat(backslashes);
      }
      started = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
      i += 1;
      continue;
    }
    if ((ch === ' ' || ch === '\t') && !inQuotes) {
      if (started) {
        args.push(arg);
        arg = '';
        started = false;
      }
      i += 1;
      continue;
    }
    arg += ch;
    started = true;
    i += 1;
  }
  if (started) args.push(arg);
  return args;
}

/**
 * Resolves what to launch to uninstall an install-mode game (§2): FS search in the install dir first
 * (deterministic, no parsing/encoding issues — we build the silent args), then a registry fallback for a
 * rare nonstandard NSIS uninstaller name. Returns null → the caller does a plain directory removal.
 */
async function resolveUninstaller(
  install: NonNullable<ResolvedManifest['install']>,
): Promise<LaunchTarget | null> {
  if (process.platform !== 'win32') return null; // install mode is Windows-only

  // Step 1: FS search in install.dir, with self-built silent flags.
  const found = await findUninstallerInDir(install.dir, install.type);
  if (found !== null) {
    return {
      file: found,
      args: silentUninstallArgs(install.type),
      cwd: install.dir,
      runAsAdmin: install.runAsAdmin,
    };
  }
  if (install.type === 'custom') return null; // no FS match and no silent convention → plain remove

  // Step 2: registry fallback (rare — nonstandard NSIS uninstaller name).
  const entry = await findUninstallEntry(install.dir);
  if (entry === null) return null;
  const command = entry.quietUninstallString ?? entry.uninstallString;
  if (command === undefined) return null;
  const tokens = parseCommandLine(command);
  const file = tokens[0];
  if (file === undefined) return null;
  const rest = tokens.slice(1);
  // QuietUninstallString is already silent; a plain UninstallString needs the family's silent flag.
  const args =
    entry.quietUninstallString !== undefined ? rest : [...rest, ...silentUninstallArgs(install.type)];
  return {
    file,
    args,
    cwd: install.dir,
    runAsAdmin: entry.fromHKLM || install.runAsAdmin,
  };
}

/**
 * Removes a directory with a few backed-off retries (I5): the forked Inno uninstaller may still hold
 * files for a moment after waitForExit. Checks `signal.aborted` between attempts (fse.remove itself is
 * not interruptible). Throws the last error if every attempt fails.
 */
async function removeWithRetry(dir: string, signal?: AbortSignal): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REMOVE_RETRY_ATTEMPTS; attempt += 1) {
    if (signal?.aborted === true) return;
    try {
      await fse.remove(dir);
      return;
    } catch (cause) {
      lastError = cause;
      if (attempt < REMOVE_RETRY_ATTEMPTS) await delay(REMOVE_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export class GameController {
  private current: ResolvedManifest | null = null;
  private cardPresent = false;
  private launchInFlight = false;
  private abort: AbortController | null = null;
  // A card swapped in WHILE a launch/install was in flight (E1): DriveWatcher can swap without an
  // empty tick, so we stash the new root, abort the in-flight sequence, and replay onInsert from its
  // finally (after launchInFlight clears) — otherwise the aborted sequence could set state over the new card.
  private pendingRoot: string | null = null;
  // Audio for the current card, sent on its own channel (not on every AppState) — see AudioAssets.
  private currentAudio: AudioAssets | null = null;
  // Bundled fallback wallpaper as a data URL: undefined = not read yet, null = unavailable.
  private wallpaperDataUrl: string | null | undefined;

  constructor(private readonly deps: ControllerDeps) {}

  /** Subscriptions to drive-watcher, state replication to the window, IPC handlers. */
  init(): void {
    const { state, window, watcher } = this.deps;

    state.subscribe((next) => {
      const browserWindow = window.browserWindow;
      if (browserWindow !== null && !browserWindow.isDestroyed()) {
        browserWindow.webContents.send(IPC.stateUpdate, next);
      }
    });

    watcher.onInsert((root) => void this.onInsert(root));
    watcher.onRemove(() => this.onRemove());
    watcher.onError((error) => log.error('[drive-watcher]', error));

    ipcMain.handle(IPC.stateRequest, (): AppState => state.get());
    ipcMain.handle(IPC.audioRequest, (): AudioAssets | null => this.currentAudio);
    ipcMain.handle(IPC.wallpaperRequest, (): Promise<string | null> => this.readWallpaperDataUrl());
    ipcMain.on(IPC.actionLaunch, () => void this.onLaunchRequested());
    ipcMain.on(IPC.actionUninstall, () => void this.onUninstallRequested());
    ipcMain.on(IPC.actionHide, () => this.deps.window.hide());
  }

  /** Sends a transient error to the renderer to surface in the error popup. */
  private sendError(message: string): void {
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.errorShow, message);
    }
  }

  /** Stops the process waits and the watcher (on application exit). */
  shutdown(): void {
    this.abort?.abort();
    this.deps.watcher.stop();
  }

  // ── Reaction to card insertion ───────────────────────────────────────────

  private async onInsert(root: string): Promise<void> {
    // E1: a card was swapped in mid-flight (no empty tick). Don't process it now — that would race the
    // in-flight sequence. Stash it, abort the current flow; its finally replays this once it unwinds.
    if (this.launchInFlight) {
      log.info(`[insert] card swapped during launch/install — deferring root="${root}"`);
      this.pendingRoot = root;
      this.abort?.abort();
      return;
    }
    this.cardPresent = true;
    log.info(`[insert] card detected at root="${root}"`);
    // Documents is resolved via the system Known Folder API (the same one the game uses),
    // so %DOCUMENTS% in the manifest maps to the real save folder regardless of UI
    // language or OneDrive redirection. Safe to read here — app is ready by now.
    const env: ManifestEnv = { documents: app.getPath('documents') };
    const result = await readManifest(root, env);
    if (!result.ok) {
      // No valid game determined → keep the window hidden (the reason is in the log). We still set
      // the error state so a manually-summoned window can show it, but we never auto-surface it.
      log.warn(`[insert] manifest rejected: ${result.message}`);
      this.current = null;
      this.setAudio(null);
      this.deps.state.set({ kind: 'error', message: result.message });
      this.deps.window.hide();
      return;
    }
    const manifest = result.manifest;
    this.current = manifest;
    log.info(`[insert] manifest ok id=${manifest.raw.id} root="${manifest.root}"`);
    this.setAudio(await this.readAudioAssets(manifest));

    // Reconcile the card's traveling stats with this PC's mirror (the "one card, many PCs"
    // unified total) FIRST, so the PC mirror holds the merged value before anything else copies
    // stats to the card. Then write the merged result back to the card so it stays current.
    const stats = await this.deps.stats.reconcileWithCard(manifest.raw.id, manifest.root);
    await this.deps.stats.copyToCard(manifest.root, stats);

    // If the card was yanked mid-game last time — top up the deferred PC→SD (saves snapshot).
    // Runs after reconcile so its own stats copy uses the already-merged value, never clobbering
    // a higher total the card picked up on another PC.
    try {
      await this.flushPendingIfAny(manifest);
    } catch (cause) {
      log.warn('[pending-flush] failed on insert:', describe(cause));
    }

    const info = await this.buildGameInfo(manifest, stats);
    this.deps.state.set({ kind: 'ready', game: info });
    this.deps.window.showAndFocus();
  }

  private async flushPendingIfAny(manifest: ResolvedManifest): Promise<void> {
    if (manifest.saveOnCardPath === undefined) return;
    const pending = await this.deps.store.getPending(manifest.raw.id);
    if (pending === null) return;
    await syncDir(pending.savesSnapshotDir, manifest.saveOnCardPath);
    const stats = await this.deps.stats.read(manifest.raw.id);
    await this.deps.stats.copyToCard(manifest.root, stats);
    await this.deps.store.clearPending(manifest.raw.id);
  }

  // ── Reaction to card removal ─────────────────────────────────────────────

  private onRemove(): void {
    this.cardPresent = false;
    const kind = this.deps.state.get().kind;
    // During play/sync, removal is expected (R2): the flow continues, sync-out
    // will see cardPresent=false and put the task into pending-flush. We don't touch state.
    if (
      kind === 'running' ||
      kind === 'launching' ||
      kind === 'installing' ||
      kind === 'uninstalling' ||
      kind === 'syncing-in' ||
      kind === 'syncing-out'
    ) {
      // During install, removal is also expected (A5): the installer reads from the card, so yanking
      // it makes the install fail → <exe> won't appear → we stay on "Install"; next attempt pre-cleans.
      // During uninstall it targets the PC, so it completes; runUninstallSequence then sees cardPresent
      // = false and goes idle + hide on its own (R-CARDPULL-UNINSTALL).
      return;
    }
    // ready / error / idle → no card, hide the window.
    this.current = null;
    this.setAudio(null);
    this.deps.state.set({ kind: 'idle' });
    this.deps.window.hide();
  }

  // ── "Launch" action (the A button / click) ──────────────────────────────

  private onLaunchRequested(): void {
    // Ignore input outside the ready state — this is the "ignore-gamepad" during play
    // (harmless under any interpretation of the Gamepad API focus bug, R5).
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'ready' || this.launchInFlight) return;
    const manifest = this.current;
    if (manifest === null) return;
    // Install mode + not yet installed → run the installer; otherwise it's an ordinary launch
    // (this includes a fully-installed game, whose executable now exists → requiresInstall=false).
    if (manifest.install !== undefined && snapshot.game.requiresInstall) {
      void this.runInstallSequence(manifest, snapshot.game);
    } else {
      void this.runLaunchSequence(manifest, snapshot.game);
    }
  }

  /** "Uninstall" action (the user confirmed in the popup). Only for an installed install-mode game. */
  private onUninstallRequested(): void {
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'ready' || this.launchInFlight) return;
    const manifest = this.current;
    if (manifest === null || manifest.install === undefined) return;
    if (!snapshot.game.canUninstall) return; // nothing installed to remove
    void this.runUninstallSequence(manifest, snapshot.game);
  }

  private async runLaunchSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const { state, window, stats } = this.deps;
    this.launchInFlight = true;
    const abort = new AbortController();
    this.abort = abort;
    // Declared before the try so `finally` can dispose the kept HANDLE (elevated path).
    let proc: GameProcess | null = null;
    try {
      // 1. SD→PC (if sync is configured)
      state.set({ kind: 'syncing-in', game: info });
      if (manifest.pcSavePath !== undefined && manifest.saveOnCardPath !== undefined) {
        await syncDir(manifest.saveOnCardPath, manifest.pcSavePath);
      }

      // 2. launch → GameProcess (spawn, or elevated ShellExecuteEx per manifest.runAsAdmin)
      state.set({ kind: 'launching', game: info });
      try {
        proc = await launchGame(manifest);
      } catch (cause) {
        this.failLaunch(info, `failed to launch the game: ${describe(cause)}`);
        return;
      }

      // 3/4. wait for the game to appear, then for it to exit. Two paths:
      //  - watched (launcher/wrapper, manifest.watchProcesses): the game is a SEPARATE process; we wait
      //    for one of the watched image names to appear (HANDOFF — the launcher may live on in its menu),
      //    then track that process's presence for exit.
      //  - normal: the spawned pid IS the game; wait for that pid to appear, then disappear.
      // Running-phase note (both paths): gamepad input is ignored (outside ready). The window stays put —
      // the game takes the foreground on its own and simply covers the launcher, which avoids the jerky
      // hide/show flash. We grab the foreground back in step 6 once the game exits. The global Start+Back
      // hotkey is intentionally a no-op while running, so there's nothing to re-summon.
      const watchProcesses = manifest.raw.watchProcesses;
      let since: number;
      if (watchProcesses !== undefined && watchProcesses.length > 0) {
        const { started } = await waitForWatchedStart(
          proc.pid,
          watchProcesses,
          manifest.raw.launchTimeoutSec,
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
        state.set({ kind: 'running', game: info, since });
        log.info(`[launch] running (watched) id=${manifest.raw.id} watch=${watchProcesses.join(',')}`);
        await waitForWatchedExit(watchProcesses, abort.signal);
        log.info(`[launch] exited (watched) id=${manifest.raw.id}`);
      } else {
        const started = await waitForStart(proc, manifest.raw.launchTimeoutSec, abort.signal);
        if (!started) {
          this.failLaunch(info, 'the game did not start (process wait timed out)');
          return;
        }
        since = Date.now();
        state.set({ kind: 'running', game: info, since });
        log.info(`[launch] running id=${manifest.raw.id} pid=${proc.pid}`);
        await waitForExit(proc, abort.signal);
        log.info(`[launch] exited id=${manifest.raw.id} pid=${proc.pid}`);
      }

      // 5. game closed → write stats to the PC (source of truth)
      const playSeconds = (Date.now() - since) / 1000;
      const updatedStats = await stats.recordPlay(manifest.raw.id, playSeconds);
      const updatedInfo = await this.buildGameInfo(manifest, updatedStats);

      // 6. PC→SD + stats copy (or pending-flush, if the card is already gone). The game just exited,
      // so reclaim the foreground (forceForeground) to surface the launcher over Steam/desktop.
      state.set({ kind: 'syncing-out', game: updatedInfo });
      window.showAndFocus(true);
      await this.performSyncOut(manifest, updatedStats);

      // 7. done
      state.set({ kind: 'ready', game: updatedInfo });
      window.showAndFocus();
    } catch (cause) {
      if (cause instanceof LaunchAbortedError) return; // application is shutting down
      this.failLaunch(info, describe(cause));
    } finally {
      // Release the elevated HANDLE (no-op for the normal spawn path).
      proc?.dispose();
      this.launchInFlight = false;
      this.abort = null;
      // Replay a card that was swapped in mid-flight (E1), now that launchInFlight has cleared.
      this.resumePendingInsert();
    }
  }

  /**
   * Runs the installer for an install-mode game that isn't installed yet (mirrors runLaunchSequence's
   * infrastructure: launchInFlight/abort, the LaunchAbortedError guard, the pendingRoot replay).
   * Pre-cleans the install dir (C1), runs the installer silently, then grace-polls for the executable —
   * on success the button becomes "Play"; otherwise we stay on "Install" and surface the reason.
   */
  private async runInstallSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const install = manifest.install;
    if (install === undefined) return; // defensive: onLaunchRequested only calls this in install mode
    const { state, window, stats } = this.deps;
    this.launchInFlight = true; // E3: set/cleared explicitly, like runLaunchSequence
    const abort = new AbortController();
    this.abort = abort;
    let proc: GameProcess | null = null;
    try {
      state.set({ kind: 'installing', game: info });

      // Pre-clean (C1): a partial install left by a previous failed attempt could carry a stale <exe> →
      // a bogus "Play". We're (re)installing anyway, so a clean directory is safe.
      await fse.remove(install.dir);

      try {
        proc = await launchInstaller(install);
      } catch (cause) {
        this.failInstall(info, `failed to start the installer: ${describe(cause)}`);
        return;
      }

      // Wait for the installer to exit, then grace-poll for the executable: some installers (often
      // custom wrappers) fork a child and exit early, so <exe> may appear shortly AFTER waitForExit.
      await waitForExit(proc, abort.signal);
      const installed = await this.pollForExecutable(
        manifest.executablePath,
        manifest.raw.launchTimeoutSec,
        abort.signal,
      );
      if (!installed) {
        this.failInstall(info, 'installation did not complete (the game executable did not appear)');
        return;
      }

      // Installed: rebuild GameInfo so requiresInstall recomputes to false (the executable now exists),
      // flipping the button back to "Play". The next press launches normally from the install dir.
      const currentStats = await stats.read(manifest.raw.id);
      const installedInfo = await this.buildGameInfo(manifest, currentStats);
      log.info(`[install] completed id=${manifest.raw.id} dir="${install.dir}"`);
      state.set({ kind: 'ready', game: installedInfo });
      window.showAndFocus();
    } catch (cause) {
      if (cause instanceof LaunchAbortedError) return; // aborted by shutdown or a card swap (E1/E2)
      this.failInstall(info, describe(cause));
    } finally {
      proc?.dispose();
      this.launchInFlight = false;
      this.abort = null;
      this.resumePendingInsert();
    }
  }

  /**
   * Polls for the game executable to appear within `timeoutSec` (grace window after the installer
   * exits, C1). Throws LaunchAbortedError if aborted, so a mid-install card swap unwinds WITHOUT
   * setting state over the new card (E1) — never returns false on abort.
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
   * An install attempt failed: return to the 'ready' screen with the SAME info (its executable still
   * doesn't exist → requiresInstall stays true → the button remains "Install") and surface the reason.
   * Mirrors failLaunch; the next attempt pre-cleans the install dir.
   */
  private failInstall(game: GameInfo, message: string): void {
    log.warn(`[install] failed: ${message}`);
    this.deps.state.set({ kind: 'ready', game });
    this.deps.window.showAndFocus();
    this.sendError(message);
  }

  /**
   * Uninstalls an installed install-mode game (mirrors runInstallSequence's infrastructure:
   * launchInFlight/abort, the LaunchAbortedError guard, the pendingRoot replay). Runs the game's own
   * uninstaller (best-effort — it cleans the registry/shortcuts), then ALWAYS sweeps the app-controlled
   * install dir, so on success the executable is gone → requiresInstall recomputes true → "Install".
   */
  private async runUninstallSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const install = manifest.install;
    if (install === undefined) return; // defensive: onUninstallRequested only calls this in install mode
    const { state, window, stats } = this.deps;
    this.launchInFlight = true; // E3: set/cleared explicitly, like runInstallSequence
    const abort = new AbortController();
    this.abort = abort;
    let proc: GameProcess | null = null;
    try {
      state.set({ kind: 'uninstalling', game: info });

      // Run the game's own uninstaller if we can resolve one (FS search → registry fallback, §2). Any
      // launch/wait failure is NON-fatal: we log it and fall through to the directory sweep. Only a
      // LaunchAbortedError (from waitForExit on a card swap) propagates to unwind cleanly.
      const target = await resolveUninstaller(install);
      if (target !== null) {
        try {
          proc = await launchUninstaller(target);
          await waitForExit(proc, abort.signal);
        } catch (cause) {
          if (cause instanceof LaunchAbortedError) throw cause;
          log.warn(`[uninstall] uninstaller failed, continuing to cleanup: ${describe(cause)}`);
        }
      }

      // Always sweep the app-controlled install dir — after the uninstaller, and as the fallback when
      // no target was resolved (custom / nothing found).
      await removeWithRetry(install.dir, abort.signal);

      // fse.remove is NOT interrupted by the signal (unlike waitForExit), so check the abort flag
      // manually — strictly BEFORE reading cardPresent / rebuilding info — so a mid-uninstall card swap
      // doesn't set state over the new card (the finally → resumePendingInsert handles it). (I2)
      if (abort.signal.aborted) return;

      // The card may have been yanked during the uninstall (it targets the PC, so it completed): no card
      // → idle + hide, mirroring abandonWatchedLaunch / onRemove's cleanup (R-CARDPULL-UNINSTALL).
      if (!this.cardPresent) {
        this.current = null;
        this.setAudio(null);
        state.set({ kind: 'idle' });
        window.hide();
        return;
      }

      // Done: rebuild GameInfo so requiresInstall recomputes true and canUninstall false (the executable
      // is gone) → the button flips back to "Install" and "Uninstall" disappears.
      const currentStats = await stats.read(manifest.raw.id);
      const updatedInfo = await this.buildGameInfo(manifest, currentStats);
      log.info(`[uninstall] completed id=${manifest.raw.id} dir="${install.dir}"`);
      state.set({ kind: 'ready', game: updatedInfo });
      window.showAndFocus();
    } catch (cause) {
      if (cause instanceof LaunchAbortedError) return; // aborted by shutdown or a card swap (E1/E2)
      this.failUninstall(info, describe(cause));
    } finally {
      proc?.dispose();
      this.launchInFlight = false;
      this.abort = null;
      this.resumePendingInsert();
    }
  }

  /**
   * An uninstall attempt failed (e.g. the install dir files are locked): return to 'ready' with the
   * SAME info — the game is still installed → canUninstall stays true → the "Uninstall" button remains —
   * and surface the reason. Mirrors failInstall.
   */
  private failUninstall(game: GameInfo, message: string): void {
    log.warn(`[uninstall] failed: ${message}`);
    this.deps.state.set({ kind: 'ready', game });
    this.deps.window.showAndFocus();
    this.sendError(message);
  }

  /** Replays a card insertion deferred during an in-flight launch/install (E1). No-op if none pending. */
  private resumePendingInsert(): void {
    const root = this.pendingRoot;
    if (root === null) return;
    this.pendingRoot = null;
    void this.onInsert(root);
  }

  /**
   * A launch attempt failed: return to the normal 'ready' screen (the game is still on the card)
   * and surface the reason in the error popup. The user can read it, close it (B / veil) and retry.
   */
  private failLaunch(game: GameInfo, message: string): void {
    log.warn(`[launch] failed: ${message}`);
    this.deps.state.set({ kind: 'ready', game });
    this.deps.window.showAndFocus();
    this.sendError(message);
  }

  /**
   * The watched-launcher path ended without the game ever becoming visible: the user closed the launcher
   * without playing, or the game runs elevated / as a service and `tasklist` can't see it (R4). This is
   * neither a failure nor a play session — we do NOT call stats.recordPlay (it would bump launchCount and
   * lastPlayedAt for a 0s session) and we do NOT surface an error popup. Back to the normal screen; if the
   * card is already gone, go idle and hide, mirroring onRemove's cleanup.
   */
  private abandonWatchedLaunch(game: GameInfo): void {
    log.info('[launch] watched game never appeared — returning without recording a session');
    if (!this.cardPresent) {
      this.current = null;
      this.setAudio(null);
      this.deps.state.set({ kind: 'idle' });
      this.deps.window.hide();
      return;
    }
    this.deps.state.set({ kind: 'ready', game });
    this.deps.window.showAndFocus();
  }

  private async performSyncOut(manifest: ResolvedManifest, stats: Stats): Promise<void> {
    const id = manifest.raw.id;
    // The card is already removed (the expected R2 scenario) → defer PC→SD into pending-flush.
    if (!this.cardPresent) {
      if (manifest.pcSavePath !== undefined) {
        await this.deps.store.enqueuePcToSd(id, manifest.pcSavePath);
      }
      return;
    }
    if (manifest.pcSavePath !== undefined && manifest.saveOnCardPath !== undefined) {
      try {
        await syncDir(manifest.pcSavePath, manifest.saveOnCardPath);
      } catch (cause) {
        // The card may have been yanked during the sync → saves.bak is intact, we'll finish on insertion.
        log.warn('[sync-out] failed, deferring to pending-flush:', describe(cause));
        await this.deps.store.enqueuePcToSd(id, manifest.pcSavePath);
        return;
      }
    }
    await this.deps.stats.copyToCard(manifest.root, stats);
  }

  // ── Building GameInfo for the UI ─────────────────────────────────────────

  private async buildGameInfo(manifest: ResolvedManifest, stats: Stats): Promise<GameInfo> {
    const heroImageDataUrl = await this.readHeroDataUrl(manifest.heroImagePath);
    // E6: requiresInstall/canUninstall are computed here from ONE existence check so every caller
    // (onInsert, the post-install rebuild, the post-uninstall rebuild) gets consistent values.
    // `installed` (install mode AND the executable present) splits into requiresInstall = install &&
    // !installed and canUninstall = installed (installed already implies install mode).
    const installed =
      manifest.install !== undefined && (await fse.pathExists(manifest.executablePath));
    const requiresInstall = manifest.install !== undefined && !installed;
    const canUninstall = installed;
    return {
      id: manifest.raw.id,
      title: manifest.raw.title,
      lastPlayedAt: stats.lastPlayedAt,
      totalPlaySeconds: stats.totalPlaySeconds,
      launchCount: stats.launchCount,
      requiresInstall,
      canUninstall,
      ...(heroImageDataUrl !== undefined ? { heroImageDataUrl } : {}),
    };
  }

  /** Game hero, or the fallback wallpaper when the manifest has no heroImage (or it fails to read). */
  private async readHeroDataUrl(heroImagePath: string | undefined): Promise<string | undefined> {
    if (heroImagePath !== undefined) {
      const url = await this.readImageDataUrl(heroImagePath);
      if (url !== undefined) return url;
      log.warn('[hero-image] failed to read, using wallpaper fallback');
    }
    return (await this.readWallpaperDataUrl()) ?? undefined;
  }

  private async readImageDataUrl(filePath: string): Promise<string | undefined> {
    try {
      const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      const buffer = await fse.readFile(filePath);
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (cause) {
      log.warn(`[image] failed to read "${filePath}":`, describe(cause));
      return undefined;
    }
  }

  /** Bundled fallback wallpaper as a data URL (read once and cached). null if it can't be read. */
  private async readWallpaperDataUrl(): Promise<string | null> {
    if (this.wallpaperDataUrl !== undefined) return this.wallpaperDataUrl;
    const url = await this.readImageDataUrl(WALLPAPER_PATH);
    this.wallpaperDataUrl = url ?? null;
    return this.wallpaperDataUrl;
  }

  // ── Audio assets (sounds + background music) ─────────────────────────────

  /** Stores the current audio and pushes it to the window (null when no card / on error). */
  private setAudio(assets: AudioAssets | null): void {
    this.currentAudio = assets;
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.audioUpdate, assets);
    }
  }

  /** Reads the manifest's sounds + music into data URLs. Returns null when nothing is configured. */
  private async readAudioAssets(manifest: ResolvedManifest): Promise<AudioAssets | null> {
    const sounds: Record<string, string> = {};
    for (const name of SFX_NAMES) {
      // Per slot: the game's own sound if set, otherwise the bundled default.
      const filePath = manifest.soundPaths?.[name] ?? defaultSfxPath(name);
      const url = await this.readAudioDataUrl(filePath);
      if (url !== undefined) sounds[name] = url;
    }
    const music =
      manifest.backgroundMusicPath !== undefined
        ? await this.readAudioDataUrl(manifest.backgroundMusicPath)
        : undefined;

    if (Object.keys(sounds).length === 0 && music === undefined) return null;
    return { sounds, ...(music !== undefined ? { music } : {}) };
  }

  private async readAudioDataUrl(filePath: string): Promise<string | undefined> {
    try {
      const mime = AUDIO_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      const buffer = await fse.readFile(filePath);
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (cause) {
      log.warn('[audio] failed to read, skipping:', describe(cause));
      return undefined;
    }
  }
}
