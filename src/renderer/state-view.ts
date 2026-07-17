// Pure views over AppState shared by the renderer modules. No DOM — just the mapping from a
// state to the UI phase, the status label, the Steam-busy flag and the current game. Kept in one place
// so app.ts (render/title-slide) and controls.ts (focus/actions) read the same derivations.
import type { AppState, GameInfo } from '../shared/types';
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
      // Base label; the renderer appends a rotating funny suffix after a minute (Р7j).
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
      // Steam non-blocking install/uninstall indicators on the ready screen (the window stays usable).
      // No install percent: Steam exposes no reliable live progress in the files we read (see main).
      if (state.game.steamUninstalling === true) return t('launcher.state.uninstalling');
      if (state.game.steamInstalling === true) {
        if (state.game.steamPaused !== true) return t('launcher.state.installing');
        const progress = state.game.steamPausedProgress;
        return progress === undefined
          ? t('launcher.state.installingPaused')
          : t('launcher.state.installingPausedPercent', { percent: Math.round(progress * 100) });
      }
      return '';
    }
    default:
      return '';
  }
}

// Which busy visual the Play button shows, by the design's semantics: a rotating GEAR for system
// activity (install/uninstall, incl. Steam), a SPINNER arc for game phases (launch/save-sync/running).
// 'none' → not busy (the play triangle). Drives #app[data-busy] in app.ts. (steamBusy is hoisted.)
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
    case 'ready':
      // Steam download/uninstall is non-blocking system activity on the (still) ready screen.
      return steamBusy(state) ? 'system' : 'none';
    default:
      return 'none';
  }
}

// True while a Steam install (download) or uninstall is in progress: a non-blocking indicator on the
// (still) ready screen — the busy visuals (loader + status + slid title) are reused via
// #app[data-steam-busy], NOT the busy phase.
export function steamBusy(state: AppState): boolean {
  if (state.kind !== 'ready') return false;
  return state.game.steamInstalling === true || state.game.steamUninstalling === true;
}

export function gameOf(state: AppState): GameInfo | undefined {
  return 'game' in state ? state.game : undefined;
}
