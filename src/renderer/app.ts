// Renderer UI logic. Drives a persistent DOM (built once in index.html) by toggling classes
// and data-attributes per AppState, so CSS transitions animate smoothly between states.
// IMPORTANT: title/data come from the card (untrusted) — rendered via textContent, never innerHTML.
import type { AppState, GameInfo } from '../shared/types';
import { createGamepadController } from './gamepad.js';
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
const message = req('message');
const playButton = req<HTMLButtonElement>('play-button');
const infoButton = req<HTMLButtonElement>('info-button');
const titleEl = req('title');
const statusEl = req('status');
const infoPanel = req('info-panel');
const infoPopup = req('info-popup');
const barContent = reqQuery<HTMLElement>('.bar-content');
const infoVeil = reqQuery<HTMLElement>('.info-veil');

type Phase = 'idle' | 'ready' | 'busy' | 'error';

let currentState: AppState = { kind: 'idle' };
let infoOpen = false;
const paletteCache = new Map<string, Palette | null>();

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

function setHero(game: GameInfo | undefined): void {
  if (game?.heroImageDataUrl !== undefined) {
    app.style.backgroundImage = `url("${game.heroImageDataUrl}")`;
  } else {
    app.style.backgroundImage = 'none';
  }
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

function applyTitleSlide(toRight: boolean): void {
  if (!toRight) {
    titleEl.style.setProperty('--title-x', '0px');
    return;
  }
  // Measure after layout so scrollWidth/offsetLeft are correct.
  requestAnimationFrame(() => {
    const shift = barContent.clientWidth - titleEl.scrollWidth - titleEl.offsetLeft;
    titleEl.style.setProperty('--title-x', `${Math.max(0, Math.round(shift))}px`);
  });
}

// ── Info popup ──────────────────────────────────────────────────────────────

function openInfo(): void {
  if (infoOpen || phaseOf(currentState) !== 'ready') return;
  infoOpen = true;
  app.dataset['info'] = 'open';
  infoPopup.setAttribute('aria-hidden', 'false');
  applyFocus();
}

function closeInfo(): void {
  if (!infoOpen) return;
  infoOpen = false;
  delete app.dataset['info'];
  infoPopup.setAttribute('aria-hidden', 'true');
  applyFocus();
}

// ── Render ──────────────────────────────────────────────────────────────────

function render(state: AppState): void {
  currentState = state;
  const phase = phaseOf(state);
  const game = gameOf(state);

  app.dataset['phase'] = phase;
  setHero(game);

  if (game !== undefined) {
    updatePalette(game);
    titleEl.textContent = game.title;
    buildInfoPanel(game);
  }

  if (phase === 'idle') {
    message.textContent = 'Insert a game card';
  } else if (phase === 'error' && state.kind === 'error') {
    message.textContent = state.message;
  }

  statusEl.textContent = statusOf(state);
  applyTitleSlide(phase === 'busy');

  // Info popup is only valid in ready; force-close on any other state.
  if (phase !== 'ready') closeInfo();
  applyFocus();
}

// ── Focus navigation (gamepad / mouse) ──────────────────────────────────────

// Navigation order across the on-screen controls (left → right).
const focusables: readonly HTMLButtonElement[] = [playButton, infoButton];
let focusIndex = 0;

// Focus is only meaningful on the ready screen with the popup closed.
function focusActive(): boolean {
  return phaseOf(currentState) === 'ready' && !infoOpen;
}

function applyFocus(): void {
  const active = focusActive();
  focusables.forEach((btn, i) => btn.classList.toggle('is-focused', active && i === focusIndex));
}

function moveFocus(delta: number): void {
  if (!focusActive()) return;
  focusIndex = Math.min(focusables.length - 1, Math.max(0, focusIndex + delta));
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
  if (btn === infoButton) openInfo();
  else window.api.requestLaunch();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

playButton.addEventListener('click', () => {
  if (focusActive()) window.api.requestLaunch();
});
infoButton.addEventListener('click', () => openInfo());
infoVeil.addEventListener('click', () => closeInfo());

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
  onA: () => activateFocused(),
  onB: () => closeInfo(),
});

window.api.onStateUpdate(render);
void window.api.requestState().then(render);
gamepad.start();

// Re-measure the title slide on resize while busy (keeps right-alignment correct).
window.addEventListener('resize', () => {
  if (phaseOf(currentState) === 'busy') applyTitleSlide(true);
});
