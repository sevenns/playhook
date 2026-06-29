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
  type GameInfo,
  type ResolvedManifest,
  type Stats,
} from '../shared/types';
import { type StateManager } from './state';
import { type GameWindow } from './window';
import { type PcStore } from './pc-store';
import { type StatsService } from './stats';
import { type DriveWatcher } from './drive-watcher';
import { readManifest, type ManifestEnv } from './manifest';
import { syncDir } from './save-sync';
import { launchGame, waitForExit, waitForStart, LaunchAbortedError } from './game-launcher';

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

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class GameController {
  private current: ResolvedManifest | null = null;
  private cardPresent = false;
  private launchInFlight = false;
  private abort: AbortController | null = null;

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
    watcher.onError((error) => console.error('[drive-watcher]', error));

    ipcMain.handle(IPC.stateRequest, (): AppState => state.get());
    ipcMain.on(IPC.actionLaunch, () => void this.onLaunchRequested());
  }

  /** Stops the process waits and the watcher (on application exit). */
  shutdown(): void {
    this.abort?.abort();
    this.deps.watcher.stop();
  }

  // ── Reaction to card insertion ───────────────────────────────────────────

  private async onInsert(root: string): Promise<void> {
    this.cardPresent = true;
    // Documents is resolved via the system Known Folder API (the same one the game uses),
    // so %DOCUMENTS% in the manifest maps to the real save folder regardless of UI
    // language or OneDrive redirection. Safe to read here — app is ready by now.
    const env: ManifestEnv = { documents: app.getPath('documents') };
    const result = await readManifest(root, env);
    if (!result.ok) {
      this.current = null;
      this.deps.state.set({ kind: 'error', message: result.message });
      this.deps.window.showAndFocus();
      return;
    }
    const manifest = result.manifest;
    this.current = manifest;

    // If the card was yanked mid-game last time — top up the deferred PC→SD.
    try {
      await this.flushPendingIfAny(manifest);
    } catch (cause) {
      console.warn('[pending-flush] failed on insert:', describe(cause));
    }

    const stats = await this.deps.stats.read(manifest.raw.id);
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
    try {
      // 1. SD→PC (if sync is configured)
      state.set({ kind: 'syncing-in', game: info });
      if (manifest.pcSavePath !== undefined && manifest.saveOnCardPath !== undefined) {
        await syncDir(manifest.saveOnCardPath, manifest.pcSavePath);
      }

      // 2. spawn → pid
      state.set({ kind: 'launching', game: info });
      let pid: number;
      try {
        pid = await launchGame(manifest);
      } catch (cause) {
        state.set({ kind: 'error', game: info, message: `failed to launch the game: ${describe(cause)}` });
        window.showAndFocus();
        return;
      }

      // 3. wait for the process to appear within launchTimeoutSec
      const started = await waitForStart(pid, manifest.raw.launchTimeoutSec, abort.signal);
      if (!started) {
        state.set({ kind: 'error', game: info, message: 'the game did not start (process wait timed out)' });
        window.showAndFocus();
        return;
      }

      // 4. running: count time, gamepad input is ignored (outside ready). The window stays put —
      // the game takes the foreground on its own and simply covers the launcher, which avoids the
      // jerky hide/show flash. We grab the foreground back in step 6 once the game exits.
      const since = Date.now();
      state.set({ kind: 'running', game: info, since });
      await waitForExit(pid, abort.signal);

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
      state.set({ kind: 'error', game: info, message: describe(cause) });
      window.showAndFocus();
    } finally {
      this.launchInFlight = false;
      this.abort = null;
    }
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
        console.warn('[sync-out] failed, deferring to pending-flush:', describe(cause));
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

  private async readHeroDataUrl(heroImagePath: string | undefined): Promise<string | undefined> {
    if (heroImagePath === undefined) return undefined;
    try {
      const mime = IMAGE_MIME[path.extname(heroImagePath).toLowerCase()] ?? 'application/octet-stream';
      const buffer = await fse.readFile(heroImagePath);
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (cause) {
      console.warn('[hero-image] failed to read, skipping:', describe(cause));
      return undefined;
    }
  }
}
