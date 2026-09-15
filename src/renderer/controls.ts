// Interaction layer (split out of app.ts): the router of the six navigation primitives. It owns the
// main bar's focus group (Play / More) and the user actions on it, decides which surface the primitives
// drive — the popup column (popups.ts), an open screen, the carousel strip, or the bar — and wires the
// input models to that routing: the gamepad controller (gamepad.ts), the keyboard (keyboard.ts), mouse
// hover and clicks, the wheel, right-click-as-back. The idle countdown and the mouse's sleep live in
// idle.ts. It reaches back into app.ts only through the narrow `deps` seam (controls-deps.ts); app.ts
// drives it via applyGameButtons/clearGameButtons/refresh/showError and starts it with start().
import type { AppState, GameInfo } from '../shared/types.js';
import type { Translator } from '../shared/i18n/index.js';
import { NAV_REPEAT_MS, createAutoRepeatChain } from './auto-repeat.js';
import { createGamepadController } from './gamepad.js';
import { createKeyboardController } from './keyboard.js';
import { createIdleGuard } from './idle.js';
import { createPopups } from './popups.js';
import { createHoverGuard } from './hover-guard.js';
import type { NavSurface } from './nav-surface.js';
import type { SystemCardId } from './system-cards.js';
import { gameOf, phaseOf, steamBusy } from './state-view.js';
import { pressFlash, req } from './dom.js';
import type { GameCollision } from '../shared/types.js';
import type { ControlsDeps } from './controls-deps.js';

export interface Controls {
  /** Refreshes the game-dependent menu item (Install/Uninstall text + visibility) from the current state. */
  applyGameButtons(): void;
  /** The Settings screen closed itself — restore the bar highlight on the More button it came from. */
  settingsClosed(): void;
  /** The Settings screen asked to reset — opens the shared confirm popup (No returns to Settings). */
  confirmResetSettings(): void;
  /** The Customize screen asked one of its questions — opens the same shared confirm popup. */
  confirmGameSettings(
    kind:
      | 'reset'
      | 'delete'
      | 'delete-history'
      | 'discard'
      | 'switch-source'
      | 'cancel-move'
      | 'replace-title',
    options?: { readonly title?: string },
  ): void;
  /**
   * Work in progress, in the same column: a message and a Stop. `closeBusy` takes it away when the work
   * answers — a progress popup nobody dismissed must not outlive the thing it describes.
   */
  showBusy(message: string, onStop: () => void): void;
  closeBusy(): void;
  /**
   * Opens the surface one of the carousel's launcher cards stands for. The card plays the press sound
   * itself (app.ts), so nothing here does — the surface's own popup-open follows it.
   */
  openSystemCard(id: SystemCardId): void;
  /** "Add game", from the Library's column — the launcher's only route to creating a game. */
  openAddGame(): void;
  /** Clears the game-dependent menu item for the idle/no-game screen. */
  clearGameButtons(): void;
  /**
   * main found the same game on the card and on this PC: asks what should happen to it. Waits for the
   * popup to free up rather than clobbering whatever is on screen — the question is not urgent, and the
   * card it is about is already loaded.
   */
  askGameCollision(collision: GameCollision): void;
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
  // Where the pointer was when hover was last disarmed — by a surface opening under it, or by a
  // keyboard/gamepad step. Until the mouse travels far enough from there, hover does not move the focus:
  // an element arriving under a still cursor is the ELEMENT moving, not the mouse, and Chromium reports
  // both the same way (hover-guard.ts).
  const hover = createHoverGuard();
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

  /**
   * The full-screen overlays, as a set rather than as a named one. Every mechanism that has to stand down
   * while a screen is up — the idle timer, the wheel, Y, and all six primitives — asks THESE two
   * questions instead of `settings.isOpen()`, so the next screen is one entry in this list rather than an
   * eleventh edit in every primitive.
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

  // ── Settings screen (the fourth surface) ─────────────────────────────────────
  // Opening/closing lives here because the bar focus does: the screen is entered from More and returns
  // to it. Everything INSIDE the screen belongs to settings-screen.ts.

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
    idle.arm(); // the countdown was suspended while the screen was up
  }

  // ── Main bar focus (gamepad / mouse) ─────────────────────────────────────────

  const ALL_MAIN_BUTTONS: readonly HTMLButtonElement[] = [playButton, moreButton];
  let focusIndex = 0;
  // Whether the bar's focus highlight is "awake". It goes dormant when an active state (install / launch
  // / uninstall / steam) appears, so the highlight doesn't auto-jump onto a button the user didn't pick;
  // it wakes again only on an explicit gamepad move or a mouse hover. `wasActive` tracks the edge.
  let focusRevealed = true;
  let wasActive = false;
  // The popup column (popups.ts): every view of #popup, its vertical stack and what its buttons do.
  const popups = createPopups({
    api: deps.api,
    audio,
    getState: () => deps.getState(),
    getBrowse: () => deps.getBrowse(),
    getTranslator: () => deps.getTranslator(),
    getLocale: () => deps.getLocale(),
    getNotifications: () => deps.getNotifications(),
    carousel: deps.carousel,
    settings: deps.settings,
    gameSettings: deps.gameSettings,
    library: deps.library,
    hover,
    screenGame,
    screenIsActionable,
    openGameDetail: (id) => deps.openGameDetail(id),
    onPopupClosed: () => deps.onPopupClosed(),
    onFocusChanged: () => applyFocus(),
  });

  // Idle timeout, shared by the bar focus and the mouse (idle.ts): after 5s with no input the bar
  // highlight goes dormant AND the mouse falls asleep. Any input restarts the countdown; the gamepad puts
  // the mouse to sleep at once (the user switched to the pad), a shove wakes it back up.
  const idle = createIdleGuard({
    hover,
    isSuspended: () => overlays.isAnyOpen(),
    onIdle: () => {
      if (focusRevealed && focusActive()) {
        focusRevealed = false;
        applyFocus();
      }
    },
  });

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
    if (popups.isOpen()) return false;
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
  // static data-i18n-aria-label, which only re-applies on a language change).
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
      deps.api.openSteamDownloads();
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
    deps.api.requestLaunch();
  }

  function triggerMore(): void {
    popups.openDetails(); // the panel's own popup-open is the sound of this press
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

  // ── Wiring ────────────────────────────────────────────────────────────────

  playButton.addEventListener('click', () => triggerPlay());
  moreButton.addEventListener('click', () => triggerMore());
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
    hover.track(event.clientX, event.clientY);
    // Asleep, a move is not input — it only feeds the meter. Nothing hovers, nothing focuses and the
    // cursor stays hidden until the travel adds up to a shove. The position above is recorded either way:
    // whatever wakes the mouse next has to know where the pointer already is.
    if (!idle.pointerMoved(event.clientX, event.clientY, performance.now())) return;
    if (!hover.awake(event.clientX, event.clientY)) return;
    const element = event.target instanceof Element ? event.target : null;
    // The popup owns the pointer while it is open: its stack is the only thing hover may move.
    if (popups.isOpen()) {
      popups.hover(element);
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
  const onCarousel = (): boolean => !popups.isOpen() && deps.carousel.screen() === 'carousel';
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
    idle.noteGamepadActivity();
    if (repeat) noteFlip();
    // Left is "out" of a popup, the same step B takes: the stacks live on the right edge of the screen,
    // so moving left off them means leaving — the reading the layout already suggests on the carousel
    // (where left walks from the More button back to the strip). Sub-views step up one level rather than
    // closing outright, exactly as B does there. A HELD left is ignored: at the repeat cadence it would
    // walk out through every level and land on the carousel, flipping cards nobody asked to flip.
    if (popups.isOpen()) {
      popups.navLeft(repeat);
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
    idle.noteGamepadActivity();
    if (repeat) noteFlip();
    // Same early branch as navLeft — `repeat` is irrelevant here: a held right is exactly what a slider
    // wants, one step per repeat, and the screen has no "at the end, hand the focus over" rule.
    const overlay = popups.isOpen() ? null : overlays.active();
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
    if (!popups.isOpen()) moveFocus(1, repeat);
  }
  // Vertical hold-to-repeat exists for the Settings LIST, which is long enough to warrant it. The popup
  // stacks are short and cyclic — repeating there would spin them — so a repeat is dropped anywhere else.
  function navUp(repeat = false): void {
    idle.noteGamepadActivity();
    if (repeat) noteFlip();
    if (popups.isOpen()) {
      // Held presses move here like they do in every other vertical list: the notification inbox is a
      // LIST, long enough that stepping it one press at a time is work, and the shorter action stacks
      // follow the same rule so a hold means one thing everywhere. The focus wraps (popups.ts), so
      // there is no edge to stop at — a hold simply keeps going until it is released.
      popups.navUp();
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
    idle.noteGamepadActivity();
    if (repeat) noteFlip();
    if (popups.isOpen()) {
      popups.navDown(); // see navUp — a held direction runs the stack, same as any other list
      return;
    }
    const overlay = overlays.active();
    if (overlay !== null) {
      overlay.navDown(repeat);
      return;
    }
    // The other half of the vertical pair: down opens the selected GAME (what A does), up on the detail
    // screen comes back out. The strip only — with the focus on More, down has no card to open, and
    // inside a popup the direction belongs to the menu (handled above). Held presses are dropped, as
    // everywhere a direction crosses a screen boundary.
    //
    // A launcher card is not opened this way. Down means "go into this game", and the launcher cards are
    // surfaces rather than games — Settings and the Library have their own way in (A), and opening one by
    // brushing the stick downwards is how a flip along the row ends up in a screen nobody asked for.
    if (repeat || !stripActive()) return;
    if (!deps.carousel.onGame()) {
      audio.playLimit();
      return;
    }
    deps.carousel.activate();
  }
  function navActivate(): void {
    idle.noteGamepadActivity();
    if (popups.isOpen()) popups.navActivate();
    else if (overlays.active() !== null) overlays.active()?.navActivate();
    else if (stripActive()) deps.carousel.activate();
    else activateFocused();
  }
  function navBack(): void {
    idle.noteGamepadActivity();
    // Deepest level first: a popup closes, then the bar hands the focus back to the strip, then a detail
    // screen steps back to the carousel. On the strip itself B does nothing — it is the top level.
    if (popups.isOpen()) {
      popups.navBack();
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
    idle.noteGamepadActivity();
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
    const claimed = !popups.isOpen() && overlays.active()?.navSecondary !== undefined;
    if (!claimed) {
      if (!repeat) audio.playLimit();
      return;
    }
    overlays.active()?.navSecondary?.(repeat);
  }

  function navShoulder(direction: -1 | 1): void {
    const claimed = !popups.isOpen() && overlays.active()?.navShoulder !== undefined;
    if (!claimed) {
      audio.playLimit();
      return;
    }
    overlays.active()?.navShoulder?.(direction);
  }

  function navCommit(): void {
    const claimed = !popups.isOpen() && overlays.active()?.navCommit !== undefined;
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
      idle.noteMouseActivity();
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
    idle.noteMouseActivity();
  });

  /**
   * Wraps a primitive so it does nothing while the boot screen is up (see ControlsDeps.isBooting). Applied
   * at the two DISPATCH points — the pad's handler map and the keyboard's keydown — rather than inside
   * each primitive, so a surface added later is covered by construction. The mouse is fenced off in CSS
   * (`#app[data-boot]` is pointer-events:none), and the wheel / right-click, which listen on the window
   * and never touch that rule, check the flag themselves.
   */
  function whileAwake<A extends readonly unknown[]>(
    fn: (...args: A) => void,
  ): (...args: A) => void {
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

  // The keyboard's half of the input model (keyboard.ts): the same primitives, its own hold-to-repeat.
  createKeyboardController(
    {
      onLeft: navLeft,
      onRight: navRight,
      onUp: navUp,
      onDown: navDown,
      onActivate: navActivate,
      onBack: navBack,
      onDirectionsReleased: endInput,
    },
    autoRepeat,
    { isFenced: () => deps.isBooting() },
  );

  function refresh(): void {
    popups.refresh();
    // When an active state (install / launch / uninstall / steam) APPEARS, drop the bar highlight so it
    // doesn't sit on a button the user didn't choose. It wakes again on a gamepad move or a mouse hover.
    const active = phaseOf(state()) === 'busy' || steamBusy(state());
    if (active && !wasActive) focusRevealed = false;
    wasActive = active;
    applyFocus();
    applyPlayAria();
  }

  return {
    applyGameButtons: () => popups.applyGameButtons(),
    clearGameButtons: () => popups.clearGameButtons(),
    settingsClosed,
    confirmResetSettings: () => popups.confirmResetSettings(),
    confirmGameSettings: (kind, options) => popups.confirmGameSettings(kind, options),
    askGameCollision: (collision) => popups.askGameCollision(collision),
    showBusy: (message, onStop) => popups.showBusy(message, onStop),
    closeBusy: () => popups.closeBusy(),
    openSystemCard: (id) => popups.openSystemCard(id),
    openAddGame,
    refresh,
    showError: (message) => popups.showError(message),
    setGameMode: (value: boolean) => popups.setGameMode(value),
    start: () => {
      gamepad.start();
      idle.arm(); // begin the countdown so an untouched launcher hides its cursor (IDLE_MS)
    },
    /** Pause/resume acting on gamepad input (paused while the launcher is backgrounded — a game on top). */
    setGamepadPaused: (paused: boolean) => gamepad.setPaused(paused),
    applyNotifications: () => popups.applyNotifications(),
    isPopupOpen: () => popups.isOpen(),
  };
}
