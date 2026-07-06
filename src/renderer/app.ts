// Renderer UI logic — the assembly point. Drives a persistent DOM (built once in index.html) by toggling
// classes and data-attributes per AppState, so CSS transitions animate smoothly between states. The
// autonomous subsystems live in their own modules: hero background + palette (hero.ts), the interaction
// layer — popups, focus, actions (controls.ts) — and the pure state views (state-view.ts). render() here
// wires them together and owns only the bits that don't belong to any one subsystem (phase attribute,
// info panel, title slide, music gating).
// IMPORTANT: title/data come from the card (untrusted) — rendered via textContent, never innerHTML.
import type { AppState, GameInfo } from '../shared/types';
import { createTranslator, type Locale, type Translator } from '../shared/i18n/index.js';
import { localizeDocument } from './i18n-dom.js';
import { createAudioController } from './audio.js';
import { createHeroController } from './hero.js';
import { createControls } from './controls.js';
import { formatDate, formatPlaytime } from './format.js';
import { busyKindOf, gameOf, phaseOf, statusOf, steamBusy } from './state-view.js';
import { req, reqQuery } from './dom.js';

const app = req('app');
const titleEl = req('title');
const statusEl = req('status');
const infoPanel = req('info-panel');
const barContent = reqQuery<HTMLElement>('.bar-content');

let currentState: AppState = { kind: 'idle' };
// UI locale + translator (both refreshed on a language push). The HTML ships English fallback text, so
// until the invoke-seed lands there is no blank flash — the seed then localizes and re-renders.
let currentLocale: Locale = 'en';
let translator: Translator = createTranslator(currentLocale);
const getTranslator = (): Translator => translator;
const audio = createAudioController();

// ── Hero background + palette (own subsystem, see hero.ts) ───────────────────
// The hero layers, cross-fade, renderer-local rotation, the empty/idle wallpaper screen and the
// two-color palette live in hero.ts. It reaches back for just two things: whether a game is on screen
// and the current game id (for the per-hero palette cache key). render() drives it via repaint/
// startRotation/applyEmptyScreen; the hero:update channel feeds applyAssets; main's wallpaper feeds
// setWallpaper.
const hero = createHeroController({
  hasGameOnScreen: () => gameOf(currentState) !== undefined,
  getGameId: () => gameOf(currentState)?.id ?? '',
  getTranslator,
});

// ── Interaction layer (popups + focus + actions, see controls.ts) ────────────
// Owns the popups, the two focus groups and the actions they trigger, plus their wiring (clicks, hover,
// gamepad, Esc). render() drives it via applyGameButtons/clearGameButtons/refresh; main's error goes to
// showError; the gamepad loop starts with start().
const controls = createControls({ getState: () => currentState, audio, getTranslator });

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
    infoItem(translator('launcher.info.lastPlayed'), formatDate(game.lastPlayedAt, translator, currentLocale)),
    infoItem(translator('launcher.info.playtime'), formatPlaytime(game.totalPlaySeconds, translator)),
    infoItem(translator('launcher.info.launches'), String(game.launchCount)),
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

// ── Background music gating ──────────────────────────────────────────────────

// Music plays only while the launcher is actually on screen: the window must be visible
// (not hidden to tray / minimized) and no game running (the game covers the launcher).
function syncMusic(): void {
  const visible = document.visibilityState === 'visible';
  const running = currentState.kind === 'running';
  audio.setMusicPlaying(visible && !running);
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
    hero.repaint();
    titleEl.textContent = game.title;
    buildInfoPanel(game);
    controls.applyGameButtons();
  } else {
    // idle / no-game error → the empty "Insert a game card" screen (wallpaper background).
    hero.applyEmptyScreen();
    controls.clearGameButtons();
  }

  // Re-evaluate the hero rotation for the new state (start when eligible: >1 image, visible, a game on
  // screen; stop otherwise, e.g. on the idle screen). Idempotent — see hero.startRotation.
  hero.startRotation();

  // Steam non-blocking install/uninstall indicator: reuse the busy visuals (loader/status/slid title)
  // via a dedicated attribute, while the logical phase stays 'ready' (window hideable, card pullable).
  const busySteam = steamBusy(state);
  if (busySteam) app.dataset['steamBusy'] = 'true';
  else delete app.dataset['steamBusy'];

  // Play-button busy visual: gear (system activity) vs spinner (game phases). Absent when not busy.
  const busyKind = busyKindOf(state);
  if (busyKind !== 'none') app.dataset['busy'] = busyKind;
  else delete app.dataset['busy'];

  // no-play layout: a requiresInstall installer/steam game on the ready screen (and NOT steam-busy, when
  // the gear must stay visible) hides Play and moves the title to x=50. Set here by phase so it is cleared
  // in every other state, including idle/error — a stale attribute would push the title over Hide.
  const noPlay = phase === 'ready' && game?.requiresInstall === true && !busySteam;
  if (noPlay) app.dataset['layout'] = 'no-play';
  else delete app.dataset['layout'];

  statusEl.textContent = statusOf(state, translator);
  applyTitleSlide(phase === 'busy' || busySteam);

  // Force-close popups off the ready screen, then re-apply the focus highlight (see controls.refresh).
  controls.refresh();
  syncMusic();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

// UI locale: subscribe BEFORE the invoke-seed so a push arriving in between isn't lost (seed pattern).
// A push rebuilds the translator, re-localizes the static DOM and re-renders the current state (info
// panel, status, title, button aria all flow through the translator) — no new caches needed.
function applyLocale(locale: Locale): void {
  currentLocale = locale;
  translator = createTranslator(locale);
  document.documentElement.lang = locale;
  localizeDocument(translator);
  render(currentState);
}
window.api.onLanguageUpdate(applyLocale);
void window.api.getLanguage().then(applyLocale);

window.api.onStateUpdate(render);
void window.api.requestState().then(render);

// A failed launch returns to 'ready' and sends the reason here to open the error popup.
window.api.onError((messageText) => controls.showError(messageText));

// Fallback wallpaper for the empty screen (data URL from main); apply if we're on it already.
void window.api.requestWallpaper().then((url) => {
  hero.setWallpaper(url);
  if (gameOf(currentState) === undefined) hero.applyEmptyScreen();
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

// Audio volumes are app-wide (set in the settings window): seed them on startup and update live.
const applyVolumes = (volumes: { music: number; sfx: number }): void => {
  audio.setMusicVolume(volumes.music);
  audio.setSfxVolume(volumes.sfx);
};
window.api.onVolumesUpdate(applyVolumes);
void window.api.requestVolumes().then(applyVolumes);

// Hero images are delivered on their own channel (not in AppState): the renderer rotates through them
// locally, so we never re-send this large payload on every state transition. See hero.applyAssets.
window.api.onHeroUpdate((assets) => hero.applyAssets(assets));
void window.api.requestHero().then((assets) => hero.applyAssets(assets));

// Pause/resume music AND the hero rotation when the window is hidden to tray or restored. The active
// layer keeps showing the current hero, so no force-show is needed on return — just (re)start the timer.
document.addEventListener('visibilitychange', () => {
  syncMusic();
  hero.startRotation();
});

controls.start();

// Re-measure the title slide on resize while busy / steam-installing (keeps right-alignment correct).
window.addEventListener('resize', () => {
  if (shouldSlideTitle()) applyTitleSlide(true);
});
