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
import type { AppNotification, AppState, BrowseInfo, GameInfo } from '../shared/types';
import type { Locale, MessageKey, Translator } from '../shared/i18n/index.js';
import { formatNotification, formatNotificationTime } from './format.js';
import { createScroller } from './screen-scroller.js';
import { HOLD_DELAY_MS, NAV_REPEAT_MS, createAutoRepeatChain } from './auto-repeat.js';
import { createGamepadController } from './gamepad.js';
import { createWakeMeter } from './mouse-sleep.js';
import type { NavSurface } from './nav-surface.js';
import type { MoveResult } from './carousel.js';
import type { SystemCardId } from './system-cards.js';
import { type AudioController } from './audio.js';
import { gameOf, phaseOf, steamBusy } from './state-view.js';
import { req, reqQuery } from './dom.js';

// The current popup view (mutually exclusive; 'none' = closed). Mirrors the data-view on #popup.
type PopupView = 'none' | 'details' | 'notifications' | 'power' | 'confirm' | 'error';
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
  // The second half of the delete question: whether the game's HISTORY record goes with it. Its "No" is
  // an answer rather than a cancel — see the confirmNo branch in triggerStackButton.
  | 'delete-game-history'
  | 'discard-game-settings'
  | 'switch-game-source'
  // Leaving the screen (B/veil/Close) while a "Move to card…" is pending — drops the pending move and
  // returns the form to the PC library's baseline, WITHOUT closing the screen (see game-settings-screen.ts
  // PendingMove). Kept apart from 'discard-game-settings', whose "Yes" closes the whole screen.
  | 'cancel-move-game-settings';
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
  /** The current UI locale — the notification list formats its timestamps with it. */
  getLocale(): Locale;
  /** The history carousel — the THIRD focus group, above the bar and the popup stack (see navLeft…). */
  carousel: CarouselNav;
  /** The Settings screen — the FOURTH surface, between the popup and the carousel (see navLeft…). */
  settings: SettingsNav;
  /** The Customize screen — the fifth surface, at the same level as Settings (see `overlays` below). */
  gameSettings: GameSettingsNav;
  /** The Library screen — the sixth surface, at that same level. */
  library: LibraryNav;
  /**
   * A direction is being HELD, i.e. the strip is flipping on its own (true), or it has just been let go
   * (false). The background subsystem holds its image for the duration — see hero.setFlipping.
   */
  onFlipping(flipping: boolean): void;
  /** The inbox as main last pushed it — the popup list and the More item's dot are drawn from it. */
  getNotifications(): readonly AppNotification[];
  /** The popup finished closing. The toast shares this corner and holds its queue while it is up. */
  onPopupClosed(): void;
  /** Opens a game's detail screen (a notification about a game leads there). Owned by app.ts. */
  openGameDetail(id: string): void;
  /**
   * Whether the boot screen is still up (app.ts owns the reveal). The whole UI is built and laid out
   * behind the wallpaper — the bar sits at opacity 0, the cards are held at zero — so every surface is
   * already drivable while nothing of it can be seen: A on the invisible row opened the Notifications
   * card behind the boot image, and a direction flipped a carousel nobody was looking at.
   */
  isBooting(): boolean;
}

/**
 * What the interaction layer needs from the Settings screen. The screen owns its rows, focus and IPC
 * (settings-screen.ts); this module only routes the six primitives to it and guards the mechanisms that
 * would otherwise keep running underneath (idle timer, wheel, Y).
 */
export interface SettingsNav extends NavSurface {
  /** `sectionKey` deep-links to one section — an "update ready" notification lands on Updates.
   *  `silent` suppresses the screen's own opening sound — see SettingsScreen.open. */
  open(sectionKey?: MessageKey, options?: { readonly silent?: boolean }): void;
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
  /** `move: true` starts the screen straight into "Move to card…" (Р2.1). */
  open(id: string, options?: { readonly move?: boolean }): void;
  /** Opens the same screen to CREATE a game — the "Add game" item of the Details menu. */
  openNew(): void;
  close(): void;
  /** Whether there are unsaved edits — decides whether leaving asks first. */
  isDirty(): boolean;
  /** Whether the game about to be deleted is a LOCAL one, whose save backups survive the deletion. */
  deletesLocalGame(): boolean;
  /** The shared confirm popup said yes to one of the screen's questions. */
  confirmAccepted(
    kind: 'reset' | 'delete' | 'delete-history' | 'discard' | 'switch-source' | 'cancel-move',
  ): void;
}

/**
 * The Library screen, the third overlay — and the one the "Add game" route runs through, which is why
 * this module opens it: the screen it hands over to (Customize in add mode) is this module's to open.
 */
export interface LibraryNav extends NavSurface {
  open(): void;
  /** `silent` is a hand-over to another surface (the detail screen, Add game) — see LibraryScreen. */
  close(silent?: boolean): void;
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
  /** Steps back from a detail screen to the strip; false when the strip is already the screen. */
  leaveDetail(): boolean;
  /** Whether the inbox holds anything unread — the Notifications CARD wears the dot now. */
  setUnread(unread: boolean): void;
}

export interface Controls {
  /** Refreshes the game-dependent menu item (Install/Uninstall text + visibility) from the current state. */
  applyGameButtons(): void;
  /** The Settings screen closed itself — restore the bar highlight on the More button it came from. */
  settingsClosed(): void;
  /** The Settings screen asked to reset — opens the shared confirm popup (No returns to Settings). */
  confirmResetSettings(): void;
  /** The Customize screen asked one of its questions — opens the same shared confirm popup. */
  confirmGameSettings(
    kind: 'reset' | 'delete' | 'delete-history' | 'discard' | 'switch-source' | 'cancel-move',
  ): void;
  /**
   * Opens the surface one of the carousel's launcher cards stands for. The card plays the press sound
   * itself (app.ts), so nothing here does — the surface's own popup-open follows it.
   */
  openSystemCard(id: SystemCardId): void;
  /** "Add game", from the Library's column — the launcher's only route to creating a game. */
  openAddGame(): void;
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
  /** A fresh inbox arrived: repaint the More item's dot and, if the list is up, the list. */
  applyNotifications(): void;
  /** Whether the popup is up. The toast shares its corner and waits rather than covering it. */
  isPopupOpen(): boolean;
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

  // The glide step the strip animates one held move over (styles.css reads it as --flip-step). Slightly
  // LONGER than the repeat itself, on purpose: the keyboard's repeats arrive on the OS clock and are only
  // throttled to NAV_REPEAT_MS here, so their real spacing wanders above it. A step that outlasts the gap
  // overlaps the next one and the row never stalls between them; an exact match would leave tiny holes.
  const FLIP_STEP_MS = Math.round(NAV_REPEAT_MS * 1.3);
  document.documentElement.style.setProperty('--flip-step', `${FLIP_STEP_MS}ms`);

  // The shared warmth of an auto-move, so a run handed from one direction to the next — or from the pad
  // to the keyboard — skips the initial delay instead of stalling (auto-repeat.ts).
  const autoRepeat = createAutoRepeatChain();
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
      if (deps.library.isOpen()) return deps.library;
      return null;
    },
    isAnyOpen: (): boolean =>
      deps.settings.isOpen() || deps.gameSettings.isOpen() || deps.library.isOpen(),
  };

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
  const menuInstallToggle = req<HTMLButtonElement>('menu-install-toggle');
  const menuKill = req<HTMLButtonElement>('menu-kill');
  const menuHome = req<HTMLButtonElement>('menu-home');
  const menuCustomize = req<HTMLButtonElement>('menu-customize');
  const menuMoveToCard = req<HTMLButtonElement>('menu-move-to-card');
  const menuForget = req<HTMLButtonElement>('menu-forget');
  const menuClose = req<HTMLButtonElement>('menu-close');
  const powerShutdown = req<HTMLButtonElement>('power-shutdown');
  const powerReboot = req<HTMLButtonElement>('power-reboot');
  const powerSleep = req<HTMLButtonElement>('power-sleep');
  const powerMinimize = req<HTMLButtonElement>('power-minimize');
  const powerQuit = req<HTMLButtonElement>('power-quit');
  const powerClose = req<HTMLButtonElement>('power-close');
  const notificationList = req('notification-list');
  // The same scroller every full-screen surface uses: one fixed duration and easing for the glide, plus
  // the edge fades. Reused rather than reinvented — a list that scrolls differently from the Settings
  // list would be the only one in the app that does.
  const notificationScroller = createScroller(notificationList);
  // The Details stack scrolls too: its items are the launcher's whole menu, and on a one-game screen the
  // play statistics above it leave less room than the eight items need. Its own scroller, because a
  // scroller owns one box's position and fades.
  const menuStack = req('menu-stack');
  const menuStackScroller = createScroller(menuStack);
  const notificationsClear = req<HTMLButtonElement>('notifications-clear');
  const notificationsClose = req<HTMLButtonElement>('notifications-close');
  const confirmYes = req<HTMLButtonElement>('confirm-yes');
  const confirmNo = req<HTMLButtonElement>('confirm-no');
  const errorClose = req<HTMLButtonElement>('error-close');

  let popupView: PopupView = 'none';
  // The notification entries currently in the DOM. They are recreated on every snapshot, so — unlike
  // ALL_STACK_BUTTONS — they cannot be wired or highlighted once at startup; see the click delegation
  // below and applyStackFocus.
  let notificationButtons: readonly HTMLButtonElement[] = [];
  let confirmMode: ConfirmMode = 'uninstall';
  // Where B/Esc/veil returns FROM the confirm view: install/uninstall come from Details, the power
  // actions come from Power.
  let confirmReturnTo: 'details' | 'power' | 'settings' | 'game-settings' = 'details';
  // How the CURRENT popup was entered: through the Details menu, or straight from a launcher card. It
  // decides what B does in the Power / Notifications views — stepping back into a menu that was never
  // opened would conjure a game's menu over the carousel.
  let popupRoot: 'details' | 'direct' = 'details';
  /** The game the open remove-from-history confirm is about — captured when it opens (see openConfirm). */
  let forgetId: string | null = null;

  // ── Popup machine ────────────────────────────────────────────────────────────
  // One #popup element; opening = add .is-open + set data-view; switching views keeps .is-open (so the
  // shared veil never cross-fades). Closing removes .is-open.

  function setView(view: Exclude<PopupView, 'none'>): void {
    // Every view change lays a new stack under the pointer — hover must not claim the focus the view
    // itself just set (see the mousemove handler).
    armHover();
    // Only the FIRST view is an opening; switching views keeps the popup on screen and keeps the
    // button/back sounds the callers already play (Р4).
    if (popupView === 'none') audio.play('popup-open');
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

  function closePopup(options?: { readonly silent?: boolean }): void {
    if (popupView === 'none') return;
    // `silent` is for a close that is only half of a bigger move — the popup handing over to a screen,
    // where the destination's own popup-open is the single sound of that gesture (Р5).
    if (options?.silent !== true) audio.play('popup-close');
    popupView = 'none';
    popup.classList.remove('is-open');
    popup.setAttribute('aria-hidden', 'true');
    // The toast lives in the corner this column is fading out of, so it is released only once the fade
    // is over — otherwise a plate would fade IN over a popup still fading OUT, in the same 20 pixels.
    window.setTimeout(() => deps.onPopupClosed(), POPUP_FADE_MS);
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
    applyMenuMoveToCard(); // …and "Move to card…", local (PC-library) games only
    applyMenuForget(); // keep the "Remove from history" item fresh (history-only games)
    popupRoot = 'details';
    setView('details');
    focusStackBottom(); // default focus: Close
    applyFocus(); // main highlight clears (focusActive false with a popup open)
    // Open at the BOTTOM of the stack when it does not all fit — that is where the focus already is, and
    // a menu that opens at the top and then glides down shows the wrong end first. Instant, and next
    // frame: the items were relabelled/unhidden this tick and the box has not been laid out yet. A stack
    // that fits clamps this to 0, so nothing moves.
    requestAnimationFrame(() => menuStackScroller.to(menuStack.scrollHeight, true));
  }

  /**
   * The Notifications popup (from Details → Notifications). Opening it IS reading the inbox — that is
   * one of the only two gestures that clear the unread state, the other being pressing an entry — so
   * main is told straight away and the dot beside the More item goes out.
   */
  function openNotifications(): void {
    window.api.markNotificationsRead();
    setView('notifications');
    renderNotificationList();
    focusStackBottom(); // default focus: Close, as in every other view
    applyFocus();
    // Open at the BOTTOM of the list: the freshest notifications are the last ones (the stack reads
    // oldest-first, like every other one here), and those are what the user came for. Instant — a list
    // that opens at the top and then glides down is showing the wrong end first either way.
    // Next frame, because the entries were inserted this tick and the box has not been laid out yet.
    requestAnimationFrame(() => {
      notificationScroller.to(notificationList.scrollHeight, true);
    });
  }

  /** The notification whose entry currently holds the focus — the anchor a repaint restores. */
  function focusedNotificationId(): string | undefined {
    if (popupView !== 'notifications') return undefined;
    return stackFocusables()[stackIndex]?.dataset['notificationId'];
  }

  /** One entry: what happened and when, plus the unread dot. */
  function buildNotificationButton(item: AppNotification): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button notification-item';
    const line = document.createElement('span');
    line.className = 'notification-line';
    const text = document.createElement('span');
    text.className = 'notification-text';
    line.append(text);
    const dot = document.createElement('span');
    dot.className = 'notification-dot';
    line.append(dot);
    const time = document.createElement('span');
    time.className = 'notification-time';
    button.append(line, time);
    patchNotificationButton(button, item);
    return button;
  }

  /** Writes one notification into an entry node — the same path for a fresh node and for a reused one. */
  function patchNotificationButton(button: HTMLButtonElement, item: AppNotification): void {
    button.dataset['notificationId'] = item.id;
    const text = button.querySelector('.notification-text');
    const dot = button.querySelector('.notification-dot');
    const time = button.querySelector('.notification-time');
    // textContent, never innerHTML: the title comes off the card and is untrusted data.
    if (text !== null) text.textContent = formatNotification(item, t());
    if (dot !== null) dot.classList.toggle('is-hidden', item.read);
    if (time !== null) {
      time.textContent = formatNotificationTime(item.at, Date.now(), t(), deps.getLocale());
    }
  }

  /**
   * Rebuilds the list from the latest snapshot (main is the only source of truth — nothing here edits the
   * inbox locally and hopes main agrees). Two things make the rebuild safe while the popup is on screen:
   *  • it stands down entirely during the popup's fade-out, so the user never watches the menu rewrite
   *    itself on the way out (the same freeze every applyMenu* helper respects);
   *  • the focus is re-anchored by notification ID rather than by index — `stackIndex` is only clamped
   *    when the stack changes, so a snapshot arriving under an open list would otherwise slide the
   *    highlight quietly onto a different entry.
   */
  function renderNotificationList(): void {
    if (menuFrozen()) return;
    const items = deps.getNotifications();
    // Same entries, different values — opening the popup marks them all read, and main echoes that back
    // a beat later. Recreating the nodes for it would replay the whole staggered entrance under the
    // user's eyes, right after the list appeared; patching in place does not (the same reason the stats
    // panel in app.ts updates its rows rather than rebuilding them).
    // `length > 0` guards the very first open of an EMPTY inbox: both sides are empty, every() is
    // vacuously true, and the shortcut would return without ever putting the empty-state line in.
    if (
      items.length > 0 &&
      notificationButtons.length === items.length &&
      items.every((item, at) => notificationButtons[at]?.dataset['notificationId'] === item.id)
    ) {
      items.forEach((item, at) => {
        const button = notificationButtons[at];
        if (button !== undefined) patchNotificationButton(button, item);
      });
      return;
    }
    const anchorId = focusedNotificationId();
    const anchorButton = popupView === 'notifications' ? stackFocusables()[stackIndex] : undefined;
    notificationButtons = items.map(buildNotificationButton);
    notificationList.replaceChildren(...notificationButtons);
    if (items.length === 0) {
      // A line, not a button: there is nothing to press, so it must not be focusable either.
      const empty = document.createElement('div');
      empty.className = 'notification-empty';
      empty.textContent = t()('notifications.empty');
      notificationList.append(empty);
    }
    // Nothing to clear when there is nothing there — the button would be an action with no effect, sitting
    // right where the eye lands. It folds away like every other volatile item in a stack.
    notificationsClear.classList.toggle('is-hidden', items.length === 0);
    // The fades are computed from the laid-out box, which this tick's insertions have not produced yet.
    requestAnimationFrame(() => notificationScroller.fades());
    if (popupView === 'notifications') {
      const stack = stackFocusables();
      const at =
        anchorId !== undefined
          ? stack.findIndex((button) => button.dataset['notificationId'] === anchorId)
          : anchorButton === undefined
            ? -1
            : stack.indexOf(anchorButton);
      // The entry that had the focus is gone (pressed, or evicted) → fall back to the bottom button,
      // which is "Close" — the same safe default every stack opens on.
      stackIndex = at === -1 ? Math.max(0, stack.length - 1) : at;
    }
    applyStackFocus();
  }

  /**
   * The unread state: the same dot a game card wears, on the Notifications CARD in the row. The inbox
   * belongs to the launcher, and the launcher's own cards are where it lives now.
   */
  function applyUnreadDot(): void {
    deps.carousel.setUnread(deps.getNotifications().some((item) => !item.read));
  }

  /**
   * Pressing an entry removes it (this is an inbox — the press IS the handling) and then goes where the
   * notification points. A game that is no longer in the list — its card is out, its record evicted —
   * simply has nowhere to go, and the popup just closes.
   */
  function activateNotification(button: HTMLButtonElement): void {
    const id = button.dataset['notificationId'];
    if (id === undefined) return;
    const item = deps.getNotifications().find((candidate) => candidate.id === id);
    window.api.dismissNotification(id);
    // Muted when the entry leads to Settings — that screen's popup-open is the sound of the whole
    // gesture (Р5). With nowhere to go, the popup simply closes and says so.
    closePopup({ silent: item?.kind === 'update-ready' });
    if (item === undefined) return;
    if (item.kind === 'update-ready') {
      openSettings('settings.sectionUpdates');
      return;
    }
    // A game written to a card that is not active has no entry in the library to open — the notification
    // says where it went, and pressing it does nothing beyond dismissing it.
    if (
      item.kind === 'game-added-deferred' ||
      item.kind === 'game-moved-deferred' ||
      item.kind === 'game-move-save-skipped' ||
      item.kind === 'game-move-duplicate'
    )
      return;
    deps.openGameDetail(item.gameId);
  }

  /**
   * One of the carousel's launcher cards was pressed. The three surfaces are the ones the Details menu
   * used to hold at the launcher level; they are now reached from the row itself, which is why `popupRoot`
   * is set to 'direct' — B out of them goes back to the cards, not into a menu nobody opened.
   */
  function openSystemCard(id: SystemCardId): void {
    popupRoot = 'direct';
    // A switch with an exhaustive default, not a chain ending in openPower(): a card added to
    // SYSTEM_CARDS and forgotten here used to fall through to "shut the machine down", and no type would
    // have caught it. Now the missing branch is a compile error.
    switch (id) {
      case 'library':
        // Same as Settings: the card's own `button` (app.ts) is this press's sound.
        deps.library.open();
        break;
      case 'notifications':
        openNotifications();
        break;
      case 'settings':
        // The card's own `button` (app.ts) is the sound of this press; the screen adds none of its own.
        // The other cards open a popup, whose `popup-open` is a different sound and layers fine.
        openSettings(undefined, { silent: true });
        break;
      case 'power':
        openPower();
        break;
      default: {
        const exhaustive: never = id;
        throw new Error(`unhandled launcher card ${String(exhaustive)}`);
      }
    }
    applyFocus();
  }

  // Power submenu (from a launcher card, or from Details → System on a game screen): Shutdown / Reboot /
  // Sleep. Each opens a Yes/No confirm.
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
      mode === 'delete-game-history' ||
      mode === 'discard-game-settings' ||
      mode === 'switch-game-source' ||
      mode === 'cancel-move-game-settings'
    ) {
      // The Customize screen's questions. Same shape as the Settings reset: the screen stays open
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
            : mode === 'switch-game-source'
              ? t()('gameSettings.confirmSwitchSource')
              : mode === 'cancel-move-game-settings'
                ? t()('gameSettings.confirmCancelMove')
                : mode === 'delete-game-history'
                  ? t()('gameSettings.confirmDeleteHistory', { title: browse?.title ?? '' })
                  : t()('gameSettings.confirmDelete', { title: browse?.title ?? '' });
      // The second question's own note: what each of ITS answers costs. It matters more than the first
      // one's, because "No" here does not mean "never mind" — it deletes the game and keeps the card.
      if (mode === 'delete-game-history') {
        deleteNote.textContent = t()('gameSettings.confirmDeleteHistoryNote');
      }
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
      case 'notifications':
        // Opened straight from a launcher card, there is no menu underneath to step back into: the level
        // above these is the carousel itself, so the popup simply goes.
        if (popupRoot === 'direct') {
          closePopup();
          break;
        }
        audio.play('back');
        setView('details');
        focusStackBottom();
        break;
      case 'confirm':
        // Neither 'settings' nor 'game-settings' is a popup view: that screen is already open
        // underneath, so the popup just goes and the screen has the focus again.
        if (confirmReturnTo === 'settings' || confirmReturnTo === 'game-settings') {
          closePopup();
          break;
        }
        audio.play('back');
        setView(confirmReturnTo);
        focusStackBottom();
        break;
      case 'details':
      case 'error':
        closePopup();
        break;
      default:
        break;
    }
  }

  // ── Settings screen (the fourth surface) ─────────────────────────────────────
  // Opening/closing lives here because the bar focus does: the screen is entered from More and returns
  // to it. Everything INSIDE the screen belongs to settings-screen.ts.

  function openSettings(sectionKey?: MessageKey, options?: { readonly silent?: boolean }): void {
    deps.settings.open(sectionKey, options);
    applyFocus(); // the bar highlight clears (focusActive is false with the screen open)
  }

  /**
   * "Add game", from the Library's column: the ONE way to create a game from inside the launcher (the
   * Details menu lost its item in 4c0d3dc, and openNew() has had no caller since). The library steps
   * aside first — data-overlay holds one value at a time — and app.ts remembers to bring it back when the
   * Customize screen closes.
   */
  function openAddGame(): void {
    deps.library.close(true);
    deps.gameSettings.openNew();
    applyFocus();
  }

  function openCustomize(): void {
    const browse = deps.getBrowse();
    if (browse === null || !browse.active) return; // the item's own rule, re-checked at the press
    deps.gameSettings.open(browse.id);
    applyFocus();
  }

  /** Same screen as Customize, opened straight into "Move to card…" — the item's own rule, re-checked. */
  function openMoveToCard(): void {
    const browse = deps.getBrowse();
    if (browse === null || !browse.active || browse.game?.source !== 'pc') return;
    deps.gameSettings.open(browse.id, { move: true });
    applyFocus();
  }

  /**
   * The screen closed itself (B / Esc / veil): put the highlight back on the More button it came from —
   * on a detail screen. Opened from a launcher card, the screen came from the CAROUSEL, where the bar is
   * hidden and the row is the surface: there the highlight simply clears.
   */
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
    const show = deps.carousel.screen() === 'detail';
    menuHome.classList.toggle('is-hidden', !show);
    if (show) menuHome.textContent = t()('launcher.menu.goBack');
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

  // ── Menu item: Move to card… (a local game only) ──────────────────────────────
  // Offered alongside Customize, only for a game whose manifest lives in the PC library — a card game has
  // nowhere to move TO that would mean anything. Hidden while the game is busy (install/uninstall/Steam
  // activity), same guard as Delete on the Customize screen itself (game-settings-screen.ts canDelete).
  function applyMenuMoveToCard(): void {
    if (menuFrozen()) return;
    const browse = deps.getBrowse();
    const busy = phaseOf(state()) === 'busy' || steamBusy(state());
    const show =
      onGameScreen() && browse !== null && browse.active && browse.game?.source === 'pc' && !busy;
    menuMoveToCard.classList.toggle('is-hidden', !show);
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
  // Whether the bar's focus highlight is "awake". It goes dormant when an active state (install / launch
  // / uninstall / steam) appears, so the highlight doesn't auto-jump onto a button the user didn't pick;
  // it wakes again only on an explicit gamepad move or a mouse hover. `wasActive` tracks the edge.
  let focusRevealed = true;
  let wasActive = false;
  // Idle timeout, shared by the bar focus and the mouse: after 5s with no input the bar highlight goes
  // dormant AND the mouse falls asleep. Any input restarts the countdown; the gamepad puts the mouse to
  // sleep at once (the user switched to the pad), a shove wakes it back up (see the note* helpers).
  const IDLE_MS = 5_000;
  let idleTimer = 0;
  // The launcher OPENS with the mouse asleep (index.html carries the class from the first frame, so there
  // is no moment where a parked pointer can hover something before this file runs). Waking it takes a
  // deliberate shove — see mouse-sleep.ts and the swallowing listener below.
  let mouseAsleep = true;
  const wakeMeter = createWakeMeter();

  function mainFocusables(): readonly HTMLButtonElement[] {
    // The carousel has no bar to focus at all: Play is the selected card's invisible stand-in for the
    // morph (styles.css) and More is hidden there — the launcher-level actions are cards in the row now.
    if (deps.carousel.screen() === 'carousel') return [];
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
  // popup closed. On the carousel the strip owns the selection, and nothing else on that screen can hold
  // the focus at all.
  function focusActive(): boolean {
    if (popupView !== 'none') return false;
    // The Settings screen covers the bar (which is faded out and pointer-events:none underneath).
    if (overlays.isAnyOpen()) return false;
    return deps.carousel.screen() === 'detail';
  }

  function applyFocus(): void {
    const items = mainFocusables();
    // The carousel's empty bar: clamping against a length of 0 would push the index to -1 and quietly
    // move the focus to Play the next time a detail screen is entered — wherever it had been left.
    if (items.length === 0) {
      ALL_MAIN_BUTTONS.forEach((btn) => btn.classList.remove('is-focused'));
      return;
    }
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

  /** Puts the mouse to sleep or wakes it: hides the cursor AND turns every pointer gesture on or off. */
  function setMouseAsleep(asleep: boolean): void {
    if (mouseAsleep === asleep) return;
    mouseAsleep = asleep;
    document.documentElement.classList.toggle('mouse-asleep', asleep);
    wakeMeter.reset();
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
      setMouseAsleep(true);
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

  // Gamepad/keyboard input = activity: the mouse goes to sleep at once (the user switched to the pad, so
  // the pointer parked on screen stops counting as input at all), hover is disarmed, the idle countdown
  // restarts.
  function noteGamepadActivity(): void {
    setMouseAsleep(true);
    // Explicitly, not just via setMouseAsleep: while the mouse is ALREADY asleep that call is a no-op,
    // and the travel a bumped trackpad has quietly banked up has to die on every pad step regardless —
    // otherwise a hand resting on the Deck adds up to a wake across a whole session of pressing buttons.
    wakeMeter.reset();
    // Every keyboard/gamepad step re-arms the hover guard: last input wins. Without this, one real mouse
    // move wakes hover for good, and from then on any element that slides under the still cursor — a
    // scrolling list, a popup opening — can take the focus back off the key that just moved it.
    armHover();
    armIdleTimer();
  }

  // Real mouse movement, with the mouse already awake = activity: keep the cursor up, restart the idle.
  function noteMouseActivity(): void {
    setMouseAsleep(false);
    armIdleTimer();
  }

  function moveFocus(delta: number, repeat = false): void {
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
    if (next === focusIndex) {
      if (!repeat) audio.playLimit(); // already at the edge: no move, and the dead end says so
      return;
    }
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
    menuHome,
    menuCustomize,
    menuMoveToCard,
    menuClose,
    notificationsClear,
    notificationsClose,
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
        if (!menuHome.classList.contains('is-hidden')) items.push(menuHome);
        if (!menuCustomize.classList.contains('is-hidden')) items.push(menuCustomize);
        if (!menuMoveToCard.classList.contains('is-hidden')) items.push(menuMoveToCard);
        items.push(menuClose);
        return items;
      }
      case 'notifications': {
        // The list first (oldest at the top, freshest just above the buttons — the DOM order), then the
        // buttons. This IS the up/down order, so it must match the DOM exactly.
        const items: HTMLButtonElement[] = [...notificationButtons];
        if (!notificationsClear.classList.contains('is-hidden')) items.push(notificationsClear);
        items.push(notificationsClose);
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
    // The notification entries are not in ALL_STACK_BUTTONS — they are rebuilt on every snapshot — so
    // they are cleared alongside it, or a stale highlight would sit on two buttons at once.
    for (const btn of [...ALL_STACK_BUTTONS, ...notificationButtons])
      btn.classList.toggle('is-focused', btn === focused);
    if (focused === undefined) return;
    // A focused item is revealed BY the box that scrolls it, which also keeps that box's edge fades in
    // step. Anything outside those two boxes has nothing to scroll — and must NOT fall back to
    // scrollIntoView there: with no scrollable ancestor Chromium walks up to the app itself and moves the
    // whole screen, which is what an overflowing menu used to do.
    if (focused.classList.contains('notification-item')) notificationScroller.reveal(focused);
    else if (popupView === 'details') menuStackScroller.reveal(focused);
    else focused.scrollIntoView({ block: 'nearest' });
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
    if (next === stackIndex) {
      audio.playLimit();
      return;
    }
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
    if (!focusActive()) return; // the bar is not the surface driving the press — not a dead end
    // Play acts on the game AppState is about, so it must be the one on screen: a history game has
    // nothing to launch, and while you browse game B, "Play" must not start game A behind your back.
    if (!screenIsActionable()) return audio.playLimit();
    const game = screenGame();
    // A local game whose files are gone: there is nothing to start, and the status line already says so.
    if (game?.unavailable === true) return audio.playLimit();
    // A local game with no launch method configured yet: same dead end, different reason.
    if (game?.unconfigured === true) return audio.playLimit();
    // Steam download in progress: the gear opens Steam's Downloads page, where the user can
    // pause/resume (we can't control that programmatically).
    if (game?.steamInstalling === true) {
      audio.play('button');
      window.api.openSteamDownloads();
      return;
    }
    // Steam uninstall in progress (gear) → nothing useful to do, ignore the press.
    if (game?.steamUninstalling === true) return audio.playLimit();
    // Force-close in flight: Play is a loading spinner, not return-to-game — ignore the press.
    const s = state();
    if (s.kind === 'running' && s.killing === true) return audio.playLimit();
    // In a hard-busy phase the Play button is just an activity indicator (spinner/gear) — no launch.
    // EXCEPT `running`: the launcher was summoned over the game and Play returns to it (main branches on
    // the running state and raises the game's window instead of launching).
    if (phaseOf(state()) !== 'ready' && state().kind !== 'running') return audio.playLimit();
    audio.play('play');
    window.api.requestLaunch();
  }

  function triggerMore(): void {
    openDetails(); // the panel's own popup-open is the sound of this press
  }

  function activateFocused(): void {
    // Nothing is selected while the highlight is dormant — the user must wake it (d-pad / hover) first.
    if (!focusActive()) return; // the bar is not the surface driving the press
    if (!focusRevealed) return audio.playLimit(); // A on a dormant highlight presses nothing
    const btn = mainFocusables()[focusIndex];
    if (btn === undefined) return;
    pressFlash(btn);
    if (btn === moreButton) triggerMore();
    else triggerPlay();
  }

  // Dispatch a stack button (shared by gamepad A and mouse click). Each opener/back plays its own sound.
  function triggerStackButton(btn: HTMLButtonElement): void {
    if (btn === menuInstallToggle) {
      audio.play('button');
      openConfirm(menuInstallToggle.dataset['action'] === 'install' ? 'install' : 'uninstall');
    } else if (btn === menuKill) {
      audio.play('button');
      openConfirm('kill');
    } else if (btn === menuForget) {
      audio.play('button');
      openConfirm('forget');
    } else if (btn.classList.contains('notification-item')) {
      activateNotification(btn);
    } else if (btn === notificationsClear) {
      // The popup deliberately stays open on its empty state: "Clear all" answers "get rid of these",
      // not "take me out of here", and closing would hide the very result of the press.
      audio.play('button');
      window.api.clearNotifications();
    } else if (btn === menuCustomize) {
      // Like Settings: the menu it was opened from closes first — the screen is a surface of its own.
      closePopup({ silent: true });
      openCustomize();
    } else if (btn === menuMoveToCard) {
      closePopup({ silent: true });
      openMoveToCard();
    } else if (btn === menuHome) {
      // Non-destructive, so no confirm: close the popup and hand control back to the strip.
      closePopup();
      deps.carousel.leaveDetail();
    } else if (btn === menuClose || btn === errorClose || btn === powerClose || btn === notificationsClose) {
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
      closePopup();
      window.api.requestHide();
    } else if (btn === powerQuit) {
      // The full quit. No confirm either: it is as recoverable as relaunching from the Steam library —
      // and in Game Mode this is the only way out, so a confirm would sit between the user and the exit
      // every single time.
      closePopup();
      window.api.requestQuit();
    } else if (btn === confirmYes) {
      acceptConfirm();
    } else if (btn === confirmNo) {
      // No IS back everywhere else — one gesture, one meaning. The history question is the exception: it
      // asks how FAR the deletion goes, so "No" answers it (delete the game, keep its card) while B and
      // the veil keep meaning "get me out of here" and cancel the deletion outright.
      if (popupView === 'confirm' && confirmMode === 'delete-game-history') {
        audio.play('button');
        closePopup();
        deps.gameSettings.confirmAccepted('delete');
        return;
      }
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
    // Deleting is asked in two parts, and the second one replaces the first ON THE SAME SURFACE: closing
    // the popup and opening it again would flash it out and back in for what the user experiences as one
    // question growing a follow-up.
    if (confirmMode === 'delete-game') {
      audio.play('button'); // neutral sound for the destructive confirm
      openConfirm('delete-game-history');
      return;
    }
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

  // The list's entries are recreated on every snapshot, so the one-off wiring above cannot reach them —
  // a click on a fresh entry would land on nothing (hover already works: it resolves its target through
  // closest('.text-button')). Delegation on the container covers whatever is in it at press time.
  notificationList.addEventListener('click', (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('.notification-item')
        : null;
    if (target === null) return;
    pressFlash(target);
    triggerStackButton(target);
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
    // Asleep, a move is not input — it only feeds the meter. Nothing hovers, nothing focuses and the
    // cursor stays hidden until the travel adds up to a shove. The position above is recorded either way:
    // whatever wakes the mouse next has to know where the pointer already is.
    if (mouseAsleep && !wakeMeter.moved(event.clientX, event.clientY, performance.now())) return;
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

  // Every OTHER thing a pointer can do, switched off in one place for as long as the mouse is asleep.
  //
  // Asleep means the mouse is OUT of the UI, not merely invisible: clicks, the wheel, right-click-as-back,
  // the hover reads on every surface. Gating each of those where it lives would be a list to keep in sync,
  // and one forgotten entry is a stutter nobody can reproduce — which is exactly how a resting cursor kept
  // stealing the popup's focus. So the gestures die here, in the capture phase on window, before any
  // surface sees them. Moves are the deliberate exception: they are the way back (see above).
  //
  // Two things still get through. Untrusted events, because a synthetic .click() is our own code driving
  // the UI rather than a mouse (file-picker.ts does that). And touch: a finger on the Deck's screen is a
  // poke at one specific thing, never a pointer drifting under a resting hand, so it wakes the mouse and
  // proceeds — the click Chromium synthesises after it then lands on a UI that is already awake.
  const SLEPT_THROUGH: readonly string[] = [
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'wheel',
    'mousedown',
    'mouseup',
    'mouseover',
    'mouseout',
    'mouseenter',
    'mouseleave',
    'pointerdown',
    'pointerup',
    'pointerover',
    'pointerout',
    'pointerenter',
    'pointerleave',
  ];
  SLEPT_THROUGH.forEach((type) => {
    window.addEventListener(
      type,
      (event) => {
        if (!mouseAsleep || !event.isTrusted) return;
        if (event instanceof PointerEvent && event.pointerType === 'touch') {
          noteMouseActivity();
          return;
        }
        event.stopImmediatePropagation();
        // Not merely "don't route it": the default has to go too, or a sleeping wheel still scrolls the
        // list under the cursor and a sleeping middle-click still opens Chromium's autoscroll.
        if (event.cancelable) event.preventDefault();
      },
      { capture: true, passive: false },
    );
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
  const stripActive = (): boolean => onCarousel();

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

  /**
   * Everything that ends when the input is let go: the flip spell, and the `limit` latch — a series of
   * blocked attempts ends on release, so the next dead end sounds again (see sfx-limit.ts). Both halves
   * of the release detection (the pad's onDirectionsReleased, the keyboard's keyup) come through here.
   */
  function endInput(): void {
    endFlip();
    audio.rearmLimit();
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
      const moved = deps.carousel.move(-1);
      if (!repeat && moved === 'at-end') audio.playLimit();
      return;
    }
    moveFocus(-1, repeat);
  }
  function navRight(repeat = false): void {
    noteGamepadActivity();
    if (repeat) noteFlip();
    // Same early branch as navLeft — `repeat` is irrelevant here: a held right is exactly what a slider
    // wants, one step per repeat, and the screen has no "at the end, hand the focus over" rule.
    const overlay = popupView === 'none' ? overlays.active() : null;
    if (overlay !== null) {
      overlay.navRight(repeat);
      return;
    }
    if (stripActive()) {
      // The row ends at the last launcher card and there is nothing beyond it: a stop is a dead end and
      // says so. A HELD right stays silent — one gesture running down a long history must not end in a
      // sound. `locked` is the return-morph, where nothing happens at all.
      if (deps.carousel.move(1) === 'at-end' && !repeat) audio.playLimit();
      return;
    }
    if (popupView === 'none') moveFocus(1, repeat);
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
      overlay.navUp(repeat);
      return;
    }
    // Nothing sits above the bar on the detail screen, so up leaves it: the strip the game was picked
    // from is literally where it came from, and it re-enters exactly there. Held (repeat) presses are
    // dropped — one hold must not walk out of the screen the moment the user pauses on it. Only when no
    // popup is up: there the direction belongs to the menu, which is handled above.
    if (repeat) return;
    if (deps.carousel.leaveDetail()) audio.play('back');
    else audio.playLimit(); // on the strip there is nothing above the cards to step up to
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
      overlay.navDown(repeat);
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
      // The strip is the top level and the only surface on this screen: there is nothing above home to go
      // back to, and nowhere else to hand the focus, so B is an honest dead end here.
      audio.playLimit();
      return;
    }
    if (deps.carousel.leaveDetail()) audio.play('back');
  }

  /**
   * Y belongs to the OVERLAYS alone (the keyboard's Shift). It used to hand the focus to the More button —
   * on the carousel, where More no longer exists, and on a detail screen, where left/right already walk
   * between Play and More. Everywhere else it is an honest dead end.
   */
  function navY(): void {
    noteGamepadActivity();
    const overlay = overlays.active();
    if (overlay !== null) {
      if (overlay.navTertiary === undefined) audio.playLimit();
      else overlay.navTertiary();
      return;
    }
    audio.playLimit();
  }

  /**
   * X and the shoulders: overlay-only, and only when the surface on top claims them. Everywhere else the
   * button has no meaning here — the carousel, a detail screen, the popup — and the honest answer to that
   * is the dead-end sound, not silence. Routed in ONE place, so a surface that never claims them (and any
   * added later) is covered without a stub of its own; the NavSurface contract stays "unclaimed means
   * unchanged" (nav-surface.ts).
   */
  function navSecondary(repeat = false): void {
    const claimed = popupView === 'none' && overlays.active()?.navSecondary !== undefined;
    if (!claimed) {
      if (!repeat) audio.playLimit();
      return;
    }
    overlays.active()?.navSecondary?.(repeat);
  }

  function navShoulder(direction: -1 | 1): void {
    const claimed = popupView === 'none' && overlays.active()?.navShoulder !== undefined;
    if (!claimed) {
      audio.playLimit();
      return;
    }
    overlays.active()?.navShoulder?.(direction);
  }

  function navCommit(): void {
    const claimed = popupView === 'none' && overlays.active()?.navCommit !== undefined;
    if (!claimed) {
      audio.playLimit();
      return;
    }
    overlays.active()?.navCommit?.();
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
      if (deps.isBooting()) return; // the row is behind the boot screen — see whileAwake
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
    if (deps.isBooting()) return; // the same fence the pad and the keyboard sit behind (see whileAwake)
    navBack();
    // AFTER, not before: navBack() is written for the gamepad and hides the cursor as its first act.
    // This click IS the mouse, so the cursor has to come back — and it is this call that restores it.
    noteMouseActivity();
  });

  /**
   * Wraps a primitive so it does nothing while the boot screen is up (see ControlsDeps.isBooting). Applied
   * at the two DISPATCH points — the pad's handler map and the keyboard's keydown — rather than inside
   * each primitive, so a surface added later is covered by construction. The mouse is fenced off in CSS
   * (`#app[data-boot]` is pointer-events:none), and the wheel / right-click, which listen on the window
   * and never touch that rule, check the flag themselves.
   */
  function whileAwake<A extends readonly unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A): void => {
      if (deps.isBooting()) return;
      fn(...args);
    };
  }

  const gamepad = createGamepadController(
    {
      onLeft: whileAwake(navLeft),
      onRight: whileAwake(navRight),
      onUp: whileAwake(navUp),
      onDown: whileAwake(navDown),
      onA: whileAwake(navActivate),
      onB: whileAwake(navBack),
      onY: whileAwake(navY),
      onX: whileAwake(navSecondary),
      onShoulderLeft: whileAwake(() => navShoulder(-1)),
      onShoulderRight: whileAwake(() => navShoulder(1)),
      onTriggerRight: whileAwake(navCommit),
      // NOT gated: a direction held across the reveal must still be able to end its run — this only tidies
      // the flip spell and re-arms the `limit` latch, it drives nothing.
      onDirectionsReleased: endInput,
    },
    autoRepeat,
  );

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
  // stack is dropped by navUp/navDown themselves). The repeat is OURS, on a timer — the OS supplies its
  // own, but at a rate and an initial delay that are the user's system settings, not ours, so the two
  // input models would drift apart (and chaining one run into the next would be impossible: the OS
  // restarts its full delay on every new key). Native repeats are dropped. Every other key stays one
  // action per press.
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
  // The key whose repeat is running, and its timer. Only one at a time: with two directions down the
  // last one pressed owns the run, which is what a keyboard's own repeat does too.
  let heldKey: string | null = null;
  let keyRepeatTimer = 0;

  function stopKeyRepeat(): void {
    if (keyRepeatTimer !== 0) {
      window.clearTimeout(keyRepeatTimer);
      keyRepeatTimer = 0;
    }
    heldKey = null;
  }

  function scheduleKeyRepeat(key: string, handler: (repeat: boolean) => void, delay: number): void {
    keyRepeatTimer = window.setTimeout(() => {
      keyRepeatTimer = 0;
      if (heldKey !== key) return;
      autoRepeat.noteRepeat(performance.now());
      handler(true);
      scheduleKeyRepeat(key, handler, NAV_REPEAT_MS);
    }, delay);
  }

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const handler = KEY_NAV[key];
    if (handler === undefined) return;
    event.preventDefault(); // suppress the native default even on auto-repeat (e.g. Tab traversal)
    if (event.repeat) return; // the OS cadence is not ours — the timer below drives the run
    // The boot fence, as a full return rather than a gated call (see whileAwake): the repeat timer armed
    // below outlives the boot screen, so a direction merely GATED here would come back to life the moment
    // the UI appeared and flip the row for a press made before it existed.
    if (deps.isBooting()) return;
    handler(false);
    if (!REPEATABLE_KEYS.has(key)) return;
    stopKeyRepeat(); // a second direction takes the run over from the first
    heldKey = key;
    // A key taken up while the previous run is still warm continues it, delay skipped — same rule as the
    // pad's (auto-repeat.ts), so swinging left→right glides on either device.
    const now = performance.now();
    scheduleKeyRepeat(key, handler, autoRepeat.continues(now) ? NAV_REPEAT_MS : HOLD_DELAY_MS);
  });
  // The keyboard's half of "the hold is over". A keyup can be missed (the window loses focus mid-hold and
  // the release goes to whoever took it), which is what the watchdog in noteFlip covers — and the blur
  // below, which also has to stop a timer nobody would otherwise turn off.
  window.addEventListener('keyup', (event) => {
    const key = event.key.toLowerCase();
    if (heldKey === key) stopKeyRepeat();
    if (REPEATABLE_KEYS.has(key)) endInput();
  });
  window.addEventListener('blur', () => {
    if (heldKey === null) return;
    stopKeyRepeat();
    endInput();
  });

  function applyGameButtons(): void {
    // The game-dependent Details items: the Install/Uninstall toggle and the running-only Force close.
    // Refreshed every render so they stay correct if the game state changes while Details is open (a
    // running→syncing-out self-exit must drop Force close; a ready→ready update doesn't close the popup).
    applyMenuInstallToggle();
    applyMenuKill();
    applyMenuHome();
    applyMenuCustomize();
    applyMenuMoveToCard();
    applyMenuForget();
  }

  function clearGameButtons(): void {
    if (menuFrozen()) return;
    // No game → no Install/Uninstall item and no Force close (the popup is force-closed off the ready
    // screen anyway; no-game is never `running`).
    menuInstallToggle.classList.add('is-hidden');
    menuKill.classList.add('is-hidden');
    menuCustomize.classList.add('is-hidden'); // no game on screen → no manifest to customize
    menuMoveToCard.classList.add('is-hidden'); // no game on screen → nothing to move
    menuForget.classList.add('is-hidden'); // no game on screen → nothing to remove from the history
    applyMenuHome(); // the carousel can still be there with no game on screen (history only)
  }

  function refresh(): void {
    // The popup lives on both screens (on the carousel it is what a launcher card opens). Only a
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
            : kind === 'delete-history'
              ? 'delete-game-history'
              : kind === 'switch-source'
                ? 'switch-game-source'
                : kind === 'cancel-move'
                  ? 'cancel-move-game-settings'
                  : 'discard-game-settings',
      ),
    openSystemCard,
    openAddGame,
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
    applyNotifications: () => {
      applyUnreadDot();
      if (popupView === 'notifications') renderNotificationList();
    },
    isPopupOpen: () => popupView !== 'none',
  };
}
