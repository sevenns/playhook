import { type GameActivity } from '../shared/activity';
import { type ActivityRegistry } from './activity-registry';
import { steamInstallStatuses, type SteamInstallStatus } from './steam';
import { type SteamLocator } from './platform';
import { log } from './logger';
import { describe } from './util';

const DEFAULT_STEAM_POLL_MS = 5000;

const STEAM_UNINSTALL_TIMEOUT_MS = 60_000;

/** The game one of the completion callbacks is about — everything a notification needs to name it. */
export interface SteamWatchGame {
  readonly id: string;
  readonly title: string;
}

/** One Steam game the watch polls: its id, its title and the appid Steam knows it by. */
export interface SteamWatchEntry extends SteamWatchGame {
  readonly appid: number;
}

/** What the watch needs from the launcher. */
export interface SteamActivityWatchDeps {
  /** Every Steam game whose source is available right now. */
  listSteamGames(): readonly SteamWatchEntry[];
  readonly registry: Pick<ActivityRegistry, 'get' | 'set' | 'clear'>;
  steamLocator(): SteamLocator;
  /** The id of the game the busy session is about, or null when no session is in flight. */
  sessionGameId(): string | null;
  /** Steam changed what the launcher can do with game `id` (Install / Play / Uninstall). */
  onGameChanged(id: string): void;
  /** A download that started as an install finished. */
  onInstallCompleted(game: SteamWatchGame): void;
  /** A steam://uninstall the launcher requested actually removed the game. */
  onUninstallCompleted(game: SteamWatchGame): void;
}

/** Test seams: the poll cadence and the clock the uninstall timeout is measured with. */
export interface SteamActivityWatchOptions {
  readonly intervalMs?: number;
  readonly now?: () => number;
}

type SteamState = SteamInstallStatus['state'];

interface TrackedGame {
  readonly state: SteamState;
  readonly updating: boolean;
}

/** The poll cadence: PLAYHOOK_STEAM_POLL_MS when it is a positive integer, otherwise five seconds. */
export function steamPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env['PLAYHOOK_STEAM_POLL_MS'] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STEAM_POLL_MS;
}

/**
 * The activity a download shows: an install or an update, with the snapshot percent while it is paused,
 * and an install marked as a finished pre-load while the game waits for its release.
 */
function downloadActivity(
  kind: 'steam-installing' | 'steam-updating',
  status: Extract<SteamInstallStatus, { state: 'downloading' }>,
): GameActivity {
  const base: GameActivity =
    status.paused && status.progress !== null
      ? { kind, paused: true, pausedProgress: status.progress }
      : { kind, paused: status.paused };
  return base.kind === 'steam-installing' && status.preloaded ? { ...base, preloaded: true } : base;
}

/** Whether the activity is one this watch owns (it never touches a launcher job's activity). */
function isSteamActivity(activity: GameActivity | undefined): boolean {
  return activity !== undefined && activity.kind.startsWith('steam-');
}

/**
 * Polls Steam's `.acf` state of every available Steam game and keeps each game's Steam activity in the
 * registry: downloads, updates and removals the launcher asked for, for all games at once and independently
 * of what the launcher has selected.
 */
export class SteamActivityWatch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickInFlight = false;
  private rescan = false;
  private stopped = false;
  private lastTick: Promise<void> = Promise.resolve();
  private readonly tracked = new Map<string, TrackedGame>();
  private readonly uninstallRequests = new Map<number, number>();
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: SteamActivityWatchDeps,
    options: SteamActivityWatchOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? steamPollIntervalMs();
    this.now = options.now ?? Date.now;
  }

  /**
   * Polls right away instead of waiting for the next tick; a tick in flight is followed by another one.
   * Resolves once that poll has been applied (it never rejects).
   */
  scanNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.tickInFlight) {
      this.rescan = true;
      return this.lastTick.then(() => this.lastTick);
    }
    this.clearTimer();
    return this.runTick();
  }

  /** Records a steam://uninstall the launcher opened, so the game reads as uninstalling until it is gone. */
  requestUninstall(appid: number): void {
    this.uninstallRequests.set(appid, this.now());
  }

  /** Stops polling for good (application exit). */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.uninstallRequests.clear();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private runTick(): Promise<void> {
    this.lastTick = this.tick();
    return this.lastTick;
  }

  private async tick(): Promise<void> {
    this.timer = null;
    const games = this.deps.listSteamGames();
    this.forgetGone(games);
    if (games.length === 0) return;
    this.tickInFlight = true;
    try {
      const statuses = await steamInstallStatuses(
        games.map((game) => game.appid),
        this.deps.steamLocator(),
      );
      if (statuses === null || this.stopped) return;
      const stillListed = new Set(this.deps.listSteamGames().map((game) => game.id));
      for (const game of games) {
        if (!stillListed.has(game.id)) continue;
        const status = statuses.get(game.appid);
        if (status !== undefined) this.apply(game, status);
      }
    } catch (cause) {
      log.warn('[steam-watch] tick failed:', describe(cause));
    } finally {
      this.tickInFlight = false;
      this.rearm();
    }
  }

  private rearm(): void {
    if (this.stopped) return;
    if (this.rescan) {
      this.rescan = false;
      void this.runTick();
      return;
    }
    if (this.deps.listSteamGames().length === 0) return;
    this.timer = setTimeout(() => void this.runTick(), this.intervalMs);
  }

  private forgetGone(games: readonly SteamWatchEntry[]): void {
    const ids = new Set(games.map((game) => game.id));
    const appids = new Set(games.map((game) => game.appid));
    for (const id of [...this.tracked.keys()]) {
      if (ids.has(id)) continue;
      this.tracked.delete(id);
      if (isSteamActivity(this.deps.registry.get(id))) this.deps.registry.clear(id);
    }
    for (const appid of [...this.uninstallRequests.keys()]) {
      if (!appids.has(appid)) this.uninstallRequests.delete(appid);
    }
  }

  private apply(game: SteamWatchEntry, status: SteamInstallStatus): void {
    if (game.id === this.deps.sessionGameId()) return;
    if (this.applyUninstallRequest(game, status)) return;
    const before = this.tracked.get(game.id);
    const updating =
      status.state === 'downloading' &&
      (before?.state === 'installed' || before?.updating === true);
    this.tracked.set(game.id, { state: status.state, updating });
    if (status.state === 'downloading') {
      this.deps.registry.set(
        game.id,
        downloadActivity(updating ? 'steam-updating' : 'steam-installing', status),
      );
    } else {
      this.clearSteamActivity(game.id);
    }
    const changed =
      before === undefined ? status.state === 'downloading' : before.state !== status.state;
    if (!changed) return;
    log.info(`[steam-watch] appid=${game.appid} ${before?.state ?? 'unknown'} → ${status.state}`);
    this.deps.onGameChanged(game.id);
    if (before?.state === 'downloading' && !before.updating && status.state === 'installed') {
      this.deps.onInstallCompleted({ id: game.id, title: game.title });
    }
  }

  /**
   * Handles a steam://uninstall the launcher opened for this game. True when the request decided this tick
   * (the game is still being removed, or has just been); false when there is none, or it timed out and the
   * ordinary transition takes over.
   */
  private applyUninstallRequest(game: SteamWatchEntry, status: SteamInstallStatus): boolean {
    const since = this.uninstallRequests.get(game.appid);
    if (since === undefined) return false;
    if (status.state === 'installed') {
      if (this.now() - since <= STEAM_UNINSTALL_TIMEOUT_MS) {
        this.tracked.set(game.id, { state: 'installed', updating: false });
        this.deps.registry.set(game.id, { kind: 'steam-uninstalling' });
        return true;
      }
      log.info(
        `[steam-uninstall] appid=${game.appid} still installed after timeout - assuming cancel`,
      );
      this.uninstallRequests.delete(game.appid);
      this.clearSteamActivity(game.id);
      return false;
    }
    log.info(`[steam-uninstall] appid=${game.appid} removed`);
    this.uninstallRequests.delete(game.appid);
    this.tracked.set(game.id, { state: status.state, updating: false });
    this.clearSteamActivity(game.id);
    this.deps.onGameChanged(game.id);
    this.deps.onUninstallCompleted({ id: game.id, title: game.title });
    return true;
  }

  private clearSteamActivity(id: string): void {
    if (isSteamActivity(this.deps.registry.get(id))) this.deps.registry.clear(id);
  }
}
