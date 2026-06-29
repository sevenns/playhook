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
  waitForExit,
  waitForStart,
  waitForWatchedExit,
  waitForWatchedStart,
  LaunchAbortedError,
  type GameProcess,
} from './game-launcher';
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

export class GameController {
  private current: ResolvedManifest | null = null;
  private cardPresent = false;
  private launchInFlight = false;
  private abort: AbortController | null = null;
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
      kind === 'syncing-in' ||
      kind === 'syncing-out'
    ) {
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
    void this.runLaunchSequence(manifest, snapshot.game);
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
    }
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
    return {
      id: manifest.raw.id,
      title: manifest.raw.title,
      lastPlayedAt: stats.lastPlayedAt,
      totalPlaySeconds: stats.totalPlaySeconds,
      launchCount: stats.launchCount,
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
