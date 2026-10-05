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
      return t('launcher.state.queued');
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

/** The Play button's busy visual for the game on screen: the gear for its activity, else the session's. */
export function activityBusyKind(activity: GameActivity | undefined, state: AppState): BusyKind {
  return activity === undefined ? busyKindOf(state) : 'system';
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
  return activity?.kind === 'queued' || activity?.kind === 'installing' || activity?.kind === 'configuringProton';
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
