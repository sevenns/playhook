// Renderer UI logic. Drives a persistent DOM (built once in index.html) by toggling classes
// and data-attributes per AppState, so CSS transitions animate smoothly between states.
// IMPORTANT: title/data come from the card (untrusted) — rendered via textContent, never innerHTML.
import type { AppState, GameInfo } from '../shared/types';
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
const titleEl = req('title');
const statusEl = req('status');
const infoPanel = req('info-panel');
const infoPopup = req('info-popup');
const infoVeil = reqQuery<HTMLElement>('#info-popup .popup-veil');
const errorPopup = req('error-popup');
const errorMessageEl = req('error-message');
const errorVeil = reqQuery<HTMLElement>('#error-popup .popup-veil');
const barContent = reqQuery<HTMLElement>('.bar-content');

type Phase = 'idle' | 'ready' | 'busy' | 'error';

const EMPTY_TITLE = 'Insert a game card';

let currentState: AppState = { kind: 'idle' };
let infoOpen = false;
let errorOpen = false;
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
    case 'syncing-in':
      return 'Syncing saves...';
    case 'launching':
      return 'Launching...';
    case 'running':
      return 'Running...';
    case 'syncing-out':
      return 'Saving progress...';
    default:
      return '';
  }
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

function updatePalette(game: GameInfo): void {
  const dataUrl = game.heroImageDataUrl;
  if (dataUrl === undefined) {
    applyPalette(null);
    return;
  }
  const cached = paletteCache.get(game.id);
  if (cached !== undefined) {
    applyPalette(cached);
    return;
  }
  void computePalette(dataUrl).then((palette) => {
    paletteCache.set(game.id, palette);
    if (currentState.kind !== 'idle') applyPalette(palette);
  });
}

// ── Hero background ─────────────────────────────────────────────────────────

function setHero(game: GameInfo): void {
  if (game.heroImageDataUrl !== undefined) {
    app.style.backgroundImage = `url("${game.heroImageDataUrl}")`;
  } else {
    app.style.backgroundImage = 'none';
  }
}

// The empty / idle screen (no game): the fallback wallpaper as background, its dominant colors as
// the palette, and "Insert a game card" as the title. Reuses the main screen's bottom bar layout.
function applyEmptyScreen(): void {
  titleEl.textContent = EMPTY_TITLE;
  if (wallpaperUrl === null) {
    app.style.backgroundImage = 'none';
    applyPalette(null);
    return;
  }
  app.style.backgroundImage = `url("${wallpaperUrl}")`;
  if (wallpaperPalette !== undefined) {
    applyPalette(wallpaperPalette);
    return;
  }
  void computePalette(wallpaperUrl).then((palette) => {
    wallpaperPalette = palette;
    if (gameOf(currentState) === undefined) applyPalette(palette);
  });
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
    if (phaseOf(currentState) !== 'busy') return; // state changed before the frame — don't slide
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

// ── Render ──────────────────────────────────────────────────────────────────

function render(state: AppState): void {
  currentState = state;
  const phase = phaseOf(state);
  const game = gameOf(state);

  app.dataset['phase'] = phase;

  if (game !== undefined) {
    setHero(game);
    updatePalette(game);
    titleEl.textContent = game.title;
    buildInfoPanel(game);
    applyPlayButton(game);
  } else {
    // idle / no-game error → the empty "Insert a game card" screen (wallpaper background).
    applyEmptyScreen();
  }

  statusEl.textContent = statusOf(state);
  applyTitleSlide(phase === 'busy');

  // Popups only make sense on the ready screen; force-close them on any other state. (A failed
  // launch returns to 'ready' first, then opens the error popup — so it survives this.)
  if (phase !== 'ready') {
    closeInfo();
    closeError();
  }
  applyFocus();
  syncMusic();
}

// ── Focus navigation (gamepad / mouse) ──────────────────────────────────────

// Navigation order across the on-screen controls (left → right).
const focusables: readonly HTMLButtonElement[] = [playButton, infoButton];
let focusIndex = 0;

// Focus is only meaningful on the ready screen with no popup open.
function focusActive(): boolean {
  return phaseOf(currentState) === 'ready' && !infoOpen && !errorOpen;
}

function applyFocus(): void {
  const active = focusActive();
  focusables.forEach((btn, i) => btn.classList.toggle('is-focused', active && i === focusIndex));
}

function moveFocus(delta: number): void {
  if (!focusActive()) return;
  const next = Math.min(focusables.length - 1, Math.max(0, focusIndex + delta));
  if (next === focusIndex) return; // already at the edge — no move, no sound
  focusIndex = next;
  audio.play('navigate');
  applyFocus();
}

// Gamepad A doesn't trigger :active, so flash a press class to play the scale-down animation.
const PRESS_MS = 130;
function pressFlash(btn: HTMLElement): void {
  btn.classList.add('is-pressed');
  window.setTimeout(() => btn.classList.remove('is-pressed'), PRESS_MS);
}

function activateFocused(): void {
  if (!focusActive()) return;
  const btn = focusables[focusIndex];
  if (btn === undefined) return;
  pressFlash(btn);
  if (btn === infoButton) triggerInfo();
  else triggerPlay();
}

// User-initiated actions (shared by mouse clicks and gamepad A/B) — each plays its sound.
function triggerPlay(): void {
  if (!focusActive()) return;
  audio.play('play');
  window.api.requestLaunch();
}

function triggerInfo(): void {
  audio.play('button');
  openInfo();
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
infoVeil.addEventListener('click', () => triggerClosePopup());
errorVeil.addEventListener('click', () => triggerClosePopup());
hideButton.addEventListener('click', () => window.api.requestHide());

// Mouse hover moves the gamepad focus too, so A always activates what's highlighted.
focusables.forEach((btn, i) => {
  btn.addEventListener('mouseenter', () => {
    if (!focusActive()) return;
    focusIndex = i;
    applyFocus();
  });
});

const gamepad = createGamepadController({
  onLeft: () => moveFocus(-1),
  onRight: () => moveFocus(1),
  // On the empty / idle screen the only action is Hide; otherwise A activates the focused button.
  onA: () => (onMessageScreen() ? window.api.requestHide() : activateFocused()),
  onB: () => (onMessageScreen() ? window.api.requestHide() : triggerClosePopup()),
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

// Pause/resume music when the window is hidden to tray or restored.
document.addEventListener('visibilitychange', () => syncMusic());

gamepad.start();

// Re-measure the title slide on resize while busy (keeps right-alignment correct).
window.addEventListener('resize', () => {
  if (phaseOf(currentState) === 'busy') applyTitleSlide(true);
});
