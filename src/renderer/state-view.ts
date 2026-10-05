// Pure views over AppState shared by the renderer modules. No DOM — just the mapping from a
// state to the UI phase, the status label and the current game. Kept in one place
// so app.ts (render/title-slide) and controls.ts (focus/actions) read the same derivations.
import type { AppState, BrowseInfo, GameInfo } from '../shared/types.js';
import type { ActivityMap, GameActivity } from '../shared/activity.js';
import type { Translator } from '../shared/i18n/index.js';

export type Phase = 'idle' | 'ready' | 'busy' | 'error';

export function phaseOf(state: AppState): Phase {
  switch (state.kind) {
    case 'idle':
      return 'idle';
    case 'ready':
      return 'ready';
    case 'error':
      return 'error';
    case 'installing':
    case 'uninstalling':
    case 'configuringProton':
    case 'syncing-in':
    case 'launching':
    case 'running':
    case 'syncing-out':
      return 'busy';
  }
}

export function statusOf(state: AppState, t: Translator): string {
  // Plain "..." instead of the "…" glyph: in M PLUS Rounded 1c (a CJK font) the ellipsis
  // glyph is centered vertically (Japanese convention), which looks misaligned in a Latin UI.
  switch (state.kind) {
    case 'installing':
      return t('launcher.state.installing');
    case 'uninstalling':
      return t('launcher.state.uninstalling');
    case 'configuringProton':
      // Base label; the renderer appends a rotating funny suffix after a minute.
      return t('launcher.protonConfig1');
    case 'syncing-in':
      return t('launcher.state.syncingIn');
    case 'launching':
      return t('launcher.state.launching');
    case 'running':
      return state.killing === true ? t('launcher.state.killing') : t('launcher.state.running');
    case 'syncing-out':
      return t('launcher.state.syncingOut');
    case 'ready': {
      // A local (PC) draft with no launch method chosen yet: no status line — the absent Play button
      // already says everything that needs saying, and "Launch is not set up" read as an error to fix
      // right now rather than as the deliberate, in-progress state a draft actually is.
      if (state.game.unconfigured === true) return '';
      // A local (PC) game whose files are gone: the card stays in the library, but there is nothing to
      // launch, so say so instead of leaving an empty status under a dead Play button.
      if (state.game.unavailable === true) return t('launcher.state.gameFilesMissing');
      return '';
    }
    default:
      return '';
  }
}

// Which busy visual the Play button shows, by the design's semantics: a rotating GEAR for system
// activity (install/uninstall, incl. Steam), a SPINNER arc for game phases (launch/save-sync/running).
// 'none' → not busy (the play triangle). Drives #app[data-busy] in app.ts.
export type BusyKind = 'none' | 'system' | 'game' | 'running';

export function busyKindOf(state: AppState): BusyKind {
  switch (state.kind) {
    case 'installing':
    case 'uninstalling':
    case 'configuringProton':
      return 'system';
    case 'syncing-in':
    case 'launching':
    case 'syncing-out':
      return 'game';
    // `running` is its own kind: the launcher may be summoned over the game, where Play shows the play
    // triangle again (press = return to the game), NOT the game-phase spinner. EXCEPT while a force-close
    // is in flight (killing) — then Play is a loading spinner, like the other game phases. See app.ts / styles.css.
    case 'running':
      return state.killing === true ? 'game' : 'running';
    default:
      return 'none';
  }
}

/** The status line of a game's activity. No live install percent: Steam exposes none (see main). */
export function activityStatus(activity: GameActivity, t: Translator): string {
  switch (activity.kind) {
    case 'queued':
      if (activity.reason !== 'session') return t('launcher.state.queued');
      return t(activity.removal === true ? 'launcher.state.queuedRemovalUntilGameExit' : 'launcher.state.queuedUntilGameExit');
    case 'installing':
      return t('launcher.state.installing');
    case 'configuringProton':
      return t('launcher.protonConfig1');
    case 'uninstalling':
    case 'steam-uninstalling':
      return t('launcher.state.uninstalling');
    case 'steam-updating':
      return t(activity.paused ? 'launcher.state.updatingPaused' : 'launcher.state.updating');
    case 'steam-installing':
      if (activity.preloaded === true) return t('launcher.state.preloaded');
      if (!activity.paused) return t('launcher.state.installing');
      return activity.pausedProgress === undefined
        ? t('launcher.state.installingPaused')
        : t('launcher.state.installingPausedPercent', { percent: Math.round(activity.pausedProgress * 100) });
  }
}

/** What the Play button looks like for the game on screen. */
export type PlayView = 'play' | 'resume' | 'gear' | 'spinner' | 'hidden';

/** Everything the bar and the Details menu may offer for the game on screen, derived from that game alone. */
export interface ScreenActions {
  /** The game on screen when it can be acted on (not a history game), else undefined. */
  readonly game: GameInfo | undefined;
  readonly canPlay: boolean;
  readonly canInstall: boolean;
  readonly canUninstall: boolean;
  readonly canCancel: boolean;
  readonly canForceClose: boolean;
  readonly playView: PlayView;
}

const NO_ACTIONS: ScreenActions = {
  game: undefined,
  canPlay: false,
  canInstall: false,
  canUninstall: false,
  canCancel: false,
  canForceClose: false,
  playView: 'hidden',
};

/**
 * What can be done with the game on screen. Its own activity wins (the gear; Play opens Steam's downloads
 * for a download). The session's own game shows the session (return to it, or its busy visual). Any other
 * game is judged by itself: while a session runs it may still be installed or removed, but Play only shows,
 * it never starts a second game.
 */
export function screenActions(
  state: AppState,
  browse: BrowseInfo | null,
  activity: GameActivity | undefined,
): ScreenActions {
  const sessionGame = gameOf(state);
  const busy = phaseOf(state) === 'busy';
  const game =
    browse === null
      ? sessionGame
      : browse.active
        ? (browse.game ?? (sessionGame?.id === browse.id ? sessionGame : undefined))
        : undefined;
  if (game === undefined) return NO_ACTIONS;
  if (activity !== undefined) {
    return { ...NO_ACTIONS, game, canPlay: opensSteamDownloads(activity), canCancel: cancellableInstall(activity), playView: 'gear' };
  }
  if (busy && sessionGame?.id === game.id) {
    const kind = busyKindOf(state);
    const running = state.kind === 'running' && state.killing !== true;
    const playView = kind === 'running' ? 'resume' : kind === 'system' ? 'gear' : 'spinner';
    return { ...NO_ACTIONS, game, canPlay: running, canForceClose: running, playView };
  }
  if (game.unavailable === true || game.unconfigured === true) return { ...NO_ACTIONS, game };
  if (game.requiresInstall) return { ...NO_ACTIONS, game, canInstall: true };
  return { ...NO_ACTIONS, game, canPlay: !busy, canUninstall: game.canUninstall, playView: 'play' };
}

/** The #app[data-busy] value a Play view stands for. */
export function busyKindOfView(view: PlayView): BusyKind {
  if (view === 'gear') return 'system';
  if (view === 'spinner') return 'game';
  return view === 'resume' ? 'running' : 'none';
}

/** The activity of the game on screen, or undefined when it is free or nothing is on screen. */
export function screenActivityOf(browse: BrowseInfo | null, activities: ActivityMap): GameActivity | undefined {
  return browse === null ? undefined : activities[browse.id];
}

/** Whether Play on a game with this activity opens Steam's Downloads page (pause/resume live there). */
export function opensSteamDownloads(activity: GameActivity | undefined): boolean {
  return activity?.kind === 'steam-installing' || activity?.kind === 'steam-updating';
}

/** The games whose cards pulse: every game with an activity plus the game of a busy session. */
export function busyIds(state: AppState, activities: ActivityMap): ReadonlySet<string> {
  const session = phaseOf(state) === 'busy' ? gameOf(state)?.id : undefined;
  return new Set([...Object.keys(activities), ...(session === undefined ? [] : [session])]);
}

/** Whether the activity is an install the user can still cancel from the launcher. */
export function cancellableInstall(activity: GameActivity | undefined): boolean {
  if (activity?.kind === 'queued') return activity.removal !== true;
  return activity?.kind === 'installing' || activity?.kind === 'configuringProton';
}

/** How many background installs / uninstalls are queued or running (Steam's own activities aside). */
export function jobCountOf(activities: ActivityMap): number {
  return Object.values(activities).filter((activity) => !activity.kind.startsWith('steam-')).length;
}

/** Whether two id sets hold the same ids. */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

export function gameOf(state: AppState): GameInfo | undefined {
  return 'game' in state ? state.game : undefined;
}
