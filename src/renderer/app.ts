// Renderer UI logic. Drives a persistent DOM (built once in index.html) by toggling classes
// and data-attributes per AppState, so CSS transitions animate smoothly between states.
// IMPORTANT: title/data come from the card (untrusted) — rendered via textContent, never innerHTML.
import type { AppState, GameInfo, HeroAssets } from '../shared/types';
import { createGamepadController } from './gamepad.js';
import { createAudioController } from './audio.js';
import { computePalette, type Palette } from './dominant-color.js';

function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} not found`);
  return el as T;
}

function reqQuery<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`${selector} not found`);
  return el;
}

const app = req('app');
const hideButton = req<HTMLButtonElement>('hide-button');
const playButton = req<HTMLButtonElement>('play-button');
const infoButton = req<HTMLButtonElement>('info-button');
const uninstallButton = req<HTMLButtonElement>('uninstall-button');
const titleEl = req('title');
const statusEl = req('status');
const infoPanel = req('info-panel');
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
const barContent = reqQuery<HTMLElement>('.bar-content');

type Phase = 'idle' | 'ready' | 'busy' | 'error';

const EMPTY_TITLE = 'Insert a game card';

let currentState: AppState = { kind: 'idle' };
let infoOpen = false;
let errorOpen = false;
let confirmOpen = false;
// Which action the confirmation popup is asking about (only meaningful while confirmOpen).
type ConfirmMode = 'install' | 'uninstall';
let confirmMode: ConfirmMode = 'uninstall';
const CONFIRM_TEXT: Readonly<Record<ConfirmMode, string>> = {
  install: 'Do you want to install game?',
  uninstall: 'Do you want to uninstall game from your PC?',
};
// Steam-mode confirm copy: the action opens Steam (no card path / silent-mode note applies).
const STEAM_INSTALL_TEXT = 'Open Steam to install this game?';
const STEAM_UNINSTALL_TEXT = 'Open Steam to uninstall this game?';
// Fallback wallpaper (data URL from main) for the empty / idle screen, and its cached palette.
let wallpaperUrl: string | null = null;
let wallpaperPalette: Palette | null | undefined;
const paletteCache = new Map<string, Palette | null>();
const audio = createAudioController();

// ── Formatting ────────────────────────────────────────────────────────────

function formatPlaytime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return 'less than a minute';
}

function formatDate(iso: string | null): string {
  if (iso === null) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString('en-GB');
}

// ── State → phase/status mapping ────────────────────────────────────────────

function phaseOf(state: AppState): Phase {
  switch (state.kind) {
    case 'idle':
      return 'idle';
    case 'ready':
      return 'ready';
    case 'error':
      return 'error';
    case 'installing':
    case 'uninstalling':
    case 'syncing-in':
    case 'launching':
    case 'running':
    case 'syncing-out':
      return 'busy';
  }
}

function statusOf(state: AppState): string {
  // Plain "..." instead of the "…" glyph: in M PLUS Rounded 1c (a CJK font) the ellipsis
  // glyph is centered vertically (Japanese convention), which looks misaligned in a Latin UI.
  switch (state.kind) {
    case 'installing':
      return 'Installing...';
    case 'uninstalling':
      return 'Uninstalling...';
    case 'syncing-in':
      return 'Syncing saves...';
    case 'launching':
      return 'Launching...';
    case 'running':
      return 'Running...';
    case 'syncing-out':
      return 'Saving progress...';
    case 'ready': {
      // Steam non-blocking install/uninstall indicators on the ready screen (the window stays usable).
      // No install percent: Steam exposes no reliable live progress in the files we read (see main).
      if (state.game.steamUninstalling === true) return 'Uninstalling...';
      if (state.game.steamInstalling === true) {
        if (state.game.steamPaused !== true) return 'Installing...';
        const progress = state.game.steamPausedProgress;
        return progress === undefined
          ? 'Installing paused...'
          : `Installing paused on ${Math.round(progress * 100)}%...`;
      }
      return '';
    }
    default:
      return '';
  }
}

// True while a Steam install (download) or uninstall is in progress: a non-blocking indicator on the
// (still) ready screen — the busy visuals (loader + status + slid title) are reused via
// #app[data-steam-busy], NOT the busy phase.
function steamBusy(state: AppState): boolean {
  if (state.kind !== 'ready') return false;
  return state.game.steamInstalling === true || state.game.steamUninstalling === true;
}

function gameOf(state: AppState): GameInfo | undefined {
  return 'game' in state ? state.game : undefined;
}

// ── Palette (two dominant colors) ───────────────────────────────────────────

function applyPalette(palette: Palette | null): void {
  if (palette === null) {
    app.style.removeProperty('--d1');
    app.style.removeProperty('--d2');
    return;
  }
  app.style.setProperty('--d1', palette.d1);
  app.style.setProperty('--d2', palette.d2);
}

// Computes (or reuses a cached) palette for an arbitrary image, keyed by an arbitrary cache key
// (per-hero: `${gameId}#${index}`). Applies it only if that image is STILL the one on screen, so a
// slow compute for a rotated-away image can't clobber the current palette.
function updatePaletteFor(url: string, cacheKey: string): void {
  const cached = paletteCache.get(cacheKey);
  if (cached !== undefined) {
    applyPalette(cached);
    return;
  }
  void computePalette(url).then((palette) => {
    paletteCache.set(cacheKey, palette);
    if (shownUrl === url) applyPalette(palette);
  });
}

// The wallpaper's palette, reused both on the idle screen AND when a game's hero falls back to the
// wallpaper — so we never recompute the same dominant colors under a per-game key (review note 7).
function applyWallpaperPalette(): void {
  if (wallpaperPalette !== undefined) {
    applyPalette(wallpaperPalette);
    return;
  }
  if (wallpaperUrl === null) {
    applyPalette(null);
    return;
  }
  const url = wallpaperUrl;
  void computePalette(url).then((palette) => {
    wallpaperPalette = palette;
    if (shownUrl === url) applyPalette(palette);
  });
}

// ── Hero background (two cross-fading layers, GTA-5-style) ────────────────────

// Two stacked layers we cross-fade between: activeLayer shows the current image, idleLayer receives the
// next one; then the roles swap. Both run bg-pan perpetually (see styles.css).
const heroLayers = Array.from(document.querySelectorAll<HTMLElement>('#hero .hero-layer'));
const [heroLayerA, heroLayerB] = heroLayers;
if (heroLayerA === undefined || heroLayerB === undefined) {
  throw new Error('#hero must contain two .hero-layer elements');
}
let activeLayer: HTMLElement = heroLayerA;
let idleLayer: HTMLElement = heroLayerB;
// The url the active layer currently shows — a gate so the dozens of state.set renders per session
// don't trigger a needless cross-fade / pan re-randomize when the image hasn't actually changed.
let shownUrl: string | null = null;

// Cross-fades to a new image on the idle layer, then swaps roles. No-op when the url is unchanged
// (keeps the running pan going). null → no image (blank background).
function showImage(url: string | null): void {
  if (url === shownUrl) return;
  shownUrl = url;
  // The incoming (idle) layer gets the new image + a fresh random pan direction (drift left vs right).
  idleLayer.style.backgroundImage = url !== null ? `url("${url}")` : 'none';
  idleLayer.style.setProperty('--pan-x', Math.random() < 0.5 ? '1.5%' : '-1.5%');
  // Force-restart bg-pan so the incoming image starts its drift from zero: opacity:0 does NOT pause the
  // animation, so without this the layer would fade in mid-drift. Toggling animation + a reflow retriggers
  // it — and the same reflow flushes styles so the opacity transition below actually animates.
  idleLayer.style.animation = 'none';
  void idleLayer.offsetWidth;
  idleLayer.style.animation = '';
  // Cross-fade: incoming layer in, outgoing out, then swap the roles.
  idleLayer.classList.add('is-active');
  activeLayer.classList.remove('is-active');
  const previousActive = activeLayer;
  activeLayer = idleLayer;
  idleLayer = previousActive;
}

// The empty / idle screen (no game): the fallback wallpaper as background, its dominant colors as
// the palette, and "Insert a game card" as the title. Reuses the main screen's bottom bar layout.
function applyEmptyScreen(): void {
  titleEl.textContent = EMPTY_TITLE;
  if (wallpaperUrl === null) {
    showImage(null);
    applyPalette(null);
    return;
  }
  showImage(wallpaperUrl);
  applyWallpaperPalette();
}

// ── Hero rotation (renderer-local, GTA-5 cadence) ────────────────────────────

const HERO_ROTATE_MS = 60_000;
// Hero images for the current card (delivered on the hero:update channel) and the rotation cursor.
let heroImages: readonly string[] = [];
let heroIndex = 0;
let heroTimer: number | null = null;

// Shows the hero at `index`: cross-fade the image + (re)apply its palette. When the only image is the
// wallpaper fallback, reuse the wallpaper palette instead of recomputing it under a per-game key.
function showHeroAt(index: number): void {
  const url = heroImages[index];
  if (url === undefined) return;
  showImage(url);
  if (url === wallpaperUrl) {
    applyWallpaperPalette();
    return;
  }
  const id = gameOf(currentState)?.id ?? '';
  updatePaletteFor(url, `${id}#${index}`);
}

// Rotation runs only with >1 image, the window visible, and a game on screen (symmetric to the music
// gate). During a Steam download the window stays on the ready screen with a game, so rotation is fine.
function heroRotationEligible(): boolean {
  return (
    heroImages.length > 1 &&
    document.visibilityState === 'visible' &&
    gameOf(currentState) !== undefined
  );
}

// (Re)evaluates the rotation timer: starts it when eligible, stops it otherwise. Idempotent — if it is
// already running and still eligible the countdown is left intact, so frequent state.set renders don't
// starve the rotation by resetting the interval.
function startHeroRotation(): void {
  if (!heroRotationEligible()) {
    stopHeroRotation();
    return;
  }
  if (heroTimer !== null) return;
  heroTimer = window.setInterval(() => {
    heroIndex = (heroIndex + 1) % heroImages.length;
    showHeroAt(heroIndex);
  }, HERO_ROTATE_MS);
}

function stopHeroRotation(): void {
  if (heroTimer === null) return;
  window.clearInterval(heroTimer);
  heroTimer = null;
}

// New hero payload for the current card: reset the cursor, paint the first image if a game is already on
// screen (channels are independent — render may have landed first), and restart the rotation from fresh.
function applyHeroAssets(assets: HeroAssets | null): void {
  heroImages = assets?.images ?? [];
  heroIndex = 0;
  stopHeroRotation();
  if (gameOf(currentState) !== undefined && heroImages.length > 0) {
    showHeroAt(0);
  }
  startHeroRotation();
}

// ── Info panel ──────────────────────────────────────────────────────────────

function infoItem(label: string, value: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'info-item';
  const labelEl = document.createElement('div');
  labelEl.className = 'info-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('div');
  valueEl.className = 'info-value';
  valueEl.textContent = value;
  item.append(labelEl, valueEl);
  return item;
}

function buildInfoPanel(game: GameInfo): void {
  while (infoPanel.firstChild !== null) infoPanel.removeChild(infoPanel.firstChild);
  infoPanel.append(
    infoItem('Last Played', formatDate(game.lastPlayedAt)),
    infoItem('Playtime', formatPlaytime(game.totalPlaySeconds)),
    infoItem('Launches', String(game.launchCount)),
  );
}

// ── Title slide (left → right while busy) ───────────────────────────────────

// The title slides right (making room for the status) while busy OR while a Steam install/uninstall
// shows its non-blocking indicator on the ready screen.
function shouldSlideTitle(): boolean {
  return phaseOf(currentState) === 'busy' || steamBusy(currentState);
}

let titleSlideRaf = 0;
function applyTitleSlide(toRight: boolean): void {
  // Cancel any pending measure: otherwise a busy-state rAF can fire AFTER we've returned to 'ready'
  // (e.g. a launch that failed fast) and wrongly re-slide the title right. This was the stuck-title bug.
  if (titleSlideRaf !== 0) {
    cancelAnimationFrame(titleSlideRaf);
    titleSlideRaf = 0;
  }
  if (!toRight) {
    titleEl.style.setProperty('--title-x', '0px');
    return;
  }
  // Measure after layout so scrollWidth/offsetLeft are correct.
  titleSlideRaf = requestAnimationFrame(() => {
    titleSlideRaf = 0;
    if (!shouldSlideTitle()) return; // state changed before the frame — don't slide
    const shift = barContent.clientWidth - titleEl.scrollWidth - titleEl.offsetLeft;
    titleEl.style.setProperty('--title-x', `${Math.max(0, Math.round(shift))}px`);
  });
}

// ── Popups (Info / Error) ─────────────────────────────────────────────────────
// Both share the same component (.popup): a right-side frosted veil + a right-aligned panel,
// toggled with the .is-open class. They are mutually exclusive.

function openInfo(): void {
  if (infoOpen || phaseOf(currentState) !== 'ready') return;
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
  if (confirmOpen || phaseOf(currentState) !== 'ready') return;
  const game = gameOf(currentState);
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

// ── Background music gating ──────────────────────────────────────────────────

// Music plays only while the launcher is actually on screen: the window must be visible
// (not hidden to tray / minimized) and no game running (the game covers the launcher).
function syncMusic(): void {
  const visible = document.visibilityState === 'visible';
  const running = currentState.kind === 'running';
  audio.setMusicPlaying(visible && !running);
}

// ── Play / Install button ───────────────────────────────────────────────────

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

// ── Render ──────────────────────────────────────────────────────────────────

function render(state: AppState): void {
  currentState = state;
  const phase = phaseOf(state);
  const game = gameOf(state);

  app.dataset['phase'] = phase;

  if (game !== undefined) {
    // Hero images travel on their own channel (hero:update), independent of state:update — on a window
    // reconnect render can arrive before the hero payload. Only paint when we already have images; an
    // empty list means "wait for onHeroUpdate" (it back-fills), rather than blanking the background.
    if (heroImages.length > 0) showHeroAt(heroIndex);
    titleEl.textContent = game.title;
    buildInfoPanel(game);
    applyPlayButton(game);
    applyUninstallButton(game);
  } else {
    // idle / no-game error → the empty "Insert a game card" screen (wallpaper background).
    applyEmptyScreen();
    // This branch doesn't touch the Uninstall button, so clear a stale .is-available from a prior
    // ready state explicitly (don't rely on CSS specificity alone, I5).
    uninstallButton.classList.remove('is-available');
    infoButton.classList.remove('has-uninstall-sibling');
  }

  // Re-evaluate the hero rotation for the new state (start when eligible: >1 image, visible, a game on
  // screen; stop otherwise, e.g. on the idle screen). Idempotent — see startHeroRotation.
  startHeroRotation();

  // Steam non-blocking install/uninstall indicator: reuse the busy visuals (loader/status/slid title)
  // via a dedicated attribute, while the logical phase stays 'ready' (window hideable, card pullable).
  const busySteam = steamBusy(state);
  if (busySteam) app.dataset['steamBusy'] = 'true';
  else delete app.dataset['steamBusy'];

  statusEl.textContent = statusOf(state);
  applyTitleSlide(phase === 'busy' || busySteam);

  // Popups only make sense on the ready screen; force-close them on any other state. (A failed
  // launch returns to 'ready' first, then opens the error popup — so it survives this.) closeConfirm
  // is critical for a card swap/pull WHILE the confirm modal is open — without it the modal would hang
  // over the busy/idle screen.
  if (phase !== 'ready') {
    closeInfo();
    closeError();
    closeConfirm();
  }
  applyFocus();
  syncMusic();
}

// ── Focus navigation (gamepad / mouse) ──────────────────────────────────────

// Main navigation group (left → right). Uninstall joins it only for an installed install-mode game, so
// the focusable set is DYNAMIC; the full set is iterated to clear stale highlights.
const ALL_MAIN_BUTTONS: readonly HTMLButtonElement[] = [playButton, infoButton, uninstallButton];
let focusIndex = 0;

function mainFocusables(): readonly HTMLButtonElement[] {
  // While a Steam install/uninstall indicator is up, the right-side buttons are hidden — keep only Play
  // focusable/clickable (during a download its click opens Steam's Downloads page; see triggerPlay).
  if (steamBusy(currentState)) return [playButton];
  return gameOf(currentState)?.canUninstall === true
    ? [playButton, infoButton, uninstallButton]
    : [playButton, infoButton];
}

// Main focus is only meaningful on the ready screen with no popup open — including the confirm modal:
// with confirmOpen this returns false, so triggerPlay/triggerInfo/moveFocus/activateFocused/mouseenter
// (all guarded by focusActive) go quiet naturally while the modal is up (B1).
function focusActive(): boolean {
  return phaseOf(currentState) === 'ready' && !infoOpen && !errorOpen && !confirmOpen;
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
  return phaseOf(currentState) === 'ready' && confirmOpen;
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

// Gamepad A doesn't trigger :active, so flash a press class to play the scale-down animation.
const PRESS_MS = 130;
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

// User-initiated actions (shared by mouse clicks and gamepad A/B) — each plays its sound.
function triggerPlay(): void {
  if (!focusActive()) return;
  const game = gameOf(currentState);
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
  const phase = phaseOf(currentState);
  return phase === 'idle' || phase === 'error';
}

// ── Wiring ──────────────────────────────────────────────────────────────────

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

window.api.onStateUpdate(render);
void window.api.requestState().then(render);

// A failed launch returns to 'ready' and sends the reason here to open the error popup.
window.api.onError((messageText) => openError(messageText));

// Fallback wallpaper for the empty screen (data URL from main); apply if we're on it already.
void window.api.requestWallpaper().then((url) => {
  wallpaperUrl = url;
  if (gameOf(currentState) === undefined) applyEmptyScreen();
});

// Audio assets are delivered on their own channel (not in AppState); load them and keep music in sync.
window.api.onAudioUpdate((assets) => {
  audio.setAssets(assets);
  syncMusic();
});
void window.api.requestAudio().then((assets) => {
  audio.setAssets(assets);
  syncMusic();
});

// Hero images are delivered on their own channel (not in AppState): the renderer rotates through them
// locally, so we never re-send this large payload on every state transition. See applyHeroAssets.
window.api.onHeroUpdate(applyHeroAssets);
void window.api.requestHero().then(applyHeroAssets);

// Pause/resume music AND the hero rotation when the window is hidden to tray or restored. The active
// layer keeps showing the current hero, so no force-show is needed on return — just (re)start the timer.
document.addEventListener('visibilitychange', () => {
  syncMusic();
  startHeroRotation();
});

gamepad.start();

// Re-measure the title slide on resize while busy / steam-installing (keeps right-alignment correct).
window.addEventListener('resize', () => {
  if (shouldSlideTitle()) applyTitleSlide(true);
});
