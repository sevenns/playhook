import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControls, type Controls } from '../../src/renderer/controls';
import type { ControlsApi, ControlsDeps } from '../../src/renderer/controls-deps';
import { req } from '../../src/renderer/dom';
import { createTranslator } from '../../src/shared/i18n/index';
import type { AppState, BrowseInfo, GameInfo } from '../../src/shared/types';
import type { ActivityMap } from '../../src/shared/activity';
import { jobCountOf, screenActivityOf } from '../../src/renderer/state-view';
import { loadFixture } from './helpers/fixture';
import { fakeAudio, fakeKeyboard, type FakeAudio } from './helpers/fakes';
import { installRafHarness } from './helpers/raf';

/** The popup's fade-out (popups.ts POPUP_FADE_MS) — what `onPopupClosed` waits for. */
const POPUP_FADE_MS = 350;

type Overlay = ControlsDeps['settings'] & ControlsDeps['gameSettings'] & ControlsDeps['library'];

/** A NavSurface that is never open — the overlays the router asks before it touches anything else. */
function closedOverlay(): Overlay {
  const noop = (): void => undefined;
  return {
    ...fakeKeyboard(),
    isOpen: () => false,
    open: noop,
    openFromHistory: noop,
    openNew: noop,
    close: noop,
    resetSettings: noop,
    isDirty: () => false,
    deletesLocalGame: () => false,
    confirmAccepted: noop,
  };
}

function fakeControlsApi(): ControlsApi {
  return {
    requestLaunch: vi.fn(),
    requestUninstall: vi.fn(),
    cancelJob: vi.fn(),
    requestKill: vi.fn(),
    forgetGame: vi.fn(),
    openSteamDownloads: vi.fn(),
    requestShutdown: vi.fn(),
    requestReboot: vi.fn(),
    requestSleep: vi.fn(),
    requestHide: vi.fn(),
    requestQuit: vi.fn(),
    quitConfirmReply: vi.fn(),
    resolveGameCollision: vi.fn(() =>
      Promise.resolve({ saved: true, applied: 'applied' } as const),
    ),
    markNotificationsRead: vi.fn(),
    dismissNotification: vi.fn(),
    clearNotifications: vi.fn(),
  };
}

/**
 * What one instance's seams read and write. Per instance, not module-level: no controller removes its
 * window listeners (see CLAUDE.md), so every instance from an earlier test still answers a keydown — and
 * would push into a shared array. Each answers into its own harness; only the current one is asserted on.
 */
interface Harness {
  /** What the carousel reports it is showing, and what browse model the bar is drawn from. */
  screen: 'carousel' | 'detail';
  browse: BrowseInfo | null;
  /** Every game's activity, as app.ts would hold it. */
  activities: ActivityMap;
  state: AppState;
  /** Every `carousel.move(delta)` the router made. */
  readonly carouselMoves: number[];
  /** The primitives routed into the Settings overlay while it reports itself open. */
  readonly settingsNav: string[];
  settingsOpen: boolean;
  booting: boolean;
  popupClosed: number;
}

let controls: Controls;
let audio: FakeAudio;
let api: ControlsApi;
let harness: Harness;

const popup = (): HTMLElement => req('popup');
const focusedStackButton = (): string | null =>
  popup().querySelector<HTMLElement>('.text-button.is-focused')?.id ?? null;

/** The keyboard half of the input model — the same six primitives the gamepad drives. */
function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  loadFixture();
  installRafHarness();
  vi.useFakeTimers();
  audio = fakeAudio();
  api = fakeControlsApi();
  const own: Harness = {
    screen: 'carousel',
    browse: null,
    activities: {},
    state: { kind: 'idle' },
    carouselMoves: [],
    settingsNav: [],
    settingsOpen: false,
    booting: false,
    popupClosed: 0,
  };
  harness = own;
  const settings: Overlay = {
    ...closedOverlay(),
    isOpen: () => own.settingsOpen,
    navLeft: () => {
      own.settingsNav.push('left');
    },
    navBack: () => {
      own.settingsNav.push('back');
    },
  };
  controls = createControls({
    api,
    getState: () => own.state,
    getBrowse: () => own.browse,
    getScreenActivity: () => screenActivityOf(own.browse, own.activities),
    getJobCount: () => jobCountOf(own.activities),
    audio,
    getTranslator: () => createTranslator('en'),
    getLocale: () => 'en',
    carousel: {
      screen: () => own.screen,
      move: (delta) => {
        own.carouselMoves.push(delta);
        return 'moved';
      },
      activate: () => undefined,
      onGame: () => false,
      leaveDetail: () => false,
      setUnread: () => undefined,
    },
    settings,
    gameSettings: closedOverlay(),
    library: closedOverlay(),
    onFlipping: () => undefined,
    getNotifications: () => [],
    onPopupClosed: () => {
      own.popupClosed += 1;
    },
    openGameDetail: () => undefined,
    isBooting: () => own.booting,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('controls popup', () => {
  it('opens the power menu from its launcher card, focused on Close', () => {
    controls.openSystemCard('power');

    expect(popup().classList.contains('is-open')).toBe(true);
    expect(popup().dataset['view']).toBe('power');
    expect(popup().getAttribute('aria-hidden')).toBe('false');
    expect(focusedStackButton()).toBe('power-close');
    expect(audio.played).toEqual(['popup-open']);
    expect(controls.isPopupOpen()).toBe(true);
  });

  it('closes on back, and releases the toast corner only once the fade is over', () => {
    controls.openSystemCard('power');
    audio.reset();

    press('Escape');

    expect(popup().classList.contains('is-open')).toBe(false);
    expect(popup().getAttribute('aria-hidden')).toBe('true');
    expect(controls.isPopupOpen()).toBe(false);
    expect(audio.played).toEqual(['popup-close']);
    expect(harness.popupClosed).toBe(0);

    vi.advanceTimersByTime(POPUP_FADE_MS);

    expect(harness.popupClosed).toBe(1);
  });

  it("closes on a click into the veil, the mouse's way of saying back", () => {
    controls.openSystemCard('power');

    req('popup').querySelector<HTMLElement>('.popup-veil')?.click();

    expect(popup().classList.contains('is-open')).toBe(false);
  });

  it('walks the stack up from Close and wraps down from it', () => {
    controls.openSystemCard('power');
    audio.reset();

    press('ArrowUp');
    expect(focusedStackButton()).toBe('power-quit');

    press('ArrowDown');
    press('ArrowDown');
    expect(focusedStackButton()).toBe('power-shutdown');
    expect(audio.played).toEqual(['navigate', 'navigate', 'navigate']);
  });

  it('presses the focused button on activate — Close is the way out', () => {
    controls.openSystemCard('power');

    press('Enter');

    expect(popup().classList.contains('is-open')).toBe(false);
  });

  it('shows an error from main on its own view with a single Close', () => {
    controls.showError('Something broke');

    expect(popup().dataset['view']).toBe('error');
    expect(req('error-message').textContent).toBe('Something broke');
    expect(focusedStackButton()).toBe('error-close');
  });
});

describe('controls routing', () => {
  it('sends a direction to the strip when nothing is open, and eats the browser default', () => {
    const event = press('ArrowLeft');

    expect(harness.carouselMoves).toEqual([-1]);
    expect(event.defaultPrevented).toBe(true);
    expect(harness.settingsNav).toEqual([]);
  });

  it('routes into the open overlay instead — direction and back alike', () => {
    harness.settingsOpen = true;

    press('ArrowLeft');
    press('Escape');

    expect(harness.settingsNav).toEqual(['left', 'back']);
    expect(harness.carouselMoves).toEqual([]);
  });

  it('keeps a direction inside the popup while one is up', () => {
    controls.openSystemCard('power');

    press('ArrowLeft');

    // Left is "out" of a popup, the step B takes — never a flip of the strip underneath.
    expect(popup().classList.contains('is-open')).toBe(false);
    expect(harness.carouselMoves).toEqual([]);
  });

  it('is fenced off entirely while the boot screen is up', () => {
    harness.booting = true;

    press('ArrowRight');
    press('Enter');

    expect(harness.carouselMoves).toEqual([]);
    expect(audio.played).toEqual([]);
  });
});

const LOCAL_GAME: GameInfo = {
  id: 'local',
  title: 'Local',
  lastPlayedAt: null,
  totalPlaySeconds: 0,
  launchCount: 0,
  requiresInstall: false,
  canUninstall: false,
};

function browsing(game: GameInfo): BrowseInfo {
  return {
    id: game.id,
    title: game.title,
    active: true,
    stats: { schemaVersion: 1, totalPlaySeconds: 0, lastPlayedAt: null, launchCount: 0 },
    game,
  };
}

describe('controls focus ring on the detail screen', () => {
  const focusedMain = (): string[] =>
    ['play-button', 'more-button'].filter((id) => req(id).classList.contains('is-focused'));

  it('lands on Play first for a game that can be started', () => {
    harness.screen = 'detail';
    harness.browse = browsing(LOCAL_GAME);
    controls.refresh();

    expect(focusedMain()).toEqual(['play-button']);

    press('ArrowRight');

    expect(focusedMain()).toEqual(['more-button']);
  });

  it('skips the hidden Play of a local game whose files are gone', () => {
    harness.screen = 'detail';
    harness.browse = browsing({ ...LOCAL_GAME, unavailable: true });
    controls.refresh();

    expect(focusedMain()).toEqual(['more-button']);

    press('ArrowRight');

    expect(focusedMain()).toEqual(['more-button']);
    expect(audio.limits()).toBe(1);
  });

  it('skips the hidden Play of a local game with no launch method yet', () => {
    harness.screen = 'detail';
    harness.browse = browsing({ ...LOCAL_GAME, unconfigured: true });
    controls.refresh();

    expect(focusedMain()).toEqual(['more-button']);
  });
});

describe('controls Play with per-game activities', () => {
  const focusedMain = (): string[] =>
    ['play-button', 'more-button'].filter((id) => req(id).classList.contains('is-focused'));
  const STEAM_GAME: GameInfo = { ...LOCAL_GAME, id: 'steam', title: 'Steam', requiresInstall: true, installVia: 'steam' };

  it('keeps the gear of a download on screen focusable, and Play opens the Steam downloads', () => {
    harness.screen = 'detail';
    harness.browse = browsing(STEAM_GAME);
    harness.activities = { steam: { kind: 'steam-installing', paused: false } };
    controls.refresh();
    press('ArrowLeft');

    expect(focusedMain()).toEqual(['play-button']);

    req('play-button').click();

    expect(api.openSteamDownloads).toHaveBeenCalledTimes(1);
    expect(api.requestLaunch).not.toHaveBeenCalled();
  });

  it('opens the Steam downloads for an update too', () => {
    harness.screen = 'detail';
    harness.browse = browsing({ ...STEAM_GAME, requiresInstall: false });
    harness.activities = { steam: { kind: 'steam-updating', paused: true } };
    controls.refresh();

    req('play-button').click();

    expect(api.openSteamDownloads).toHaveBeenCalledTimes(1);
    expect(api.requestLaunch).not.toHaveBeenCalled();
  });

  it('refuses Play while the game on screen is being removed', () => {
    harness.screen = 'detail';
    harness.browse = browsing({ ...STEAM_GAME, requiresInstall: false, canUninstall: true });
    harness.activities = { steam: { kind: 'steam-uninstalling' } };
    controls.refresh();

    req('play-button').click();

    expect(audio.limits()).toBe(1);
    expect(api.requestLaunch).not.toHaveBeenCalled();
    expect(api.openSteamDownloads).not.toHaveBeenCalled();
  });

  it("launches the game on screen while ANOTHER game downloads: someone else's activity is not this game's", () => {
    harness.screen = 'detail';
    harness.browse = browsing(LOCAL_GAME);
    harness.state = { kind: 'ready', game: LOCAL_GAME };
    harness.activities = { steam: { kind: 'steam-installing', paused: false } };
    controls.refresh();

    expect(focusedMain()).toEqual(['play-button']);

    req('play-button').click();

    expect(api.requestLaunch).toHaveBeenCalledTimes(1);
    expect(api.openSteamDownloads).not.toHaveBeenCalled();
  });
});

describe('controls Force close', () => {
  const OTHER_GAME: GameInfo = { ...LOCAL_GAME, id: 'other', title: 'Other' };
  const killHidden = (): boolean => req('menu-kill').classList.contains('is-hidden');

  it('is offered on the detail screen of the running game', () => {
    harness.screen = 'detail';
    harness.browse = browsing(LOCAL_GAME);
    harness.state = { kind: 'running', game: LOCAL_GAME, since: 0 };
    req('more-button').click();

    expect(killHidden()).toBe(false);
  });

  it("is not offered on another game's detail screen while one runs", () => {
    harness.screen = 'detail';
    harness.browse = browsing(OTHER_GAME);
    harness.state = { kind: 'running', game: LOCAL_GAME, since: 0 };
    req('more-button').click();

    expect(killHidden()).toBe(true);
  });
});

describe('controls background installs', () => {
  const COPY_GAME: GameInfo = { ...LOCAL_GAME, id: 'copy', title: 'Copy', requiresInstall: true, installVia: 'copy' };
  const toggle = (): HTMLButtonElement => req<HTMLButtonElement>('menu-install-toggle');

  it('offers Cancel installation for an install of the game on screen, and cancels it by id', () => {
    harness.screen = 'detail';
    harness.browse = browsing(COPY_GAME);
    harness.state = { kind: 'ready', game: COPY_GAME };
    harness.activities = { copy: { kind: 'queued' } };
    req('more-button').click();

    expect(toggle().classList.contains('is-hidden')).toBe(false);
    expect(toggle().textContent).toBe('Cancel installation');

    toggle().click();

    expect(api.cancelJob).toHaveBeenCalledWith('copy');
  });

  it('closes an open install question once the game on screen starts installing', () => {
    harness.screen = 'detail';
    harness.browse = browsing(COPY_GAME);
    harness.state = { kind: 'ready', game: COPY_GAME };
    req('more-button').click();
    toggle().click();

    expect(popup().dataset['mode']).toBe('install');
    expect(popup().classList.contains('is-open')).toBe(true);

    harness.activities = { copy: { kind: 'installing' } };
    controls.refresh();

    expect(popup().classList.contains('is-open')).toBe(false);
  });
});


describe('controls quit with background jobs', () => {
  const view = (): string | undefined => popup().dataset['view'];
  const message = (): string | null => req('confirm-message').textContent;

  it('Quit from the Power menu asks first while jobs run, and its No goes back to Power', () => {
    harness.activities = { a: { kind: 'installing' }, b: { kind: 'queued' } };
    controls.openSystemCard('power');
    req('power-quit').click();

    expect(view()).toBe('confirm');
    expect(message()).toBe('2 operations are in progress and will be cancelled. Quit anyway?');
    expect(api.requestQuit).not.toHaveBeenCalled();

    req('confirm-no').click();

    expect(view()).toBe('power');
  });

  it('Quit from the Power menu leaves at once with nothing running', () => {
    harness.activities = { a: { kind: 'steam-installing', paused: false } };
    controls.openSystemCard('power');
    req('power-quit').click();

    expect(api.requestQuit).toHaveBeenCalledTimes(1);
    expect(api.requestQuit).toHaveBeenCalledWith();
  });

  it("main's question opens on its own, says it is shown, and its No just closes - no Power menu", () => {
    harness.activities = { a: { kind: 'installing' } };
    controls.askQuit('quit');

    expect(api.quitConfirmReply).toHaveBeenCalledWith('shown');
    expect(view()).toBe('confirm');

    req('confirm-no').click();

    expect(popup().classList.contains('is-open')).toBe(false);
    expect(api.quitConfirmReply).toHaveBeenLastCalledWith('dismissed');
  });

  it("main's question answered Yes quits confirmed and is not reported as dismissed", () => {
    harness.activities = { a: { kind: 'installing' } };
    controls.askQuit('quit');
    req('confirm-yes').click();

    expect(api.requestQuit).toHaveBeenCalledWith(true);
    expect(api.quitConfirmReply).not.toHaveBeenCalledWith('dismissed');
  });

  it("main's question waits behind an open error and comes up once it is closed", () => {
    harness.activities = { a: { kind: 'installing' } };
    controls.showError('Something broke');
    controls.askQuit('reboot');

    expect(api.quitConfirmReply).toHaveBeenCalledWith('shown');
    expect(view()).toBe('error');

    req('error-close').click();
    vi.advanceTimersByTime(POPUP_FADE_MS);

    expect(view()).toBe('confirm');
    expect(message()).toBe('1 operation is in progress and will be cancelled. Reboot the PC anyway?');
  });

  it('an open quit question follows the job count, and falls back to the plain question at zero', () => {
    harness.activities = { a: { kind: 'installing' }, b: { kind: 'installing' } };
    controls.askQuit('quit');
    harness.activities = { a: { kind: 'installing' } };
    controls.refresh();

    expect(message()).toBe('1 operation is in progress and will be cancelled. Quit anyway?');

    harness.activities = {};
    controls.refresh();

    expect(message()).toBe('Quit Playhook?');
  });
});

describe('controls while another game runs', () => {
  const SESSION: GameInfo = { ...LOCAL_GAME, id: 'session', title: 'Session' };
  const UNINSTALLED: GameInfo = { ...LOCAL_GAME, id: 'later', title: 'Later', requiresInstall: true, installVia: 'copy' };
  const focusedMain = (): string[] =>
    ['play-button', 'more-button'].filter((id) => req(id).classList.contains('is-focused'));

  beforeEach(() => {
    harness.state = { kind: 'running', game: SESSION, since: 0 };
  });

  it("an installed game's Play is out of the ring and refuses - it never starts a second game", () => {
    harness.screen = 'detail';
    harness.browse = browsing(LOCAL_GAME);
    controls.refresh();
    press('ArrowRight');

    expect(focusedMain()).toEqual(['more-button']);

    req('play-button').click();

    expect(api.requestLaunch).not.toHaveBeenCalled();
    expect(audio.limits()).toBe(1);
  });

  it("the session game's Play returns to it, by its id", () => {
    harness.screen = 'detail';
    harness.browse = browsing(SESSION);
    controls.refresh();
    req('play-button').click();

    expect(api.requestLaunch).toHaveBeenCalledWith('session');
  });

  it("an uninstalled game's Install question sends its own id, fixed when the question opened", () => {
    harness.screen = 'detail';
    harness.browse = browsing(UNINSTALLED);
    req('more-button').click();
    req('menu-install-toggle').click();

    expect(popup().dataset['mode']).toBe('install');

    req('confirm-yes').click();

    expect(api.requestLaunch).toHaveBeenCalledWith('later');
  });

  it('closes the open question when main moves the screen onto another game, so its Yes cannot hit that one', () => {
    harness.screen = 'detail';
    harness.browse = browsing(UNINSTALLED);
    req('more-button').click();
    req('menu-install-toggle').click();
    harness.browse = browsing(SESSION);
    controls.refresh();

    expect(popup().classList.contains('is-open')).toBe(false);
    expect(api.requestLaunch).not.toHaveBeenCalled();
  });
});
