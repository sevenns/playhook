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
import type { AppState } from '../shared/types';
import type { Translator } from '../shared/i18n/index.js';
import { createGamepadController } from './gamepad.js';
import { type AudioController } from './audio.js';
import { gameOf, phaseOf, steamBusy } from './state-view.js';
import { req, reqQuery } from './dom.js';

// The current popup view (mutually exclusive; 'none' = closed). Mirrors the data-view on #popup.
type PopupView = 'none' | 'details' | 'power' | 'confirm' | 'error';
// Which action the confirm view is asking about (only meaningful while popupView === 'confirm').
type ConfirmMode = 'install' | 'uninstall' | 'shutdown' | 'reboot' | 'sleep';
// Gamepad A doesn't trigger :active, so flash a press class to play the scale-down animation.
const PRESS_MS = 130;

/** What the interaction layer needs from the rest of the renderer. */
export interface ControlsDeps {
  /** The current AppState snapshot (app.ts owns it; updated before it calls into here). */
  getState(): AppState;
  /** The shared audio controller (UI sounds). */
  audio: AudioController;
  /** The current translator (read live so menu/confirm copy follows the language). */
  getTranslator(): Translator;
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
  /** Starts the gamepad polling loop. */
  start(): void;
}

export function createControls(deps: ControlsDeps): Controls {
  const { audio } = deps;
  const state = (): AppState => deps.getState();
  const t = (): Translator => deps.getTranslator();

  // Bar buttons.
  const hideButton = req<HTMLButtonElement>('hide-button');
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
  const menuClose = req<HTMLButtonElement>('menu-close');
  const powerShutdown = req<HTMLButtonElement>('power-shutdown');
  const powerReboot = req<HTMLButtonElement>('power-reboot');
  const powerSleep = req<HTMLButtonElement>('power-sleep');
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

  // Details menu (from More): game stats on top + Shutdown / Install|Uninstall / Close stack.
  function openDetails(): void {
    if (phaseOf(state()) !== 'ready') return;
    applyMenuInstallToggle(); // keep the toggle's text/visibility fresh for the current game
    setView('details');
    focusStackBottom(); // default focus: Close
    applyFocus(); // main highlight clears (focusActive false with a popup open)
  }

  // Power submenu (from Details → Shutdown): Shutdown / Reboot / Sleep. Each opens a Yes/No confirm.
  function openPower(): void {
    if (phaseOf(state()) !== 'ready') return;
    setView('power');
    focusStackBottom(); // default focus: Sleep
    applyFocus();
  }

  // Confirm view — install/uninstall (from Details) or a power action (from Power). Yes runs the action
  // and closes the whole stack; No/back returns to where it came from.
  function openConfirm(mode: ConfirmMode): void {
    if (phaseOf(state()) !== 'ready') return;
    if (mode === 'install' || mode === 'uninstall') {
      const game = gameOf(state());
      if (game === undefined) return;
      if (mode === 'install' && !game.requiresInstall) return; // nothing to install
      if (mode === 'uninstall' && !game.canUninstall) return; // nothing to uninstall
      confirmReturnTo = 'details';
      const isSteam = game.installVia === 'steam';
      const isSteamInstall = mode === 'install' && isSteam;
      popup.dataset['mode'] = mode; // 'install' shows the path note (card install only, see styles.css)
      if (isSteamInstall) popup.dataset['installVia'] = 'steam';
      else delete popup.dataset['installVia'];
      if (isSteam) {
        confirmMessage.textContent = t()(
          mode === 'install' ? 'launcher.confirm.steamInstall' : 'launcher.confirm.steamUninstall',
        );
      } else {
        confirmMessage.textContent = t()(
          mode === 'install' ? 'launcher.confirm.install' : 'launcher.confirm.uninstall',
        );
      }
      // Card path only for a card-installer install (empty for steam — there is no install dir).
      if (mode === 'install') confirmPath.textContent = isSteamInstall ? '' : (game.installDir ?? '');
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
    const game = gameOf(state());
    const showInstall = game?.requiresInstall === true;
    const showUninstall = game?.canUninstall === true;
    const show = showInstall || showUninstall;
    menuInstallToggle.classList.toggle('is-hidden', !show);
    if (show) {
      menuInstallToggle.textContent = t()(showInstall ? 'launcher.menu.install' : 'launcher.menu.uninstall');
      // Which action Yes will run — read back in the stack trigger.
      menuInstallToggle.dataset['action'] = showInstall ? 'install' : 'uninstall';
    }
  }

  // ── Main bar focus (gamepad / mouse) ─────────────────────────────────────────

  const ALL_MAIN_BUTTONS: readonly HTMLButtonElement[] = [playButton, moreButton];
  let focusIndex = 0;

  function mainFocusables(): readonly HTMLButtonElement[] {
    // Steam install/uninstall indicator up: only the gear (playButton) is focusable — its click opens
    // Steam's Downloads page (see triggerPlay). The right-side More is hidden.
    if (steamBusy(state())) return [playButton];
    // no-play layout: a requiresInstall installer/steam game hides Play → only More.
    if (gameOf(state())?.requiresInstall === true) return [moreButton];
    return [playButton, moreButton];
  }

  // Main focus is only meaningful on the ready screen with the popup closed.
  function focusActive(): boolean {
    return phaseOf(state()) === 'ready' && popupView === 'none';
  }

  function applyFocus(): void {
    const items = mainFocusables();
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

  // ── Popup stack focus (vertical) ─────────────────────────────────────────────
  // A single dynamic group covering all four views; the visible buttons depend on the view (and, for
  // Details, whether the Install/Uninstall item is present). Default focus is the BOTTOM button.
  const ALL_STACK_BUTTONS: readonly HTMLButtonElement[] = [
    menuShutdown,
    menuInstallToggle,
    menuClose,
    powerShutdown,
    powerReboot,
    powerSleep,
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
        items.push(menuClose);
        return items;
      }
      case 'power':
        return [powerShutdown, powerReboot, powerSleep];
      case 'confirm':
        return [confirmYes, confirmNo];
      case 'error':
        return [errorClose];
      default:
        return [];
    }
  }

  function stackActive(): boolean {
    return phaseOf(state()) === 'ready' && popupView !== 'none';
  }

  function applyStackFocus(): void {
    const items = stackFocusables();
    stackIndex = Math.min(items.length - 1, Math.max(0, stackIndex));
    const focused = stackActive() ? items[stackIndex] : undefined;
    ALL_STACK_BUTTONS.forEach((btn) => btn.classList.toggle('is-focused', btn === focused));
  }

  function focusStackBottom(): void {
    stackIndex = Math.max(0, stackFocusables().length - 1);
    applyStackFocus();
  }

  function moveStackFocus(delta: number): void {
    if (!stackActive()) return;
    const items = stackFocusables();
    const next = Math.min(items.length - 1, Math.max(0, stackIndex + delta));
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
    const game = gameOf(state());
    // Steam download in progress: the gear opens Steam's Downloads page, where the user can
    // pause/resume (we can't control that programmatically).
    if (game?.steamInstalling === true) {
      audio.play('button');
      window.api.openSteamDownloads();
      return;
    }
    // Steam uninstall in progress (gear) → nothing useful to do, ignore the press.
    if (game?.steamUninstalling === true) return;
    audio.play('play');
    window.api.requestLaunch();
  }

  function triggerMore(): void {
    audio.play('button');
    openDetails();
  }

  function activateFocused(): void {
    if (!focusActive()) return;
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
    } else if (btn === menuClose || btn === errorClose) {
      back(); // closes Details / Error
    } else if (btn === powerShutdown) {
      audio.play('button');
      openConfirm('shutdown');
    } else if (btn === powerReboot) {
      audio.play('button');
      openConfirm('reboot');
    } else if (btn === powerSleep) {
      audio.play('button');
      openConfirm('sleep');
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

  // The empty / idle screen, where the only action is "Hide" (back to tray).
  function onMessageScreen(): boolean {
    const phase = phaseOf(state());
    return phase === 'idle' || phase === 'error';
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  playButton.addEventListener('click', () => triggerPlay());
  moreButton.addEventListener('click', () => triggerMore());
  hideButton.addEventListener('click', () => window.api.requestHide());
  popupVeil.addEventListener('click', () => back());

  // A mouse click on a stack button triggers THAT button (regardless of the current highlight); only the
  // active view's group is visible/clickable, so a click can't reach a hidden view's button.
  ALL_STACK_BUTTONS.forEach((btn) => {
    btn.addEventListener('click', () => {
      pressFlash(btn);
      triggerStackButton(btn);
    });
  });

  // Mouse hover moves the gamepad focus too, so A always activates what's highlighted.
  ALL_MAIN_BUTTONS.forEach((btn) => {
    btn.addEventListener('mouseenter', () => {
      if (!focusActive()) return;
      const idx = mainFocusables().indexOf(btn);
      if (idx === -1) return;
      focusIndex = idx;
      applyFocus();
    });
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

  const gamepad = createGamepadController({
    // With a popup open, left/right are a no-op (the stacks are vertical); the bar uses them otherwise.
    onLeft: () => {
      if (popupView === 'none') moveFocus(-1);
    },
    onRight: () => {
      if (popupView === 'none') moveFocus(1);
    },
    // Up/down drive the vertical popup stack; ignored on the bar (which has no vertical axis).
    onUp: () => {
      if (popupView !== 'none') moveStackFocus(-1);
    },
    onDown: () => {
      if (popupView !== 'none') moveStackFocus(1);
    },
    // On the empty / idle screen the only action is Hide; otherwise A activates the focused control.
    onA: () => {
      if (popupView !== 'none') activateStack();
      else if (onMessageScreen()) window.api.requestHide();
      else activateFocused();
    },
    onB: () => {
      if (popupView !== 'none') back();
      else if (onMessageScreen()) window.api.requestHide();
    },
  });

  // Keyboard Esc: step back through the popup first, otherwise hide the launcher to tray from any screen
  // — mirrors the Hide button. Intentionally keyboard-only; the gamepad routing is left as is.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (popupView !== 'none') back();
    else window.api.requestHide();
  });

  function applyGameButtons(): void {
    // The only game-dependent control now is the Details menu's Install/Uninstall item (the popup's
    // other buttons are static). Refreshed every render so it stays correct if the game state changes
    // while Details is open (a ready→ready update doesn't force-close the popup).
    applyMenuInstallToggle();
  }

  function clearGameButtons(): void {
    // No game → no Install/Uninstall item (the popup is force-closed off the ready screen anyway).
    menuInstallToggle.classList.add('is-hidden');
  }

  function refresh(): void {
    // The popup only makes sense on the ready screen with no steam-busy indicator; force-close it
    // otherwise. A failed launch returns to 'ready' first, THEN opens the error popup (separate IPC),
    // so the error survives this. Closing also matters for a card swap/pull WHILE the popup is open,
    // and for a steam download/uninstall that starts externally (SteamInstallWatch) under an open
    // Details with Install/Uninstall items.
    if (phaseOf(state()) !== 'ready' || steamBusy(state())) {
      closePopup();
    }
    applyFocus();
    applyStackFocus();
  }

  return {
    applyGameButtons,
    clearGameButtons,
    refresh,
    showError: openError,
    start: () => gamepad.start(),
  };
}
