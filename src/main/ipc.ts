// Flow orchestrator + IPC registration.
// This is where the state machine lives: the controller listens to drive-watcher, reacts to
// the "Launch" action from the renderer, runs the sequence sync→spawn→wait→sync
// and replicates AppState to the window. All FS/process work happens only here (in main).
import path from 'node:path';
import fse from 'fs-extra';
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import {
  IPC,
  type AppState,
  type AudioAssets,
  type GameInfo,
  type GameLibrary,
  type HeroAssets,
  type InstallManifest,
  type LaunchTarget,
  type ResolvedManifest,
  type Stats,
  type WallpaperResult,
} from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { type StateManager } from './state';
import { type GameWindow } from './window';
import { type PcStore } from './pc-store';
import { type StatsService } from './stats';
import { type DriveWatcher } from './drive-watcher';
import { readManifests, type ManifestEnv } from './manifest';
import { syncDir, syncByChange, snapshotTree } from './save-sync';
import {
  launchGame,
  launchInstaller,
  launchUninstaller,
  waitForExit,
  waitForStart,
  waitForWatchedExit,
  waitForWatchedStart,
  killImageByName,
  anyImageAlive,
  killImagesElevated,
  LaunchAbortedError,
  type GameProcess,
} from './game-launcher';
import { findUninstallEntry, getSteamPath } from './registry';
import { steamInstallStatus, openSteamUri } from './steam';
import { AssetReader } from './asset-reader';
import { type AppSettingsStore } from './app-settings';
import { focusGameWindow } from './window-finder';
import { normalizeImageNames } from './image-names';
import { SteamInstallWatch } from './steam-install-watch';
import { describe, delay } from './util';
import { log } from './logger';

export interface ControllerDeps {
  readonly state: StateManager;
  readonly window: GameWindow;
  readonly store: PcStore;
  readonly stats: StatsService;
  readonly watcher: DriveWatcher;
  /** App-wide settings store — read/patched by the custom-wallpaper handlers (they own AssetReader). */
  readonly settings: AppSettingsStore;
  /** The current translator (read live so a language change applies to freshly-generated messages). */
  readonly getTranslator: () => Translator;
}

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

// Directory removal retries: an Inno uninstaller forks a copy of itself into
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
 * Resolves what to launch to uninstall an install-mode game: FS search in the install dir first
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
 * Removes a directory with a few backed-off retries: the forked Inno uninstaller may still hold
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
  // A card carries one OR MANY games (game.json is an object or an array). `games` holds every resolved
  // game; `selectedIndex` is the one currently selected/browsed. `current()` (below) derives the single
  // "active" manifest that all the existing launch/kill/uninstall/save-sync/stats code reads, so those
  // bodies stay untouched. Empty (`games=[]`) whenever no card / rejected.
  private games: ResolvedManifest[] = [];
  private selectedIndex = 0;
  // True while a game is launching/running: main is "locked" on that game — a game switch is refused and
  // the renderer hides the "Select game" button (its guard is `kind==='ready'`). Set in runLaunchSequence.
  private locked = false;
  private cardPresent = false;
  // Mirror of AppSettings.alwaysShowEmptyScreen (seeded at startup, toggled live from the settings
  // window): when true the launcher stays on the empty "no card" screen instead of hiding to the tray.
  private alwaysShowEmptyScreen = false;
  private launchInFlight = false;
  // A manifest reload from the Configure-game window is in flight. Unlike launchInFlight it does NOT
  // gate on state kind (the reload runs from `ready`), so onLaunchRequested/onUninstallRequested check
  // it explicitly: during the reload's awaits (readManifest + hero/audio on a slow SD — hundreds of ms)
  // the state stays `ready`, and a gamepad Play would otherwise start a game mid-reload (enterReady over
  // launching). Only the reload path is raced like this — an ordinary insert never is.
  private reloadInFlight = false;
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
  // Audio for the current card, sent on its own channel (not on every AppState) — see AudioAssets.
  private currentAudio: AudioAssets | null = null;
  // Hero images for the current card, sent on their own channel (not on every AppState) — see HeroAssets.
  private currentHero: HeroAssets | null = null;
  // The light list of games ({id,title}) on the current card, delivered once per card on its own channel
  // so the renderer can render the "Select game" popup. Null when no card. (The SELECTED game's heavy
  // assets travel on hero:update/audio:update/state:update, only for the one game on screen.)
  private currentLibrary: GameLibrary | null = null;
  // The reconciled Stats per game id, captured in loadCard so onSelectRequested can rebuild the selected
  // game's GameInfo without re-reading stats (buildGameInfo still re-reads the .acf for a steam game).
  private statsById = new Map<string, Stats>();
  // Reads card assets (hero/audio/wallpaper) into data URLs; owns the effective-wallpaper cache and the
  // custom Empty-screen wallpaper (needs userData + the live custom-file name from settings via DI).
  private readonly assets = new AssetReader({
    userData: app.getPath('userData'),
    getCustomWallpaperName: async () => (await this.deps.settings.read()).customWallpaper,
  });
  // Steam-mode background re-detect poller (timer + tick + optimistic uninstall request), extracted from
  // this controller. Reaches back only through the narrow accessor seam below.
  private readonly steamWatch = new SteamInstallWatch({
    getManifest: () => this.current(),
    isLaunchInFlight: () => this.launchInFlight,
    getState: () => this.deps.state.get(),
    isCardPresent: () => this.cardPresent,
    enterReady: (info) => this.enterReady(info),
  });

  constructor(private readonly deps: ControllerDeps) {}

  /** The current translator (a message is fixed at the language of the moment it is generated). */
  private get t(): Translator {
    return this.deps.getTranslator();
  }

  /**
   * The single "active" manifest — the selected game — that every existing consumer reads
   * (launch/kill/uninstall/save-sync/stats). Read-only: the card's games live in `games`, the choice in
   * `selectedIndex`. Null when there is no card / it was rejected.
   */
  private current(): ResolvedManifest | null {
    return this.games[this.selectedIndex] ?? null;
  }

  /** Clears all card-scoped state (games, selection, lock, audio/hero/library channels). The caller sets
   * the follow-up AppState (idle/error) and window visibility, exactly as before. */
  private clearCard(): void {
    this.games = [];
    this.selectedIndex = 0;
    this.locked = false;
    this.statsById.clear();
    this.setAudio(null);
    this.setHero(null);
    this.setLibrary(null);
  }

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
    ipcMain.handle(IPC.libraryRequest, (): GameLibrary | null => this.currentLibrary);
    ipcMain.handle(IPC.wallpaperRequest, (): Promise<string | null> => this.assets.readWallpaperDataUrl());
    // Custom Empty-screen wallpaper (invoked from the settings window; the handlers live here because they
    // own the AssetReader + the game window — see plan F2.2 p.6). preview-request feeds the settings preview.
    ipcMain.handle(IPC.wallpaperPick, (event): Promise<WallpaperResult> => this.pickWallpaper(event.sender));
    ipcMain.handle(IPC.wallpaperClear, (): Promise<{ dataUrl: string }> => this.clearWallpaper());
    ipcMain.handle(IPC.wallpaperPreviewRequest, async (): Promise<{ dataUrl: string }> => ({
      dataUrl: (await this.assets.readWallpaperDataUrl()) ?? '',
    }));
    ipcMain.on(IPC.actionLaunch, () => void this.onLaunchRequested());
    ipcMain.on(IPC.actionUninstall, () => void this.onUninstallRequested());
    ipcMain.on(IPC.actionHide, () => this.deps.window.hide());
    ipcMain.on(IPC.actionOpenSteamDownloads, () => void this.onOpenSteamDownloads());
    ipcMain.on(IPC.actionKill, () => void this.onKillRequested());
    ipcMain.on(IPC.actionSelect, (_event, id: unknown) => void this.onSelectRequested(id));
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
    this.steamWatch.stop();
    this.steamWatch.clearUninstallRequest();
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
      this.steamWatch.start();
    } else {
      this.steamWatch.stop();
    }
  }

  // ── Reaction to card insertion ───────────────────────────────────────────

  private async onInsert(root: string): Promise<void> {
    // A card was swapped in mid-flight (no empty tick). Don't process it now — that would race the
    // in-flight sequence. Stash it, abort the current flow; its finally replays this once it unwinds.
    if (this.launchInFlight) {
      log.info(`[insert] card swapped during launch/install — deferring root="${root}"`);
      this.pendingRoot = root;
      this.abort?.abort();
      return;
    }
    await this.loadCard(root, { focus: true });
  }

  /**
   * Reads a card at `root` and drives the launcher to `ready` for the selected game (single- or
   * multi-game card), or to `error` — the shared body of an ordinary insert AND a Configure-window reload.
   * A multi-game card exposes its other games through the "Select game" popup (the light game list). `focus`
   * controls whether the launcher pops to the front: true for a real insertion (unchanged behaviour), false
   * for a reload so an Apply from the Configure window doesn't steal focus from the editor. Returns the
   * readManifests verdict so the caller (reloadManifest) can report it; onInsert ignores it.
   */
  private async loadCard(
    root: string,
    opts: { readonly focus: boolean },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    this.cardPresent = true;
    log.info(`[insert] card detected at root="${root}"`);
    // Documents is resolved via the system Known Folder API (the same one the game uses),
    // so %DOCUMENTS% in the manifest maps to the real save folder regardless of UI
    // language or OneDrive redirection. Safe to read here — app is ready by now.
    const env: ManifestEnv = { documents: app.getPath('documents'), t: this.t };
    const result = await readManifests(root, env);
    if (!result.ok) {
      // No valid game determined → keep the window hidden (the reason is in the log). We still set
      // the error state so a manually-summoned window can show it, but we never auto-surface it.
      log.warn(`[insert] manifest rejected: ${result.message}`);
      this.clearCard();
      this.deps.state.set({ kind: 'error', message: result.message });
      this.deps.window.hide();
      return { ok: false, message: result.message };
    }
    const manifests = result.manifests;
    // Keep the selection on a reload if it still points at a game; a real insert starts at the first.
    this.selectedIndex = opts.focus || this.selectedIndex >= manifests.length ? 0 : this.selectedIndex;
    this.games = manifests;
    this.locked = false;
    log.info(`[insert] manifest ok games=${manifests.length} ids=[${manifests.map((m) => m.raw.id).join(',')}] root="${root}"`);

    // Read the card's traveling stats ONCE to detect the pre-multi-game bare-Stats format. Attribution of
    // that legacy value is decided HERE (only loadCard knows the game count): a single-game card owns it
    // unambiguously; on a multi-game card the owner is unknown → ignore it (the per-id PC mirror is intact).
    const cardStatsRead = await this.deps.stats.readCardStatsMap(root);
    let legacyForSingle: Stats | null = null;
    if (cardStatsRead.kind === 'legacy') {
      if (manifests.length === 1) legacyForSingle = cardStatsRead.stats;
      else log.warn(`[stats] legacy bare card stats on a ${manifests.length}-game card — owner ambiguous, ignoring (PC mirror per-id is intact)`);
    }

    // Reconcile + copy card stats for EVERY game FIRST (so each PC mirror holds the merged value before
    // anything writes the card), caching the merged Stats per id so onSelectRequested can rebuild the
    // switched-to game's GameInfo without re-reading. Order matters vs the flush below.
    this.statsById.clear();
    for (const manifest of manifests) {
      const stats = await this.deps.stats.reconcileWithCard(manifest.raw.id, root, legacyForSingle);
      await this.deps.stats.copyToCard(root, manifest.raw.id, stats);
      this.statsById.set(manifest.raw.id, stats);
    }

    // If a card was yanked mid-game last time — top up the deferred PC→SD (saves snapshot) for ANY game
    // that has a pending flush, not just the selected one (else game B's flush hangs until B is selected on
    // some future insert). Runs AFTER all reconciles so each flush's stats copy uses the merged value.
    for (const manifest of manifests) {
      try {
        await this.flushPendingIfAny(manifest);
      } catch (cause) {
        log.warn(`[pending-flush] failed on insert for id=${manifest.raw.id}:`, describe(cause));
      }
    }

    // Deliver the LIGHT game list ({id,title}) for the "Select game" popup — one entry per game, no heavy
    // assets. The selected game's hero/audio/info are built on demand below (and in onSelectRequested).
    this.setLibrary({ games: manifests.map((m) => ({ id: m.raw.id, title: m.raw.title })) });

    // Always enter `ready` for the selected game (single- or multi-game card). Its hero/audio go out on the
    // existing per-game channels; the popup handles switching between the card's games.
    const selected = manifests[this.selectedIndex] ?? manifests[0];
    if (selected !== undefined) {
      const stats = this.statsById.get(selected.raw.id) ?? (await this.deps.stats.read(selected.raw.id));
      this.setAudio(await this.assets.readAudioAssets(selected));
      this.setHero(await this.assets.readHeroAssets(selected));
      this.enterReady(await this.buildGameInfo(selected, stats));
    }
    if (opts.focus) this.deps.window.showAndFocus();
    return { ok: true };
  }

  /**
   * Applies an edited game.json to the ACTIVE card without restarting the app (Configure-game window).
   * Re-reads the manifest through the same loadCard path an insert uses (readManifest → stats reconcile
   * → audio/hero → buildGameInfo → enterReady | error), so nothing is duplicated and the steam poller's
   * stale-guard still holds. Focus is NOT taken (opts.focus=false), so the editor keeps it.
   *
   * Two guards: (1) on ENTRY — refuse unless idle/ready/error and not launchInFlight (busy guard, like
   * UpdaterService.install; also prevents killing an in-flight sequence, since onInsert would abort it);
   * (2) reloadInFlight for the DURATION — checked by onLaunchRequested/onUninstallRequested so a gamepad
   * Play/Uninstall can't slip in during the reload's awaits.
   */
  async reloadManifest(root: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const kind = this.deps.state.get().kind;
    if ((kind !== 'ready' && kind !== 'error' && kind !== 'idle') || this.launchInFlight) {
      return { ok: false, message: this.t('errors.finishBeforeApply') };
    }
    if (this.reloadInFlight) return { ok: false, message: this.t('errors.reloadInProgress') };
    this.reloadInFlight = true;
    try {
      return await this.loadCard(root, { focus: false });
    } finally {
      this.reloadInFlight = false;
    }
  }

  private async flushPendingIfAny(manifest: ResolvedManifest): Promise<void> {
    if (manifest.saveOnCardPath === undefined) return;
    const pending = await this.deps.store.getPending(manifest.raw.id);
    if (pending === null) return;
    // Direct, NOT change-based (deliberate — see the plan, part B): the snapshot exists precisely because
    // the card was yanked mid-game and we are OBLIGED to top up the promised PC progress onto the card.
    // LWW here would silently drop that flush if the card looked "unchanged"/newer, so keep it a plain
    // snapshot→card replace.
    await syncDir(pending.savesSnapshotDir, manifest.saveOnCardPath);
    const stats = await this.deps.stats.read(manifest.raw.id);
    await this.deps.stats.copyToCard(manifest.root, manifest.raw.id, stats);
    await this.deps.store.clearPending(manifest.raw.id);
    // The card now holds the flushed progress, so both sides are back in sync. Rebase the baseline from
    // the real folders (each in its own mtime scale) so the next launch sees them as synced, not as a
    // spurious card-side change that would trigger a needless card→PC.
    await this.rebaseSyncStateAfterFlush(manifest);
  }

  /** Records a fresh sync baseline from both real save folders (used after a direct pending-flush). */
  private async rebaseSyncStateAfterFlush(manifest: ResolvedManifest): Promise<void> {
    const cardPath = manifest.saveOnCardPath;
    const pcPath = manifest.pcSavePath;
    if (cardPath === undefined || pcPath === undefined) return;
    await this.deps.store.writeSyncState(manifest.raw.id, {
      card: await snapshotTree(cardPath),
      pc: await snapshotTree(pcPath),
      syncedAt: Date.now(),
    });
  }

  // ── Reaction to card removal ─────────────────────────────────────────────

  private onRemove(): void {
    this.cardPresent = false;
    const kind = this.deps.state.get().kind;
    // During play/sync, removal is expected: the flow continues, sync-out
    // will see cardPresent=false and put the task into pending-flush. We don't touch state.
    if (
      kind === 'running' ||
      kind === 'launching' ||
      kind === 'installing' ||
      kind === 'uninstalling' ||
      kind === 'syncing-in' ||
      kind === 'syncing-out'
    ) {
      // During install, removal is also expected: the installer reads from the card, so yanking
      // it makes the install fail → <exe> won't appear → we stay on "Install"; next attempt pre-cleans.
      // During uninstall it targets the PC, so it completes; runUninstallSequence then sees cardPresent
      // = false and goes idle + hide on its own.
      return;
    }
    // ready / error / idle → no card. Stop any Steam re-detect poller (the card is gone; a Steam game in
    // `ready` reaches here since its kind is never running/installing).
    this.steamWatch.stop();
    this.steamWatch.clearUninstallRequest();
    this.clearCard();
    this.deps.state.set({ kind: 'idle' });
    // Normally the background app hides to the tray when no card is present. With "always show the no-card
    // screen" on, keep the launcher up on the empty screen instead — BUT only if it's currently on screen.
    // If the user minimized it to the tray, pulling the card must not pop it back up (respect that intent).
    if (this.alwaysShowEmptyScreen) {
      if (this.deps.window.isShown()) this.deps.window.showAndFocus();
    } else {
      this.deps.window.hide();
    }
  }

  /**
   * Applies the "always show the no-card screen" setting (seeded at startup, toggled live from the
   * settings window). Besides caching the flag it reconciles the launcher NOW when we're idle with no
   * card: show the empty screen when turning it on, or hide back to the tray when turning it off. When a
   * card is present (ready/busy) nothing changes — the launcher is already visible for the game.
   */
  setAlwaysShowEmptyScreen(on: boolean): void {
    this.alwaysShowEmptyScreen = on;
    if (this.cardPresent || this.deps.state.get().kind !== 'idle') return;
    if (on) this.deps.window.showAndFocus();
    else this.deps.window.hide();
  }

  // ── "Launch" action (the A button / click) ──────────────────────────────

  private onLaunchRequested(): void {
    const snapshot = this.deps.state.get();
    // Play pressed while a game is running (the launcher was summoned over it via the tray): return to the
    // game instead of launching. Checked BEFORE the ready-guard — launchInFlight is true during running,
    // but we never reach its check. No-op if we don't have the image names yet.
    if (snapshot.kind === 'running') {
      this.resumeRunningGame();
      return;
    }
    // Ignore input outside the ready state — this is the "ignore-gamepad" during play
    // (harmless under any interpretation of the Gamepad API focus bug).
    if (snapshot.kind !== 'ready' || this.launchInFlight || this.reloadInFlight) return;
    const manifest = this.current();
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

  /**
   * Return-to-game: raise the running game's own window to the foreground (restoring it if it minimized
   * when it lost focus). Best-effort — if the window isn't found (the game is already closing, a race with
   * waitForExit) it's a silent no-op; the state machine will move to syncing-out → ready on its own.
   */
  private resumeRunningGame(): void {
    const names = this.runningImageNames;
    if (names === null) return;
    if (!focusGameWindow(names)) {
      log.info('[resume] running game window not found — no-op (it may be closing)');
    }
  }

  /**
   * "Select game" popup → a game was picked (renderer sent action:select with the game id). Switches to
   * it: builds that game's hero/audio/GameInfo on demand (only the selected game ever gets heavy assets)
   * and enters `ready`. Selection is by id (not index) so a card reload that reorders games can't pick the
   * wrong one. Rejected unless we're on `ready` and idle (not locked / launching / reloading) — the same
   * guard the "Select game" button already enforces, so you can't switch while a game is running.
   */
  private async onSelectRequested(idRaw: unknown): Promise<void> {
    if (typeof idRaw !== 'string') return;
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'ready' || this.locked || this.launchInFlight || this.reloadInFlight) return;
    const index = this.games.findIndex((m) => m.raw.id === idRaw);
    if (index === -1) {
      log.warn(`[select] no game with id="${idRaw}" on the current card — ignoring`);
      return;
    }
    const manifest = this.games[index];
    if (manifest === undefined) return;
    this.selectedIndex = index;
    // Build the switched-to game's assets on demand (mirrors loadCard). Stats come from the loadCard cache
    // (buildGameInfo still re-reads a steam game's .acf); fall back to a fresh read if somehow absent.
    const stats = this.statsById.get(manifest.raw.id) ?? (await this.deps.stats.read(manifest.raw.id));
    this.setHero(await this.assets.readHeroAssets(manifest));
    this.setAudio(await this.assets.readAudioAssets(manifest));
    this.enterReady(await this.buildGameInfo(manifest, stats));
  }

  /**
   * Force-close the running game (More → Force close → confirmed Yes). Flips the running snapshot into its
   * `killing` sub-state (the launcher shows "Force closing…" and hides the Force close button), kills the
   * main executable AND every watchProcess, then lets the EXISTING exit waiters (waitForExit /
   * waitForWatchedExit) notice the processes vanish and carry the flow through syncing-out → sync → ready
   * (K-Д3) — no state machine of its own. Guarded by the running state + a killInFlight flag (double Yes /
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
  private async onKillRequested(): Promise<void> {
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'running') return; // only meaningful while a game is running
    if (this.killInFlight) return; // a force-close is already underway (double Yes / repeat)
    const manifest = this.current();
    if (manifest === null) return; // defensive: `running` always has a current manifest
    this.killInFlight = true;
    // Show "Force closing…" and hide the Force close button immediately (cleared back on failure).
    this.deps.state.set({ ...snapshot, killing: true });
    try {
      // Targets are computed HERE from this.current, leaving runningImageNames untouched: a union there
      // would regress return-to-game (focusGameWindow picks the first Z-order match — the launcher name
      // could steal focus from the game). Steam's executablePath is '' and drops out in normalization.
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
          log.warn('[kill] owned-process kill failed (continuing to taskkill by name):', describe(cause));
        }
      }

      // 2. taskkill /F /IM per target image name (non-elevated). Per-name failures are normal ("not
      //    found" = already dead); the verdict is the control poll below, not these exit codes.
      for (const name of targets) {
        await killImageByName(name);
      }

      // 2b. Elevated escalation (runAsAdmin games only). A non-elevated taskkill / the ShellExecuteEx
      //     HANDLE can't terminate high-integrity processes, so if the targets survive a short grace we
      //     run ONE elevated `taskkill /F /T /IM …` (a single UAC prompt). Non-elevated games never reach
      //     here (no UAC for them). A declined UAC just leaves the targets up → killFailed below.
      if (manifest.raw.runAsAdmin && (await this.killTargetsStillAlive(targets, proc, KILL_ELEVATE_GRACE_SEC))) {
        log.info(`[kill] elevated game survived non-elevated kill id=${manifest.raw.id} — escalating to elevated taskkill (UAC)`);
        killImagesElevated(targets);
      }

      // 3. Fact-based verdict over a window bounded by killTimeoutSec (a killed process lingers in
      //    tasklist for a beat — a single instant snapshot would false-positive). killFailed only if
      //    something is STILL alive when the window elapses.
      if (await this.killTargetsStillAlive(targets, proc, manifest.raw.killTimeoutSec)) {
        log.warn(`[kill] targets still alive after force-close id=${manifest.raw.id} — reporting killFailed`);
        // The game is still up → back to plain running (status "Running…", Force close button returns),
        // then surface the error. Re-read in case a waiter advanced the state (then leave it be).
        const current = this.deps.state.get();
        if (current.kind === 'running') this.deps.state.set({ ...current, killing: false });
        this.sendError(this.t('errors.killFailed'));
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
      if (!ownedAlive && !(await anyImageAlive(targets))) return false;
      if (Date.now() >= deadline) return true; // window elapsed and something is still alive → real fail
      await delay(KILL_VERIFY_INTERVAL_MS);
    }
  }

  /** "Uninstall" action (the user confirmed in the popup). Only for an installed install-mode game. */
  private onUninstallRequested(): void {
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'ready' || this.launchInFlight || this.reloadInFlight) return;
    const manifest = this.current();
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
   * repeated `steam://install` calls, so no debounce is needed. Pre-checks getSteamPath: openExternal
   * doesn't reliably reject when steam:// is unregistered.
   */
  private async runSteamInstall(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const appid = manifest.steam?.appid;
    if (appid === undefined) return; // defensive: onLaunchRequested only calls this in steam mode
    if ((await getSteamPath()) === null) {
      this.sendError(this.t('errors.steamNotInstalled'));
      return;
    }
    try {
      await openSteamUri(`steam://install/${appid}`);
      log.info(`[steam-install] opened steam://install/${appid} id=${manifest.raw.id}`);
    } catch (cause) {
      this.sendError(this.t('errors.steamOpenInstall', { cause: describe(cause) }));
      return;
    }
    // Ensure the re-detect poller is running so the button flips to "Play" when the download completes
    // (no-op if already running; info confirms this is a steam game still requiring install).
    if (info.installVia === 'steam' && info.requiresInstall && this.cardPresent) {
      this.steamWatch.start();
    }
  }

  /**
   * Steam uninstall action: fire-and-forget, mirroring runSteamInstall. Opens `steam://uninstall/<appid>`
   * (Steam shows its own confirmation/removal UI) and returns WITHOUT a blocking `uninstalling` state. We
   * stay on the `ready` ("Play"/"Uninstall") screen; the background poller flips the button back to
   * "Install" once Steam removes the .acf. Pre-checks getSteamPath.
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
      this.sendError(this.t('errors.steamOpenDownloads', { cause: describe(cause) }));
    }
  }

  private async runSteamUninstall(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const appid = manifest.steam?.appid;
    if (appid === undefined) return; // defensive: onUninstallRequested only calls this in steam mode
    if ((await getSteamPath()) === null) {
      this.sendError(this.t('errors.steamNotInstalled'));
      return;
    }
    try {
      await openSteamUri(`steam://uninstall/${appid}`);
      log.info(`[steam-uninstall] opened steam://uninstall/${appid} id=${manifest.raw.id}`);
    } catch (cause) {
      this.sendError(this.t('errors.steamOpenUninstall', { cause: describe(cause) }));
      return;
    }
    // Optimistically show "Uninstalling…": record the request and flip the UI. The poller clears it when
    // the .acf is gone (→ Install) or on timeout (assumed cancel → back to Play/Uninstall). enterReady
    // (re)arms the poller for the inserted steam card.
    this.steamWatch.requestUninstall(appid);
    this.enterReady({ ...info, steamUninstalling: true, canUninstall: false });
  }

  private async runLaunchSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const { state, window, stats } = this.deps;
    this.launchInFlight = true;
    // Lock the launcher on this game for the launching→running span: a game switch is refused and the
    // "Select game" button is hidden. Cleared in the finally alongside the other running-scoped fields.
    this.locked = true;
    const abort = new AbortController();
    this.abort = abort;
    // Declared before the try so `finally` can dispose the kept HANDLE (elevated path).
    let proc: GameProcess | null = null;
    try {
      // 1. Change-based sync before the game (phase = sync-in). No longer a blind card→PC: if the PC
      // saves changed since the last sync (e.g. played on another PC last, or this PC is newer) they are
      // NOT overwritten — the changed side wins (see save-sync change-detection). The old card→PC is only
      // the first-run fallback (no baseline yet).
      state.set({ kind: 'syncing-in', game: info });
      if (manifest.pcSavePath !== undefined && manifest.saveOnCardPath !== undefined) {
        // Soft catch: sync-in can now WRITE to the card (change-detection may pick PC→card) — a new
        // failure point BEFORE launch (a full / write-protected / slow card). The launch never depended
        // on a card write before, so keep it that way: log and start the game regardless (mirrors sync-out).
        try {
          log.info(
            `[sync-in] change-based sync between card "${manifest.saveOnCardPath}" and PC "${manifest.pcSavePath}"`,
          );
          await this.runSaveSync(manifest, 'card-to-pc');
        } catch (cause) {
          log.warn('[sync-in] change-based sync failed, launching anyway:', describe(cause));
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
        if ((await getSteamPath()) === null) {
          this.failSequence('launch', info, this.t('errors.steamNotInstalled'));
          return;
        }
        try {
          await openSteamUri(`steam://rungameid/${manifest.steam.appid}`);
        } catch (cause) {
          this.failSequence('launch', info, this.t('errors.launchViaSteam', { cause: describe(cause) }));
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
        this.runningImageNames = normalizeImageNames(watchProcesses ?? []);
        // Steam owns no process of ours (steam://rungameid returns instantly) — a force-close relies on
        // taskkill /IM over the watchProcesses alone.
        this.runningProc = null;
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
          this.failSequence('launch', info, this.t('errors.launchGame', { cause: describe(cause) }));
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
          this.runningImageNames = normalizeImageNames(watchProcesses);
          // The spawned launcher (proc) — usually already dead here; kept so a force-close can also take
          // down its pid tree. The game itself is killed by taskkill /IM over the watchProcesses.
          this.runningProc = proc;
          state.set({ kind: 'running', game: info, since });
          log.info(`[launch] running (watched) id=${manifest.raw.id} watch=${watchProcesses.join(',')}`);
          await waitForWatchedExit(watchProcesses, abort.signal);
          log.info(`[launch] exited (watched) id=${manifest.raw.id}`);
        } else {
          const started = await waitForStart(proc, manifest.raw.launchTimeoutSec, abort.signal);
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
      this.failSequence('launch', info, describe(cause));
    } finally {
      // Release the elevated HANDLE (no-op for the normal spawn path).
      proc?.dispose();
      this.launchInFlight = false;
      // The game is done → unlock (game switching allowed again, "Select game" button reappears).
      this.locked = false;
      this.abort = null;
      // The game is no longer running → forget its image names (return-to-game only applies while running).
      this.runningImageNames = null;
      // Drop the owned-process reference (proc.dispose() above is the single owner-side release; this is
      // just the reference the force-close used while running).
      this.runningProc = null;
      // Replay a card that was swapped in mid-flight, now that launchInFlight has cleared.
      this.resumePendingInsert();
    }
  }

  /**
   * Runs the installer for an install-mode game that isn't installed yet (mirrors runLaunchSequence's
   * infrastructure: launchInFlight/abort, the LaunchAbortedError guard, the pendingRoot replay).
   * Pre-cleans the install dir, runs the installer silently, then grace-polls for the executable —
   * on success the button becomes "Play"; otherwise we stay on "Install" and surface the reason.
   */
  private async runInstallSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const install = manifest.install;
    if (install === undefined) return; // defensive: onLaunchRequested only calls this in install mode
    const { state, window, stats } = this.deps;
    this.launchInFlight = true; // set/cleared explicitly, like runLaunchSequence
    const abort = new AbortController();
    this.abort = abort;
    let proc: GameProcess | null = null;
    try {
      state.set({ kind: 'installing', game: info });

      // Pre-clean: a partial install left by a previous failed attempt could carry a stale <exe> →
      // a bogus "Play". We're (re)installing anyway, so a clean directory is safe.
      await fse.remove(install.dir);

      try {
        proc = await launchInstaller(install);
      } catch (cause) {
        this.failSequence('install', info, this.t('errors.startInstaller', { cause: describe(cause) }));
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
        this.failSequence('install', info, this.t('errors.installIncomplete'));
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
      if (cause instanceof LaunchAbortedError) return; // aborted by shutdown or a card swap
      this.failSequence('install', info, describe(cause));
    } finally {
      proc?.dispose();
      this.launchInFlight = false;
      this.abort = null;
      this.resumePendingInsert();
    }
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
  private async runUninstallSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const install = manifest.install;
    if (install === undefined) return; // defensive: onUninstallRequested only calls this in install mode
    const { state, window, stats } = this.deps;
    this.launchInFlight = true; // set/cleared explicitly, like runInstallSequence
    const abort = new AbortController();
    this.abort = abort;
    let proc: GameProcess | null = null;
    try {
      state.set({ kind: 'uninstalling', game: info });

      // Run the game's own uninstaller if we can resolve one (FS search → registry fallback). Any
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
      // doesn't set state over the new card (the finally → resumePendingInsert handles it).
      if (abort.signal.aborted) return;

      // The card may have been yanked during the uninstall (it targets the PC, so it completed): no card
      // → idle + hide, mirroring abandonWatchedLaunch / onRemove's cleanup.
      if (!this.cardPresent) {
        this.clearCard();
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
      if (cause instanceof LaunchAbortedError) return; // aborted by shutdown or a card swap
      this.failSequence('uninstall', info, describe(cause));
    } finally {
      proc?.dispose();
      this.launchInFlight = false;
      this.abort = null;
      this.resumePendingInsert();
    }
  }

  /** Replays a card insertion deferred during an in-flight launch/install. No-op if none pending. */
  private resumePendingInsert(): void {
    const root = this.pendingRoot;
    if (root === null) return;
    this.pendingRoot = null;
    void this.onInsert(root);
  }

  /**
   * A launch/install/uninstall attempt failed: return to the 'ready' screen with the SAME info and
   * surface the reason in the error popup. The info is unchanged, so the flags recompute to the pre-attempt
   * button (launch → "Play", failed install → still "Install", failed uninstall → still "Uninstall"); the
   * user can read the error, close it (B / veil) and retry. Only the log prefix differs per phase.
   */
  private failSequence(phase: 'launch' | 'install' | 'uninstall', game: GameInfo, message: string): void {
    log.warn(`[${phase}] failed: ${message}`);
    this.enterReady(game);
    this.deps.window.showAndFocus();
    this.sendError(message);
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
    if (!this.cardPresent) {
      this.steamWatch.stop();
      this.clearCard();
      this.deps.state.set({ kind: 'idle' });
      this.deps.window.hide();
      return;
    }
    this.enterReady(game);
    this.deps.window.showAndFocus();
  }

  /**
   * Runs a bidirectional, change-based save sync (syncByChange) and persists the new baseline. The
   * `fallback` direction is used only on the FIRST run (no baseline yet): 'card-to-pc' for sync-in,
   * 'pc-to-card' for sync-out — i.e. the phase's old deterministic direction. Otherwise the direction is
   * chosen by which side changed since the last sync. A conflict (both changed) and a fallback are logged.
   * Throws propagate to the caller (sync-in swallows them softly; sync-out defers to pending-flush).
   */
  private async runSaveSync(
    manifest: ResolvedManifest,
    fallback: 'card-to-pc' | 'pc-to-card',
  ): Promise<void> {
    const cardPath = manifest.saveOnCardPath;
    const pcPath = manifest.pcSavePath;
    if (cardPath === undefined || pcPath === undefined) return;
    const id = manifest.raw.id;
    const baseline = await this.deps.store.readSyncState(id);
    const result = await syncByChange(cardPath, pcPath, baseline, fallback);
    if (result.conflict) {
      // The only branch that can lose data: both sides changed, LWW picked one. The losing side survives
      // only as syncDir's `<dest>.bak`. Logged loudly so it's visible in the diagnostics.
      log.warn(
        `[save-sync] CONFLICT id=${id}: both sides changed since last sync → ${result.direction} by LWW (losing side kept as <dest>.bak)`,
      );
    }
    log.info(
      `[save-sync] id=${id} direction=${result.direction}${result.usedFallback ? ' (fallback: no baseline)' : ''}`,
    );
    await this.deps.store.writeSyncState(id, result.state);
  }

  private async performSyncOut(manifest: ResolvedManifest, stats: Stats): Promise<void> {
    const id = manifest.raw.id;
    // The card is already removed (the expected scenario) → defer PC→SD into pending-flush.
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
          // Change-based sync after the game (phase = sync-out). The old blind PC→card is only the
          // first-run fallback; normally the changed side wins (this PC just played → usually PC→card).
          log.info(
            `[sync-out] change-based sync between PC "${manifest.pcSavePath}" and card "${manifest.saveOnCardPath}"`,
          );
          await this.runSaveSync(manifest, 'pc-to-card');
        } catch (cause) {
          // The card may have been yanked during the sync → saves.bak is intact, we'll finish on insertion.
          log.warn('[sync-out] failed, deferring to pending-flush:', describe(cause));
          await this.deps.store.enqueuePcToSd(id, manifest.pcSavePath);
          return;
        }
      }
    }
    await this.deps.stats.copyToCard(manifest.root, manifest.raw.id, stats);
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

  // ── Custom Empty-screen wallpaper ────────────────────────────────────────

  /**
   * Picks an image via the OS file dialog (parented to the settings window), copies it in as the custom
   * Empty-screen wallpaper, persists its file name, and pushes the new data URL to the launcher so the
   * Empty screen updates live. Cancellation and validation failures come back as a Result-union.
   */
  private async pickWallpaper(sender: WebContents): Promise<WallpaperResult> {
    const parent = BrowserWindow.fromWebContents(sender);
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    };
    const result =
      parent !== null ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const sourcePath = result.filePaths[0];
    if (result.canceled || sourcePath === undefined) return { ok: false, cancelled: true };
    const set = await this.assets.setCustomWallpaper(sourcePath);
    if (!set.ok) return { ok: false, message: this.wallpaperErrorMessage(set.reason) };
    await this.deps.settings.patch({ customWallpaper: set.fileName });
    this.pushWallpaper(set.dataUrl);
    return { ok: true, dataUrl: set.dataUrl };
  }

  /** Clears the custom wallpaper (settings + file), returns and pushes the default wallpaper data URL. */
  private async clearWallpaper(): Promise<{ dataUrl: string }> {
    const { dataUrl } = await this.assets.clearCustomWallpaper();
    await this.deps.settings.patch({ customWallpaper: null });
    this.pushWallpaper(dataUrl);
    return { dataUrl };
  }

  /**
   * Removes the custom wallpaper file and pushes the default to the launcher, for the general settings
   * Reset: reset() already wrote customWallpaper=null, but the FILE must still be deleted separately (see
   * plan F2.2 p.7). Called from main via the UpdaterService onWallpaperReset callback.
   */
  async resetCustomWallpaper(): Promise<void> {
    const { dataUrl } = await this.assets.clearCustomWallpaper();
    this.pushWallpaper(dataUrl);
  }

  /** Pushes the Empty-screen wallpaper data URL to the game window so it repaints the Empty screen live. */
  private pushWallpaper(dataUrl: string): void {
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.wallpaperUpdate, dataUrl);
    }
  }

  /** Maps an AssetReader failure reason to a localized, user-facing message for the settings window. */
  private wallpaperErrorMessage(reason: 'too-large' | 'not-image' | 'io'): string {
    switch (reason) {
      case 'too-large':
        return this.t('errors.wallpaperTooLarge');
      case 'not-image':
        return this.t('errors.wallpaperNotImage');
      case 'io':
        return this.t('errors.wallpaperFailed');
    }
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

  // ── Audio assets (sounds + background music) ─────────────────────────────

  /** Stores the current audio and pushes it to the window (null when no card / on error). */
  private setAudio(assets: AudioAssets | null): void {
    this.currentAudio = assets;
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.audioUpdate, assets);
    }
  }

  // ── Game list (the card's games as {id,title}, for the "Select game" popup; once per card) ──

  /** Stores the current game list and pushes it to the window (null when no card / on error). */
  private setLibrary(library: GameLibrary | null): void {
    this.currentLibrary = library;
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.libraryUpdate, library);
    }
  }
}
