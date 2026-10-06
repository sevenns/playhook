import { type GameInfo } from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import type { ResolvedManifest } from './manifest-types';
import { type ControllerDeps } from './controller-deps';
import { type GameSequences } from './game-sequences';
import { type GameJobs } from './game-jobs';
import { resolveActionTarget, type ActionTarget } from './action-target';
import { log } from './logger';

/** What the actions need back from the card session. */
export interface GameActionsHost {
  /** Every game that can be acted on right now (the card's and the PC library's). */
  games(): readonly ResolvedManifest[];
  /** The selected game, or the first one when the selection is gone. */
  current(): ResolvedManifest | null;
  sourceAvailable(manifest: ResolvedManifest): boolean;
  /** A manifest reload from the Customize screen is in flight. */
  isReloading(): boolean;
  /** The id of the game the busy session is about, or null while the state is settled. */
  sessionGameId(): string | null;
  /** The renderer's action:select for `id`; refused (left as it was) while the session is busy. */
  select(id: string): Promise<void>;
  /** A freshly built GameInfo for a game that is not the one AppState is about. */
  buildGameInfo(manifest: ResolvedManifest): Promise<GameInfo>;
  sendError(message: string): void;
}

export type GameActionsDeps = Pick<
  ControllerDeps,
  'state' | 'activities' | 'processControl' | 'getTranslator'
> & {
  readonly sequences: Pick<
    GameSequences,
    | 'inFlight'
    | 'runningGameImageNames'
    | 'runSteamInstall'
    | 'runSteamUninstall'
    | 'runLaunchSequence'
  >;
  readonly jobs: Pick<GameJobs, 'startInstall' | 'startUninstall' | 'startPrefixCleanup'>;
  readonly host: GameActionsHost;
};

/**
 * The renderer's Play / Install and Uninstall, addressed by game id. With the session free they act on the
 * selected game exactly as before (selecting the target first when it is another one); with a game running
 * they still install or remove OTHER games in the background, and never start a second one.
 */
export class GameActions {
  constructor(private readonly deps: GameActionsDeps) {}

  private get t(): Translator {
    return this.deps.getTranslator();
  }

  /** The id AppState is about while ready, else the selection's. */
  private selectedId(): string | null {
    const snapshot = this.deps.state.get();
    return snapshot.kind === 'ready'
      ? snapshot.game.id
      : (this.deps.host.current()?.raw.id ?? null);
  }

  /** The game an action names, or the selected one when it names none (an older caller). */
  private targetOf(idRaw: unknown): ResolvedManifest | null {
    const id = typeof idRaw === 'string' ? idRaw : this.selectedId();
    return this.deps.host.games().find((manifest) => manifest.raw.id === id) ?? null;
  }

  private resolve(action: 'launch' | 'uninstall', manifest: ResolvedManifest): ActionTarget {
    const sessionGameId = this.deps.host.sessionGameId();
    return resolveActionTarget({
      action,
      id: manifest.raw.id,
      selectedId: this.selectedId(),
      sessionBusy: sessionGameId !== null || this.deps.sequences.inFlight,
      sessionGameId,
      hasActivity: this.deps.activities.has(manifest.raw.id),
      sourceAvailable: this.deps.host.sourceAvailable(manifest),
      reloadInFlight: this.deps.host.isReloading(),
    });
  }

  /** Play / the install confirm's Yes for game `idRaw`. */
  async launch(idRaw: unknown): Promise<void> {
    const manifest = this.targetOf(idRaw);
    if (manifest === null) return;
    const id = manifest.raw.id;
    switch (this.resolve('launch', manifest)) {
      case 'resume-session':
        // Play pressed while a game is running (the launcher was summoned over it via the tray): return to the
        // game instead of launching. No-op if we don't have the image names yet.
        if (this.deps.state.get().kind === 'running') this.resumeRunningGame();
        return;
      case 'select-then-act':
        await this.deps.host.select(id);
        if (this.selectedId() === id) await this.launch(id);
        return;
      case 'install-only':
        await this.installInBackground(manifest);
        return;
      case 'launch-or-install-selected':
        this.launchSelected();
        return;
      case 'uninstall-only':
      case 'refuse':
        log.info(`[launch] refused id=${id}: the game is busy, unavailable or being reloaded`);
        return;
    }
  }

  /** The uninstall confirm's Yes for game `idRaw`. */
  async uninstall(idRaw: unknown): Promise<void> {
    const manifest = this.targetOf(idRaw);
    if (manifest === null) return;
    const id = manifest.raw.id;
    switch (this.resolve('uninstall', manifest)) {
      case 'select-then-act':
        await this.deps.host.select(id);
        if (this.selectedId() === id) await this.uninstall(id);
        return;
      case 'uninstall-only':
        await this.uninstallOne(manifest);
        return;
      default:
        log.info(`[uninstall] refused id=${id}`);
    }
  }

  private launchSelected(): void {
    const snapshot = this.deps.state.get();
    // Ignore input outside the ready state — this is the "ignore-gamepad" during play
    // (harmless under any interpretation of the Gamepad API focus bug).
    if (snapshot.kind !== 'ready' || this.deps.sequences.inFlight) return;
    const manifest = this.targetOf(snapshot.game.id);
    if (manifest === null) return;
    // A local game whose .exe is gone (deleted, or an external drive unplugged). The renderer already
    // disables Play, but a gamepad press must not slip past it into a launch that can only fail.
    if (snapshot.game.unavailable === true) {
      log.info(
        `[launch] refused id=${manifest.raw.id}: "${manifest.executablePath}" is not on disk`,
      );
      this.deps.host.sendError(this.t('launcher.state.gameFilesMissing'));
      return;
    }
    // A local draft with no launch method chosen yet — same guard, different reason. The renderer already
    // disables Play, but a gamepad press must not slip past it into runLaunchSequence.
    if (snapshot.game.unconfigured === true) {
      log.info(`[launch] refused id=${manifest.raw.id}: no launch method is configured`);
      this.deps.host.sendError(this.t('launcher.state.launchNotConfigured'));
      return;
    }
    // Steam mode: not yet installed → open steam://install (fire-and-forget); otherwise launch via
    // steam://rungameid. Both inside runSteamInstall / runLaunchSequence's steam branch.
    if (manifest.steam !== undefined) {
      if (snapshot.game.requiresInstall) {
        void this.deps.sequences.runSteamInstall(manifest);
      } else {
        void this.deps.sequences.runLaunchSequence(manifest, snapshot.game);
      }
      return;
    }
    // Card-install mode + not yet installed → run the installer; otherwise it's an ordinary launch
    // (this includes a fully-installed game, whose executable now exists → requiresInstall=false).
    if (manifest.install !== undefined && snapshot.game.requiresInstall) {
      this.deps.jobs.startInstall(manifest);
    } else {
      void this.deps.sequences.runLaunchSequence(manifest, snapshot.game);
    }
  }

  /** Installs a game other than the session's: Steam's own download, or a background job. Never a launch. */
  private async installInBackground(manifest: ResolvedManifest): Promise<void> {
    const info = await this.deps.host.buildGameInfo(manifest);
    if (!info.requiresInstall || info.unconfigured === true) {
      log.info(
        `[launch] refused id=${manifest.raw.id}: a second game is not launched while one runs`,
      );
      return;
    }
    if (manifest.steam !== undefined) {
      void this.deps.sequences.runSteamInstall(manifest);
      return;
    }
    this.deps.jobs.startInstall(manifest);
  }

  private async uninstallOne(manifest: ResolvedManifest): Promise<void> {
    const snapshot = this.deps.state.get();
    const info =
      snapshot.kind === 'ready' && snapshot.game.id === manifest.raw.id
        ? snapshot.game
        : await this.deps.host.buildGameInfo(manifest);
    if (!info.canUninstall) return; // nothing installed to remove
    // Steam: delegate removal to Steam (steam://uninstall) — fire-and-forget, the poller flips to Install.
    if (manifest.steam !== undefined) {
      void this.deps.sequences.runSteamUninstall(manifest);
      return;
    }
    if (manifest.install === undefined) {
      // Normal executable game: the only "uninstall" is clearing its Wine prefix (Linux; the game stays on
      // the card). canUninstall is set only when that prefix exists — see buildGameInfo / prefixCleanupOnly.
      if (info.prefixCleanupOnly === true) this.deps.jobs.startPrefixCleanup(manifest);
      return;
    }
    this.deps.jobs.startUninstall(manifest);
  }

  /**
   * Return-to-game: raise the running game's own window to the foreground (restoring it if it minimized
   * when it lost focus). Best-effort — if the window isn't found (the game is already closing, a race with
   * waitForExit) it's a silent no-op; the state machine will move to syncing-out → ready on its own.
   */
  private resumeRunningGame(): void {
    const names = this.deps.sequences.runningGameImageNames;
    if (names === null) return;
    if (!this.deps.processControl.focusGameWindow(names)) {
      log.info('[resume] running game window not found — no-op (it may be closing)');
    }
  }
}
