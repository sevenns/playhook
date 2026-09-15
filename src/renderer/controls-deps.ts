// The seams of the interaction layer (controls.ts): what it sends to main, and what it needs from the
// rest of the renderer — the app state, the audio controller and the surfaces it routes the six
// primitives into. Types only, kept apart from the controller so a test can build the deps without it.
import type {
  AppNotification,
  AppState,
  BrowseInfo,
  ConfigSaveResult,
  GameCollisionAnswer,
} from '../shared/types.js';
import type { Locale, MessageKey, Translator } from '../shared/i18n/index.js';
import type { AudioController } from './audio.js';
import type { MoveResult } from './carousel.js';
import type { NavSurface } from './nav-surface.js';

/**
 * What this module sends to main. A seam, so app.ts owns the `window.api` wiring and a DOM test can fake
 * it — the same shape `SettingsScreenApi` and `GameSettingsScreenApi` take.
 */
export interface ControlsApi {
  /** Play / the install confirm's Yes — main decides install vs launch from `requiresInstall`. */
  requestLaunch(): void;
  requestUninstall(): void;
  requestKill(): void;
  /** Drops a history game's record — the id is captured when the confirm opens (see openConfirm). */
  forgetGame(id: string): void;
  /** The gear on a Steam download: opens Steam's own Downloads page, the only pause/resume there is. */
  openSteamDownloads(): void;
  requestShutdown(): void;
  requestReboot(): void;
  requestSleep(): void;
  /** "Minimize Playhook" — hide to the tray. */
  requestHide(): void;
  /** "Close Playhook" — the full quit. */
  requestQuit(): void;
  /** The answer to a card-vs-PC collision question; fails when the card is no longer the one asked about. */
  resolveGameCollision(answer: GameCollisionAnswer): Promise<ConfigSaveResult>;
  /** Opening the inbox IS reading it. */
  markNotificationsRead(): void;
  /** Pressing an entry removes it. */
  dismissNotification(id: string): void;
  clearNotifications(): void;
}

/** What the interaction layer needs from the rest of the renderer. */
export interface ControlsDeps {
  readonly api: ControlsApi;
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
  open(id: string): void;
  /** Opens the same screen for a game whose card is not in — see GameSettingsScreen.openFromHistory. */
  openFromHistory(id: string): void;
  /** Opens the same screen to CREATE a game — the "Add game" item of the Details menu. */
  openNew(): void;
  close(): void;
  /** Whether there are unsaved edits — decides whether leaving asks first. */
  isDirty(): boolean;
  /** Whether the game about to be deleted is a LOCAL one, whose save backups survive the deletion. */
  deletesLocalGame(): boolean;
  /** The shared confirm popup said yes to one of the screen's questions. */
  confirmAccepted(
    kind:
      | 'reset'
      | 'delete'
      | 'delete-history'
      | 'discard'
      | 'switch-source'
      | 'cancel-move'
      | 'replace-title',
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
  /**
   * Whether the strip is standing on a GAME rather than one of the launcher's own cards. Down opens a
   * game and nothing else, so it has to ask before acting (see navDown).
   */
  onGame(): boolean;
  /** Steps back from a detail screen to the strip; false when the strip is already the screen. */
  leaveDetail(): boolean;
  /** Whether the inbox holds anything unread — the Notifications CARD wears the dot now. */
  setUnread(unread: boolean): void;
}
