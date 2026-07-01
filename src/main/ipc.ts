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
  type HeroAssets,
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
import { findUninstallEntry, getSteamPath } from './registry';
import { steamInstallStatus, openSteamUri, type SteamInstallStatus } from './steam';
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

// Steam-mode background re-detect cadence: while a Steam game shows "Install" (not yet installed in
// Steam), poll its .acf state so the button flips to "Play" once the (possibly hours-long) download
// finishes. Non-blocking — no `installing` state is entered (see runSteamInstall).
const STEAM_INSTALL_WATCH_INTERVAL_MS = 5000;

// How long to keep showing "Uninstalling…" after we open steam://uninstall before giving up. Steam's
// uninstall is fire-and-forget: we can't tell "user is reading the dialog / cancelled" from "removing".
// If the .acf is still present after this window, we assume a cancel and return to "Play"/"Uninstall".
// Safe either way — the poller keeps running and will flip to "Install" if removal completes later.
const STEAM_UNINSTALL_TIMEOUT_MS = 60_000;

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
  // Hero images for the current card, sent on their own channel (not on every AppState) — see HeroAssets.
  private currentHero: HeroAssets | null = null;
  // Steam-mode background re-detect timer (recursive setTimeout, no overlap). Non-null only while a
  // Steam game is on the ready screen with the card present (managed by enterReady).
  private steamInstallWatch: ReturnType<typeof setTimeout> | null = null;
  // True while a tick is mid-flight (between nulling the timer and finishing). Prevents a concurrent
  // startSteamInstallWatch (e.g. an Install/Uninstall action landing during the tick's await) from
  // spinning up a SECOND poller. The tick re-arms itself in its finally.
  private steamTickInFlight = false;
  // A steam://uninstall we requested (appid + when), driving the optimistic "Uninstalling…" indicator
  // until the .acf disappears or STEAM_UNINSTALL_TIMEOUT_MS elapses (assumed cancel). Null = none.
  private steamUninstallRequest: { readonly appid: number; readonly since: number } | null = null;
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
    ipcMain.handle(IPC.heroRequest, (): HeroAssets | null => this.currentHero);
    ipcMain.handle(IPC.wallpaperRequest, (): Promise<string | null> => this.readWallpaperDataUrl());
    ipcMain.on(IPC.actionLaunch, () => void this.onLaunchRequested());
    ipcMain.on(IPC.actionUninstall, () => void this.onUninstallRequested());
    ipcMain.on(IPC.actionHide, () => this.deps.window.hide());
    ipcMain.on(IPC.actionOpenSteamDownloads, () => void this.onOpenSteamDownloads());
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
    this.stopSteamInstallWatch();
    this.steamUninstallRequest = null;
    this.deps.watcher.stop();
  }

  // ── Ready transition + Steam re-detect poller ──────────────────────────────

  /**
   * The single entry point for the `ready` state. Besides setting the state, it manages the Steam
   * background re-detect poller: started when the current game is a Steam game still showing "Install"
   * (and the card is present), stopped otherwise. ALL ready transitions go through here so the poller's
   * lifecycle is governed in exactly one place (StateManager is not a controller hook).
   */
  private enterReady(info: GameInfo): void {
    this.deps.state.set({ kind: 'ready', game: info });
    // Poll for ANY steam game while the card is present: it catches install completion (Install→Play),
    // uninstall completion (Play→Install) — incl. an uninstall the user triggers in Steam directly — and
    // download progress. The .acf read is cheap, so a perpetual 5s poll for an inserted steam card is fine.
    if (info.installVia === 'steam' && this.cardPresent) {
      this.startSteamInstallWatch();
    } else {
      this.stopSteamInstallWatch();
    }
  }

  /** (Re)starts the recursive Steam re-detect timer. No-op if already running or a tick is in flight. */
  private startSteamInstallWatch(): void {
    if (this.steamInstallWatch !== null || this.steamTickInFlight) return;
    this.steamInstallWatch = setTimeout(() => void this.steamInstallTick(), STEAM_INSTALL_WATCH_INTERVAL_MS);
  }

  /** Stops the Steam re-detect timer. */
  private stopSteamInstallWatch(): void {
    if (this.steamInstallWatch === null) return;
    clearTimeout(this.steamInstallWatch);
    this.steamInstallWatch = null;
  }

  /**
   * One Steam re-detect tick: captures the current manifest's appid, reads Steam's .acf state, and — only
   * if the card/state is still the same after the await (same steam game, ready, no launch in flight) —
   * reconciles the UI flags (requiresInstall/canUninstall/progress/uninstalling) by PATCHING the current
   * GameInfo in place (cheap — no hero re-read). Catches install completion, uninstall completion (incl.
   * an uninstall done in Steam directly), live download progress, and the uninstall-cancel timeout.
   */
  private async steamInstallTick(): Promise<void> {
    this.steamInstallWatch = null; // consumed; the finally re-arms it if we should still be polling
    const manifest = this.current;
    const appid = manifest?.steam?.appid;
    if (manifest === undefined || manifest === null || appid === undefined) return; // not steam → stop
    this.steamTickInFlight = true;
    try {
      let status: SteamInstallStatus = { state: 'absent' };
      try {
        status = await steamInstallStatus(appid);
      } catch (cause) {
        log.warn('[steam-watch] detect failed:', describe(cause));
      }

      // Re-validate everything that could have changed during the await (card swap, launch in flight).
      const snapshot = this.deps.state.get();
      if (
        this.launchInFlight ||
        this.current !== manifest ||
        snapshot.kind !== 'ready' ||
        snapshot.game.installVia !== 'steam'
      ) {
        return; // stale — drop this result (the finally re-arms iff still a steam card on ready)
      }
      const prev = snapshot.game;

      // Reconcile the UI flags with Steam's fresh .acf state. Only these flags change on install/uninstall;
      // the rest of GameInfo (title/hero/stats) is unaffected, so we patch `prev` in place — no hero re-read.
      let requiresInstall = status.state !== 'installed';
      let canUninstall = status.state === 'installed';
      const steamInstalling = status.state === 'downloading';
      const steamPaused = status.state === 'downloading' && status.paused;
      const steamPausedProgress =
        status.state === 'downloading' ? (status.progress ?? undefined) : undefined;
      let steamUninstalling = false;

      // A requested steam://uninstall is in flight for this game.
      const req = this.steamUninstallRequest;
      if (req !== null && req.appid === appid) {
        if (status.state === 'installed') {
          // .acf still present: either Steam is removing files, or the user is still on / cancelled the
          // dialog. Keep "Uninstalling…" until the timeout, then assume cancel and restore Play/Uninstall.
          if (Date.now() - req.since > STEAM_UNINSTALL_TIMEOUT_MS) {
            log.info(`[steam-uninstall] appid=${appid} still installed after timeout — assuming cancel`);
            this.steamUninstallRequest = null;
          } else {
            steamUninstalling = true;
            canUninstall = false; // hide Uninstall while the indicator is up
          }
        } else {
          // .acf gone (absent/downloading) → Steam removed the game; finish the uninstall.
          log.info(`[steam-uninstall] appid=${appid} removed — flipping to Install`);
          this.steamUninstallRequest = null;
        }
      }

      const changed =
        prev.requiresInstall !== requiresInstall ||
        prev.canUninstall !== canUninstall ||
        (prev.steamInstalling ?? false) !== steamInstalling ||
        (prev.steamPaused ?? false) !== steamPaused ||
        prev.steamPausedProgress !== steamPausedProgress ||
        (prev.steamUninstalling ?? false) !== steamUninstalling;
      if (changed) {
        if (!steamUninstalling) {
          log.info(
            `[steam-watch] appid=${appid} state=${status.state}${steamPaused ? ' (paused)' : ''} → requiresInstall=${requiresInstall} canUninstall=${canUninstall}`,
          );
        }
        this.enterReady({
          ...prev,
          requiresInstall,
          canUninstall,
          steamInstalling,
          steamPaused,
          steamPausedProgress,
          steamUninstalling,
        });
      }
    } finally {
      this.steamTickInFlight = false;
      // Re-arm iff we should still be watching this steam card (mirrors enterReady's start condition).
      const s = this.deps.state.get();
      if (s.kind === 'ready' && s.game.installVia === 'steam' && this.cardPresent) {
        this.startSteamInstallWatch();
      }
    }
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
      this.setHero(null);
      this.deps.state.set({ kind: 'error', message: result.message });
      this.deps.window.hide();
      return;
    }
    const manifest = result.manifest;
    this.current = manifest;
    log.info(`[insert] manifest ok id=${manifest.raw.id} root="${manifest.root}"`);
    this.setAudio(await this.readAudioAssets(manifest));
    // Hero images are delivered once per card on their own channel (like audio) — the renderer holds
    // the list and rotates locally, so we never re-send this large payload on subsequent state.set's.
    this.setHero(await this.readHeroAssets(manifest));

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
    this.enterReady(info);
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
    // ready / error / idle → no card, hide the window. Stop any Steam re-detect poller (the card is gone;
    // a Steam game in `ready` reaches here since its kind is never running/installing).
    this.stopSteamInstallWatch();
    this.steamUninstallRequest = null;
    this.current = null;
    this.setAudio(null);
    this.setHero(null);
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
    // Steam mode: not yet installed → open steam://install (fire-and-forget); otherwise launch via
    // steam://rungameid. Both inside runSteamInstall / runLaunchSequence's steam branch.
    if (manifest.steam !== undefined) {
      if (snapshot.game.requiresInstall) {
        void this.runSteamInstall(manifest, snapshot.game);
      } else {
        void this.runLaunchSequence(manifest, snapshot.game);
      }
      return;
    }
    // Card-install mode + not yet installed → run the installer; otherwise it's an ordinary launch
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
    if (manifest === null) return;
    if (!snapshot.game.canUninstall) return; // nothing installed to remove
    // Steam: delegate removal to Steam (steam://uninstall) — fire-and-forget, the poller flips to Install.
    if (manifest.steam !== undefined) {
      void this.runSteamUninstall(manifest, snapshot.game);
      return;
    }
    if (manifest.install === undefined) return;
    void this.runUninstallSequence(manifest, snapshot.game);
  }

  /**
   * Steam install action: fire-and-forget. Opens `steam://install/<appid>` (Steam shows its own dialog
   * and the download — possibly hours/GBs) and returns WITHOUT entering a blocking `installing` state.
   * We stay on the `ready` ("Install") screen; the background re-detect poller (started by enterReady)
   * flips the button to "Play" once Steam's .acf reports the game fully installed. Steam itself collapses
   * repeated `steam://install` calls, so no debounce is needed. Pre-checks getSteamPath (I8): openExternal
   * doesn't reliably reject when steam:// is unregistered.
   */
  private async runSteamInstall(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const appid = manifest.steam?.appid;
    if (appid === undefined) return; // defensive: onLaunchRequested only calls this in steam mode
    if ((await getSteamPath()) === null) {
      this.sendError('Steam is not installed');
      return;
    }
    try {
      await openSteamUri(`steam://install/${appid}`);
      log.info(`[steam-install] opened steam://install/${appid} id=${manifest.raw.id}`);
    } catch (cause) {
      this.sendError(`failed to open Steam install: ${describe(cause)}`);
      return;
    }
    // Ensure the re-detect poller is running so the button flips to "Play" when the download completes
    // (no-op if already running; info confirms this is a steam game still requiring install).
    if (info.installVia === 'steam' && info.requiresInstall && this.cardPresent) {
      this.startSteamInstallWatch();
    }
  }

  /**
   * Steam uninstall action: fire-and-forget, mirroring runSteamInstall. Opens `steam://uninstall/<appid>`
   * (Steam shows its own confirmation/removal UI) and returns WITHOUT a blocking `uninstalling` state. We
   * stay on the `ready` ("Play"/"Uninstall") screen; the background poller flips the button back to
   * "Install" once Steam removes the .acf. Pre-checks getSteamPath (I8).
   */
  /**
   * Opens Steam's Downloads page (steam://open/downloads). Triggered by the Play button while a Steam
   * download is in progress (its loader is otherwise a no-op) so the user can pause/resume in Steam —
   * we can't control Steam's downloads programmatically (no URI/API for pause/resume).
   */
  private async onOpenSteamDownloads(): Promise<void> {
    try {
      await openSteamUri('steam://open/downloads');
    } catch (cause) {
      this.sendError(`failed to open Steam downloads: ${describe(cause)}`);
    }
  }

  private async runSteamUninstall(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const appid = manifest.steam?.appid;
    if (appid === undefined) return; // defensive: onUninstallRequested only calls this in steam mode
    if ((await getSteamPath()) === null) {
      this.sendError('Steam is not installed');
      return;
    }
    try {
      await openSteamUri(`steam://uninstall/${appid}`);
      log.info(`[steam-uninstall] opened steam://uninstall/${appid} id=${manifest.raw.id}`);
    } catch (cause) {
      this.sendError(`failed to open Steam uninstall: ${describe(cause)}`);
      return;
    }
    // Optimistically show "Uninstalling…": record the request and flip the UI. The poller clears it when
    // the .acf is gone (→ Install) or on timeout (assumed cancel → back to Play/Uninstall). enterReady
    // (re)arms the poller for the inserted steam card.
    this.steamUninstallRequest = { appid, since: Date.now() };
    this.enterReady({ ...info, steamUninstalling: true, canUninstall: false });
  }

  private async runLaunchSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const { state, window, stats } = this.deps;
    this.launchInFlight = true;
    const abort = new AbortController();
    this.abort = abort;
    // Declared before the try so `finally` can dispose the kept HANDLE (elevated path).
    let proc: GameProcess | null = null;
    try {
      // 1. SD→PC (if sync is configured). A missing card source is normal on first run (no saves yet),
      // so this direction only logs the attempt — no warning.
      state.set({ kind: 'syncing-in', game: info });
      if (manifest.pcSavePath !== undefined && manifest.saveOnCardPath !== undefined) {
        log.info(`[sync-in] copying saves card→PC "${manifest.saveOnCardPath}" → "${manifest.pcSavePath}"`);
        await syncDir(manifest.saveOnCardPath, manifest.pcSavePath);
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
        // launch on Steam actually being installed (I8) instead of relying on a reject.
        if ((await getSteamPath()) === null) {
          this.failLaunch(info, 'Steam is not installed');
          return;
        }
        try {
          await openSteamUri(`steam://rungameid/${manifest.steam.appid}`);
        } catch (cause) {
          this.failLaunch(info, `failed to launch via Steam: ${describe(cause)}`);
          return;
        }
        // No launcher pid → null. watchProcesses is guaranteed non-empty by the schema in steam mode.
        const { started } = await waitForWatchedStart(
          null,
          watchProcesses ?? [],
          manifest.raw.launchTimeoutSec,
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
        state.set({ kind: 'running', game: info, since });
        log.info(`[launch] running (steam) id=${manifest.raw.id} appid=${manifest.steam.appid}`);
        await waitForWatchedExit(watchProcesses ?? [], abort.signal);
        log.info(`[launch] exited (steam) id=${manifest.raw.id}`);
      } else {
        // 2. launch → GameProcess (spawn, or elevated ShellExecuteEx per manifest.runAsAdmin)
        state.set({ kind: 'launching', game: info });
        try {
          proc = await launchGame(manifest);
        } catch (cause) {
          this.failLaunch(info, `failed to launch the game: ${describe(cause)}`);
          return;
        }
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
      this.enterReady(updatedInfo);
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
      this.enterReady(installedInfo);
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
    this.enterReady(game);
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
        this.setHero(null);
        state.set({ kind: 'idle' });
        window.hide();
        return;
      }

      // Done: rebuild GameInfo so requiresInstall recomputes true and canUninstall false (the executable
      // is gone) → the button flips back to "Install" and "Uninstall" disappears.
      const currentStats = await stats.read(manifest.raw.id);
      const updatedInfo = await this.buildGameInfo(manifest, currentStats);
      log.info(`[uninstall] completed id=${manifest.raw.id} dir="${install.dir}"`);
      this.enterReady(updatedInfo);
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
    this.enterReady(game);
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
    this.enterReady(game);
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
      this.stopSteamInstallWatch();
      this.current = null;
      this.setAudio(null);
      this.setHero(null);
      this.deps.state.set({ kind: 'idle' });
      this.deps.window.hide();
      return;
    }
    this.enterReady(game);
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
      // Diagnostic (silent-failure guard): syncDir no-ops when the source is missing. If the PC save
      // folder doesn't exist after a play session, pcSavePath is almost certainly wrong in game.json
      // (e.g. %APPDATA% used for an AppData\LocalLow path) — warn instead of failing silently.
      if (!(await fse.pathExists(manifest.pcSavePath))) {
        log.warn(
          `[sync-out] pcSavePath does not exist — nothing copied to the card. Check the manifest path: "${manifest.pcSavePath}"`,
        );
      } else {
        try {
          log.info(`[sync-out] copying saves PC→card "${manifest.pcSavePath}" → "${manifest.saveOnCardPath}"`);
          await syncDir(manifest.pcSavePath, manifest.saveOnCardPath);
        } catch (cause) {
          // The card may have been yanked during the sync → saves.bak is intact, we'll finish on insertion.
          log.warn('[sync-out] failed, deferring to pending-flush:', describe(cause));
          await this.deps.store.enqueuePcToSd(id, manifest.pcSavePath);
          return;
        }
      }
    }
    await this.deps.stats.copyToCard(manifest.root, stats);
  }

  // ── Building GameInfo for the UI ─────────────────────────────────────────

  private async buildGameInfo(manifest: ResolvedManifest, stats: Stats): Promise<GameInfo> {
    // Hero images are NOT part of GameInfo anymore — they travel on the hero:update channel (see
    // readHeroAssets / setHero), delivered once per card on insert (not on every state transition).
    // Three mutually-exclusive modes decide requiresInstall/canUninstall/installVia. Kept as an EXPLICIT
    // 3-way branch (not the old `install !== undefined && !installed` formula, which gives false for a
    // steam game and would always show "Play"). executablePath is only read by pathExists in the
    // install/normal branches, where it is real (in steam mode it is '' and we never reach that read).
    let requiresInstall: boolean;
    let canUninstall: boolean;
    let installVia: 'steam' | undefined;
    let steamInstalling = false;
    let steamPaused = false;
    let steamPausedProgress: number | undefined;
    if (manifest.steam !== undefined) {
      // Steam mode: "installed" is Steam's own .acf state; uninstall is managed in Steam (never here).
      const status = await steamInstallStatus(manifest.steam.appid);
      requiresInstall = status.state !== 'installed';
      // Steam uninstall is delegated to Steam (steam://uninstall) — available once installed.
      canUninstall = status.state === 'installed';
      installVia = 'steam';
      // Non-blocking "Installing…" indicator while Steam is downloading (no live percent — see types.ts);
      // `paused` flips it to "Installing paused on N%…" using the snapshot percent.
      steamInstalling = status.state === 'downloading';
      steamPaused = status.state === 'downloading' && status.paused;
      steamPausedProgress = status.state === 'downloading' ? (status.progress ?? undefined) : undefined;
    } else if (manifest.install !== undefined) {
      // Card-install mode: installed ⇔ the resolved executable exists; that also enables Uninstall.
      const installed = await fse.pathExists(manifest.executablePath);
      requiresInstall = !installed;
      canUninstall = installed;
      installVia = undefined;
    } else {
      // Normal card game: always ready to play, nothing to uninstall.
      requiresInstall = false;
      canUninstall = false;
      installVia = undefined;
    }
    return {
      id: manifest.raw.id,
      title: manifest.raw.title,
      lastPlayedAt: stats.lastPlayedAt,
      totalPlaySeconds: stats.totalPlaySeconds,
      launchCount: stats.launchCount,
      requiresInstall,
      canUninstall,
      ...(manifest.install !== undefined ? { installDir: manifest.install.dir } : {}),
      ...(installVia !== undefined ? { installVia } : {}),
      ...(steamInstalling ? { steamInstalling: true } : {}),
      ...(steamPaused ? { steamPaused: true } : {}),
      ...(steamPausedProgress !== undefined ? { steamPausedProgress } : {}),
    };
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

  // ── Hero images (delivered once per card, rotated in the renderer) ───────

  /** Stores the current hero images and pushes them to the window (null when no card / on error). */
  private setHero(assets: HeroAssets | null): void {
    this.currentHero = assets;
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.heroUpdate, assets);
    }
  }

  /**
   * Reads all of the manifest's hero images into data URLs, dropping any that fail to read. When none
   * remain (no heroImage, or every file unreadable) it falls back to the bundled wallpaper — so the
   * result always carries at least one image (same fallback semantics as the old single-hero path).
   */
  private async readHeroAssets(manifest: ResolvedManifest): Promise<HeroAssets> {
    const images: string[] = [];
    for (const heroPath of manifest.heroImagePaths ?? []) {
      const url = await this.readImageDataUrl(heroPath);
      if (url !== undefined) images.push(url);
      else log.warn('[hero-image] failed to read, skipping:', heroPath);
    }
    if (images.length === 0) {
      const wallpaper = await this.readWallpaperDataUrl();
      if (wallpaper !== null) images.push(wallpaper);
    }
    return { images };
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
