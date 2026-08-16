// Interaction layer (split out of app.ts). Owns the single popup (Details / Power / Confirm / Error),
// the two focus groups (the main bar + the popup's vertical action stack) and the user actions they
// trigger, plus all their wiring: button/veil clicks, mouse hover, the gamepad controller and the
// keyboard Esc handler. These are bidirectionally coupled (popups call applyFocus; focus reads the
// popup-open flag), so they live together as one cohesive controller rather than two half-modules with
// fragile circular wiring. It reaches back into app.ts only through the narrow `deps` seam (current
// state + the audio controller); app.ts drives it via applyGameButtons/clearGameButtons/refresh/
// showError and starts it with start().
//
// The popup is a state machine: one #popup element whose content + action stack switch by data-view.
// Navigation is vertical (up/down) inside a stack; the default focus is always the BOTTOM button
// (Close / No / Sleep), which the mockup draws filled. B/Esc/veil step BACK one level.
import type { AppState, BrowseInfo, GameInfo } from '../shared/types';
import type { Translator } from '../shared/i18n/index.js';
import { NAV_REPEAT_MS, createGamepadController } from './gamepad.js';
import type { NavSurface } from './nav-surface.js';
import type { MoveResult } from './carousel.js';
import { type AudioController } from './audio.js';
import { gameOf, phaseOf, steamBusy } from './state-view.js';
import { req, reqQuery } from './dom.js';

// The current popup view (mutually exclusive; 'none' = closed). Mirrors the data-view on #popup.
type PopupView = 'none' | 'details' | 'power' | 'confirm' | 'error';
// Which action the confirm view is asking about (only meaningful while popupView === 'confirm').
type ConfirmMode =
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
  | 'discard-game-settings';
// Gamepad A doesn't trigger :active, so flash a press class to play the scale-down animation.
const PRESS_MS = 130;
/** How far the pointer must travel before hover may take the focus again (see armHover). */
const HOVER_WAKE_PX = 6;
/** How long the popup takes to fade out (.popup transition in styles.css) — the window its contents
 *  must stay frozen for, so the user never watches the menu rewrite itself on the way out. */
const POPUP_FADE_MS = 350;

/** What the interaction layer needs from the rest of the renderer. */
export interface ControlsDeps {
  /** The current AppState snapshot (app.ts owns it; updated before it calls into here). */
  getState(): AppState;
  /**
   * What is on screen (browse:update). Needed because AppState alone can no longer answer "does Play act
   * on what I'm looking at?": while a card is inserted the state describes ITS game, but the screen may
   * be showing a history game — pressing Play there would launch someone else.
   */
  getBrowse(): BrowseInfo | null;
  /** The shared audio controller (UI sounds). */
  audio: AudioController;
  /** The current translator (read live so menu/confirm copy follows the language). */
  getTranslator(): Translator;
  /** The history carousel — the THIRD focus group, above the bar and the popup stack (see navLeft…). */
  carousel: CarouselNav;
  /** The Settings screen — the FOURTH surface, between the popup and the carousel (see navLeft…). */
  settings: SettingsNav;
  /** The Customize screen — the fifth surface, at the same level as Settings (see `overlays` below). */
  gameSettings: GameSettingsNav;
  /**
   * A direction is being HELD, i.e. the strip is flipping on its own (true), or it has just been let go
   * (false). The background subsystem holds its image for the duration — see hero.setFlipping.
   */
  onFlipping(flipping: boolean): void;
  /**
   * Any user input reached the launcher (gamepad/keyboard or a real mouse move). Feeds the presence
   * signal, which decides whether main may pop a notification toast at this moment — see presence.ts.
   */
  onInput(): void;
}

/**
 * What the interaction layer needs from the Settings screen. The screen owns its rows, focus and IPC
 * (settings-screen.ts); this module only routes the six primitives to it and guards the mechanisms that
 * would otherwise keep running underneath (idle timer, wheel, Y).
 */
export interface SettingsNav extends NavSurface {
  open(): void;
  close(): void;
  /** Runs the reset once the shared confirm popup says yes. */
  resetSettings(): void;
}

/**
 * The same seam for the Customize screen. It is an OVERLAY like Settings — same level, never both open —
 * which is why the routing below asks "which overlay is up?" rather than naming one: a third screen
 * (adding a game) then costs one line here instead of a rewrite of every primitive.
 */
export interface GameSettingsNav extends NavSurface {
  open(id: string): void;
  close(): void;
  /** Whether there are unsaved edits — decides whether leaving asks first. */
  isDirty(): boolean;
  /** Whether the game about to be deleted is a LOCAL one, whose save backups survive the deletion. */
  deletesLocalGame(): boolean;
  /** The shared confirm popup said yes to one of the screen's three questions. */
  confirmAccepted(kind: 'reset' | 'delete' | 'discard'): void;
}

/**
 * What the interaction layer needs from the carousel. A narrow seam on purpose: the carousel owns its
 * strip and selection, this module owns which surface the buttons currently drive.
 */
export interface CarouselNav {
  /** 'carousel' (the strip) or 'detail' (the bar screen). */
  screen(): 'carousel' | 'detail';
  /** Moves the selection by `delta` cards; says whether it moved, hit an end, or was locked mid-morph. */
  move(delta: number): MoveResult;
  /** Enters the selected card's detail screen. */
  activate(): void;
  /** Steps back from a detail screen to the strip; false when there is no carousel to return to. */
  leaveDetail(): boolean;
  /** Whether a carousel exists at all (>1 game) — gates the Details menu's "Home" item. */
  exists(): boolean;
}

export interface Controls {
  /** Refreshes the game-dependent menu item (Install/Uninstall text + visibility) from the current state. */
  applyGameButtons(): void;
  /** The Settings screen closed itself — restore the bar highlight on the More button it came from. */
  settingsClosed(): void;
  /** The Settings screen asked to reset — opens the shared confirm popup (No returns to Settings). */
  confirmResetSettings(): void;
  /** The Customize screen asked one of its three questions — opens the same shared confirm popup. */
  confirmGameSettings(kind: 'reset' | 'delete' | 'discard'): void;
  /** Clears the game-dependent menu item for the idle/no-game screen. */
  clearGameButtons(): void;
  /** Per-render refresh: force-close the popup off the ready screen (or while steam-busy), then re-apply focus. */
  refresh(): void;
  /** Opens the error popup with the given message (a failed launch/action from main). */
  showError(message: string): void;
  /** Seeds whether this is a Game Mode (gamescope) session — drops "Minimize Playhook" from the power
   *  menu, since there is no tray to minimize into there. Called once at startup. */
  setGameMode(gameMode: boolean): void;
  /** Starts the gamepad polling loop. */
  start(): void;
  /** Pause/resume acting on gamepad input (paused while the launcher is backgrounded — a game on top). */
  setGamepadPaused(paused: boolean): void;
}

/**
 * Whether the pointer is over text the user is allowed to select — computed from the effective
 * `user-select`, not from a hard-coded class list, so any future selectable text is covered by
 * construction. Everything in this UI is `user-select: none` (styles.css) except where a rule opts back
 * in, currently the install path in the confirm popup.
 */
function isOverSelectableText(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const selectable = getComputedStyle(target).userSelect;
  return selectable !== 'none';
}

export function createControls(deps: ControlsDeps): Controls {
  const { audio } = deps;
  const state = (): AppState => deps.getState();
  const t = (): Translator => deps.getTranslator();

  /**
   * The GameInfo of what is on screen, or undefined when the screen shows a history game (nothing to
   * install, uninstall or launch there). Everything that used to read `gameOf(state())` for a SCREEN
   * decision goes through here; `state()` is still read for PHASE decisions (busy / running / killing).
   */
  const screenGame = (): GameInfo | undefined => {
    const browse = deps.getBrowse();
    if (browse === null) return gameOf(state()); // no browse model yet (first paint) — behave as before
    return browse.active ? (browse.game ?? gameOf(state())) : undefined;
  };

  /** Whether the launch/uninstall actions apply to what is on screen: it must be a card game AND the one
   * AppState is currently about (you can browse game B while game A is busy — B is not actionable). */
  const screenIsActionable = (): boolean => {
    const browse = deps.getBrowse();
    if (browse === null) return true; // pre-browse behaviour
    if (!browse.active) return false;
    const subject = gameOf(state())?.id;
    return subject === undefined || subject === browse.id;
  };
  // SteamOS Game Mode (gamescope): no tray, so the power menu's primary item quits instead of minimizing.
  // Seeded once at startup (setGameMode); false until then — the power menu isn't reachable that early.
  let gameMode = false;

  /**
   * The full-screen overlays, as a set rather than as a named one. Every mechanism that has to stand down
   * while a screen is up — the idle timer, the wheel, Y, and all six primitives — asks THESE two
   * questions instead of `settings.isOpen()`, so the next screen is one entry in this list rather than an
   * eleventh edit in every primitive (see the plan, Р1).
   *
   * At most one is ever open: a screen is entered from the Details menu, which closes on the way in, and
   * a surface that opens on top of a screen (the keyboard, the file picker) belongs to that screen's own
   * stack rather than to this list.
   */
  const overlays = {
    active: (): NavSurface | null => {
      if (deps.settings.isOpen()) return deps.settings;
      if (deps.gameSettings.isOpen()) return deps.gameSettings;
      return null;
    },
    isAnyOpen: (): boolean => deps.settings.isOpen() || deps.gameSettings.isOpen(),
  };

  // The app shell — carries the attributes CSS keys the screen-level states on (see setCarouselBarFocus).
  const app = req('app');

  // Bar buttons.
  const playButton = req<HTMLButtonElement>('play-button');
  const moreButton = req<HTMLButtonElement>('more-button');

  // The single popup + its veil, plus the content fields set from JS.
  const popup = req('popup');
  const popupVeil = reqQuery<HTMLElement>('#popup .popup-veil');
  const confirmMessage = req('confirm-message');
  const confirmPath = req('confirm-path');
  const errorMessageEl = req('error-message');
  const deleteNote = req('delete-note');

  // Action-stack buttons (grouped by view in the HTML).
  const menuShutdown = req<HTMLButtonElement>('menu-shutdown');
  const menuInstallToggle = req<HTMLButtonElement>('menu-install-toggle');
  const menuKill = req<HTMLButtonElement>('menu-kill');
  const menuHome = req<HTMLButtonElement>('menu-home');
  const menuCustomize = req<HTMLButtonElement>('menu-customize');
  const menuForget = req<HTMLButtonElement>('menu-forget');
  const menuSettings = req<HTMLButtonElement>('menu-settings');
  const menuClose = req<HTMLButtonElement>('menu-close');
  const powerShutdown = req<HTMLButtonElement>('power-shutdown');
  const powerReboot = req<HTMLButtonElement>('power-reboot');
  const powerSleep = req<HTMLButtonElement>('power-sleep');
  const powerMinimize = req<HTMLButtonElement>('power-minimize');
  const powerQuit = req<HTMLButtonElement>('power-quit');
  const powerClose = req<HTMLButtonElement>('power-close');
  const confirmYes = req<HTMLButtonElement>('confirm-yes');
  const confirmNo = req<HTMLButtonElement>('confirm-no');
  const errorClose = req<HTMLButtonElement>('error-close');

  let popupView: PopupView = 'none';
  let confirmMode: ConfirmMode = 'uninstall';
  // Where B/Esc/veil returns FROM the confirm view: install/uninstall come from Details, the power
  // actions come from Power.
  let confirmReturnTo: 'details' | 'power' | 'settings' | 'game-settings' = 'details';
  /** The game the open remove-from-history confirm is about — captured when it opens (see openConfirm). */
  let forgetId: string | null = null;

  // ── Popup machine ────────────────────────────────────────────────────────────
  // One #popup element; opening = add .is-open + set data-view; switching views keeps .is-open (so the
  // shared veil never cross-fades). Closing removes .is-open.

  function setView(view: Exclude<PopupView, 'none'>): void {
    // Every view change lays a new stack under the pointer — hover must not claim the focus the view
    // itself just set (see the mousemove handler).
    armHover();
    popupView = view;
    popup.dataset['view'] = view;
    popup.classList.add('is-open');
    popup.setAttribute('aria-hidden', 'false');
  }

  /**
   * Closing is a 0.35s fade, and the menu is still on screen for all of it. Anything that rebuilds its
   * items in that window is visible — pressing "Home" leaves the detail screen, which swaps the game's
   * items for the launcher's, and the user watched that happen through the fading popup. So the items
   * are frozen until the fade is over, then brought up to date in one go for the next opening.
   */
  let menuThawTimer = 0;

  function freezeMenuDuringFade(): void {
    if (menuThawTimer !== 0) window.clearTimeout(menuThawTimer);
    menuThawTimer = window.setTimeout(() => {
      menuThawTimer = 0;
      applyGameButtons();
    }, POPUP_FADE_MS);
  }

  /** Whether the menu's items are currently held still (see freezeMenuDuringFade). */
  function menuFrozen(): boolean {
    return menuThawTimer !== 0;
  }

  /** Ends the freeze early and rebuilds now — used when the popup opens again mid-fade. */
  function thawMenu(): void {
    if (menuThawTimer === 0) return;
    window.clearTimeout(menuThawTimer);
    menuThawTimer = 0;
  }

  function closePopup(): void {
    if (popupView === 'none') return;
    popupView = 'none';
    popup.classList.remove('is-open');
    popup.setAttribute('aria-hidden', 'true');
    freezeMenuDuringFade();
    applyStackFocus(); // clear the stack highlight (stackActive becomes false)
    applyFocus(); // restore the main bar highlight
  }

  // Details menu (from More): game stats on top + Shutdown / Install|Uninstall / Close stack. Works on
  // every screen — on the empty (no-card) screen there are no stats and no Install/Uninstall, so it
  // degrades to just System + Close.
  function openDetails(): void {
    thawMenu(); // a re-open inside the fade window must show the CURRENT items, not the frozen ones
    applyMenuInstallToggle(); // keep the toggle's text/visibility fresh for the current game
    applyMenuKill(); // keep the force-close item's visibility fresh (running-only)
    applyMenuHome(); // keep the "Home" item fresh (only when there is a carousel to go back to)
    applyMenuCustomize(); // …and "Customize", which only applies to a game we can reach the file of
    applyMenuForget(); // keep the "Remove from history" item fresh (history-only games)
    applyMenuSystem(); // …and System, which belongs to the carousel level, not to a game
    applyMenuSettings(); // …and Settings, which belongs to that level too
    setView('details');
    focusStackBottom(); // default focus: Close
    applyFocus(); // main highlight clears (focusActive false with a popup open)
  }

  // Power submenu (from Details → Shutdown): Shutdown / Reboot / Sleep. Each opens a Yes/No confirm.
  function openPower(): void {
    setView('power');
    focusStackBottom(); // default focus: Close (bottom) — a safe non-destructive default
    applyFocus();
  }

  // Confirm view — install/uninstall (from Details) or a power action (from Power). Yes runs the action
  // and closes the whole stack; No/back returns to where it came from.
  function openConfirm(mode: ConfirmMode): void {
    if (mode === 'install' || mode === 'uninstall') {
      const game = screenIsActionable() ? screenGame() : undefined;
      if (game === undefined) return;
      if (mode === 'install' && !game.requiresInstall) return; // nothing to install
      if (mode === 'uninstall' && !game.canUninstall) return; // nothing to uninstall
      confirmReturnTo = 'details';
      const isSteam = game.installVia === 'steam';
      const isCopy = game.installVia === 'copy';
      const isSteamInstall = mode === 'install' && isSteam;
      popup.dataset['mode'] = mode; // 'install' shows the note (card install only, see styles.css)
      // Picks WHICH note the confirm shows: steam → none, copy → "it will be copied here and run from
      // here", absent → the card-installer one with the destination path.
      if (isSteamInstall) popup.dataset['installVia'] = 'steam';
      else if (mode === 'install' && isCopy) popup.dataset['installVia'] = 'copy';
      else delete popup.dataset['installVia'];
      // Prefix-cleanup uninstall shows its own note in the detail (CSS) — the heading stays a short question.
      if (mode === 'uninstall' && game.prefixCleanupOnly === true)
        popup.dataset['uninstallVia'] = 'prefix';
      else delete popup.dataset['uninstallVia'];
      if (isSteam) {
        confirmMessage.textContent = t()(
          mode === 'install' ? 'launcher.confirm.steamInstall' : 'launcher.confirm.steamUninstall',
        );
      } else if (mode === 'install') {
        confirmMessage.textContent = t()('launcher.confirm.install');
      } else {
        // Uninstall: a normal exe game's "uninstall" only clears its Proton prefix (the game stays on the
        // card) — a different message from removing an installed game. prefixCleanupOnly flags that case.
        confirmMessage.textContent = t()(
          game.prefixCleanupOnly === true
            ? 'launcher.confirm.uninstallPrefix'
            : 'launcher.confirm.uninstall',
        );
      }
      // Card path only for a card-INSTALLER install: steam has no install dir, and for copy the path is
      // ours to manage — the user has nothing to type it into.
      if (mode === 'install') {
        confirmPath.textContent = isSteamInstall || isCopy ? '' : (game.installDir ?? '');
      }
    } else if (mode === 'forget') {
      // Remove-from-history confirm (from Details). The id is captured HERE, not read again on Yes: main
      // can move the screen onto another game while the popup is open (a card is inserted), and the one
      // the question was asked about is the only one it may answer for.
      const browse = deps.getBrowse();
      if (browse === null || browse.active) return; // gone or now playable — the item no longer applies
      forgetId = browse.id;
      confirmReturnTo = 'details';
      popup.dataset['mode'] = mode;
      delete popup.dataset['installVia'];
      confirmMessage.textContent = t()('launcher.confirm.forget', { title: browse.title });
    } else if (mode === 'reset-settings') {
      // Asked from the Settings screen, which stays open UNDER the popup — so "No" must return there,
      // not to the Details menu the screen was reached through.
      confirmReturnTo = 'settings';
      popup.dataset['mode'] = mode;
      delete popup.dataset['installVia'];
      confirmMessage.textContent = t()('settings.confirmReset');
    } else if (
      mode === 'reset-game-settings' ||
      mode === 'delete-game' ||
      mode === 'discard-game-settings'
    ) {
      // The Customize screen's three questions. Same shape as the Settings reset: the screen stays open
      // underneath, so "No" simply closes the popup and hands control back to it.
      confirmReturnTo = 'game-settings';
      popup.dataset['mode'] = mode;
      delete popup.dataset['installVia'];
      const browse = deps.getBrowse();
      confirmMessage.textContent =
        mode === 'reset-game-settings'
          ? t()('gameSettings.confirmReset')
          : mode === 'discard-game-settings'
            ? t()('gameSettings.confirmDiscard')
            : t()('gameSettings.confirmDelete', { title: browse?.title ?? '' });
      if (mode === 'delete-game') {
        // A local game's save backups survive the deletion — gcOrphans sweeps artwork and never touches
        // saves/ — and a confirm that stayed silent about it would read as "everything goes".
        deleteNote.textContent = t()(
          deps.gameSettings.deletesLocalGame()
            ? 'gameSettings.confirmDeleteSavesNote'
            : 'gameSettings.confirmDeleteNote',
        );
      }
    } else if (mode === 'kill') {
      // Force-close confirm (from Details): no path note; returns to Details. The message warns about
      // unsaved progress. data-mode ≠ 'install' hides the path note (styles.css).
      confirmReturnTo = 'details';
      popup.dataset['mode'] = mode;
      delete popup.dataset['installVia'];
      confirmMessage.textContent = t()('launcher.confirm.kill');
    } else {
      // Power action: a single-question confirm, no path note (data-mode ≠ 'install' hides it).
      confirmReturnTo = 'power';
      popup.dataset['mode'] = mode;
      delete popup.dataset['installVia'];
      const key =
        mode === 'shutdown'
          ? 'launcher.confirm.shutdown'
          : mode === 'reboot'
            ? 'launcher.confirm.reboot'
            : 'launcher.confirm.sleep';
      confirmMessage.textContent = t()(key);
    }
    confirmMode = mode;
    setView('confirm');
    focusStackBottom(); // default focus: No (safe default)
    applyFocus();
  }

  // Error popup — opened by main via showError (a failed launch/action). A single Close button.
  function openError(messageText: string): void {
    errorMessageEl.textContent = messageText;
    setView('error');
    focusStackBottom(); // the sole button (Close)
    applyFocus();
  }

  // B / Esc / veil: step BACK one level. power → details, confirm → wherever it was opened from,
  // details / error → close. Default focus lands on the bottom button of the destination stack.
  function back(): void {
    switch (popupView) {
      case 'power':
        audio.play('back');
        setView('details');
        focusStackBottom();
        break;
      case 'confirm':
        audio.play('back');
        // Neither 'settings' nor 'game-settings' is a popup view: that screen is already open
        // underneath, so the popup just goes and the screen has the focus again.
        if (confirmReturnTo === 'settings' || confirmReturnTo === 'game-settings') {
          closePopup();
          break;
        }
        setView(confirmReturnTo);
        focusStackBottom();
        break;
      case 'details':
      case 'error':
        audio.play('back');
        closePopup();
        break;
      default:
        break;
    }
  }

  // ── Settings screen (the fourth surface) ─────────────────────────────────────
  // Opening/closing lives here because the bar focus does: the screen is entered from More and returns
  // to it. Everything INSIDE the screen belongs to settings-screen.ts.

  function openSettings(): void {
    deps.settings.open();
    applyFocus(); // the bar highlight clears (focusActive is false with the screen open)
  }

  function openCustomize(): void {
    const browse = deps.getBrowse();
    if (browse === null || !browse.active) return; // the item's own rule, re-checked at the press
    deps.gameSettings.open(browse.id);
    applyFocus();
  }

  /** The screen closed itself (B / Esc / veil): put the highlight back on the More button it came from. */
  function settingsClosed(): void {
    const items = mainFocusables();
    const more = items.indexOf(moreButton);
    if (more !== -1) focusIndex = more;
    focusRevealed = true;
    applyFocus();
    armIdleTimer(); // the countdown was suspended while the screen was up
  }

  // ── Menu item: Install / Uninstall (game-dependent) ──────────────────────────
  // One button whose text + visibility follow the current game: "Install" when it needs installing,
  // "Uninstall" when installed & removable, hidden entirely for a plain executable (no install block).
  /**
   * Whether the Details menu currently belongs to ONE game. On the carousel it does not: the strip is a
   * browsing surface, and its More is the launcher-level menu (System + Close). Every game-specific item
   * is gated on this, so none of them can appear over a row of cards.
   */
  function onGameScreen(): boolean {
    return deps.carousel.screen() === 'detail';
  }

  /**
   * System lives at the top level — the carousel — so the game's own menu is only about the game. With NO
   * carousel to go up to (a single-game card, the empty screen) the detail menu is the only menu there
   * is, and dropping System there would strand Shutdown / Minimize Playhook with no way to reach them.
   */
  function applyMenuSystem(): void {
    if (menuFrozen()) return;
    menuShutdown.classList.toggle('is-hidden', onGameScreen() && deps.carousel.exists());
  }

  /**
   * Settings live at the launcher level (Home), not inside one game's menu — the same rule System
   * follows, and the same exception: with NO carousel to go up to (a single-game card, the empty screen)
   * the detail menu is the only menu there is, and hiding Settings there would put them out of reach.
   */
  function applyMenuSettings(): void {
    if (menuFrozen()) return;
    menuSettings.classList.toggle('is-hidden', onGameScreen() && deps.carousel.exists());
  }

  function applyMenuInstallToggle(): void {
    if (menuFrozen()) return;
    if (!onGameScreen()) {
      menuInstallToggle.classList.add('is-hidden');
      return;
    }
    const game = screenIsActionable() ? screenGame() : undefined;
    // While an install/uninstall (card or Steam) is in flight, the Install/Uninstall item is hidden —
    // acting on it mid-operation makes no sense (Details still opens for the stats + power actions).
    const busy = phaseOf(state()) === 'busy' || steamBusy(state());
    const showInstall = !busy && game?.requiresInstall === true;
    const showUninstall = !busy && game?.canUninstall === true;
    const show = showInstall || showUninstall;
    menuInstallToggle.classList.toggle('is-hidden', !show);
    if (show) {
      menuInstallToggle.textContent = t()(
        showInstall ? 'launcher.menu.install' : 'launcher.menu.uninstall',
      );
      // Which action Yes will run — read back in the stack trigger.
      menuInstallToggle.dataset['action'] = showInstall ? 'install' : 'uninstall';
    }
  }

  // ── Menu item: Force close (running-only) ────────────────────────────────────
  // The MIRROR IMAGE of the install toggle: shown ONLY while a game is running (running is a busy phase,
  // so this is the exact opposite of the install toggle, which hides during busy). Text from JS (no
  // data-i18n) so a language change re-labels it at render time and it stays out of the i18n HTML test.
  function applyMenuKill(): void {
    if (menuFrozen()) return;
    // Shown only while a game is running AND a force-close isn't already in flight (during killing the
    // status reads "Force closing…" and the button would be a no-op — main guards a repeat anyway).
    const s = state();
    const running = onGameScreen() && s.kind === 'running' && s.killing !== true;
    menuKill.classList.toggle('is-hidden', !running);
    if (running) menuKill.textContent = t()('launcher.menu.forceClose');
  }

  // ── Menu item: Home (back to the history carousel) ───────────────────────────
  // The MOUSE route out of a detail screen — the gamepad/keyboard have B for it, but a mouse user had no
  // way back to the strip. Shown only on a detail screen that has a carousel behind it.
  function applyMenuHome(): void {
    if (menuFrozen()) return;
    const show = deps.carousel.exists() && deps.carousel.screen() === 'detail';
    menuHome.classList.toggle('is-hidden', !show);
    if (show) menuHome.textContent = t()('launcher.menu.home');
  }

  // ── Menu item: Remove from history (history-only games) ──────────────────────
  // Offered ONLY for a game that is not available right now — `active` is main's word for "on the card or
  // in the PC library". Those games are rebuilt from their manifests on every insert, so removing one
  // would be a lie the next refresh undoes; what CAN be removed is the record of a game you no longer have.
  // ── Menu item: Customize (the per-game manifest editor) ──────────────────────
  // The MIRROR of "Remove from history": that one is for a game we no longer have, this one for a game we
  // do — `active` is main's word for "on the card or in the PC library", and it is exactly the condition
  // under which a game.json to edit exists at all. The two are mutually exclusive by construction, so
  // they never appear together.
  function applyMenuCustomize(): void {
    if (menuFrozen()) return;
    const browse = deps.getBrowse();
    const show = onGameScreen() && browse !== null && browse.active;
    menuCustomize.classList.toggle('is-hidden', !show);
    if (show) menuCustomize.textContent = t()('launcher.menu.customize');
  }

  function applyMenuForget(): void {
    if (menuFrozen()) return;
    const browse = deps.getBrowse();
    const show = onGameScreen() && browse !== null && !browse.active;
    menuForget.classList.toggle('is-hidden', !show);
    if (show) menuForget.textContent = t()('launcher.menu.forget');
  }

  // The power menu carries both ways out of the launcher: "Minimize Playhook" (hide to the tray) and
  // "Close Playhook" (full quit). In Game Mode the first one goes — there is no tray to hide into, so
  // hiding is a no-op there, and the quit is the honest option (mirrors how closing the window quits in
  // Game Mode).
  function applyPowerItems(): void {
    powerMinimize.classList.toggle('is-hidden', gameMode);
  }

  // ── Main bar focus (gamepad / mouse) ─────────────────────────────────────────

  const ALL_MAIN_BUTTONS: readonly HTMLButtonElement[] = [playButton, moreButton];
  let focusIndex = 0;
  // Which SURFACE holds the focus on the carousel screen: the strip (false, the default) or the bar's
  // More button (true). Y flips it — see navToggleBar. Meaningless on the detail screen, where the bar
  // always has it, and reset whenever the carousel is left so returning to it starts on the strip.
  let carouselBarFocus = false;
  // Whether the bar's focus highlight is "awake". It goes dormant when an active state (install / launch
  // / uninstall / steam) appears, so the highlight doesn't auto-jump onto a button the user didn't pick;
  // it wakes again only on an explicit gamepad move or a mouse hover. `wasActive` tracks the edge.
  let focusRevealed = true;
  let wasActive = false;
  // Idle timeout, shared by the bar focus and the mouse cursor: after 5s with no input the bar
  // highlight goes dormant AND the cursor hides. Any input restarts the countdown; the gamepad hides the
  // cursor at once (the user switched to the pad), a real mouse move shows it (see the note* helpers).
  const IDLE_MS = 5_000;
  let idleTimer = 0;
  let cursorHidden = false;

  function mainFocusables(): readonly HTMLButtonElement[] {
    // On the carousel screen Play is not a button at all — it is the selected card's invisible stand-in
    // for the morph (see styles.css) — so More is the whole bar there.
    if (deps.carousel.screen() === 'carousel') return [moreButton];
    // Steam install/uninstall indicator up (phase stays 'ready'): the gear opens Steam's Downloads page
    // and More opens Details — both focusable.
    if (steamBusy(state())) return [playButton, moreButton];
    // Running with the launcher summoned over the game: Play returns to the game, so it's focusable too —
    // EXCEPT while a force-close is in flight (killing), when Play is a non-interactive loading spinner.
    const running = state();
    if (running.kind === 'running')
      return running.killing === true ? [moreButton] : [playButton, moreButton];
    // Hard busy (install / uninstall / launch / save-sync): the Play button is a non-interactive activity
    // indicator (spinner/gear), so only More is focusable — it still opens Details.
    if (phaseOf(state()) === 'busy') return [moreButton];
    // Empty screen, a HISTORY game (nothing to launch) or a requiresInstall installer/steam game → Play is
    // hidden, only More.
    const game = screenIsActionable() ? screenGame() : undefined;
    if (game === undefined || game.requiresInstall === true) return [moreButton];
    return [playButton, moreButton];
  }

  // Main focus is meaningful on every DETAIL screen (the More button is always present there) with the
  // popup closed. On the carousel the strip owns the selection instead — until Y hands the focus to the
  // bar, which is the only way More is reachable there.
  function focusActive(): boolean {
    if (popupView !== 'none') return false;
    // The Settings screen covers the bar (which is faded out and pointer-events:none underneath).
    if (overlays.isAnyOpen()) return false;
    return deps.carousel.screen() === 'detail' || carouselBarFocus;
  }

  function applyFocus(): void {
    const items = mainFocusables();
    focusIndex = Math.min(items.length - 1, Math.max(0, focusIndex));
    const active = focusActive() && focusRevealed;
    ALL_MAIN_BUTTONS.forEach((btn) => {
      const idx = items.indexOf(btn);
      btn.classList.toggle('is-focused', active && idx !== -1 && idx === focusIndex);
    });
  }

  // The Play button's aria-label follows the state: "Return to game" while a game is running (the
  // launcher was summoned over it), "Play" otherwise. Set at render time via the translator (not the
  // static data-i18n-aria-label, which only re-applies on a language change) — see plan F1-5.
  function applyPlayAria(): void {
    // "Return to game" only when running and NOT force-closing (during killing Play is a loader, so the
    // default "Play" label fits better than an action it won't perform).
    const s = state();
    const returnToGame = s.kind === 'running' && s.killing !== true;
    playButton.setAttribute(
      'aria-label',
      t()(returnToGame ? 'launcher.aria.returnToGame' : 'launcher.aria.play'),
    );
  }

  function setCursorHidden(hidden: boolean): void {
    if (cursorHidden === hidden) return;
    cursorHidden = hidden;
    document.documentElement.classList.toggle('cursor-hidden', hidden);
  }

  // (Re)start the idle countdown (IDLE_MS). On expiry the cursor hides and the bar highlight
  // goes dormant if it's shown with nothing open — both "went idle" at the same moment.
  function armIdleTimer(): void {
    if (idleTimer !== 0) window.clearTimeout(idleTimer);
    // With the Settings screen up there is no bar highlight to retire and no carousel to hand back to:
    // firing would strip the return point on More and light the strip up under the veil.
    if (overlays.isAnyOpen()) return;
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      setCursorHidden(true);
      // On the carousel the bar-focus spell is not a highlight that can simply go dormant: dropping it
      // would leave the row dimmed with nothing focused anywhere — a dead screen. Hand the focus back to
      // the cards instead, which is where an untouched carousel belongs.
      // NOT while the menu that button opened is up, though: the focus is inside the popup then, and
      // pulling the surface out from under it would light the row back up behind an open menu.
      if (carouselBarFocus && popupView === 'none') {
        setCarouselBarFocus(false);
        return;
      }
      if (focusRevealed && focusActive()) {
        focusRevealed = false;
        applyFocus();
      }
    }, IDLE_MS);
  }

  // Where the pointer was when hover was last disarmed — by a surface opening under it, or by a
  // keyboard/gamepad step. Until the mouse travels HOVER_WAKE_PX from there, hover does not move the
  // focus: an element arriving under a still cursor is the ELEMENT moving, not the mouse, and Chromium
  // reports both the same way. Cleared by the first genuine move.
  let hoverArmedAt: { readonly x: number; readonly y: number } | null = null;

  function armHover(): void {
    hoverArmedAt = { x: lastMouseX, y: lastMouseY };
  }

  function hoverAwake(x: number, y: number): boolean {
    if (hoverArmedAt === null) return true;
    if (Math.hypot(x - hoverArmedAt.x, y - hoverArmedAt.y) < HOVER_WAKE_PX) return false;
    hoverArmedAt = null;
    return true;
  }

  // Gamepad/keyboard input = activity: hide the cursor at once (the user switched to the pad), disarm
  // hover, restart the idle countdown.
  function noteGamepadActivity(): void {
    deps.onInput();
    setCursorHidden(true);
    // Every keyboard/gamepad step re-arms the hover guard: last input wins. Without this, one real mouse
    // move wakes hover for good, and from then on any element that slides under the still cursor — a
    // scrolling list, a popup opening — can take the focus back off the key that just moved it.
    armHover();
    armIdleTimer();
  }

  // Real mouse movement = activity: show the cursor + restart the idle.
  function noteMouseActivity(): void {
    deps.onInput();
    setCursorHidden(false);
    armIdleTimer();
  }

  function moveFocus(delta: number): void {
    if (!focusActive()) return;
    // Dormant (an active state or the idle timeout cleared the highlight): the first d-pad press only
    // WAKES the highlight at the current button — it doesn't move — so control returns without a jump.
    if (!focusRevealed) {
      focusRevealed = true;
      audio.play('navigate');
      applyFocus();
      return;
    }
    const items = mainFocusables();
    const next = Math.min(items.length - 1, Math.max(0, focusIndex + delta));
    if (next === focusIndex) return; // already at the edge — no move, no sound
    focusIndex = next;
    audio.play('navigate');
    applyFocus();
  }

  // ── Popup stack focus (vertical) ─────────────────────────────────────────────
  // A single dynamic group covering all four views; the visible buttons depend on the view (and, for
  // Details, whether the Install/Uninstall item is present). Default focus is the BOTTOM button.
  const ALL_STACK_BUTTONS: readonly HTMLButtonElement[] = [
    menuInstallToggle,
    menuKill,
    menuForget,
    menuShutdown,
    menuHome,
    menuCustomize,
    menuSettings,
    menuClose,
    powerShutdown,
    powerReboot,
    powerSleep,
    powerMinimize,
    powerQuit,
    powerClose,
    confirmYes,
    confirmNo,
    errorClose,
  ];
  let stackIndex = 0;

  function stackFocusables(): readonly HTMLButtonElement[] {
    switch (popupView) {
      case 'details': {
        // MUST match the DOM order in index.html — this list IS the up/down order, and a mismatch would
        // move the highlight somewhere other than where the eye follows. Volatile items first (they come
        // and go with the game's phase), then the fixed block that ends at Close: see the note there.
        const items: HTMLButtonElement[] = [];
        if (!menuInstallToggle.classList.contains('is-hidden')) items.push(menuInstallToggle);
        if (!menuKill.classList.contains('is-hidden')) items.push(menuKill);
        if (!menuForget.classList.contains('is-hidden')) items.push(menuForget);
        if (!menuShutdown.classList.contains('is-hidden')) items.push(menuShutdown);
        if (!menuHome.classList.contains('is-hidden')) items.push(menuHome);
        if (!menuCustomize.classList.contains('is-hidden')) items.push(menuCustomize);
        if (!menuSettings.classList.contains('is-hidden')) items.push(menuSettings);
        items.push(menuClose);
        return items;
      }
      case 'power': {
        const items: HTMLButtonElement[] = [powerShutdown, powerReboot, powerSleep];
        if (!powerMinimize.classList.contains('is-hidden')) items.push(powerMinimize);
        items.push(powerQuit, powerClose);
        return items;
      }
      case 'confirm':
        return [confirmYes, confirmNo];
      case 'error':
        return [errorClose];
      default:
        return [];
    }
  }

  function stackActive(): boolean {
    return popupView !== 'none';
  }

  function applyStackFocus(): void {
    const items = stackFocusables();
    stackIndex = Math.min(items.length - 1, Math.max(0, stackIndex));
    const focused = stackActive() ? items[stackIndex] : undefined;
    for (const btn of ALL_STACK_BUTTONS) btn.classList.toggle('is-focused', btn === focused);
    if (focused !== undefined) focused.scrollIntoView({ block: 'nearest' });
  }

  function focusStackBottom(): void {
    stackIndex = Math.max(0, stackFocusables().length - 1);
    applyStackFocus();
  }

  function moveStackFocus(delta: number): void {
    if (!stackActive()) return;
    const items = stackFocusables();
    if (items.length === 0) return;
    // Cyclic navigation (wrap around) — shared by every popup stack. The early return keeps a single-button
    // view (error) from playing `navigate` without moving: at len===1 the wrap formula returns the same index.
    const next = (stackIndex + delta + items.length) % items.length;
    if (next === stackIndex) return;
    stackIndex = next;
    audio.play('navigate');
    applyStackFocus();
  }

  function pressFlash(btn: HTMLElement): void {
    btn.classList.add('is-pressed');
    window.setTimeout(() => btn.classList.remove('is-pressed'), PRESS_MS);
  }

  // ── User-initiated actions ───────────────────────────────────────────────────

  function triggerPlay(): void {
    if (!focusActive()) return;
    // Play acts on the game AppState is about, so it must be the one on screen: a history game has
    // nothing to launch, and while you browse game B, "Play" must not start game A behind your back.
    if (!screenIsActionable()) return;
    const game = screenGame();
    // A local game whose files are gone: there is nothing to start, and the status line already says so.
    if (game?.unavailable === true) return;
    // Steam download in progress: the gear opens Steam's Downloads page, where the user can
    // pause/resume (we can't control that programmatically).
    if (game?.steamInstalling === true) {
      audio.play('button');
      window.api.openSteamDownloads();
      return;
    }
    // Steam uninstall in progress (gear) → nothing useful to do, ignore the press.
    if (game?.steamUninstalling === true) return;
    // Force-close in flight: Play is a loading spinner, not return-to-game — ignore the press.
    const s = state();
    if (s.kind === 'running' && s.killing === true) return;
    // In a hard-busy phase the Play button is just an activity indicator (spinner/gear) — no launch.
    // EXCEPT `running`: the launcher was summoned over the game and Play returns to it (main branches on
    // the running state and raises the game's window instead of launching).
    if (phaseOf(state()) !== 'ready' && state().kind !== 'running') return;
    audio.play('play');
    window.api.requestLaunch();
  }

  function triggerMore(): void {
    audio.play('button');
    openDetails();
  }

  function activateFocused(): void {
    // Nothing is selected while the highlight is dormant — the user must wake it (d-pad / hover) first.
    if (!focusActive() || !focusRevealed) return;
    const btn = mainFocusables()[focusIndex];
    if (btn === undefined) return;
    pressFlash(btn);
    if (btn === moreButton) triggerMore();
    else triggerPlay();
  }

  // Dispatch a stack button (shared by gamepad A and mouse click). Each opener/back plays its own sound.
  function triggerStackButton(btn: HTMLButtonElement): void {
    if (btn === menuShutdown) {
      audio.play('button');
      openPower();
    } else if (btn === menuInstallToggle) {
      audio.play('button');
      openConfirm(menuInstallToggle.dataset['action'] === 'install' ? 'install' : 'uninstall');
    } else if (btn === menuKill) {
      audio.play('button');
      openConfirm('kill');
    } else if (btn === menuForget) {
      audio.play('button');
      openConfirm('forget');
    } else if (btn === menuSettings) {
      // The single entrance to Settings — the tray item is gone, so this works the same on the desktop
      // and in Game Mode. The menu it was opened from closes first: the screen is a surface of its own.
      audio.play('button');
      closePopup();
      openSettings();
    } else if (btn === menuCustomize) {
      // Like Settings: the menu it was opened from closes first — the screen is a surface of its own.
      audio.play('button');
      closePopup();
      openCustomize();
    } else if (btn === menuHome) {
      // Non-destructive, so no confirm: close the popup and hand control back to the strip.
      audio.play('back');
      closePopup();
      deps.carousel.leaveDetail();
    } else if (btn === menuClose || btn === errorClose || btn === powerClose) {
      // back() dispatches by the current view: Details/Error → close the popup; Power → step back to
      // the Details menu (so "Close" in the Power submenu returns you one level up, like the B gesture).
      back();
    } else if (btn === powerShutdown) {
      audio.play('button');
      openConfirm('shutdown');
    } else if (btn === powerReboot) {
      audio.play('button');
      openConfirm('reboot');
    } else if (btn === powerSleep) {
      audio.play('button');
      openConfirm('sleep');
    } else if (btn === powerMinimize) {
      // Hide to the tray (same as the empty-screen Hide button); never shown in Game Mode, where there is
      // no tray and this would be a no-op. No confirm — hiding is non-destructive. Close the popup first
      // so a re-summoned launcher shows a clean bar, not this menu.
      audio.play('back');
      closePopup();
      window.api.requestHide();
    } else if (btn === powerQuit) {
      // The full quit. No confirm either: it is as recoverable as relaunching from the Steam library —
      // and in Game Mode this is the only way out, so a confirm would sit between the user and the exit
      // every single time.
      audio.play('back');
      closePopup();
      window.api.requestQuit();
    } else if (btn === confirmYes) {
      acceptConfirm();
    } else if (btn === confirmNo) {
      back(); // cancel → returns to Details / Power
    }
  }

  function activateStack(): void {
    if (!stackActive()) return;
    const btn = stackFocusables()[stackIndex];
    if (btn === undefined) return;
    pressFlash(btn);
    triggerStackButton(btn);
  }

  // "Yes" — closes the ENTIRE popup stack (→ 'none') and runs the action. Closing first is critical for
  // steam-install: after Yes the state stays 'ready', so the popup wouldn't self-close on a state change.
  function acceptConfirm(): void {
    const mode = confirmMode;
    closePopup();
    switch (mode) {
      case 'install':
        audio.play('play');
        window.api.requestLaunch(); // main decides install vs launch from requiresInstall
        break;
      case 'uninstall':
        audio.play('button'); // neutral sound for the destructive confirm
        window.api.requestUninstall();
        break;
      case 'kill':
        audio.play('button'); // neutral sound for the destructive confirm
        window.api.requestKill();
        break;
      case 'forget':
        audio.play('button'); // neutral sound for the destructive confirm
        if (forgetId !== null) window.api.forgetGame(forgetId);
        forgetId = null;
        break;
      case 'shutdown':
        audio.play('button');
        window.api.requestShutdown();
        break;
      case 'reboot':
        audio.play('button');
        window.api.requestReboot();
        break;
      case 'sleep':
        audio.play('button');
        window.api.requestSleep();
        break;
      case 'reset-settings':
        audio.play('button'); // neutral sound for the destructive confirm
        deps.settings.resetSettings();
        break;
      case 'reset-game-settings':
        audio.play('button'); // neutral sound for the destructive confirm
        deps.gameSettings.confirmAccepted('reset');
        break;
      case 'delete-game':
        audio.play('button'); // neutral sound for the destructive confirm
        deps.gameSettings.confirmAccepted('delete');
        break;
      case 'discard-game-settings':
        audio.play('back');
        deps.gameSettings.confirmAccepted('discard');
        break;
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  playButton.addEventListener('click', () => triggerPlay());
  moreButton.addEventListener('click', () => triggerMore());
  popupVeil.addEventListener('click', () => back());

  // A mouse click on a stack button triggers THAT button (regardless of the current highlight); only the
  // active view's group is visible/clickable, so a click can't reach a hidden view's button.
  ALL_STACK_BUTTONS.forEach((btn) => {
    btn.addEventListener('click', () => {
      pressFlash(btn);
      triggerStackButton(btn);
    });
  });

  // ONE window-level mouse handler for both surfaces (the bar and the popup stack), guarded against
  // SYNTHETIC moves — and that guard is the whole point, not a detail.
  //
  // Chromium fires mouse events at unchanged coordinates whenever the element UNDER a still pointer
  // changes: a busy title sliding past, or — the case that bit us — a popup opening with its buttons
  // landing right where the cursor happens to rest. As `mouseenter` handlers, the stack buttons took
  // that for a hover and moved the focus off the item the popup had just focused; the next gamepad press
  // moved it back. That was the "it jumps and returns" stutter, and it needed nothing but a resting
  // mouse to reproduce — no blur, no dropped frame.
  //
  // Reading hover from mousemove with a coordinate check instead means the focus follows the pointer
  // only when the pointer actually moves.
  let lastMouseX = -1;
  let lastMouseY = -1;
  window.addEventListener('mousemove', (event) => {
    if (event.clientX === lastMouseX && event.clientY === lastMouseY) return; // synthetic — ignore
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    noteMouseActivity();
    if (!hoverAwake(event.clientX, event.clientY)) return;
    const element = event.target instanceof Element ? event.target : null;
    // The popup owns the pointer while it is open: its stack is the only thing hover may move.
    if (stackActive()) {
      const button = element?.closest<HTMLButtonElement>('.text-button') ?? null;
      if (button === null) return;
      const idx = stackFocusables().indexOf(button);
      if (idx === -1 || idx === stackIndex) return;
      stackIndex = idx;
      applyStackFocus();
      return;
    }
    if (!focusActive()) return;
    const target = element?.closest<HTMLButtonElement>('#play-button, #more-button') ?? null;
    if (target === null) return;
    const idx = mainFocusables().indexOf(target);
    if (idx === -1) return;
    if (!focusRevealed || focusIndex !== idx) {
      focusRevealed = true;
      focusIndex = idx;
      applyFocus();
    }
  });

  // The six navigation primitives, shared by the gamepad AND the keyboard (below) so both drive the exact
  // same custom-highlight model and can never diverge. Each notes activity first (hides the cursor,
  // restarts the idle countdown), then does its job: left/right move the bar (no-op with a popup open — the
  // stacks are vertical); up/down move the vertical popup stack (no-op on the bar); activate fires the
  // focused control (Play/More) or stack button; back steps out of the popup. Minimizing/closing lives in
  // the System menu, not a nav key.
  // Which surface the six primitives drive. Three, in priority order: the popup stack (when open), the
  // carousel strip (the top-level screen), then the bar. The primitives themselves are unchanged — the
  // routing lives HERE, in one place, so the gamepad and the keyboard can never diverge.
  const onCarousel = (): boolean => popupView === 'none' && deps.carousel.screen() === 'carousel';
  /** Whether the STRIP is the surface the nav keys drive — the carousel screen, minus the spell in which
   *  Y has handed the focus to the bar (then left/right/A belong to More, like on any other screen). */
  const stripActive = (): boolean => onCarousel() && !carouselBarFocus;

  // ── Held directions ────────────────────────────────────────────────────────
  // A repeat press means a direction is being held. It ends on an explicit release — the pad reports one
  // (onDirectionsReleased), the keyboard has keyup — but neither is guaranteed to arrive: the window can
  // lose focus mid-hold and swallow the keyup, and a pad can be unplugged. So a watchdog closes it too,
  // renewed on every repeat; at the repeat cadence (NAV_REPEAT_MS) this silence can only mean a stop.
  const FLIP_WATCHDOG_MS = 400;
  let flipping = false;
  let flipWatchdog = 0;

  function noteFlip(): void {
    if (flipWatchdog !== 0) window.clearTimeout(flipWatchdog);
    flipWatchdog = window.setTimeout(endFlip, FLIP_WATCHDOG_MS);
    if (flipping) return;
    flipping = true;
    deps.onFlipping(true);
  }

  function endFlip(): void {
    if (flipWatchdog !== 0) {
      window.clearTimeout(flipWatchdog);
      flipWatchdog = 0;
    }
    if (!flipping) return;
    flipping = false;
    deps.onFlipping(false);
  }

  function navLeft(repeat = false): void {
    noteGamepadActivity();
    if (repeat) noteFlip();
    // Left is "out" of a popup, the same step B takes: the stacks live on the right edge of the screen,
    // so moving left off them means leaving — the reading the layout already suggests on the carousel
    // (where left walks from the More button back to the strip). Sub-views step up one level rather than
    // closing outright, exactly as B does there. A HELD left is ignored: at the repeat cadence it would
    // walk out through every level and land on the carousel, flipping cards nobody asked to flip.
    if (popupView !== 'none') {
      if (!repeat) back();
      return;
    }
    // BEFORE stripActive(): left/right are the slider's own gesture (and the dropdown's fast path), and
    // holding one on the Settings screen must never flip through the carousel underneath.
    const overlay = overlays.active();
    if (overlay !== null) {
      overlay.navLeft(repeat);
      return;
    }
    if (stripActive()) {
      deps.carousel.move(-1);
      return;
    }
    // More sits to the RIGHT of the strip, so left is the way back to the cards — the exit the layout
    // itself suggests, and the one a user will try before finding Y or B.
    if (onCarousel() && carouselBarFocus) {
      audio.play('navigate');
      setCarouselBarFocus(false);
      return;
    }
    moveFocus(-1);
  }
  function navRight(repeat = false): void {
    noteGamepadActivity();
    if (repeat) noteFlip();
    // Same early branch as navLeft — `repeat` is irrelevant here: a held right is exactly what a slider
    // wants, one step per repeat, and the screen has no "at the end, hand the focus over" rule.
    const overlay = popupView === 'none' ? overlays.active() : null;
    if (overlay !== null) {
      overlay.navRight();
      return;
    }
    if (stripActive()) {
      // Past the last card there is one thing left to the right: the More button. A HELD right stays
      // pinned at the end instead — running down a long history is one gesture, and it must not end with
      // the focus flung off the strip (and one A away from a menu nobody asked for). Release, press
      // again, and the stop becomes the step. `locked` is the return-morph, where nothing happens at all.
      if (deps.carousel.move(1) !== 'at-end' || repeat) return;
      audio.play('navigate');
      setCarouselBarFocus(true);
      return;
    }
    if (popupView === 'none') moveFocus(1);
  }
  // Vertical hold-to-repeat exists for the Settings LIST, which is long enough to warrant it. The popup
  // stacks are short and cyclic — repeating there would spin them — so a repeat is dropped anywhere else.
  function navUp(repeat = false): void {
    noteGamepadActivity();
    if (repeat) noteFlip();
    if (popupView !== 'none') {
      if (!repeat) moveStackFocus(-1);
      return;
    }
    const overlay = overlays.active();
    if (overlay !== null) {
      overlay.navUp();
      return;
    }
    // Nothing sits above the bar on the detail screen, so up leaves it: the strip the game was picked
    // from is literally where it came from, and it re-enters exactly there. Held (repeat) presses are
    // dropped — one hold must not walk out of the screen the moment the user pauses on it. Only when no
    // popup is up: there the direction belongs to the menu, which is handled above.
    if (!repeat && deps.carousel.leaveDetail()) audio.play('back');
  }
  function navDown(repeat = false): void {
    noteGamepadActivity();
    if (repeat) noteFlip();
    if (popupView !== 'none') {
      if (!repeat) moveStackFocus(1);
      return;
    }
    const overlay = overlays.active();
    if (overlay !== null) {
      overlay.navDown();
      return;
    }
    // The other half of the vertical pair: down opens the selected card (what A does), up on the detail
    // screen comes back out. The strip only — with the focus on More, down has no card to open, and
    // inside a popup the direction belongs to the menu (handled above). Held presses are dropped, as
    // everywhere a direction crosses a screen boundary.
    if (!repeat && stripActive()) deps.carousel.activate();
  }
  function navActivate(): void {
    noteGamepadActivity();
    if (popupView !== 'none') activateStack();
    else if (overlays.active() !== null) overlays.active()?.navActivate();
    else if (stripActive()) deps.carousel.activate();
    else activateFocused();
  }
  function navBack(): void {
    noteGamepadActivity();
    // Deepest level first: a popup closes, then the bar hands the focus back to the strip, then a detail
    // screen steps back to the carousel. On the strip itself B does nothing — it is the top level.
    if (popupView !== 'none') {
      back();
      return;
    }
    const overlay = overlays.active();
    if (overlay !== null) {
      overlay.navBack();
      return;
    }
    if (deps.carousel.screen() === 'carousel') {
      // The strip is the top level: there is nothing above home to go back TO, so rather than doing
      // nothing, back hands the focus to More — the only other place on this screen — and hands it
      // straight back on the next press. That makes B / Tab / Esc a round trip instead of a dead key.
      audio.play(carouselBarFocus ? 'back' : 'navigate');
      setCarouselBarFocus(!carouselBarFocus);
      return;
    }
    if (deps.carousel.leaveDetail()) audio.play('back');
  }

  /**
   * Y: "put me on More". On the carousel that means handing the focus between the strip and the bar; on a
   * detail screen, where both buttons are already in the same bar, it means jumping between Play and More
   * — which is the same promise the button makes on home, and the reason it is worth having here: the
   * hand that learned Y-then-A on the carousel was launching games with it on the detail screen instead.
   * The highlight is woken along with it: the press IS the user pointing at where it should be. Coming
   * BACK there are two more ways out, both meaning what they usually mean: B (back) and left.
   */
  function navToggleBar(): void {
    noteGamepadActivity();
    // With an overlay up, Y belongs to whatever is open there (the keyboard's Shift) — and if that
    // surface has no use for it, it stays unassigned rather than handing the focus to a hidden bar.
    const overlay = overlays.active();
    if (overlay !== null) {
      overlay.navTertiary?.();
      return;
    }
    if (popupView !== 'none') return;
    if (deps.carousel.screen() !== 'carousel') {
      toggleMoreFocus();
      return;
    }
    audio.play('navigate');
    setCarouselBarFocus(!carouselBarFocus);
  }

  /** The detail screen's half of Y: the focus swaps between More and whatever else the bar offers. */
  function toggleMoreFocus(): void {
    if (!focusActive()) return;
    const items = mainFocusables();
    const more = items.indexOf(moreButton);
    if (more === -1) return;
    // Only More is focusable (a busy game, an installer): there is nothing to swap with, so Y wakes the
    // highlight where it is rather than moving it somewhere that does not exist.
    const next = focusRevealed && focusIndex === more ? (items.length > 1 ? 0 : more) : more;
    if (focusRevealed && next === focusIndex) return;
    focusIndex = next;
    focusRevealed = true;
    audio.play('navigate');
    applyFocus();
  }

  /** X and the shoulders: overlay-only, and only when the surface on top claims them. */
  function navSecondary(repeat = false): void {
    if (popupView !== 'none') return;
    overlays.active()?.navSecondary?.(repeat);
  }

  function navShoulder(direction: -1 | 1): void {
    if (popupView !== 'none') return;
    overlays.active()?.navShoulder?.(direction);
  }

  function navCommit(): void {
    if (popupView !== 'none') return;
    overlays.active()?.navCommit?.();
  }

  function setCarouselBarFocus(onBar: boolean): void {
    carouselBarFocus = onBar;
    // The strip stops reading as the active surface while the bar has the focus: the ring goes, the row
    // dims and the bar copy (which names the selected card) hides. All of it is CSS off this attribute.
    if (onBar) app.dataset['barFocus'] = 'on';
    else delete app.dataset['barFocus'];
    if (onBar) {
      focusRevealed = true;
      focusIndex = 0; // More is the whole bar on this screen — see mainFocusables
    }
    applyFocus();
  }

  // The wheel flips through the carousel. Throttled: one notch of a mouse wheel is one event, but a
  // trackpad emits a stream of them, which would fly past a dozen cards per gesture.
  const WHEEL_THROTTLE_MS = 120;
  let lastWheelAt = 0;
  window.addEventListener(
    'wheel',
    (event) => {
      // onCarousel() stays true under the Settings screen — without this the wheel would flip through the
      // strip behind the veil. Inside the screen the wheel scrolls its own list natively.
      if (overlays.isAnyOpen()) return;
      if (!onCarousel()) return;
      noteMouseActivity();
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      const now = performance.now();
      if (now - lastWheelAt < WHEEL_THROTTLE_MS) return;
      lastWheelAt = now;
      deps.carousel.move(delta > 0 ? 1 : -1);
    },
    { passive: true },
  );

  // A right-click is the mouse's B button: the same "step back" as B / Esc / Tab / Backspace. The
  // launcher has nothing to offer in a context menu, so the native one is suppressed either way — which
  // is also why this listens on the window rather than per-element: the gesture means the same thing
  // wherever the pointer is.
  window.addEventListener('contextmenu', (event) => {
    // …except over SELECTABLE text, where the right-click means "Copy". The whole UI is user-select:none
    // save for the install path in the confirm popup, and main puts a Copy menu on it (window.ts) — but
    // that menu only appears if the DOM event is left alone: preventDefault here kills the native
    // context-menu event main listens for, which is exactly how this broke copying the path.
    if (isOverSelectableText(event.target)) return;
    event.preventDefault();
    navBack();
    // AFTER, not before: navBack() is written for the gamepad and hides the cursor as its first act.
    // This click IS the mouse, so the cursor has to come back — and it is this call that restores it.
    noteMouseActivity();
  });

  const gamepad = createGamepadController({
    onLeft: navLeft,
    onRight: navRight,
    onUp: navUp,
    onDown: navDown,
    onA: navActivate,
    onB: navBack,
    onY: navToggleBar,
    onX: navSecondary,
    onShoulderLeft: () => navShoulder(-1),
    onShoulderRight: () => navShoulder(1),
    onTriggerRight: navCommit,
    onDirectionsReleased: endFlip,
  });

  // Keyboard navigation (Desktop Mode / no gamepad): WASD + arrows move, Space/Enter activate, Tab/Backspace
  // (and Esc) step back — the SAME six primitives as the gamepad, so the two input models stay in lockstep.
  // No key of its own for "go to More": on home, back has nothing above it to return to, so it doubles as
  // that toggle (see navBack) and Tab / Esc / B all reach the button.
  // Edge-only (event.repeat ignored) to match the gamepad's one-move-per-press feel. preventDefault stops
  // the browser default (Tab focus traversal, Space scroll / native button press, arrow scroll) from firing
  // alongside our custom navigation. A backgrounded launcher doesn't receive keydown (the OS routes keys to
  // the focused window), so — unlike the Gamepad API — no explicit pause is needed here.
  const KEY_NAV: Readonly<Record<string, (repeat: boolean) => void>> = {
    a: navLeft,
    arrowleft: navLeft,
    d: navRight,
    arrowright: navRight,
    w: navUp,
    arrowup: navUp,
    s: navDown,
    arrowdown: navDown,
    ' ': navActivate,
    enter: navActivate,
    tab: navBack,
    backspace: navBack,
    escape: navBack,
  };
  // The four directions are the exception to the edge model: holding one flips through the carousel or
  // runs down the Settings list, matching the gamepad's hold-to-repeat (a held direction inside a popup
  // stack is dropped by navUp/navDown themselves). The OS auto-repeat supplies the events (its own
  // initial delay is close enough to the pad's), but its rate is far too fast, so it is throttled to the
  // same NAV_REPEAT_MS cadence. Every other key stays one action per press.
  const REPEATABLE_KEYS = new Set([
    'a',
    'arrowleft',
    'd',
    'arrowright',
    'w',
    'arrowup',
    's',
    'arrowdown',
  ]);
  let lastKeyRepeatAt = 0;
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const handler = KEY_NAV[key];
    if (handler === undefined) return;
    event.preventDefault(); // suppress the native default even on auto-repeat (e.g. Tab traversal)
    if (event.repeat) {
      if (!REPEATABLE_KEYS.has(key)) return;
      const now = performance.now();
      if (now - lastKeyRepeatAt < NAV_REPEAT_MS) return;
      lastKeyRepeatAt = now;
    }
    handler(event.repeat);
  });
  // The keyboard's half of "the hold is over". A keyup can be missed (the window loses focus mid-hold and
  // the release goes to whoever took it), which is what the watchdog in noteFlip covers.
  window.addEventListener('keyup', (event) => {
    if (REPEATABLE_KEYS.has(event.key.toLowerCase())) endFlip();
  });

  function applyGameButtons(): void {
    // The game-dependent Details items: the Install/Uninstall toggle and the running-only Force close.
    // Refreshed every render so they stay correct if the game state changes while Details is open (a
    // running→syncing-out self-exit must drop Force close; a ready→ready update doesn't close the popup).
    applyMenuInstallToggle();
    applyMenuKill();
    applyMenuHome();
    applyMenuCustomize();
    applyMenuForget();
    applyMenuSystem();
    applyMenuSettings();
  }

  function clearGameButtons(): void {
    if (menuFrozen()) return;
    // No game → no Install/Uninstall item and no Force close (the popup is force-closed off the ready
    // screen anyway; no-game is never `running`).
    menuInstallToggle.classList.add('is-hidden');
    menuKill.classList.add('is-hidden');
    menuCustomize.classList.add('is-hidden'); // no game on screen → no manifest to customize
    menuForget.classList.add('is-hidden'); // no game on screen → nothing to remove from the history
    applyMenuHome(); // the carousel can still be there with no game on screen (history only)
    applyMenuSystem();
    applyMenuSettings();
  }

  function refresh(): void {
    // The bar-focus spell belongs to the carousel: off that screen the bar has the focus anyway, and a
    // stale true would send B to a strip that is no longer under it (and leave the row dimmed).
    if (deps.carousel.screen() !== 'carousel' && carouselBarFocus) setCarouselBarFocus(false);
    // The popup lives on every screen now (empty included — More there offers System + Close). Only a
    // game-specific install/uninstall Confirm is void once the card is pulled (no game), so close that
    // one; Details/Power/power-Confirm/Error all remain valid with or without a card. A failed launch
    // returns to 'ready' first, THEN opens the error popup (separate IPC), so the error survives.
    if (
      popupView === 'confirm' &&
      (confirmMode === 'install' || confirmMode === 'uninstall') &&
      screenGame() === undefined
    ) {
      closePopup();
    }
    // When an active state (install / launch / uninstall / steam) APPEARS, drop the bar highlight so it
    // doesn't sit on a button the user didn't choose. It wakes again on a gamepad move or a mouse hover.
    const active = phaseOf(state()) === 'busy' || steamBusy(state());
    if (active && !wasActive) focusRevealed = false;
    wasActive = active;
    applyPowerItems();
    applyFocus();
    applyStackFocus();
    applyPlayAria();
  }

  return {
    applyGameButtons,
    clearGameButtons,
    settingsClosed,
    confirmResetSettings: () => openConfirm('reset-settings'),
    confirmGameSettings: (kind) =>
      openConfirm(
        kind === 'reset'
          ? 'reset-game-settings'
          : kind === 'delete'
            ? 'delete-game'
            : 'discard-game-settings',
      ),
    refresh,
    showError: openError,
    setGameMode: (value: boolean) => {
      gameMode = value;
      applyPowerItems();
    },
    start: () => {
      gamepad.start();
      armIdleTimer(); // begin the countdown so an untouched launcher hides its cursor (IDLE_MS)
    },
    /** Pause/resume acting on gamepad input (paused while the launcher is backgrounded — a game on top). */
    setGamepadPaused: (paused: boolean) => gamepad.setPaused(paused),
  };
}
