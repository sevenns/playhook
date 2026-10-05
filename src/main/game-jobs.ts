import path from 'node:path';
import fse from 'fs-extra';
import { ipcMain } from 'electron';
import { IPC, type AppState, type ManifestSource } from '../shared/types';
import { type GameActivity } from '../shared/activity';
import { type Translator } from '../shared/i18n/index';
import type {
  ResolvedCopyInstall,
  ResolvedInstall,
  ResolvedInstallerRun,
  ResolvedManifest,
} from './manifest-types';
import { type ControllerDeps } from './controller-deps';
import { type GameProcess } from './platform';
import { findCaseInsensitiveName } from './manifest';
import { LaunchAbortedError } from './launch-errors';
import { removeWithRetry } from './remove-with-retry';
import { delay, describe } from './util';
import { log } from './logger';

const DEFAULT_MAX_PARALLEL_COPY_INSTALLS = 2;

const DEFAULT_MAX_PARALLEL_INSTALLERS = 1;

const INSTALL_POLL_INTERVAL_MS = 1000;

const PARTIAL_SUFFIX = '.partial';

const INSTALL_MARKER = '.playhook-installing';

export type GameJobKind = 'install' | 'uninstall' | 'prefix-cleanup';

/** Why a job was stopped before it finished; `user` and `shutdown` are never reported as a failure. */
export type JobAbortReason = 'user' | 'card-removed' | 'shutdown' | 'game-gone';

/** Which queue a job waits in: copies and installer runs have limits of their own, removals none. */
export type JobLane = 'copy' | 'installer' | 'uninstall' | 'prefix-cleanup';

/** What the session is doing, as far as starting a job goes. */
export type SessionPhase = 'free' | 'active' | 'running';

/** What is known about an install before it starts; undefined until it has been looked up. */
export interface JobFacts {
  /** The installer shows its wizard (silent installs are switched off in Settings). */
  readonly interactive?: boolean;
  /** Preparing the install's prefix would run winetricks. */
  readonly provisions?: boolean;
}

export interface StartContext {
  readonly session: SessionPhase;
  readonly gamescope: boolean;
  /** The install runs elevated (Windows: a UAC prompt and a blocking ShellExecuteEx). */
  readonly elevated: boolean;
  readonly runningInLane: number;
  readonly laneLimit: number;
}

/** Start now, wait in the queue, or look the facts up first and then decide. */
export type StartVerdict = 'start' | 'wait' | 'learn';

/**
 * Whether a queued job may start. Installer runs: at most `laneLimit` at once (MSI's global mutex fails a
 * second one with 1618, repacks eat the machine), never an interactive or elevated one during a session
 * (a wizard or a UAC prompt over the game), and under gamescope none at all while a game runs — the game has
 * the only surface there, and even a silent installer opens windows. A copy waits under gamescope only when
 * its prefix still needs winetricks, for the same reason. Removals always start.
 */
export function startVerdict(lane: JobLane, facts: JobFacts, ctx: StartContext): StartVerdict {
  if (lane === 'uninstall' || lane === 'prefix-cleanup') return 'start';
  if (ctx.runningInLane >= ctx.laneLimit) return 'wait';
  const gameUnderGamescope = ctx.gamescope && ctx.session === 'running';
  if (lane === 'copy') {
    if (!gameUnderGamescope) return 'start';
    if (facts.provisions === undefined) return 'learn';
    return facts.provisions ? 'wait' : 'start';
  }
  if (gameUnderGamescope) return 'wait';
  if (ctx.session === 'free') return 'start';
  if (ctx.elevated) return 'wait';
  if (facts.interactive === undefined) return 'learn';
  return facts.interactive ? 'wait' : 'start';
}

/** The session phase of an AppState: settled, busy around a game, or with the game itself running. */
export function sessionPhaseOf(kind: AppState['kind']): SessionPhase {
  if (kind === 'idle' || kind === 'ready' || kind === 'error') return 'free';
  return kind === 'running' ? 'running' : 'active';
}

/** What a caller may know about a job: whose it is, what it does, and where the game comes from. */
export interface GameJob {
  readonly id: string;
  readonly kind: GameJobKind;
  readonly source: ManifestSource;
}

interface Job extends GameJob {
  readonly lane: JobLane;
  readonly install: ResolvedInstall | null;
  readonly title: string;
  facts: JobFacts;
  learning: boolean;
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

export type GameJobsDeps = Pick<
  ControllerDeps,
  'activities' | 'notifications' | 'getTranslator' | 'settings' | 'isGamescope'
> & {
  readonly state: Pick<ControllerDeps['state'], 'get' | 'subscribe'>;
  readonly platform: {
    readonly gameLauncher: Pick<
      ControllerDeps['platform']['gameLauncher'],
      | 'prepareInstallDir'
      | 'needsProvisioning'
      | 'launchInstaller'
      | 'resolveUninstaller'
      | 'launchUninstaller'
      | 'uninstallDir'
      | 'prefixCleanupDir'
    >;
  };
  readonly processControl: Pick<ControllerDeps['processControl'], 'waitForExit'>;
  readonly host: GameJobsHost;
  /** How many copy installs run at once; the rest wait as `queued`. */
  readonly maxParallelCopies?: number;
  /** How many installer runs go at once; the rest wait as `queued`. */
  readonly maxParallelInstallers?: number;
};

/** A failure the job reports with its own message rather than the cause's. */
class JobFailure extends Error {}

/** The copy-install limit: PLAYHOOK_MAX_PARALLEL_COPY_INSTALLS when it is a positive integer, otherwise 2. */
export function maxParallelCopyInstalls(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env['PLAYHOOK_MAX_PARALLEL_COPY_INSTALLS'] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PARALLEL_COPY_INSTALLS;
}

/** The installer-run limit: PLAYHOOK_MAX_PARALLEL_INSTALLERS when it is a positive integer, otherwise 1. */
export function maxParallelInstallers(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env['PLAYHOOK_MAX_PARALLEL_INSTALLERS'] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PARALLEL_INSTALLERS;
}

/** Where a copy install stages its files until they are complete: a sibling of the install dir. */
export function partialDirOf(installDir: string): string {
  return `${installDir}${PARTIAL_SUFFIX}`;
}

/** The file an installer run leaves in its install dir until it finished: there, the game is not installed. */
export function installMarkerOf(installDir: string): string {
  return path.join(installDir, INSTALL_MARKER);
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
  private readonly maxParallelInstallers: number;

  constructor(private readonly deps: GameJobsDeps) {
    this.maxParallelCopies = deps.maxParallelCopies ?? maxParallelCopyInstalls();
    this.maxParallelInstallers = deps.maxParallelInstallers ?? maxParallelInstallers();
  }

  private get t(): Translator {
    return this.deps.getTranslator();
  }

  /**
   * Registers the renderer's Cancel for a queued or running install, and re-checks the queue on every
   * session change: what waits for the game to end starts once the state settles.
   */
  init(): void {
    ipcMain.on(IPC.actionCancelJob, (_event, id: unknown) => {
      if (typeof id === 'string') this.cancel(id);
    });
    this.deps.state.subscribe(() => this.pump());
  }

  /** Starts (or queues) an install: a copy or an installer run. False when the game is busy already. */
  startInstall(manifest: ResolvedManifest): boolean {
    const install = manifest.install;
    if (install === undefined) return false;
    if (install.type === 'copy') {
      return this.enqueue(manifest, 'install', 'copy', install, (job) =>
        this.runCopy(job, manifest, install),
      );
    }
    return this.enqueue(manifest, 'install', 'installer', install, (job) =>
      this.runInstaller(job, manifest, install),
    );
  }

  /** Starts removing an installed game from the PC. False when the game is busy already. */
  startUninstall(manifest: ResolvedManifest): boolean {
    const install = manifest.install;
    if (install === undefined) return false;
    return this.enqueue(manifest, 'uninstall', 'uninstall', install, (job) =>
      this.runUninstall(job, install),
    );
  }

  /** Starts clearing a plain game's Wine prefix. False when the game is busy already. */
  startPrefixCleanup(manifest: ResolvedManifest): boolean {
    return this.enqueue(manifest, 'prefix-cleanup', 'prefix-cleanup', null, (job) =>
      this.runPrefixCleanup(job),
    );
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

  /**
   * Removes the staging dirs a copy left behind when the launcher was killed mid-way (a quit through the
   * tray or the menu waits for the cleanup; a crash or an OS logout does not). Skips games with a job.
   */
  async sweepPartials(manifests: readonly ResolvedManifest[]): Promise<void> {
    for (const manifest of manifests) {
      const install = manifest.install;
      if (install?.type !== 'copy' || this.jobs.has(manifest.raw.id)) continue;
      const partial = partialDirOf(install.dir);
      if (!(await fse.pathExists(partial))) continue;
      log.info(`[jobs] removing an orphaned ${PARTIAL_SUFFIX} of id=${manifest.raw.id}`);
      await fse
        .remove(partial)
        .catch((cause: unknown) =>
          log.warn(`[jobs] could not remove "${partial}":`, describe(cause)),
        );
    }
  }

  /** Stops the jobs of games no longer among `ids`: a reload dropped them, and nothing names them now. */
  abortGone(ids: readonly string[]): void {
    this.abortWhere((job) => !ids.includes(job.id), 'game-gone');
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

  private enqueue(
    manifest: ResolvedManifest,
    kind: GameJobKind,
    lane: JobLane,
    install: ResolvedInstall | null,
    body: (job: Job) => Promise<void>,
  ): boolean {
    const id = manifest.raw.id;
    if (
      this.jobs.has(id) ||
      this.deps.activities.has(id) ||
      this.deps.host.sessionGameId() === id
    ) {
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
      lane,
      install,
      facts: {},
      learning: false,
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
    this.pump();
    if (!job.running) {
      this.deps.activities.set(id, { kind: 'queued' });
      log.info(`[jobs] queued ${lane} id=${id}`);
    }
    return true;
  }

  private runningIn(lane: JobLane): number {
    return [...this.jobs.values()].filter((job) => job.lane === lane && job.running).length;
  }

  private verdict(job: Job): StartVerdict {
    return startVerdict(job.lane, job.facts, {
      session: sessionPhaseOf(this.deps.state.get().kind),
      gamescope: this.deps.isGamescope,
      elevated: job.install?.runAsAdmin === true,
      runningInLane: this.runningIn(job.lane),
      laneLimit: job.lane === 'copy' ? this.maxParallelCopies : this.maxParallelInstallers,
    });
  }

  /** Looks up what a queued install's start depends on, then re-checks the queue. */
  private async learn(job: Job): Promise<void> {
    if (job.learning || job.install === null) return;
    job.learning = true;
    try {
      const [settings, provisions] = await Promise.all([
        this.deps.settings.read(),
        this.deps.platform.gameLauncher.needsProvisioning(job.install),
      ]);
      job.facts = { interactive: settings.disableSilentInstall, provisions };
    } catch (cause) {
      log.warn(
        `[jobs] could not look up how id=${job.id} installs — treating it as interactive:`,
        describe(cause),
      );
      job.facts = { interactive: true, provisions: true };
    } finally {
      job.learning = false;
      this.pump();
    }
  }

  private launch(job: Job): void {
    job.running = true;
    this.deps.activities.set(job.id, {
      kind: job.kind === 'install' ? 'installing' : 'uninstalling',
    });
    log.info(`[jobs] started ${job.kind} id=${job.id}`);
    void this.execute(job);
  }

  private stop(job: Job, reason: JobAbortReason): void {
    if (job.abortReason !== null) return;
    job.abortReason = reason;
    job.abort.abort();
    log.info(`[jobs] stopping ${job.kind} id=${job.id} reason=${reason}`);
    if (job.running) {
      void job.proc
        ?.kill()
        .catch((cause: unknown) => log.warn(`[jobs] kill failed id=${job.id}:`, describe(cause)));
      return;
    }
    this.failed(job, new LaunchAbortedError());
    this.finish(job);
  }

  private pump(): void {
    for (const job of [...this.jobs.values()]) {
      if (job.running || job.abortReason !== null) continue;
      const verdict = this.verdict(job);
      if (verdict === 'start') this.launch(job);
      else if (verdict === 'learn') void this.learn(job);
    }
  }

  private finish(job: Job): void {
    job.proc?.dispose();
    this.jobs.delete(job.id);
    this.deps.activities.clear(job.id);
    job.settle();
    this.pump();
  }

  private setActivity(job: Job, activity: GameActivity): void {
    if (job.abortReason === null) this.deps.activities.set(job.id, activity);
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
    this.deps.host.onGameChanged(job.id);
    if (job.kind === 'prefix-cleanup') return;
    this.deps.notifications.notify({
      kind: job.kind === 'install' ? 'game-installed' : 'game-uninstalled',
      gameId: job.id,
      gameTitle: job.title,
    });
  }

  private failed(job: Job, cause: unknown): void {
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
        return job.lane === 'copy'
          ? this.t('errors.copyGameFailed', { cause: describe(cause) })
          : describe(cause);
    }
  }

  private async dropPartial(job: Job, install: ResolvedCopyInstall): Promise<void> {
    try {
      await removeWithRetry(partialDirOf(install.dir));
    } catch (cause) {
      log.warn(
        `[jobs] leftover ${PARTIAL_SUFFIX} of id=${job.id} could not be removed:`,
        describe(cause),
      );
    }
  }

  /**
   * Copies the card's game directory to the PC. The files land in `<dir>.partial` first and move into
   * `dir` only once complete and holding the executable, so a stopped copy never leaves a playable-looking
   * game behind (`requiresInstall` is "the executable is missing").
   */
  private async runCopy(
    job: Job,
    manifest: ResolvedManifest,
    install: ResolvedCopyInstall,
  ): Promise<void> {
    try {
      const partial = partialDirOf(install.dir);
      await fse.remove(install.dir);
      await fse.remove(partial);
      await this.deps.platform.gameLauncher.prepareInstallDir(install, (active) =>
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
      if (!(await fse.pathExists(staged)))
        throw new JobFailure(await this.missingExeMessage(manifest, staged));
      await fse.remove(install.dir);
      await fse.move(partial, install.dir);
      log.info(`[install] copied id=${job.id} from="${install.installerPath}" to="${install.dir}"`);
    } finally {
      await this.dropPartial(job, install);
    }
  }

  /**
   * Runs a card installer into the install dir: a marker first (a launcher killed mid-run must not leave a
   * playable-looking game behind), the installer, then a grace poll for the executable — some wrappers fork a
   * child and exit early. A stopped or failed run sweeps the install dir.
   */
  private async runInstaller(
    job: Job,
    manifest: ResolvedManifest,
    install: ResolvedInstallerRun,
  ): Promise<void> {
    try {
      await fse.remove(install.dir);
      await fse.outputFile(installMarkerOf(install.dir), '');
      const silent = !(await this.deps.settings.read()).disableSilentInstall;
      try {
        job.proc = await this.deps.platform.gameLauncher.launchInstaller(
          install,
          silent,
          (active) => this.setActivity(job, { kind: active ? 'configuringProton' : 'installing' }),
        );
      } catch (cause) {
        throwIfAborted(job);
        throw new JobFailure(this.t('errors.startInstaller', { cause: describe(cause) }));
      }
      await this.deps.processControl.waitForExit(job.proc, job.abort.signal);
      if (!(await this.pollForExecutable(job, manifest))) {
        throw new JobFailure(this.t('errors.installIncomplete'));
      }
      await fse.remove(installMarkerOf(install.dir));
      log.info(`[install] completed id=${job.id} dir="${install.dir}"`);
    } catch (cause) {
      await removeWithRetry(install.dir).catch((error: unknown) =>
        log.warn(`[jobs] the install dir of id=${job.id} could not be swept:`, describe(error)),
      );
      throw cause;
    }
  }

  /** Waits up to launchTimeoutSec for the executable to appear; throws once the job is stopped. */
  private async pollForExecutable(job: Job, manifest: ResolvedManifest): Promise<boolean> {
    const deadline = Date.now() + manifest.raw.launchTimeoutSec * 1000;
    for (;;) {
      throwIfAborted(job);
      if (await fse.pathExists(manifest.executablePath)) return true;
      if (Date.now() >= deadline) return false;
      await delay(INSTALL_POLL_INTERVAL_MS);
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
      const target = await this.deps.platform.gameLauncher.resolveUninstaller(install);
      if (target !== null) {
        try {
          job.proc = await this.deps.platform.gameLauncher.launchUninstaller(target);
          await this.deps.processControl.waitForExit(job.proc, job.abort.signal);
        } catch (cause) {
          if (cause instanceof LaunchAbortedError) throw cause;
          log.warn(`[uninstall] uninstaller failed, continuing to cleanup: ${describe(cause)}`);
        }
      }
    }
    throwIfAborted(job);
    const dir = this.deps.platform.gameLauncher.uninstallDir(install);
    await removeWithRetry(dir, job.abort.signal);
    log.info(`[uninstall] removed id=${job.id} dir="${dir}"`);
  }

  /** Clears a plain game's Wine prefix (Linux): the game stays on its card, only the prefix goes. */
  private async runPrefixCleanup(job: Job): Promise<void> {
    const dir = await this.deps.platform.gameLauncher.prefixCleanupDir(job.id);
    if (dir === null) return;
    await removeWithRetry(dir, job.abort.signal);
    log.info(`[prefix-cleanup] removed "${dir}" id=${job.id}`);
  }
}
