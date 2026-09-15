import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControls, type Controls } from '../../src/renderer/controls';
import type { ControlsApi, ControlsDeps } from '../../src/renderer/controls-deps';
import { req } from '../../src/renderer/dom';
import { createTranslator } from '../../src/shared/i18n/index';
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
    requestKill: vi.fn(),
    forgetGame: vi.fn(),
    openSteamDownloads: vi.fn(),
    requestShutdown: vi.fn(),
    requestReboot: vi.fn(),
    requestSleep: vi.fn(),
    requestHide: vi.fn(),
    requestQuit: vi.fn(),
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
    getState: () => ({ kind: 'idle' }),
    getBrowse: () => null,
    audio,
    getTranslator: () => createTranslator('en'),
    getLocale: () => 'en',
    carousel: {
      screen: () => 'carousel',
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
