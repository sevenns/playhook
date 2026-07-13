// Renderer UI logic — the assembly point. Drives a persistent DOM (built once in index.html) by toggling
// classes and data-attributes per AppState, so CSS transitions animate smoothly between states. The
// autonomous subsystems live in their own modules: hero background + palette (hero.ts), the interaction
// layer — popups, focus, actions (controls.ts) — and the pure state views (state-view.ts). render() here
// wires them together and owns only the bits that don't belong to any one subsystem (phase attribute,
// info panel, title slide, music gating).
// IMPORTANT: title/data come from the card (untrusted) — rendered via textContent, never innerHTML.
import type { AppState, GameInfo } from '../shared/types';
import { createTranslator, type Locale, type Translator, type MessageKey } from '../shared/i18n/index.js';
import { localizeDocument } from './i18n-dom.js';
import { createAudioController } from './audio.js';
import { createHeroController } from './hero.js';
import { createControls } from './controls.js';
import { formatDate, formatPlaytime } from './format.js';
import { busyKindOf, gameOf, phaseOf, statusOf, steamBusy } from './state-view.js';
import { req } from './dom.js';

const app = req('app');
const titleEl = req('title');
const statusEl = req('status');
const infoPanel = req('info-panel');

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
// Owns the popups (incl. the "Select game" list for a multi-game card), the two focus groups and the
// actions they trigger, plus their wiring (clicks, hover, gamepad, Esc). render() drives it via
// applyGameButtons/clearGameButtons/refresh; main's error goes to showError; the game list arrives via
// setGames; the gamepad loop starts with start().
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

// ── Title / status busy layout ──────────────────────────────────────────────
// While busy (or during a Steam install/uninstall indicator) the title lifts UP and the status line
// fades in below it — a two-line block that keeps the long title fully visible (it no longer slides
// right into the More button). Both moves are pure CSS, keyed off #app[data-phase]/[data-steam-busy]
// (see styles.css), so there's no JS measurement here anymore.

// ── Background music gating ──────────────────────────────────────────────────

// Music plays only while the launcher is actually on screen: the window must be visible
// (not hidden to tray / minimized) and no game running (the game covers the launcher).
function syncMusic(): void {
  const visible = document.visibilityState === 'visible';
  const running = currentState.kind === 'running';
  audio.setMusicPlaying(visible && !running);
}

// ── "Chatter": a rotating funny suffix for long busy phases (install / Proton config — Р7j) ──────────
// The base status ("Установка..." / "Конфигурация Proton...") shows alone for the first MINUTE; after that
// a random funny suffix is APPENDED and swapped every 20s, so a long silent install/provision doesn't feel
// stuck. Renderer-owned (pure presentation) — main only sets the base state.
const CHATTER_DELAY_MS = 60_000; // base-only for the first minute
const CHATTER_ROTATE_MS = 20_000; // then swap the funny suffix every 20 seconds
const INSTALL_SUFFIX_KEYS: readonly MessageKey[] = [
  'launcher.installChatter1',
  'launcher.installChatter2',
  'launcher.installChatter3',
  'launcher.installChatter4',
  'launcher.installChatter5',
  'launcher.installChatter6',
  'launcher.installChatter7',
  'launcher.installChatter8',
  'launcher.installChatter9',
  'launcher.installChatter10',
];
// Reuse the Proton funny lines as suffixes appended to "Configuring Proton..." (protonConfig1 is the base).
const PROTON_SUFFIX_KEYS: readonly MessageKey[] = [
  'launcher.protonConfig2',
  'launcher.protonConfig3',
  'launcher.protonConfig4',
  'launcher.protonConfig5',
  'launcher.protonConfig6',
  'launcher.protonConfig7',
  'launcher.protonConfig8',
  'launcher.protonConfig9',
  'launcher.protonConfig10',
  'launcher.protonConfig11',
  'launcher.protonConfig12',
];

type ChatterKind = 'installing' | 'configuringProton';
let chatterKind: ChatterKind | null = null;
let chatterSuffix: MessageKey | null = null;
let chatterDelayTimer = 0;
let chatterRotateTimer = 0;

function chatterPool(kind: ChatterKind): readonly MessageKey[] {
  return kind === 'installing' ? INSTALL_SUFFIX_KEYS : PROTON_SUFFIX_KEYS;
}

function stopChatterTimers(): void {
  if (chatterDelayTimer !== 0) {
    window.clearTimeout(chatterDelayTimer);
    chatterDelayTimer = 0;
  }
  if (chatterRotateTimer !== 0) {
    window.clearInterval(chatterRotateTimer);
    chatterRotateTimer = 0;
  }
}

function rotateChatter(kind: ChatterKind): void {
  const pool = chatterPool(kind);
  chatterSuffix = pool[Math.floor(Math.random() * pool.length)] ?? null;
  applyStatus();
}

// Sets the status line: the base label for the current state, plus the current funny suffix when active.
function applyStatus(): void {
  const base = statusOf(currentState, translator);
  statusEl.textContent =
    chatterSuffix !== null && currentState.kind === chatterKind
      ? `${base} ${translator(chatterSuffix)}`
      : base;
}

// (Re)starts / stops the chatter timer as the state enters/leaves a long busy phase. First suffix appears
// at the first tick (~1 min); base-only before that. A phase change resets it (each phase gets its minute).
function syncChatter(state: AppState): void {
  const kind: ChatterKind | null =
    state.kind === 'installing' || state.kind === 'configuringProton' ? state.kind : null;
  if (kind === chatterKind) return; // same phase (or same non-phase) — keep the running timers
  stopChatterTimers();
  chatterKind = kind;
  chatterSuffix = null; // base only for the first minute
  if (kind !== null) {
    chatterDelayTimer = window.setTimeout(() => {
      chatterDelayTimer = 0;
      rotateChatter(kind); // first funny suffix at 1 minute
      chatterRotateTimer = window.setInterval(() => rotateChatter(kind), CHATTER_ROTATE_MS); // then every 20s
    }, CHATTER_DELAY_MS);
  }
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
    // idle / no-game error → the empty "Insert a game card" screen (wallpaper background). Clear any
    // stale stats so the empty screen's Details menu (opened via More) shows just System + Close.
    hero.applyEmptyScreen();
    while (infoPanel.firstChild !== null) infoPanel.removeChild(infoPanel.firstChild);
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
  // in every other state (idle/error move the title via their own per-phase rule).
  const noPlay = phase === 'ready' && game?.requiresInstall === true && !busySteam;
  if (noPlay) app.dataset['layout'] = 'no-play';
  else delete app.dataset['layout'];

  syncChatter(state);
  applyStatus();

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

// Live custom-wallpaper updates (settings window changed the Empty-screen background). An empty string
// means "no custom / bundle unreadable" → treat as null. Repaint immediately if we're on the Empty screen.
window.api.onWallpaperUpdate((url) => {
  hero.setWallpaper(url === '' ? null : url);
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

// Gate gamepad input on window focus: a backgrounded launcher (a game on top — most visibly under
// gamescope, where Chromium keeps feeding the unfocused window input) must not act on presses meant for
// the game. Resumes the instant the user switches back to the launcher (it regains focus).
window.api.onWindowFocus((focused) => controls.setGamepadPaused(!focused));

// Hero images are delivered on their own channel (not in AppState): the renderer rotates through them
// locally, so we never re-send this large payload on every state transition. See hero.applyAssets.
window.api.onHeroUpdate((assets) => hero.applyAssets(assets));
void window.api.requestHero().then((assets) => hero.applyAssets(assets));

// The card's game list ({id,title}) is delivered on its own channel; controls uses it to build the
// "Select game" popup. Seed on startup (back-fill after a window reconnect), then live updates.
window.api.onLibraryUpdate((library) => controls.setGames(library?.games ?? []));
void window.api.requestLibrary().then((library) => controls.setGames(library?.games ?? []));

// Pause/resume music AND the hero rotation when the window is hidden to tray or restored. The active
// layer keeps showing the current hero, so no force-show is needed on return — just (re)start the timer.
document.addEventListener('visibilitychange', () => {
  syncMusic();
  hero.startRotation();
});

controls.start();

// Wake-from-sleep guard for background music. JS timers don't advance while the machine is suspended,
// so a ballooned gap between heartbeats means we just resumed — and the OS may have torn down the audio
// session, leaving the looping music silent while UI sounds (fresh clones) still work. Re-sync to
// re-issue play(). visibilitychange doesn't cover this: the window can stay visible across sleep.
let lastHeartbeat = Date.now();
window.setInterval(() => {
  const now = Date.now();
  const resumedFromSleep = now - lastHeartbeat > 5000;
  lastHeartbeat = now;
  if (resumedFromSleep) syncMusic();
}, 2000);
