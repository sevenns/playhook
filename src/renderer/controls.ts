// Interaction layer (audit I2 — split out of app.ts). Owns the popups (Info / Error / Confirm), the two
// focus groups (main buttons + the confirm modal's No/Yes) and the user actions they trigger, plus all
// their wiring: button/veil clicks, mouse hover, the gamepad controller and the keyboard Esc handler.
// These are bidirectionally coupled (popups call applyFocus; focus reads the popup-open flags), so they
// live together as one cohesive controller rather than two half-modules with fragile circular wiring.
// It reaches back into app.ts only through the narrow `deps` seam (current state + the audio controller);
// app.ts drives it via applyGameButtons/clearGameButtons/refresh/showError and starts it with start().
import type { AppState, GameInfo } from '../shared/types';
import { createGamepadController } from './gamepad.js';
import { type AudioController } from './audio.js';
import { gameOf, phaseOf, steamBusy } from './state-view.js';
import { req, reqQuery } from './dom.js';

// Which action the confirmation popup is asking about (only meaningful while confirmOpen).
type ConfirmMode = 'install' | 'uninstall';
const CONFIRM_TEXT: Readonly<Record<ConfirmMode, string>> = {
  install: 'Do you want to install game?',
  uninstall: 'Do you want to uninstall game from your PC?',
};
// Steam-mode confirm copy: the action opens Steam (no card path / silent-mode note applies).
const STEAM_INSTALL_TEXT = 'Open Steam to install this game?';
const STEAM_UNINSTALL_TEXT = 'Open Steam to uninstall this game?';
// Gamepad A doesn't trigger :active, so flash a press class to play the scale-down animation.
const PRESS_MS = 130;

/** What the interaction layer needs from the rest of the renderer. */
export interface ControlsDeps {
  /** The current AppState snapshot (app.ts owns it; updated before it calls into here). */
  getState(): AppState;
  /** The shared audio controller (UI sounds). */
  audio: AudioController;
}

export interface Controls {
  /** Renders the Play/Install + Uninstall buttons for the given game (render's game branch). */
  applyGameButtons(game: GameInfo): void;
  /** Clears the Uninstall button + its Info sibling shift for the idle/no-game screen. */
  clearGameButtons(): void;
  /** Per-render refresh: force-close popups when off the ready screen, then re-apply the focus highlight. */
  refresh(): void;
  /** Opens the error popup with the given message (a failed launch/action from main). */
  showError(message: string): void;
  /** Starts the gamepad polling loop. */
  start(): void;
}

export function createControls(deps: ControlsDeps): Controls {
  const { audio } = deps;
  const state = (): AppState => deps.getState();

  const hideButton = req<HTMLButtonElement>('hide-button');
  const playButton = req<HTMLButtonElement>('play-button');
  const infoButton = req<HTMLButtonElement>('info-button');
  const uninstallButton = req<HTMLButtonElement>('uninstall-button');
  const infoPopup = req('info-popup');
  const infoVeil = reqQuery<HTMLElement>('#info-popup .popup-veil');
  const errorPopup = req('error-popup');
  const errorMessageEl = req('error-message');
  const errorVeil = reqQuery<HTMLElement>('#error-popup .popup-veil');
  const confirmPopup = req('confirm-popup');
  const confirmMessage = req('confirm-message');
  const confirmPath = req('confirm-path');
  const confirmNo = req<HTMLButtonElement>('confirm-no');
  const confirmYes = req<HTMLButtonElement>('confirm-yes');
  const confirmVeil = reqQuery<HTMLElement>('#confirm-popup .popup-veil');

  let infoOpen = false;
  let errorOpen = false;
  let confirmOpen = false;
  let confirmMode: ConfirmMode = 'uninstall';

  // ── Popups (Info / Error) ───────────────────────────────────────────────────
  // Both share the same component (.popup): a right-side frosted veil + a right-aligned panel,
  // toggled with the .is-open class. They are mutually exclusive.

  function openInfo(): void {
    if (infoOpen || phaseOf(state()) !== 'ready') return;
    closeError();
    closeConfirm();
    infoOpen = true;
    infoPopup.classList.add('is-open');
    infoPopup.setAttribute('aria-hidden', 'false');
    applyFocus();
  }

  function closeInfo(): void {
    if (!infoOpen) return;
    infoOpen = false;
    infoPopup.classList.remove('is-open');
    infoPopup.setAttribute('aria-hidden', 'true');
    applyFocus();
  }

  function openError(messageText: string): void {
    closeInfo();
    closeConfirm();
    errorMessageEl.textContent = messageText;
    errorOpen = true;
    errorPopup.classList.add('is-open');
    errorPopup.setAttribute('aria-hidden', 'false');
    applyFocus();
  }

  function closeError(): void {
    if (!errorOpen) return;
    errorOpen = false;
    errorPopup.classList.remove('is-open');
    errorPopup.setAttribute('aria-hidden', 'true');
    applyFocus();
  }

  // Confirmation popup — same .popup component, shared by Install and Uninstall, with its own No/Yes
  // focus group (confirmIndex). Mutually exclusive with Info/Error (each opener closes the others). The
  // install variant also shows the destination path (so it can be copied if the installer isn't silent).
  function openConfirm(mode: ConfirmMode): void {
    if (confirmOpen || phaseOf(state()) !== 'ready') return;
    const game = gameOf(state());
    if (game === undefined) return;
    if (mode === 'install' && !game.requiresInstall) return; // nothing to install
    if (mode === 'uninstall' && !game.canUninstall) return; // nothing to uninstall
    closeInfo();
    closeError();
    confirmMode = mode;
    confirmPopup.dataset['mode'] = mode; // drives the description's visibility (install only)
    // Steam install has no card path and no silent-mode note: a more specific CSS selector
    // (data-install-via='steam') hides the description, and the copy differs (both install & uninstall).
    const isSteam = game.installVia === 'steam';
    const isSteamInstall = mode === 'install' && isSteam;
    if (isSteamInstall) {
      confirmPopup.dataset['installVia'] = 'steam';
    } else {
      delete confirmPopup.dataset['installVia'];
    }
    if (isSteam) {
      confirmMessage.textContent = mode === 'install' ? STEAM_INSTALL_TEXT : STEAM_UNINSTALL_TEXT;
    } else {
      confirmMessage.textContent = CONFIRM_TEXT[mode];
    }
    // Card path only for a card-installer game (empty for steam — there is no install dir).
    if (mode === 'install') confirmPath.textContent = isSteamInstall ? '' : (game.installDir ?? '');
    confirmOpen = true;
    confirmPopup.classList.add('is-open');
    confirmPopup.setAttribute('aria-hidden', 'false');
    confirmIndex = confirmButtons.indexOf(confirmNo); // default focus on "No" (safe default, Q1)
    applyFocus(); // main highlight clears (focusActive becomes false with confirmOpen)
    applyConfirmFocus();
  }

  function closeConfirm(): void {
    if (!confirmOpen) return;
    confirmOpen = false;
    confirmPopup.classList.remove('is-open');
    confirmPopup.setAttribute('aria-hidden', 'true');
    applyConfirmFocus(); // clears the No/Yes highlight (confirmFocusActive becomes false)
    applyFocus(); // restore the main focus highlight
  }

  // ── Play / Install + Uninstall buttons ──────────────────────────────────────

  // Install mode: an uninstalled game shows "Install" instead of "Play" (the action is the same —
  // main decides install vs launch). The HTML hardcodes aria-label="Play", so we set it from JS here.
  function applyPlayButton(game: GameInfo): void {
    const install = game.requiresInstall;
    playButton.dataset['action'] = install ? 'install' : 'play';
    playButton.setAttribute('aria-label', install ? 'Install' : 'Play');
  }

  // The Uninstall button is shown only for an installed install-mode game (canUninstall), via a per-game
  // class (visibility is a game property, not a phase). In busy it stays in layout but fades out like Info.
  function applyUninstallButton(game: GameInfo): void {
    uninstallButton.classList.toggle('is-available', game.canUninstall);
    // Info shifts left to make room for the rightmost Uninstall button (see styles.css).
    infoButton.classList.toggle('has-uninstall-sibling', game.canUninstall);
  }

  // ── Focus navigation (gamepad / mouse) ──────────────────────────────────────

  // Main navigation group (left → right). Uninstall joins it only for an installed install-mode game, so
  // the focusable set is DYNAMIC; the full set is iterated to clear stale highlights.
  const ALL_MAIN_BUTTONS: readonly HTMLButtonElement[] = [playButton, infoButton, uninstallButton];
  let focusIndex = 0;

  function mainFocusables(): readonly HTMLButtonElement[] {
    // While a Steam install/uninstall indicator is up, the right-side buttons are hidden — keep only Play
    // focusable/clickable (during a download its click opens Steam's Downloads page; see triggerPlay).
    if (steamBusy(state())) return [playButton];
    return gameOf(state())?.canUninstall === true
      ? [playButton, infoButton, uninstallButton]
      : [playButton, infoButton];
  }

  // Main focus is only meaningful on the ready screen with no popup open — including the confirm modal:
  // with confirmOpen this returns false, so triggerPlay/triggerInfo/moveFocus/activateFocused/mouseenter
  // (all guarded by focusActive) go quiet naturally while the modal is up (B1).
  function focusActive(): boolean {
    return phaseOf(state()) === 'ready' && !infoOpen && !errorOpen && !confirmOpen;
  }

  function applyFocus(): void {
    const items = mainFocusables();
    // Clamp: the set length changes with canUninstall, so a prior index may now be out of range.
    focusIndex = Math.min(items.length - 1, Math.max(0, focusIndex));
    const active = focusActive();
    ALL_MAIN_BUTTONS.forEach((btn) => {
      const idx = items.indexOf(btn);
      btn.classList.toggle('is-focused', active && idx !== -1 && idx === focusIndex);
    });
  }

  function moveFocus(delta: number): void {
    if (!focusActive()) return;
    const items = mainFocusables();
    const next = Math.min(items.length - 1, Math.max(0, focusIndex + delta));
    if (next === focusIndex) return; // already at the edge — no move, no sound
    focusIndex = next;
    audio.play('navigate');
    applyFocus();
  }

  // Confirm modal focus group — fully separate from the main group (No / Yes), so it can never disturb
  // the main focusIndex (I6). Active only while the confirm modal is open on the ready screen.
  // Visual order, left → right: Yes on the left, No on the right (per design). Navigation/default-focus
  // key off button identity, not a fixed index, so this order can change without touching the logic.
  const confirmButtons: readonly HTMLButtonElement[] = [confirmYes, confirmNo];
  let confirmIndex = 0;

  function confirmFocusActive(): boolean {
    return phaseOf(state()) === 'ready' && confirmOpen;
  }

  function applyConfirmFocus(): void {
    const active = confirmFocusActive();
    confirmButtons.forEach((btn, i) => btn.classList.toggle('is-focused', active && i === confirmIndex));
  }

  function moveConfirmFocus(delta: number): void {
    if (!confirmFocusActive()) return;
    const next = Math.min(confirmButtons.length - 1, Math.max(0, confirmIndex + delta));
    if (next === confirmIndex) return;
    confirmIndex = next;
    audio.play('navigate');
    applyConfirmFocus();
  }

  function pressFlash(btn: HTMLElement): void {
    btn.classList.add('is-pressed');
    window.setTimeout(() => btn.classList.remove('is-pressed'), PRESS_MS);
  }

  function activateFocused(): void {
    if (!focusActive()) return;
    const btn = mainFocusables()[focusIndex];
    if (btn === undefined) return;
    pressFlash(btn);
    if (btn === infoButton) triggerInfo();
    else if (btn === uninstallButton) triggerUninstall();
    else triggerPlay();
  }

  // Confirm modal: gamepad A activates the focused No/Yes; No cancels, Yes runs the confirmed action.
  function activateConfirm(): void {
    if (!confirmFocusActive()) return;
    const btn = confirmButtons[confirmIndex];
    if (btn === undefined) return;
    pressFlash(btn);
    if (btn === confirmNo) cancelConfirm();
    else acceptConfirm();
  }

  // ── User-initiated actions (shared by mouse clicks and gamepad A/B) ──────────

  function triggerPlay(): void {
    if (!focusActive()) return;
    const game = gameOf(state());
    // Steam download in progress: the Play button shows a loader and can't launch — repurpose the click to
    // open Steam's Downloads page, where the user can pause/resume (we can't control that programmatically).
    if (game?.steamInstalling === true) {
      audio.play('button');
      window.api.openSteamDownloads();
      return;
    }
    // Steam uninstall in progress (loader) → nothing useful to do, ignore the press.
    if (game?.steamUninstalling === true) return;
    // Install mode (button reads "Install"): confirm first and show the destination path. main still
    // decides install vs launch from requiresInstall, so the confirmed request goes through requestLaunch.
    if (game?.requiresInstall === true) {
      audio.play('button');
      openConfirm('install');
      return;
    }
    audio.play('play');
    window.api.requestLaunch();
  }

  function triggerInfo(): void {
    audio.play('button');
    openInfo();
  }

  // Uninstall button → open the destructive confirmation. The actual removal waits for "Yes".
  function triggerUninstall(): void {
    audio.play('button');
    openConfirm('uninstall');
  }

  function cancelConfirm(): void {
    audio.play('back');
    closeConfirm();
  }

  // "Yes" — dispatch by the confirmed mode. Install → run the installer (main still decides install vs
  // launch from requiresInstall); Uninstall → remove the game. Capture the mode before closeConfirm.
  function acceptConfirm(): void {
    const mode = confirmMode;
    closeConfirm();
    if (mode === 'install') {
      audio.play('play');
      window.api.requestLaunch();
    } else {
      audio.play('button'); // Q3: neutral button sound for the destructive confirm
      window.api.requestUninstall();
    }
  }

  // Gamepad B / veil click closes whichever popup is open (Info or Error).
  function triggerClosePopup(): void {
    if (infoOpen) {
      audio.play('back');
      closeInfo();
    } else if (errorOpen) {
      audio.play('back');
      closeError();
    }
  }

  // The empty / idle screen, where the only action is "Hide" (back to tray).
  function onMessageScreen(): boolean {
    const phase = phaseOf(state());
    return phase === 'idle' || phase === 'error';
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  playButton.addEventListener('click', () => triggerPlay());
  infoButton.addEventListener('click', () => triggerInfo());
  uninstallButton.addEventListener('click', () => triggerUninstall());
  infoVeil.addEventListener('click', () => triggerClosePopup());
  errorVeil.addEventListener('click', () => triggerClosePopup());
  confirmNo.addEventListener('click', () => cancelConfirm());
  confirmYes.addEventListener('click', () => acceptConfirm());
  confirmVeil.addEventListener('click', () => cancelConfirm());
  hideButton.addEventListener('click', () => window.api.requestHide());

  // Mouse hover moves the gamepad focus too, so A always activates what's highlighted. The main buttons
  // use focusActive (quiet while the modal is open); the modal's No/Yes use their own confirm group.
  ALL_MAIN_BUTTONS.forEach((btn) => {
    btn.addEventListener('mouseenter', () => {
      if (!focusActive()) return;
      const idx = mainFocusables().indexOf(btn);
      if (idx === -1) return;
      focusIndex = idx;
      applyFocus();
    });
  });
  confirmButtons.forEach((btn, i) => {
    btn.addEventListener('mouseenter', () => {
      if (!confirmFocusActive()) return;
      confirmIndex = i;
      applyConfirmFocus();
    });
  });

  const gamepad = createGamepadController({
    // The confirm modal is a separate branch BEFORE the main one, so its No/Yes navigation/activation
    // never touches the main controls while it's open.
    onLeft: () => (confirmOpen ? moveConfirmFocus(-1) : moveFocus(-1)),
    onRight: () => (confirmOpen ? moveConfirmFocus(1) : moveFocus(1)),
    // On the empty / idle screen the only action is Hide; otherwise A activates the focused button.
    onA: () => {
      if (confirmOpen) activateConfirm();
      else if (onMessageScreen()) window.api.requestHide();
      else activateFocused();
    },
    onB: () => {
      if (confirmOpen) cancelConfirm();
      else if (onMessageScreen()) window.api.requestHide();
      else triggerClosePopup();
    },
  });

  // Keyboard Esc: close an open popup first (no hide), otherwise hide the launcher to tray from any
  // screen — mirrors the Hide button. Intentionally keyboard-only; the gamepad routing is left as is.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (confirmOpen) cancelConfirm();
    else if (infoOpen || errorOpen) triggerClosePopup();
    else window.api.requestHide();
  });

  function applyGameButtons(game: GameInfo): void {
    applyPlayButton(game);
    applyUninstallButton(game);
  }

  function clearGameButtons(): void {
    // The idle branch doesn't touch the Uninstall button, so clear a stale .is-available from a prior
    // ready state explicitly (don't rely on CSS specificity alone, I5).
    uninstallButton.classList.remove('is-available');
    infoButton.classList.remove('has-uninstall-sibling');
  }

  function refresh(): void {
    // Popups only make sense on the ready screen; force-close them on any other state. (A failed
    // launch returns to 'ready' first, then opens the error popup — so it survives this.) closeConfirm
    // is critical for a card swap/pull WHILE the confirm modal is open — without it the modal would hang
    // over the busy/idle screen.
    if (phaseOf(state()) !== 'ready') {
      closeInfo();
      closeError();
      closeConfirm();
    }
    applyFocus();
  }

  return {
    applyGameButtons,
    clearGameButtons,
    refresh,
    showError: openError,
    start: () => gamepad.start(),
  };
}
