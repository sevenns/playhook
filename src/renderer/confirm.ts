// The confirm view of the popup column (popups.ts), as two pure halves: what the question SAYS for a
// given mode (`describeConfirm`), and what a "Yes" DOES (`runConfirmedAction`). The popup keeps the
// state — which mode is up, where B returns to, the id a "forget" was asked about — and applies both.
import type { AudioController } from './audio.js';
import type { ControlsApi, GameSettingsNav, SettingsNav } from './controls-deps.js';
import type { BrowseInfo, GameCollision, GameInfo } from '../shared/types.js';
import type { Translator } from '../shared/i18n/index.js';

// Which action the confirm view is asking about (only meaningful while the popup shows 'confirm').
export type ConfirmMode =
  | 'install'
  | 'uninstall'
  | 'kill'
  | 'forget'
  | 'shutdown'
  | 'reboot'
  | 'sleep'
  | 'reset-settings'
  | 'reset-game-settings'
  | 'delete-game'
  // The second half of the delete question: whether the game's HISTORY record goes with it. Its "No" is
  // an answer rather than a cancel — see the confirmNo branch in triggerStackButton.
  | 'delete-game-history'
  | 'discard-game-settings'
  | 'switch-game-source'
  // Leaving the screen (B/veil/Close) while a "Move to card…" is pending — drops the pending move and
  // returns the form to the PC library's baseline, WITHOUT closing the screen (see game-settings-screen.ts
  // PendingMove). Kept apart from 'discard-game-settings', whose "Yes" closes the whole screen.
  | 'cancel-move-game-settings'
  // Taking the store's spelling into the Customize form's Title — the one thing the "Find online" screen
  // does that REPLACES something the user may have typed rather than adding a file beside the game.
  | 'replace-game-title'
  // The same game turned up on the card AND on this PC. Both answers are answers — "No" means "leave
  // them as they are", not "never mind" — and both are remembered (see GameCollision).
  | 'game-collision';

/** Where B/Esc/veil returns FROM the confirm view: install/uninstall come from Details, the power
 *  actions come from Power; a screen's question returns to that screen, which is still open underneath. */
export type ConfirmReturnTo = 'details' | 'power' | 'settings' | 'game-settings';

/** What the confirm view shows for one question. Fields left undefined leave the DOM as it was. */
export interface ConfirmCopy {
  readonly returnTo: ConfirmReturnTo;
  readonly message: string;
  /** Which note the install confirm shows (styles.css keys on data-install-via); null takes it off. */
  readonly installVia: 'steam' | 'copy' | null;
  /** Prefix-cleanup uninstall shows its own note in the detail; null takes it off. Only the
   *  install/uninstall question touches it. */
  readonly uninstallVia?: 'prefix' | null;
  /** The destination path under an install question ('' for steam / copy, which have none to type). */
  readonly path?: string;
  /** The note under a delete / collision question. */
  readonly note?: string;
  /** The game a "forget" is about — captured HERE, not read again on Yes (see the branch). */
  readonly forgetId?: string;
}

export interface ConfirmContext {
  /** The game the launch/uninstall actions apply to right now — undefined when none does. */
  readonly game: GameInfo | undefined;
  readonly browse: BrowseInfo | null;
  /** The collision the open question is about, if one was raised. */
  readonly collision: GameCollision | null;
  /** Whether the game about to be deleted is a LOCAL one, whose save backups survive the deletion. */
  deletesLocalGame(): boolean;
  /** The game name the "replace the title?" question quotes. */
  readonly title: string;
}

/**
 * The copy of the confirm for `mode`, or null when the question does not apply any more (nothing to
 * install, a history game that became playable, a collision nobody raised) — the popup then stays as is.
 */
export function describeConfirm(
  mode: ConfirmMode,
  ctx: ConfirmContext,
  t: Translator,
): ConfirmCopy | null {
  if (mode === 'install' || mode === 'uninstall') {
    const game = ctx.game;
    if (game === undefined) return null;
    if (mode === 'install' && !game.requiresInstall) return null; // nothing to install
    if (mode === 'uninstall' && !game.canUninstall) return null; // nothing to uninstall
    const isSteam = game.installVia === 'steam';
    const isCopy = game.installVia === 'copy';
    const isSteamInstall = mode === 'install' && isSteam;
    // Picks WHICH note the confirm shows: steam → none, copy → "it will be copied here and run from
    // here", absent → the card-installer one with the destination path.
    const installVia = isSteamInstall ? 'steam' : mode === 'install' && isCopy ? 'copy' : null;
    // Prefix-cleanup uninstall shows its own note in the detail (CSS) — the heading stays a short question.
    const uninstallVia = mode === 'uninstall' && game.prefixCleanupOnly === true ? 'prefix' : null;
    const message = isSteam
      ? t(mode === 'install' ? 'launcher.confirm.steamInstall' : 'launcher.confirm.steamUninstall')
      : mode === 'install'
        ? t('launcher.confirm.install')
        : // Uninstall: a normal exe game's "uninstall" only clears its Proton prefix (the game stays on
          // the card) — a different message from removing an installed game. prefixCleanupOnly flags it.
          t(
            game.prefixCleanupOnly === true
              ? 'launcher.confirm.uninstallPrefix'
              : 'launcher.confirm.uninstall',
          );
    return {
      returnTo: 'details',
      message,
      installVia,
      uninstallVia,
      // Card path only for a card-INSTALLER install: steam has no install dir, and for copy the path is
      // ours to manage — the user has nothing to type it into.
      ...(mode === 'install'
        ? { path: isSteamInstall || isCopy ? '' : (game.installDir ?? '') }
        : {}),
    };
  }
  if (mode === 'forget') {
    // Remove-from-history confirm (from Details). The id is captured HERE, not read again on Yes: main
    // can move the screen onto another game while the popup is open (a card is inserted), and the one
    // the question was asked about is the only one it may answer for.
    const browse = ctx.browse;
    if (browse === null || browse.active) return null; // gone or now playable — the item no longer applies
    return {
      returnTo: 'details',
      message: t('launcher.confirm.forget', { title: browse.title }),
      installVia: null,
      forgetId: browse.id,
    };
  }
  if (mode === 'game-collision') {
    // Not a menu question: main raised it after a card came in, so there is nothing underneath to
    // return to — B and the veil simply leave it unanswered, and the next insertion asks again.
    const collision = ctx.collision;
    if (collision === null) return null;
    return {
      returnTo: 'details',
      message: t('launcher.confirm.collision', { title: collision.title }),
      installVia: null,
      note: t('launcher.confirm.collisionNote'),
    };
  }
  if (mode === 'reset-settings') {
    // Asked from the Settings screen, which stays open UNDER the popup — so "No" must return there,
    // not to the Details menu the screen was reached through.
    return { returnTo: 'settings', message: t('settings.confirmReset'), installVia: null };
  }
  if (
    mode === 'reset-game-settings' ||
    mode === 'delete-game' ||
    mode === 'delete-game-history' ||
    mode === 'discard-game-settings' ||
    mode === 'switch-game-source' ||
    mode === 'cancel-move-game-settings' ||
    mode === 'replace-game-title'
  ) {
    // The Customize screen's questions. Same shape as the Settings reset: the screen stays open
    // underneath, so "No" simply closes the popup and hands control back to it.
    const browse = ctx.browse;
    const message =
      mode === 'replace-game-title'
        ? t('metadata.titleConfirm', { title: ctx.title })
        : mode === 'reset-game-settings'
          ? t('gameSettings.confirmReset')
          : mode === 'discard-game-settings'
            ? t('gameSettings.confirmDiscard')
            : mode === 'switch-game-source'
              ? t('gameSettings.confirmSwitchSource')
              : mode === 'cancel-move-game-settings'
                ? t('gameSettings.confirmCancelMove')
                : mode === 'delete-game-history'
                  ? t('gameSettings.confirmDeleteHistory', { title: browse?.title ?? '' })
                  : t('gameSettings.confirmDelete', { title: browse?.title ?? '' });
    // The second question's own note: what each of ITS answers costs. It matters more than the first
    // one's, because "No" here does not mean "never mind" — it deletes the game and keeps the card.
    // A local game's save backups survive the deletion — gcOrphans sweeps artwork and never touches
    // saves/ — and a confirm that stayed silent about it would read as "everything goes".
    const note =
      mode === 'delete-game-history'
        ? t('gameSettings.confirmDeleteHistoryNote')
        : mode === 'delete-game'
          ? t(
              ctx.deletesLocalGame()
                ? 'gameSettings.confirmDeleteSavesNote'
                : 'gameSettings.confirmDeleteNote',
            )
          : undefined;
    return {
      returnTo: 'game-settings',
      message,
      installVia: null,
      ...(note === undefined ? {} : { note }),
    };
  }
  if (mode === 'kill') {
    // Force-close confirm (from Details): no path note; returns to Details. The message warns about
    // unsaved progress. data-mode ≠ 'install' hides the path note (styles.css).
    return { returnTo: 'details', message: t('launcher.confirm.kill'), installVia: null };
  }
  // Power action: a single-question confirm, no path note (data-mode ≠ 'install' hides it).
  const key =
    mode === 'shutdown'
      ? 'launcher.confirm.shutdown'
      : mode === 'reboot'
        ? 'launcher.confirm.reboot'
        : 'launcher.confirm.sleep';
  return { returnTo: 'power', message: t(key), installVia: null };
}

export interface ConfirmActionDeps {
  readonly api: ControlsApi;
  readonly audio: Pick<AudioController, 'play'>;
  readonly settings: Pick<SettingsNav, 'resetSettings'>;
  readonly gameSettings: Pick<GameSettingsNav, 'confirmAccepted'>;
  /** The id the open "forget" was asked about, handed over once (the popup clears it). */
  takeForgetId(): string | null;
  /** The collision question's "yes". */
  mergeCollision(): void;
}

/**
 * What a "Yes" runs, once the popup has already closed. `delete-game` never reaches here: its "Yes"
 * grows the second question on the same surface (see acceptConfirm in popups.ts).
 */
export function runConfirmedAction(
  mode: Exclude<ConfirmMode, 'delete-game'>,
  deps: ConfirmActionDeps,
): void {
  const { audio } = deps;
  switch (mode) {
    case 'install':
      audio.play('play');
      deps.api.requestLaunch(); // main decides install vs launch from requiresInstall
      break;
    case 'uninstall':
      audio.play('button'); // neutral sound for the destructive confirm
      deps.api.requestUninstall();
      break;
    case 'kill':
      audio.play('button'); // neutral sound for the destructive confirm
      deps.api.requestKill();
      break;
    case 'forget': {
      audio.play('button'); // neutral sound for the destructive confirm
      const forgetId = deps.takeForgetId();
      if (forgetId !== null) deps.api.forgetGame(forgetId);
      break;
    }
    case 'shutdown':
      audio.play('button');
      deps.api.requestShutdown();
      break;
    case 'reboot':
      audio.play('button');
      deps.api.requestReboot();
      break;
    case 'sleep':
      audio.play('button');
      deps.api.requestSleep();
      break;
    case 'reset-settings':
      audio.play('button'); // neutral sound for the destructive confirm
      deps.settings.resetSettings();
      break;
    case 'reset-game-settings':
      audio.play('button'); // neutral sound for the destructive confirm
      deps.gameSettings.confirmAccepted('reset');
      break;
    case 'delete-game-history':
      audio.play('button'); // neutral sound for the destructive confirm
      deps.gameSettings.confirmAccepted('delete-history');
      break;
    case 'discard-game-settings':
      audio.play('back');
      deps.gameSettings.confirmAccepted('discard');
      break;
    case 'switch-game-source':
      audio.play('button');
      deps.gameSettings.confirmAccepted('switch-source');
      break;
    case 'cancel-move-game-settings':
      audio.play('back');
      deps.gameSettings.confirmAccepted('cancel-move');
      break;
    case 'game-collision':
      audio.play('button');
      deps.mergeCollision();
      break;
    case 'replace-game-title':
      audio.play('button');
      deps.gameSettings.confirmAccepted('replace-title');
      break;
    default: {
      // A mode with no branch here is a Yes that closes the popup and does nothing, which is exactly
      // how "Update title" came to be a button that asked and then ignored the answer. Now a missing
      // branch is a compile error.
      const unhandled: never = mode;
      return unhandled;
    }
  }
}
