// Steam-mode background re-detect poller (audit I1 — split out of the GameController god-object).
// While a Steam game sits on the `ready` screen with the card present, this polls Steam's .acf state
// so the UI flips Install↔Play↔Uninstall as a (possibly hours-long) download/uninstall completes —
// including changes the user makes in Steam directly. It owns its timer, the in-flight guard and the
// optimistic uninstall request; it reaches back into the controller only through the narrow `deps`
// seam below (accessors + enterReady), so the delicate re-arm/staleness logic stays in one place.
import { type AppState, type GameInfo, type ResolvedManifest } from '../shared/types';
import { steamInstallStatus, type SteamInstallStatus } from './steam';
import { log } from './logger';
import { describe } from './util';

// Steam-mode background re-detect cadence: while a Steam game shows "Install" (not yet installed in
// Steam), poll its .acf state so the button flips to "Play" once the (possibly hours-long) download
// finishes. Non-blocking — no `installing` state is entered.
const STEAM_INSTALL_WATCH_INTERVAL_MS = 5000;

// How long to keep showing "Uninstalling…" after we open steam://uninstall before giving up. Steam's
// uninstall is fire-and-forget: we can't tell "user is reading the dialog / cancelled" from "removing".
// If the .acf is still present after this window, we assume a cancel and return to "Play"/"Uninstall".
// Safe either way — the poller keeps running and will flip to "Install" if removal completes later.
const STEAM_UNINSTALL_TIMEOUT_MS = 60_000;

/** The narrow view of the controller the poller needs — accessors plus the single mutation it makes. */
export interface SteamWatchDeps {
  /** The current resolved manifest (null when no card / rejected). */
  getManifest(): ResolvedManifest | null;
  /** Whether a launch/install/uninstall sequence is in flight (the poller must not race it). */
  isLaunchInFlight(): boolean;
  /** The current AppState snapshot. */
  getState(): AppState;
  /** Whether a card is currently present. */
  isCardPresent(): boolean;
  /** Transition to `ready` with the given info (also re-arms/stops the poller, exactly as before). */
  enterReady(info: GameInfo): void;
}

export class SteamInstallWatch {
  // Recursive setTimeout (no overlap). Non-null only while a Steam game is on the ready screen with a card.
  private timer: ReturnType<typeof setTimeout> | null = null;
  // True while a tick is mid-flight (between nulling the timer and finishing). Prevents a concurrent
  // start() (e.g. an Install/Uninstall action landing during the tick's await) from spinning up a SECOND
  // poller. The tick re-arms itself in its finally.
  private tickInFlight = false;
  // A steam://uninstall we requested (appid + when), driving the optimistic "Uninstalling…" indicator
  // until the .acf disappears or STEAM_UNINSTALL_TIMEOUT_MS elapses (assumed cancel). Null = none.
  private uninstallRequest: { readonly appid: number; readonly since: number } | null = null;

  constructor(private readonly deps: SteamWatchDeps) {}

  /** (Re)starts the recursive re-detect timer. No-op if already running or a tick is in flight. */
  start(): void {
    if (this.timer !== null || this.tickInFlight) return;
    this.timer = setTimeout(() => void this.tick(), STEAM_INSTALL_WATCH_INTERVAL_MS);
  }

  /** Stops the re-detect timer. */
  stop(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Records an optimistic steam://uninstall request so the next tick shows "Uninstalling…". */
  requestUninstall(appid: number): void {
    this.uninstallRequest = { appid, since: Date.now() };
  }

  /** Clears any pending uninstall request (card removed / shutdown). */
  clearUninstallRequest(): void {
    this.uninstallRequest = null;
  }

  /**
   * One re-detect tick: captures the current manifest's appid, reads Steam's .acf state, and — only if
   * the card/state is still the same after the await (same steam game, ready, no launch in flight) —
   * reconciles the UI flags (requiresInstall/canUninstall/progress/uninstalling) by PATCHING the current
   * GameInfo in place (cheap — no hero re-read). Catches install completion, uninstall completion (incl.
   * an uninstall done in Steam directly), live download progress, and the uninstall-cancel timeout.
   */
  private async tick(): Promise<void> {
    this.timer = null; // consumed; the finally re-arms it if we should still be polling
    const manifest = this.deps.getManifest();
    const appid = manifest?.steam?.appid;
    if (manifest === null || appid === undefined) return; // not steam → stop
    this.tickInFlight = true;
    try {
      let status: SteamInstallStatus = { state: 'absent' };
      try {
        status = await steamInstallStatus(appid);
      } catch (cause) {
        log.warn('[steam-watch] detect failed:', describe(cause));
      }

      // Re-validate everything that could have changed during the await (card swap, launch in flight).
      const snapshot = this.deps.getState();
      if (
        this.deps.isLaunchInFlight() ||
        this.deps.getManifest() !== manifest ||
        snapshot.kind !== 'ready' ||
        snapshot.game.installVia !== 'steam'
      ) {
        return; // stale — drop this result (the finally re-arms iff still a steam card on ready)
      }
      const prev = snapshot.game;

      // Reconcile the UI flags with Steam's fresh .acf state. Only these flags change on install/uninstall;
      // the rest of GameInfo (title/hero/stats) is unaffected, so we patch `prev` in place — no hero re-read.
      const requiresInstall = status.state !== 'installed';
      let canUninstall = status.state === 'installed';
      const steamInstalling = status.state === 'downloading';
      const steamPaused = status.state === 'downloading' && status.paused;
      const steamPausedProgress =
        status.state === 'downloading' ? (status.progress ?? undefined) : undefined;
      let steamUninstalling = false;

      // A requested steam://uninstall is in flight for this game.
      const req = this.uninstallRequest;
      if (req !== null && req.appid === appid) {
        if (status.state === 'installed') {
          // .acf still present: either Steam is removing files, or the user is still on / cancelled the
          // dialog. Keep "Uninstalling…" until the timeout, then assume cancel and restore Play/Uninstall.
          if (Date.now() - req.since > STEAM_UNINSTALL_TIMEOUT_MS) {
            log.info(`[steam-uninstall] appid=${appid} still installed after timeout — assuming cancel`);
            this.uninstallRequest = null;
          } else {
            steamUninstalling = true;
            canUninstall = false; // hide Uninstall while the indicator is up
          }
        } else {
          // .acf gone (absent/downloading) → Steam removed the game; finish the uninstall.
          log.info(`[steam-uninstall] appid=${appid} removed — flipping to Install`);
          this.uninstallRequest = null;
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
        this.deps.enterReady({
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
      this.tickInFlight = false;
      // Re-arm iff we should still be watching this steam card (mirrors enterReady's start condition).
      const s = this.deps.getState();
      if (s.kind === 'ready' && s.game.installVia === 'steam' && this.deps.isCardPresent()) {
        this.start();
      }
    }
  }
}
