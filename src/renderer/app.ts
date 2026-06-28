// Renderer UI logic (stage 5): renders the state machine replicated from main.
// IMPORTANT: title/data come from the card (untrusted input) — we render via
// textContent / style, without innerHTML, to rule out injections.
import type { AppState, GameInfo } from '../shared/types';
import { createGamepadController } from './gamepad.js';
import { computeButtonColors, type ButtonColors } from './dominant-color.js';

const root = document.getElementById('app');
if (root === null) throw new Error('#app root element not found');
const mount: HTMLElement = root;

let currentState: AppState = { kind: 'idle' };

// Cache the derived button color per game id so we don't recompute on every re-render.
const buttonColorCache = new Map<string, ButtonColors | null>();

function formatPlaytime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return 'less than a minute';
}

function formatDate(iso: string | null): string {
  if (iso === null) return 'never launched';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString('en-US');
}

function clear(): void {
  while (mount.firstChild !== null) mount.removeChild(mount.firstChild);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setHeroBackground(game: GameInfo): void {
  if (game.heroImageDataUrl !== undefined) {
    mount.style.backgroundImage = `url("${game.heroImageDataUrl}")`;
  } else {
    mount.style.backgroundImage = 'none';
  }
}

function renderInfoBlock(game: GameInfo): HTMLElement {
  const panel = el('div', 'panel');
  panel.appendChild(el('h1', 'title', game.title));

  const meta = el('div', 'meta');
  meta.appendChild(el('div', 'meta-row', `Last played: ${formatDate(game.lastPlayedAt)}`));
  meta.appendChild(el('div', 'meta-row', `Playtime: ${formatPlaytime(game.totalPlaySeconds)}`));
  meta.appendChild(el('div', 'meta-row', `Launches: ${String(game.launchCount)}`));
  panel.appendChild(meta);
  return panel;
}

function setButtonColors(button: HTMLButtonElement, colors: ButtonColors): void {
  button.style.setProperty('--btn-bg', colors.bg);
  button.style.setProperty('--btn-fg', colors.fg);
}

// Derives the button color from the hero background. If there's no background or it fails to
// load/decode, nothing is set and the button keeps its default color via the CSS fallback.
function applyButtonColor(button: HTMLButtonElement, game: GameInfo): void {
  const dataUrl = game.heroImageDataUrl;
  if (dataUrl === undefined) return;

  const cached = buttonColorCache.get(game.id);
  if (cached !== undefined) {
    if (cached !== null) setButtonColors(button, cached);
    return;
  }
  void computeButtonColors(dataUrl).then((colors) => {
    buttonColorCache.set(game.id, colors);
    if (colors !== null) setButtonColors(button, colors);
  });
}

function renderReady(game: GameInfo): void {
  setHeroBackground(game);
  const panel = renderInfoBlock(game);

  const button = el('button', 'launch-button', 'Play');
  button.type = 'button';
  button.addEventListener('click', () => window.api.requestLaunch());
  applyButtonColor(button, game);
  panel.appendChild(button);

  mount.appendChild(panel);
}

function renderBusy(game: GameInfo, message: string): void {
  setHeroBackground(game);
  const panel = renderInfoBlock(game);
  panel.appendChild(el('div', 'spinner'));
  panel.appendChild(el('div', 'status', message));
  mount.appendChild(panel);
}

function renderRunning(game: GameInfo): void {
  setHeroBackground(game);
  const panel = renderInfoBlock(game);
  panel.appendChild(el('div', 'status', 'Game running'));
  panel.appendChild(el('div', 'warning', '⚠ Do not remove the card while the game is running'));
  mount.appendChild(panel);
}

function renderError(game: GameInfo | undefined, message: string): void {
  if (game !== undefined) setHeroBackground(game);
  else mount.style.backgroundImage = 'none';
  const panel = el('div', 'panel');
  if (game !== undefined) panel.appendChild(el('h1', 'title', game.title));
  panel.appendChild(el('div', 'error-badge', 'Error'));
  panel.appendChild(el('div', 'status', message));
  mount.appendChild(panel);
}

function renderIdle(): void {
  mount.style.backgroundImage = 'none';
  const panel = el('div', 'panel');
  panel.appendChild(el('h1', 'title', 'microSD Game Launcher'));
  panel.appendChild(el('div', 'status', 'Insert a game card'));
  mount.appendChild(panel);
}

function render(state: AppState): void {
  clear();
  mount.dataset['kind'] = state.kind;
  switch (state.kind) {
    case 'idle':
      renderIdle();
      return;
    case 'ready':
      renderReady(state.game);
      return;
    case 'syncing-in':
      renderBusy(state.game, 'Syncing saves…');
      return;
    case 'launching':
      renderBusy(state.game, 'Launching game…');
      return;
    case 'running':
      renderRunning(state.game);
      return;
    case 'syncing-out':
      renderBusy(state.game, 'Saving progress to card…');
      return;
    case 'error':
      renderError(state.game, state.message);
      return;
  }
}

const gamepad = createGamepadController(() => {
  if (currentState.kind === 'ready') window.api.requestLaunch();
});

window.api.onStateUpdate((state) => {
  currentState = state;
  render(state);
});

void window.api.requestState().then((state) => {
  currentState = state;
  render(state);
});

gamepad.start();
