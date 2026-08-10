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
import { createGamepadController } from './gamepad.js';
import { type AudioController } from './audio.js';
import { gameOf, phaseOf, steamBusy } from './state-view.js';
import { req, reqQuery } from './dom.js';

// The current popup view (mutually exclusive; 'none' = closed). Mirrors the data-view on #popup.
type PopupView = 'none' | 'details' | 'power' | 'confirm' | 'error';
// Which action the confirm view is asking about (only meaningful while popupView === 'confirm').
type ConfirmMode = 'install' | 'uninstall' | 'kill' | 'shutdown' | 'reboot' | 'sleep';
// Gamepad A doesn't trigger :active, so flash a press class to play the scale-down animation.
const PRESS_MS = 130;

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
}

/**
 * What the interaction layer needs from the carousel. A narrow seam on purpose: the carousel owns its
 * strip and selection, this module owns which surface the buttons currently drive.
 */
export interface CarouselNav {
  /** 'carousel' (the strip) or 'detail' (the bar screen). */
  screen(): 'carousel' | 'detail';
  /** Moves the selection by `delta` cards. */
  move(delta: number): void;
  /** Enters the selected card's detail screen. */
  activate(): void;
  /** Steps back from a detail screen to the strip; false when there is no carousel to return to. */
  leaveDetail(): boolean;
}

export interface Controls {
  /** Refreshes the game-dependent menu item (Install/Uninstall text + visibility) from the current state. */
  applyGameButtons(): void;
  /** Clears the game-dependent menu item for the idle/no-game screen. */
  clearGameButtons(): void;
  /** Per-render refresh: force-close the popup off the ready screen (or while steam-busy), then re-apply focus. */
  refresh(): void;
  /** Opens the error popup with the given message (a failed launch/action from main). */
  showError(message: string): void;
  /** Seeds whether this is a Game Mode (gamescope) session — flips the power menu's primary item from
   *  "Minimize Playhook" (hide to tray) to "Close Playhook" (full quit). Called once at startup. */
  setGameMode(gameMode: boolean): void;
  /** Starts the gamepad polling loop. */
  start(): void;
  /** Pause/resume acting on gamepad input (paused while the launcher is backgrounded — a game on top). */
  setGamepadPaused(paused: boolean): void;
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

  // Bar buttons.
  const playButton = req<HTMLButtonElement>('play-button');
  const moreButton = req<HTMLButtonElement>('more-button');

  // The single popup + its veil, plus the content fields set from JS.
  const popup = req('popup');
  const popupVeil = reqQuery<HTMLElement>('#popup .popup-veil');
  const confirmMessage = req('confirm-message');
  const confirmPath = req('confirm-path');
  const errorMessageEl = req('error-message');

  // Action-stack buttons (grouped by view in the HTML).
  const menuShutdown = req<HTMLButtonElement>('menu-shutdown');
  const menuInstallToggle = req<HTMLButtonElement>('menu-install-toggle');
  const menuKill = req<HTMLButtonElement>('menu-kill');
  const menuClose = req<HTMLButtonElement>('menu-close');
  const powerShutdown = req<HTMLButtonElement>('power-shutdown');
  const powerReboot = req<HTMLButtonElement>('power-reboot');
  const powerSleep = req<HTMLButtonElement>('power-sleep');
  const powerMinimize = req<HTMLButtonElement>('power-minimize');
  const powerClose = req<HTMLButtonElement>('power-close');
  const confirmYes = req<HTMLButtonElement>('confirm-yes');
  const confirmNo = req<HTMLButtonElement>('confirm-no');
  const errorClose = req<HTMLButtonElement>('error-close');

  let popupView: PopupView = 'none';
  let confirmMode: ConfirmMode = 'uninstall';
  // Where B/Esc/veil returns FROM the confirm view: install/uninstall come from Details, the power
  // actions come from Power.
  let confirmReturnTo: 'details' | 'power' = 'details';

  // ── Popup machine ────────────────────────────────────────────────────────────
  // One #popup element; opening = add .is-open + set data-view; switching views keeps .is-open (so the
  // shared veil never cross-fades). Closing removes .is-open.

  function setView(view: Exclude<PopupView, 'none'>): void {
    popupView = view;
    popup.dataset['view'] = view;
    popup.classList.add('is-open');
    popup.setAttribute('aria-hidden', 'false');
  }

  function closePopup(): void {
    if (popupView === 'none') return;
    popupView = 'none';
    popup.classList.remove('is-open');
    popup.setAttribute('aria-hidden', 'true');
    applyStackFocus(); // clear the stack highlight (stackActive becomes false)
    applyFocus(); // restore the main bar highlight
  }

  // Details menu (from More): game stats on top + Shutdown / Install|Uninstall / Close stack. Works on
  // every screen — on the empty (no-card) screen there are no stats and no Install/Uninstall, so it
  // degrades to just System + Close.
  function openDetails(): void {
    applyMenuInstallToggle(); // keep the toggle's text/visibility fresh for the current game
    applyMenuKill(); // keep the force-close item's visibility fresh (running-only)
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
      if (mode === 'uninstall' && game.prefixCleanupOnly === true) popup.dataset['uninstallVia'] = 'prefix';
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

  // ── Menu item: Install / Uninstall (game-dependent) ──────────────────────────
  // One button whose text + visibility follow the current game: "Install" when it needs installing,
  // "Uninstall" when installed & removable, hidden entirely for a plain executable (no install block).
  function applyMenuInstallToggle(): void {
    const game = screenIsActionable() ? screenGame() : undefined;
    // While an install/uninstall (card or Steam) is in flight, the Install/Uninstall item is hidden —
    // acting on it mid-operation makes no sense (Details still opens for the stats + power actions).
    const busy = phaseOf(state()) === 'busy' || steamBusy(state());
    const showInstall = !busy && game?.requiresInstall === true;
    const showUninstall = !busy && game?.canUninstall === true;
    const show = showInstall || showUninstall;
    menuInstallToggle.classList.toggle('is-hidden', !show);
    if (show) {
      menuInstallToggle.textContent = t()(showInstall ? 'launcher.menu.install' : 'launcher.menu.uninstall');
      // Which action Yes will run — read back in the stack trigger.
      menuInstallToggle.dataset['action'] = showInstall ? 'install' : 'uninstall';
    }
  }

  // ── Menu item: Force close (running-only) ────────────────────────────────────
  // The MIRROR IMAGE of the install toggle: shown ONLY while a game is running (running is a busy phase,
  // so this is the exact opposite of the install toggle, which hides during busy). Text from JS (no
  // data-i18n) so a language change re-labels it at render time and it stays out of the i18n HTML test.
  function applyMenuKill(): void {
    // Shown only while a game is running AND a force-close isn't already in flight (during killing the
    // status reads "Force closing…" and the button would be a no-op — main guards a repeat anyway).
    const s = state();
    const running = s.kind === 'running' && s.killing !== true;
    menuKill.classList.toggle('is-hidden', !running);
    if (running) menuKill.textContent = t()('launcher.menu.forceClose');
  }

  // The power menu's primary item. Desktop/Windows: "Minimize Playhook" (hide to tray). Game Mode: "Close
  // Playhook" — a full quit, since there is no tray to minimize into (mirrors how closing the window quits
  // in Game Mode). Label from JS (no data-i18n) so a language change relabels it at render time and it
  // stays out of the i18n HTML test.
  function applyPowerPrimary(): void {
    powerMinimize.textContent = t()(gameMode ? 'launcher.menu.quit' : 'launcher.menu.minimize');
  }


  // ── Main bar focus (gamepad / mouse) ─────────────────────────────────────────

  const ALL_MAIN_BUTTONS: readonly HTMLButtonElement[] = [playButton, moreButton];
  let focusIndex = 0;
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
    // Steam install/uninstall indicator up (phase stays 'ready'): the gear opens Steam's Downloads page
    // and More opens Details — both focusable.
    if (steamBusy(state())) return [playButton, moreButton];
    // Running with the launcher summoned over the game: Play returns to the game, so it's focusable too —
    // EXCEPT while a force-close is in flight (killing), when Play is a non-interactive loading spinner.
    const running = state();
    if (running.kind === 'running') return running.killing === true ? [moreButton] : [playButton, moreButton];
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
  // popup closed. On the carousel the bar buttons are hidden, so the highlight has nothing to sit on —
  // the selection lives in the strip instead.
  function focusActive(): boolean {
    return popupView === 'none' && deps.carousel.screen() === 'detail';
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
    playButton.setAttribute('aria-label', t()(returnToGame ? 'launcher.aria.returnToGame' : 'launcher.aria.play'));
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
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      setCursorHidden(true);
      if (focusRevealed && focusActive()) {
        focusRevealed = false;
        applyFocus();
      }
    }, IDLE_MS);
  }

  // Gamepad input = activity: hide the cursor at once (the user switched to the pad) + restart the idle.
  function noteGamepadActivity(): void {
    setCursorHidden(true);
    armIdleTimer();
  }

  // Real mouse movement = activity: show the cursor + restart the idle.
  function noteMouseActivity(): void {
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
    menuShutdown,
    menuInstallToggle,
    menuKill,
    menuClose,
    powerShutdown,
    powerReboot,
    powerSleep,
    powerMinimize,
    powerClose,
    confirmYes,
    confirmNo,
    errorClose,
  ];
  let stackIndex = 0;

  function stackFocusables(): readonly HTMLButtonElement[] {
    switch (popupView) {
      case 'details': {
        const items: HTMLButtonElement[] = [menuShutdown];
        if (!menuInstallToggle.classList.contains('is-hidden')) items.push(menuInstallToggle);
        if (!menuKill.classList.contains('is-hidden')) items.push(menuKill);
        items.push(menuClose);
        return items;
      }
      case 'power':
        return [powerShutdown, powerReboot, powerSleep, powerMinimize, powerClose];
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
      // Desktop/Windows: hide to the tray (same as the empty-screen Hide button). Game Mode: quit the app
      // ("Close Playhook") — there is no tray, so hide is a no-op there. No confirm either way — hide is
      // non-destructive, and a quit is as recoverable as relaunching from the Steam library. Close the
      // popup first so a re-summoned launcher shows a clean bar, not this menu.
      audio.play('back');
      closePopup();
      if (gameMode) window.api.requestQuit();
      else window.api.requestHide();
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

  // One window-level mouse handler, guarded against SYNTHETIC moves (Chromium fires mousemove with
  // unchanged coordinates when an element shifts under a still pointer — e.g. the busy title-slide — and
  // that must not undo a gamepad cursor-hide). A real move shows the cursor, counts as activity, and —
  // when it's over a bar button — wakes/moves the bar focus so A activates what's highlighted.
  let lastMouseX = -1;
  let lastMouseY = -1;
  window.addEventListener('mousemove', (event) => {
    if (event.clientX === lastMouseX && event.clientY === lastMouseY) return; // synthetic — ignore
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    noteMouseActivity();
    if (!focusActive()) return;
    const target =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>('#play-button, #more-button') : null;
    if (target === null) return;
    const idx = mainFocusables().indexOf(target);
    if (idx === -1) return;
    if (!focusRevealed || focusIndex !== idx) {
      focusRevealed = true;
      focusIndex = idx;
      applyFocus();
    }
  });
  ALL_STACK_BUTTONS.forEach((btn) => {
    btn.addEventListener('mouseenter', () => {
      if (!stackActive()) return;
      const idx = stackFocusables().indexOf(btn);
      if (idx === -1) return;
      stackIndex = idx;
      applyStackFocus();
    });
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

  function navLeft(): void {
    noteGamepadActivity();
    if (onCarousel()) deps.carousel.move(-1);
    else if (popupView === 'none') moveFocus(-1);
  }
  function navRight(): void {
    noteGamepadActivity();
    if (onCarousel()) deps.carousel.move(1);
    else if (popupView === 'none') moveFocus(1);
  }
  function navUp(): void {
    noteGamepadActivity();
    if (popupView !== 'none') moveStackFocus(-1);
  }
  function navDown(): void {
    noteGamepadActivity();
    if (popupView !== 'none') moveStackFocus(1);
  }
  function navActivate(): void {
    noteGamepadActivity();
    if (popupView !== 'none') activateStack();
    else if (onCarousel()) deps.carousel.activate();
    else activateFocused();
  }
  function navBack(): void {
    noteGamepadActivity();
    // Deepest level first: a popup closes, then a detail screen steps back to the carousel. On the
    // carousel itself B does nothing — it is the top level.
    if (popupView !== 'none') {
      back();
      return;
    }
    if (deps.carousel.leaveDetail()) audio.play('back');
  }

  // The wheel flips through the carousel. Throttled: one notch of a mouse wheel is one event, but a
  // trackpad emits a stream of them, which would fly past a dozen cards per gesture.
  const WHEEL_THROTTLE_MS = 120;
  let lastWheelAt = 0;
  window.addEventListener(
    'wheel',
    (event) => {
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

  const gamepad = createGamepadController({
    onLeft: navLeft,
    onRight: navRight,
    onUp: navUp,
    onDown: navDown,
    onA: navActivate,
    onB: navBack,
  });

  // Keyboard navigation (Desktop Mode / no gamepad): WASD + arrows move, Space/Enter activate, Tab/Backspace
  // (and Esc) step back — the SAME six primitives as the gamepad, so the two input models stay in lockstep.
  // Edge-only (event.repeat ignored) to match the gamepad's one-move-per-press feel. preventDefault stops
  // the browser default (Tab focus traversal, Space scroll / native button press, arrow scroll) from firing
  // alongside our custom navigation. A backgrounded launcher doesn't receive keydown (the OS routes keys to
  // the focused window), so — unlike the Gamepad API — no explicit pause is needed here.
  const KEY_NAV: Readonly<Record<string, () => void>> = {
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
  window.addEventListener('keydown', (event) => {
    const handler = KEY_NAV[event.key.toLowerCase()];
    if (handler === undefined) return;
    event.preventDefault(); // suppress the native default even on auto-repeat (e.g. Tab traversal)
    if (event.repeat) return; // one action per press, like the gamepad edge model
    handler();
  });

  function applyGameButtons(): void {
    // The game-dependent Details items: the Install/Uninstall toggle and the running-only Force close.
    // Refreshed every render so they stay correct if the game state changes while Details is open (a
    // running→syncing-out self-exit must drop Force close; a ready→ready update doesn't close the popup).
    applyMenuInstallToggle();
    applyMenuKill();
  }

  function clearGameButtons(): void {
    // No game → no Install/Uninstall item and no Force close (the popup is force-closed off the ready
    // screen anyway; no-game is never `running`).
    menuInstallToggle.classList.add('is-hidden');
    menuKill.classList.add('is-hidden');
  }

  function refresh(): void {
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
    applyPowerPrimary(); // re-label on a language change (refresh runs after applyLocale → render)
    applyFocus();
    applyStackFocus();
    applyPlayAria();
  }


  return {
    applyGameButtons,
    clearGameButtons,
    refresh,
    showError: openError,
    setGameMode: (value: boolean) => {
      gameMode = value;
      applyPowerPrimary();
    },
    start: () => {
      gamepad.start();
      armIdleTimer(); // begin the countdown so an untouched launcher hides its cursor (IDLE_MS)
    },
    /** Pause/resume acting on gamepad input (paused while the launcher is backgrounded — a game on top). */
    setGamepadPaused: (paused: boolean) => gamepad.setPaused(paused),
  };
}
