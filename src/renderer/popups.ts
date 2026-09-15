// The popup column, split out of controls.ts: one #popup element whose content + action stack switch
// by data-view — Details (a game's menu) / Notifications / Power / Confirm / Busy / Error — and the
// vertical focus group inside it. Navigation is up/down inside a stack; the default focus is always the
// BOTTOM button (Close / No / Sleep), which the mockup draws filled. B/Esc/veil/left step BACK one level.
//
// It is a surface like the screens (NavSurface): controls.ts routes the six primitives into it whenever
// it is open, before any screen, and asks it for everything the popup says or does. The bar's own focus
// (Play / More) stays in controls.ts — the popup only tells it when to repaint (`onFocusChanged`).
import type {
  AppNotification,
  AppState,
  BrowseInfo,
  GameCollision,
  GameInfo,
} from '../shared/types.js';
import type { Locale, MessageKey, Translator } from '../shared/i18n/index.js';
import type { AudioController } from './audio.js';
import {
  describeConfirm,
  runConfirmedAction,
  type ConfirmMode,
  type ConfirmReturnTo,
} from './confirm.js';
import type {
  CarouselNav,
  ControlsApi,
  GameSettingsNav,
  LibraryNav,
  SettingsNav,
} from './controls-deps.js';
import { createDetailsMenu } from './details-menu.js';
import { pressFlash, req, reqQuery } from './dom.js';
import { formatNotification, formatNotificationTime } from './format.js';
import type { HoverGuard } from './hover-guard.js';
import type { NavSurface } from './nav-surface.js';
import { createScroller } from './screen-scroller.js';
import type { SystemCardId } from './system-cards.js';

// The current popup view (mutually exclusive; 'none' = closed). Mirrors the data-view on #popup.
type PopupView = 'none' | 'details' | 'notifications' | 'power' | 'confirm' | 'busy' | 'error';
/** How long the popup takes to fade out (.popup transition in styles.css) — the window its contents
 *  must stay frozen for, so the user never watches the menu rewrite itself on the way out. */
const POPUP_FADE_MS = 350;

/** The Customize screen's questions, as controls.ts hands them over (see GameSettingsConfirm). */
export type GameSettingsQuestion =
  | 'reset'
  | 'delete'
  | 'delete-history'
  | 'discard'
  | 'switch-source'
  | 'cancel-move'
  | 'replace-title';

export interface PopupsDeps {
  readonly api: ControlsApi;
  readonly audio: AudioController;
  getState(): AppState;
  getBrowse(): BrowseInfo | null;
  getTranslator(): Translator;
  getLocale(): Locale;
  getNotifications(): readonly AppNotification[];
  readonly carousel: Pick<CarouselNav, 'screen' | 'leaveDetail' | 'setUnread'>;
  readonly settings: SettingsNav;
  readonly gameSettings: GameSettingsNav;
  readonly library: LibraryNav;
  /** The shared hover guard: every view change lays a new stack under the pointer (see setView). */
  readonly hover: Pick<HoverGuard, 'arm'>;
  /**
   * The GameInfo of what is on screen, and whether the launch/uninstall actions apply to it — the two
   * screen decisions controls.ts derives from the state and the browse model (see there).
   */
  screenGame(): GameInfo | undefined;
  screenIsActionable(): boolean;
  /** Opens a game's detail screen (a notification about a game leads there). Owned by app.ts. */
  openGameDetail(id: string): void;
  /** The popup finished closing. The toast shares this corner and holds its queue while it is up. */
  onPopupClosed(): void;
  /** The bar highlight has to be repainted: a popup opened over it, closed under it, or a screen opened. */
  onFocusChanged(): void;
}

export interface Popups extends NavSurface {
  /** Details (from More): the game's menu on a detail screen, the launcher's on the empty screen. */
  openDetails(): void;
  /** One of the carousel's launcher cards was pressed — see the switch inside. */
  openSystemCard(id: SystemCardId): void;
  /** The Settings screen asked to reset — the shared confirm popup (No returns to Settings). */
  confirmResetSettings(): void;
  /** The Customize screen asked one of its questions — the same shared confirm popup. */
  confirmGameSettings(kind: GameSettingsQuestion, options?: { readonly title?: string }): void;
  /** main found the same game on the card and on this PC: asks what should happen to it (queued while busy). */
  askGameCollision(collision: GameCollision): void;
  /** Work in progress: a message and a Stop. `closeBusy` takes it away when the work answers. */
  showBusy(message: string, onStop: () => void): void;
  closeBusy(): void;
  /** The error popup (a failed launch/action from main). A single Close button. */
  showError(message: string): void;
  /** Whether this is a Game Mode session — drops "Minimize Playhook" from the power menu. */
  setGameMode(gameMode: boolean): void;
  /** Refreshes the game-dependent Details items from the current state. */
  applyGameButtons(): void;
  /** Clears them for the idle/no-game screen. */
  clearGameButtons(): void;
  /** A fresh inbox arrived: repaint the card's dot and, if the list is up, the list. */
  applyNotifications(): void;
  /** Per-render: drop a game-specific confirm the card left void, then re-apply the items and the stack focus. */
  refresh(): void;
  /** The pointer moved over `target`: the stack is the only thing hover may move while a popup is up. */
  hover(target: Element | null): void;
}

export function createPopups(deps: PopupsDeps): Popups {
  const { audio } = deps;
  const t = (): Translator => deps.getTranslator();
  const screenGame = (): GameInfo | undefined => deps.screenGame();
  const screenIsActionable = (): boolean => deps.screenIsActionable();
  // SteamOS Game Mode (gamescope): no tray, so the power menu's primary item quits instead of minimizing.
  // Seeded once at startup (setGameMode); false until then — the power menu isn't reachable that early.
  let gameMode = false;
  const menuItems = createDetailsMenu({
    getState: () => deps.getState(),
    getBrowse: () => deps.getBrowse(),
    getTranslator: () => deps.getTranslator(),
    carousel: deps.carousel,
    screenGame,
    screenIsActionable,
    isFrozen: () => menuFrozen(),
  });

  // The single popup + its veil, plus the content fields set from JS.
  const popup = req('popup');
  const popupVeil = reqQuery<HTMLElement>('#popup .popup-veil');
  const confirmMessage = req('confirm-message');
  /** The game name the "replace the title?" question quotes — set by whoever asks it. */
  let confirmTitle = '';
  /** What the busy view's Stop does, and how the surface that started the work hears about it. */
  let busyStop: (() => void) | null = null;
  const confirmPath = req('confirm-path');
  const errorMessageEl = req('error-message');
  const busyMessageEl = req('busy-message');
  const deleteNote = req('delete-note');

  // Action-stack buttons (grouped by view in the HTML).
  const menuInstallToggle = req<HTMLButtonElement>('menu-install-toggle');
  const menuKill = req<HTMLButtonElement>('menu-kill');
  const menuHome = req<HTMLButtonElement>('menu-home');
  const menuCustomize = req<HTMLButtonElement>('menu-customize');
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
  const busyStopButton = req<HTMLButtonElement>('busy-stop');

  let popupView: PopupView = 'none';
  // The notification entries currently in the DOM. They are recreated on every snapshot, so — unlike
  // ALL_STACK_BUTTONS — they cannot be wired or highlighted once at startup; see the click delegation
  // below and applyStackFocus.
  let notificationButtons: readonly HTMLButtonElement[] = [];
  let confirmMode: ConfirmMode = 'uninstall';
  let confirmReturnTo: ConfirmReturnTo = 'details';
  // How the CURRENT popup was entered: through the Details menu, or straight from a launcher card. It
  // decides what B does in the Power / Notifications views — stepping back into a menu that was never
  // opened would conjure a game's menu over the carousel.
  let popupRoot: 'details' | 'direct' = 'details';
  /** The game the open remove-from-history confirm is about — captured when it opens (see openConfirm). */
  let forgetId: string | null = null;
  /** The collision the open question is about, and the one waiting for the popup to free up. */
  let askedCollision: GameCollision | null = null;
  let queuedCollision: GameCollision | null = null;

  // ── Popup machine ────────────────────────────────────────────────────────────
  // One #popup element; opening = add .is-open + set data-view; switching views keeps .is-open (so the
  // shared veil never cross-fades). Closing removes .is-open.

  function setView(view: Exclude<PopupView, 'none'>): void {
    // Every view change lays a new stack under the pointer — hover must not claim the focus the view
    // itself just set (see the mousemove handler).
    deps.hover.arm();
    // Only the FIRST view is an opening; switching views keeps the popup on screen and keeps the
    // button/back sounds the callers already play.
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
      menuItems.applyGameButtons();
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
    // where the destination's own popup-open is the single sound of that gesture.
    if (options?.silent !== true) audio.play('popup-close');
    popupView = 'none';
    popup.classList.remove('is-open');
    popup.setAttribute('aria-hidden', 'true');
    // The toast lives in the corner this column is fading out of, so it is released only once the fade
    // is over — otherwise a plate would fade IN over a popup still fading OUT, in the same 20 pixels.
    window.setTimeout(() => deps.onPopupClosed(), POPUP_FADE_MS);
    freezeMenuDuringFade();
    applyStackFocus(); // clear the stack highlight (stackActive becomes false)
    deps.onFocusChanged(); // restore the main bar highlight
    flushQueuedCollision();
  }

  /** Raises a collision question that arrived while the column was busy, once it is free again. */
  function flushQueuedCollision(): void {
    const waiting = queuedCollision;
    if (waiting === null || popupView !== 'none') return;
    if (deps.gameSettings.isOpen() || deps.settings.isOpen()) return;
    queuedCollision = null;
    askedCollision = waiting;
    // After the fade, or the question would open into a column still fading the previous one out.
    window.setTimeout(() => {
      if (popupView !== 'none' || askedCollision === null) return;
      openConfirm('game-collision');
    }, POPUP_FADE_MS);
  }

  // Details menu (from More): game stats on top + Shutdown / Install|Uninstall / Close stack. Works on
  // every screen — on the empty (no-card) screen there are no stats and no Install/Uninstall, so it
  // degrades to just System + Close.
  function openDetails(): void {
    thawMenu(); // a re-open inside the fade window must show the CURRENT items, not the frozen ones
    menuItems.applyGameButtons(); // keep every game-dependent item fresh for the current game
    popupRoot = 'details';
    setView('details');
    focusStackBottom(); // default focus: Close
    deps.onFocusChanged(); // main highlight clears (focusActive false with a popup open)
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
    deps.api.markNotificationsRead();
    setView('notifications');
    renderNotificationList();
    focusStackBottom(); // default focus: Close, as in every other view
    deps.onFocusChanged();
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
    deps.api.dismissNotification(id);
    // Muted when the entry leads to Settings — that screen's popup-open is the sound of the whole
    // gesture. With nowhere to go, the popup simply closes and says so.
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
      item.kind === 'game-move-duplicate' ||
      item.kind === 'history-config-applied' ||
      item.kind === 'history-config-discarded' ||
      item.kind === 'settings-write-failed'
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
    deps.onFocusChanged();
  }

  // Power submenu (from a launcher card, or from Details → System on a game screen): Shutdown / Reboot /
  // Sleep. Each opens a Yes/No confirm.
  function openPower(): void {
    setView('power');
    focusStackBottom(); // default focus: Close (bottom) — a safe non-destructive default
    deps.onFocusChanged();
  }

  // Confirm view — install/uninstall (from Details) or a power action (from Power). Yes runs the action
  // and closes the whole stack; No/back returns to where it came from.
  function openConfirm(mode: ConfirmMode): void {
    const copy = describeConfirm(
      mode,
      {
        game: screenIsActionable() ? screenGame() : undefined,
        browse: deps.getBrowse(),
        collision: askedCollision,
        deletesLocalGame: () => deps.gameSettings.deletesLocalGame(),
        title: confirmTitle,
      },
      t(),
    );
    if (copy === null) return;
    confirmReturnTo = copy.returnTo;
    popup.dataset['mode'] = mode; // 'install' shows the note (card install only, see styles.css)
    if (copy.installVia === null) delete popup.dataset['installVia'];
    else popup.dataset['installVia'] = copy.installVia;
    if (copy.uninstallVia !== undefined) {
      if (copy.uninstallVia === null) delete popup.dataset['uninstallVia'];
      else popup.dataset['uninstallVia'] = copy.uninstallVia;
    }
    confirmMessage.textContent = copy.message;
    if (copy.path !== undefined) confirmPath.textContent = copy.path;
    if (copy.note !== undefined) deleteNote.textContent = copy.note;
    if (copy.forgetId !== undefined) forgetId = copy.forgetId;
    confirmMode = mode;
    setView('confirm');
    focusStackBottom(); // default focus: No (safe default)
    deps.onFocusChanged();
  }

  /**
   * Work in progress — a message and a Stop, in the same column everything else speaks through. Opened
   * by a surface that started something long (a download that becomes a file beside a game) and closed
   * by that same surface when the work answers, so nothing is left standing over a finished job.
   */
  function openBusy(message: string, onStop: () => void): void {
    busyMessageEl.textContent = message;
    busyStop = onStop;
    setView('busy');
    focusStackBottom(); // the sole button (Stop)
    deps.onFocusChanged();
  }

  function stopBusy(): void {
    const stop = busyStop;
    busyStop = null;
    closePopup();
    stop?.();
  }

  // Error popup — opened by main via showError (a failed launch/action). A single Close button.
  function openError(messageText: string): void {
    errorMessageEl.textContent = messageText;
    setView('error');
    focusStackBottom(); // the sole button (Close)
    deps.onFocusChanged();
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
      case 'busy':
        // B on work in progress means Stop: there is nothing else this view can answer.
        stopBusy();
        break;
      case 'details':
      case 'error':
        closePopup();
        break;
      default:
        break;
    }
  }

  function openSettings(sectionKey?: MessageKey, options?: { readonly silent?: boolean }): void {
    deps.settings.open(sectionKey, options);
    deps.onFocusChanged(); // the bar highlight clears (focusActive is false with the screen open)
  }

  function openCustomize(): void {
    const browse = deps.getBrowse();
    if (browse === null) return;
    // The item's own rule, re-checked at the press — and it decides WHICH screen opens: an available
    // game is edited on its card, a history one through the stored snapshot.
    if (browse.active) deps.gameSettings.open(browse.id);
    else if (browse.configurable === true) deps.gameSettings.openFromHistory(browse.id);
    else return;
    deps.onFocusChanged();
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
    busyStopButton,
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
      case 'busy':
        return [busyStopButton];
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
    else if (popupView === 'notifications') {
      // Clear all / Close live BELOW the scrolling list, not inside it, so they need no revealing of
      // their own — but the list does. Left where it was, it keeps showing the top entries while the
      // focus has moved past their end, and the highlight travels across a stretch of list that has
      // nothing to do with where it is going. Sending the list to its last entry keeps the two together.
      const last = notificationButtons[notificationButtons.length - 1];
      if (last !== undefined) notificationScroller.reveal(last);
    } else if (popupView === 'details') menuStackScroller.reveal(focused);
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
      deps.api.clearNotifications();
    } else if (btn === menuCustomize) {
      // Like Settings: the menu it was opened from closes first — the screen is a surface of its own.
      closePopup({ silent: true });
      openCustomize();
    } else if (btn === menuHome) {
      // Non-destructive, so no confirm: close the popup and hand control back to the strip.
      closePopup();
      deps.carousel.leaveDetail();
    } else if (btn === busyStopButton) {
      // Stop: the surface that started the work is told, and the popup goes with it.
      audio.play('back');
      stopBusy();
    } else if (
      btn === menuClose ||
      btn === errorClose ||
      btn === powerClose ||
      btn === notificationsClose
    ) {
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
      deps.api.requestHide();
    } else if (btn === powerQuit) {
      // The full quit. No confirm either: it is as recoverable as relaunching from the Steam library —
      // and in Game Mode this is the only way out, so a confirm would sit between the user and the exit
      // every single time.
      closePopup();
      deps.api.requestQuit();
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
      // "Leave them as they are" is an ANSWER to the collision question, and it is remembered — so the
      // launcher stops asking about a game the user has already decided about.
      if (popupView === 'confirm' && confirmMode === 'game-collision') {
        audio.play('button');
        closePopup();
        answerCollision('ignore');
        return;
      }
      back(); // cancel → returns to Details / Power
    }
  }

  /**
   * Sends the answer and, if it failed, says why. A failure means the card is no longer the one the
   * question was asked about (pulled, or swapped for another carrying the same id) — nothing was written
   * and nothing was remembered, so the question honestly returns on the next insertion.
   */
  function answerCollision(choice: 'merge' | 'ignore'): void {
    const collision = askedCollision;
    askedCollision = null;
    if (collision === null) return;
    void deps.api
      .resolveGameCollision({
        id: collision.id,
        choice,
        root: collision.root,
        signature: collision.signature,
      })
      .then((result) => {
        if (!result.saved) openError(result.message);
      });
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
    runConfirmedAction(mode, {
      api: deps.api,
      audio,
      settings: deps.settings,
      gameSettings: deps.gameSettings,
      takeForgetId: () => {
        const id = forgetId;
        forgetId = null;
        return id;
      },
      mergeCollision: () => answerCollision('merge'),
    });
  }

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

  return {
    isOpen: () => popupView !== 'none',
    navUp: () => moveStackFocus(-1),
    navDown: () => moveStackFocus(1),
    // Left is "out" of a popup, the same step B takes: the stacks live on the right edge of the screen,
    // so moving left off them means leaving. A HELD left is ignored: at the repeat cadence it would walk
    // out through every level and land on the carousel, flipping cards nobody asked to flip.
    navLeft: (repeat = false) => {
      if (!repeat) back();
    },
    navRight: () => undefined, // a stack is vertical — right leads nowhere, and silently so (as before)
    navActivate: activateStack,
    navBack: back,
    // Nobody calls this yet (app.ts re-localizes the screens); the inbox is the one view with labels.
    relocalize: () => {
      if (popupView === 'notifications') renderNotificationList();
    },
    openDetails,
    openSystemCard,
    confirmResetSettings: () => openConfirm('reset-settings'),
    confirmGameSettings: (kind, options) => {
      confirmTitle = options?.title ?? '';
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
                  : kind === 'replace-title'
                    ? 'replace-game-title'
                    : 'discard-game-settings',
      );
    },
    askGameCollision: (collision) => {
      // One at a time, and never over something the user is in the middle of: a confirm, the Customize
      // screen's own question, the power menu. It is picked up the moment the surface clears.
      if (popupView !== 'none' || deps.gameSettings.isOpen() || deps.settings.isOpen()) {
        queuedCollision = collision;
        return;
      }
      askedCollision = collision;
      openConfirm('game-collision');
    },
    showBusy: openBusy,
    closeBusy: () => {
      if (popupView !== 'busy') return;
      busyStop = null;
      closePopup();
    },
    showError: openError,
    setGameMode: (value) => {
      gameMode = value;
      menuItems.applyPowerItems(gameMode);
    },
    applyGameButtons: () => menuItems.applyGameButtons(),
    clearGameButtons: () => menuItems.clearGameButtons(),
    applyNotifications: () => {
      applyUnreadDot();
      if (popupView === 'notifications') renderNotificationList();
    },
    refresh: () => {
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
      menuItems.applyPowerItems(gameMode);
      applyStackFocus();
    },
    hover: (element) => {
      const button = element?.closest<HTMLButtonElement>('.text-button') ?? null;
      if (button === null) return;
      const idx = stackFocusables().indexOf(button);
      if (idx === -1 || idx === stackIndex) return;
      stackIndex = idx;
      applyStackFocus();
    },
  };
}
