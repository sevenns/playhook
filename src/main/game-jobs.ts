import path from 'node:path';
import fse from 'fs-extra';
import { ipcMain } from 'electron';
import { IPC, type ManifestSource } from '../shared/types';
import { type GameActivity } from '../shared/activity';
import { type Translator } from '../shared/i18n/index';
import type { ResolvedCopyInstall, ResolvedInstall, ResolvedManifest } from './manifest-types';
import { type ControllerActivities, type ControllerNotifications, type ProcessControl } from './controller-deps';
import { type GameProcess, type GameProcessLauncher } from './platform';
import { findCaseInsensitiveName } from './manifest';
import { LaunchAbortedError } from './launch-errors';
import { removeWithRetry } from './remove-with-retry';
import { describe } from './util';
import { log } from './logger';

const DEFAULT_MAX_PARALLEL_COPY_INSTALLS = 2;

const PARTIAL_SUFFIX = '.partial';

export type GameJobKind = 'install' | 'uninstall' | 'prefix-cleanup';

/** Why a job was stopped before it finished; `user` and `shutdown` are never reported as a failure. */
export type JobAbortReason = 'user' | 'card-removed' | 'shutdown' | 'game-gone';

/** What a caller may know about a job: whose it is, what it does, and where the game comes from. */
export interface GameJob {
  readonly id: string;
  readonly kind: GameJobKind;
  readonly source: ManifestSource;
}

interface Job extends GameJob {
  readonly title: string;
  readonly abort: AbortController;
  readonly body: (job: Job) => Promise<void>;
  readonly done: Promise<void>;
  readonly settle: () => void;
  proc: GameProcess | null;
  abortReason: JobAbortReason | null;
  running: boolean;
}

/** What the jobs need back from the launcher. */
export interface GameJobsHost {
  /** The id of the game the busy session is about, or null when no session is in flight. */
  sessionGameId(): string | null;
  /** A job changed what can be done with game `id` (Install / Play / Uninstall). */
  onGameChanged(id: string): void;
  isWindowFocused(): boolean;
  sendError(message: string): void;
}

export interface GameJobsDeps {
  readonly registry: ControllerActivities;
  readonly launcher: Pick<
    GameProcessLauncher,
    'prepareInstallDir' | 'resolveUninstaller' | 'launchUninstaller' | 'uninstallDir' | 'prefixCleanupDir'
  >;
  readonly processControl: Pick<ProcessControl, 'waitForExit'>;
  readonly notifications: ControllerNotifications;
  readonly getTranslator: () => Translator;
  readonly host: GameJobsHost;
  /** How many copy installs run at once; the rest wait as `queued`. */
  readonly maxParallelCopies?: number;
}

/** A failure the job reports with its own message rather than the cause's. */
class JobFailure extends Error {}

/** The copy-install limit: PLAYHOOK_MAX_PARALLEL_COPY_INSTALLS when it is a positive integer, otherwise 2. */
export function maxParallelCopyInstalls(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env['PLAYHOOK_MAX_PARALLEL_COPY_INSTALLS'] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PARALLEL_COPY_INSTALLS;
}

/** Where a copy install stages its files until they are complete: a sibling of the install dir. */
export function partialDirOf(installDir: string): string {
  return `${installDir}${PARTIAL_SUFFIX}`;
}

function throwIfAborted(job: Job): void {
  if (job.abort.signal.aborted) throw new LaunchAbortedError();
}

/**
 * Background installs and uninstalls, one per game and any number of games at once. Each job keeps its
 * own abort controller and process, shows itself as the game's activity in the registry, and never
 * touches the session's AppState or the window.
 */
export class GameJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly maxParallelCopies: number;

  constructor(private readonly deps: GameJobsDeps) {
    this.maxParallelCopies = deps.maxParallelCopies ?? maxParallelCopyInstalls();
  }

  private get t(): Translator {
    return this.deps.getTranslator();
  }

  /** Registers the renderer's Cancel for a queued or running install. */
  init(): void {
    ipcMain.on(IPC.actionCancelJob, (_event, id: unknown) => {
      if (typeof id === 'string') this.cancel(id);
    });
  }

  /** Starts (or queues) a copy install. False when the game is busy already or is not a copy install. */
  startInstall(manifest: ResolvedManifest): boolean {
    const install = manifest.install;
    if (install?.type !== 'copy') return false;
    return this.enqueue(manifest, 'install', (job) => this.runCopy(job, manifest, install));
  }

  /** Starts removing an installed game from the PC. False when the game is busy already. */
  startUninstall(manifest: ResolvedManifest): boolean {
    const install = manifest.install;
    if (install === undefined) return false;
    return this.enqueue(manifest, 'uninstall', (job) => this.runUninstall(job, install));
  }

  /** Starts clearing a plain game's Wine prefix. False when the game is busy already. */
  startPrefixCleanup(manifest: ResolvedManifest): boolean {
    return this.enqueue(manifest, 'prefix-cleanup', (job) => this.runPrefixCleanup(job));
  }

  /** The user's Cancel: stops a queued or running install of `id`. False when there is none. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (job?.kind !== 'install') return false;
    this.stop(job, 'user');
    return true;
  }

  /** Stops every job `predicate` picks, queued or running, for `reason`. */
  abortWhere(predicate: (job: GameJob) => boolean, reason: JobAbortReason): void {
    for (const job of [...this.jobs.values()]) {
      if (predicate(job)) this.stop(job, reason);
    }
  }

  /** Stops every job and resolves once each has run its cleanup. */
  async abortAll(reason: JobAbortReason): Promise<void> {
    const pending = [...this.jobs.values()].map((job) => job.done);
    this.abortWhere(() => true, reason);
    await Promise.all(pending);
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  /** Whether any job is queued or running. */
  anyActive(): boolean {
    return this.jobs.size > 0;
  }

  /** How many jobs are queued or running. */
  activeCount(): number {
    return this.jobs.size;
  }

  private enqueue(manifest: ResolvedManifest, kind: GameJobKind, body: (job: Job) => Promise<void>): boolean {
    const id = manifest.raw.id;
    if (this.jobs.has(id) || this.deps.registry.has(id) || this.deps.host.sessionGameId() === id) {
      log.info(`[jobs] refused ${kind} id=${id}: the game is busy`);
      return false;
    }
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const job: Job = {
      id,
      kind,
      source: manifest.source,
      title: manifest.raw.title,
      abort: new AbortController(),
      body,
      done,
      settle: () => settle(),
      proc: null,
      abortReason: null,
      running: false,
    };
    this.jobs.set(id, job);
    if (kind === 'install' && this.runningCopies() >= this.maxParallelCopies) {
      this.deps.registry.set(id, { kind: 'queued' });
      log.info(`[jobs] queued install id=${id}`);
      return true;
    }
    this.launch(job);
    return true;
  }

  private runningCopies(): number {
    return [...this.jobs.values()].filter((job) => job.kind === 'install' && job.running).length;
  }

  private launch(job: Job): void {
    job.running = true;
    this.deps.registry.set(job.id, { kind: job.kind === 'install' ? 'installing' : 'uninstalling' });
    log.info(`[jobs] started ${job.kind} id=${job.id}`);
    void this.execute(job);
  }

  private stop(job: Job, reason: JobAbortReason): void {
    if (job.abortReason !== null) return;
    job.abortReason = reason;
    job.abort.abort();
    log.info(`[jobs] stopping ${job.kind} id=${job.id} reason=${reason}`);
    if (job.running) {
      void job.proc?.kill().catch((cause: unknown) => log.warn(`[jobs] kill failed id=${job.id}:`, describe(cause)));
      return;
    }
    this.failed(job, new LaunchAbortedError());
    this.finish(job);
  }

  private pump(): void {
    for (const job of this.jobs.values()) {
      if (this.runningCopies() >= this.maxParallelCopies) return;
      if (job.kind === 'install' && !job.running) this.launch(job);
    }
  }

  private finish(job: Job): void {
    job.proc?.dispose();
    this.deps.registry.clear(job.id);
    this.jobs.delete(job.id);
    job.settle();
    this.pump();
  }

  private setActivity(job: Job, activity: GameActivity): void {
    if (job.abortReason === null) this.deps.registry.set(job.id, activity);
  }

  private async execute(job: Job): Promise<void> {
    try {
      await job.body(job);
      throwIfAborted(job);
      this.succeeded(job);
    } catch (cause) {
      this.failed(job, cause);
    } finally {
      this.finish(job);
    }
  }

  private succeeded(job: Job): void {
    log.info(`[jobs] ${job.kind} completed id=${job.id}`);
    this.deps.registry.clear(job.id);
    this.deps.host.onGameChanged(job.id);
    if (job.kind === 'prefix-cleanup') return;
    this.deps.notifications.notify({
      kind: job.kind === 'install' ? 'game-installed' : 'game-uninstalled',
      gameId: job.id,
      gameTitle: job.title,
    });
  }

  private failed(job: Job, cause: unknown): void {
    this.deps.registry.clear(job.id);
    this.deps.host.onGameChanged(job.id);
    const reason = this.failureReason(job, cause);
    if (reason === null) {
      log.info(`[jobs] ${job.kind} stopped id=${job.id} reason=${job.abortReason ?? 'aborted'}`);
      return;
    }
    log.warn(`[jobs] ${job.kind} failed id=${job.id}: ${reason}`);
    this.deps.notifications.notify({
      kind: job.kind === 'install' ? 'game-install-failed' : 'game-uninstall-failed',
      gameId: job.id,
      gameTitle: job.title,
      reason,
    });
    if (this.deps.host.isWindowFocused()) this.deps.host.sendError(reason);
  }

  /** What to tell the user about a job that did not finish, or null when it is not worth a word. */
  private failureReason(job: Job, cause: unknown): string | null {
    switch (job.abortReason) {
      case 'user':
      case 'shutdown':
        return null;
      case 'card-removed':
        return this.t('errors.jobCardRemoved');
      case 'game-gone':
        return this.t('errors.jobGameGone');
      case null:
        if (cause instanceof LaunchAbortedError) return null;
        if (cause instanceof JobFailure) return cause.message;
        return job.kind === 'install' ? this.t('errors.copyGameFailed', { cause: describe(cause) }) : describe(cause);
    }
  }

  private async dropPartial(job: Job, install: ResolvedCopyInstall): Promise<void> {
    try {
      await removeWithRetry(partialDirOf(install.dir));
    } catch (cause) {
      log.warn(`[jobs] leftover ${PARTIAL_SUFFIX} of id=${job.id} could not be removed:`, describe(cause));
    }
  }

  /**
   * Copies the card's game directory to the PC. The files land in `<dir>.partial` first and move into
   * `dir` only once complete and holding the executable, so a stopped copy never leaves a playable-looking
   * game behind (`requiresInstall` is "the executable is missing").
   */
  private async runCopy(job: Job, manifest: ResolvedManifest, install: ResolvedCopyInstall): Promise<void> {
    try {
      const partial = partialDirOf(install.dir);
      await fse.remove(install.dir);
      await fse.remove(partial);
      await this.deps.launcher.prepareInstallDir(install, (active) =>
        this.setActivity(job, { kind: active ? 'configuringProton' : 'installing' }),
      );
      throwIfAborted(job);
      try {
        await fse.copy(install.installerPath, partial, {
          dereference: false,
          filter: () => {
            throwIfAborted(job);
            return true;
          },
        });
      } catch (cause) {
        throwIfAborted(job);
        throw new JobFailure(this.t('errors.copyGameFailed', { cause: describe(cause) }));
      }
      throwIfAborted(job);
      const staged = path.join(partial, path.relative(install.dir, manifest.executablePath));
      if (!(await fse.pathExists(staged))) throw new JobFailure(await this.missingExeMessage(manifest, staged));
      await fse.remove(install.dir);
      await fse.move(partial, install.dir);
      log.info(`[install] copied id=${job.id} from="${install.installerPath}" to="${install.dir}"`);
    } finally {
      await this.dropPartial(job, install);
    }
  }

  private async missingExeMessage(manifest: ResolvedManifest, staged: string): Promise<string> {
    const shown = manifest.raw.executable ?? path.basename(manifest.executablePath);
    const found = await findCaseInsensitiveName(staged);
    return found !== null
      ? this.t('errors.copyExeNotFoundCase', { path: shown, found })
      : this.t('errors.copyExeNotFound', { path: shown });
  }

  /**
   * Removes an installed game: its own uninstaller first (never for `copy` — a copied directory's
   * uninstaller belongs to an install made on another machine), then a sweep of the uninstall dir.
   */
  private async runUninstall(job: Job, install: ResolvedInstall): Promise<void> {
    if (install.type !== 'copy') {
      const target = await this.deps.launcher.resolveUninstaller(install);
      if (target !== null) {
        try {
          job.proc = await this.deps.launcher.launchUninstaller(target);
          await this.deps.processControl.waitForExit(job.proc, job.abort.signal);
        } catch (cause) {
          if (cause instanceof LaunchAbortedError) throw cause;
          log.warn(`[uninstall] uninstaller failed, continuing to cleanup: ${describe(cause)}`);
        }
      }
    }
    throwIfAborted(job);
    const dir = this.deps.launcher.uninstallDir(install);
    await removeWithRetry(dir, job.abort.signal);
    log.info(`[uninstall] removed id=${job.id} dir="${dir}"`);
  }

  /** Clears a plain game's Wine prefix (Linux): the game stays on its card, only the prefix goes. */
  private async runPrefixCleanup(job: Job): Promise<void> {
    const dir = await this.deps.launcher.prefixCleanupDir(job.id);
    if (dir === null) return;
    await removeWithRetry(dir, job.abort.signal);
    log.info(`[prefix-cleanup] removed "${dir}" id=${job.id}`);
  }
}
