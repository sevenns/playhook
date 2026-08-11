// Renderer UI logic — the assembly point. Drives a persistent DOM (built once in index.html) by toggling
// classes and data-attributes per AppState, so CSS transitions animate smoothly between states. The
// autonomous subsystems live in their own modules: hero background + palette (hero.ts), the interaction
// layer — popups, focus, actions (controls.ts) — and the pure state views (state-view.ts). render() here
// wires them together and owns only the bits that don't belong to any one subsystem (phase attribute,
// info panel, title slide, music gating).
// IMPORTANT: title/data come from the card (untrusted) — rendered via textContent, never innerHTML.
import type { AppState, BrowseInfo, LibraryEntry, Stats } from '../shared/types';
import { createTranslator, type Locale, type Translator, type MessageKey } from '../shared/i18n/index.js';
import { localizeDocument } from './i18n-dom.js';
import { createAudioController } from './audio.js';
import { createHeroController } from './hero.js';
import { createControls } from './controls.js';
import { createCarousel } from './carousel.js';
import { formatDate, formatPlaytime } from './format.js';
import { busyKindOf, gameOf, phaseOf, statusOf, steamBusy } from './state-view.js';
import { req } from './dom.js';

const app = req('app');
const titleEl = req('title');
const statusEl = req('status');
const infoPanel = req('info-panel');

let currentState: AppState = { kind: 'idle' };
// What is ON SCREEN (main's browse:update): the source of truth for the title, the stats, the background
// and the music — for a game on the inserted card AND for one that only exists in the history. AppState
// stays the truth for the PHASE (busy/ready/error) and the status text. null = neither card nor history,
// i.e. the genuine "Insert a game card" screen. See BrowseInfo in shared/types.
let currentBrowse: BrowseInfo | null = null;
// The carousel hid the title + status for a pending selection change; the next render reveals the new one.
let textSwapPending = false;
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
// Both hooks read the BROWSE model, not AppState: a history game is browsed while the state is `idle`,
// where `gameOf` is undefined. Left on AppState, hasGameOnScreen would suppress the rotation AND the very
// first frame (hero.ts guards both), and every history game would share the palette cache key `#index`,
// bleeding one game's background colors into another's.
const hero = createHeroController({
  hasGameOnScreen: () => currentBrowse !== null,
  getGameId: () => currentBrowse?.id ?? '',
  getTranslator,
});

// ── Interaction layer (popups + focus + actions, see controls.ts) ────────────
// Owns the popups (Details / Power / Confirm / Error), the focus groups and the
// actions they trigger, plus their wiring (clicks, hover, gamepad, Esc). render() drives it via
// applyGameButtons/clearGameButtons/refresh; main's error goes to showError; the gamepad loop starts
// with start(). The carousel seam below routes A/B/left/right when the strip is the active surface.
const controls = createControls({
  getState: () => currentState,
  getBrowse: () => currentBrowse,
  audio,
  getTranslator,
  // Read lazily: the carousel is created below (it needs `controls` for its own callbacks), so the seam
  // is a set of thunks rather than the object itself.
  carousel: {
    screen: () => carousel.screen(),
    move: (delta) => carousel.move(delta),
    activate: () => carousel.activate(),
    leaveDetail: () => leaveDetail(),
    exists: () => carousel.exists(),
  },
});

// ── History carousel (the top-level screen, see carousel.ts) ─────────────────
// The strip of game cards and the `carousel`/`detail` level live there; this module wires it to main
// (list, artwork, browse) and to the interaction layer (nav sounds, focus routing).

// Background parallax while flipping through the strip: design px per card, and the cap the total drift
// never exceeds. The budget is what the hero's Ken Burns pan leaves over: at its minimum scale (1.06)
// there are ~58 design px of overscan per side, and the pan itself already spends up to 1.5% (~29 px) of
// it — so the parallax may claim at most the remaining ~29, or a corner of the wallpaper shows through.
const HERO_PARALLAX_STEP = 8;
const HERO_PARALLAX_MAX = 24;
let heroParallax = 0;

// The id this renderer last asked main to browse. It tells the two DIRECTIONS apart: an update carrying
// this id is main answering US (the strip is already there), anything else is main deciding on its own —
// a card inserted, a game picked — and then the strip has to follow it (see applyBrowse).
let requestedBrowseId: string | null = null;
// Set when the user opens a detail screen themselves (A / a click). It keeps a later list update — a
// finished session, an eviction — from bouncing them back to the carousel mid-install.
let userChoseDetail = false;

const carousel = createCarousel({
  requestGrid: (id) => window.api.requestGrid(id),
  // Sent on every step, undebounced: main answers the LIGHT part (title/stats/status) immediately and
  // debounces only the heavy hero/music read — so the text never lags behind the highlighted card.
  browseGame: (id) => {
    requestedBrowseId = id;
    window.api.browseGame(id);
  },
  onScreenChange: (screen) => {
    // The carousel clicks with the bundled fallback sounds; a game's own sounds belong to its screen.
    audio.setSfxScope(screen === 'carousel' ? 'fallback' : 'game');
    controls.refresh();
    render(currentState);
  },
  onActivate: (entry) => {
    // Entering a card is an ordinary button press — same cue as any other "open" action.
    audio.play('button');
    userChoseDetail = true;
    // An active game must also become the CARD's selected game (main rebuilds its hero/audio/GameInfo).
    // If that is refused — a launch or install is in flight — the detail screen is still correct: it is
    // drawn from the browse model, so it shows the game you picked, just without an actionable Play.
    if (entry.active && gameOf(currentState)?.id !== entry.id) window.api.selectGame(entry.id);
    carousel.setScreen('detail');
  },
  onNavigate: (delta) => {
    audio.play('navigate');
    // Parallax: the background drifts the same way the strip does, one notch per card, bounded so it
    // stays inside the pan's own headroom (see #hero). Moving back unwinds it.
    heroParallax = Math.max(
      -HERO_PARALLAX_MAX,
      Math.min(HERO_PARALLAX_MAX, heroParallax - delta * HERO_PARALLAX_STEP),
    );
    hero.setParallax(heroParallax);
    // Cut the outgoing text immediately: the new one arrives with the (debounced) browse answer, and a
    // stale name sitting next to the new card for a third of a second reads as a bug. render() fades the
    // replacement back in — see textSwapPending. The status line goes with it: the two are one block, and
    // a lingering "Installing…" over the next card is the same lie the stale title would be.
    titleEl.classList.add('is-swapping');
    statusEl.classList.add('is-swapping');
    textSwapPending = true;
  },
});

/** Back out of a detail screen to the carousel (B). False when there is no carousel to return to. */
function leaveDetail(): boolean {
  if (!carousel.exists() || carousel.screen() !== 'detail') return false;
  userChoseDetail = false;
  carousel.setScreen('carousel');
  return true;
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

function buildInfoPanel(stats: Stats): void {
  while (infoPanel.firstChild !== null) infoPanel.removeChild(infoPanel.firstChild);
  infoPanel.append(
    infoItem(translator('launcher.info.lastPlayed'), formatDate(stats.lastPlayedAt, translator, currentLocale)),
    infoItem(translator('launcher.info.playtime'), formatPlaytime(stats.totalPlaySeconds, translator)),
    infoItem(translator('launcher.info.launches'), String(stats.launchCount)),
  );
}

// ── Title / status busy layout ──────────────────────────────────────────────
// While busy (or during a Steam install/uninstall indicator) the title drops DOWN and the status line
// fades in above it — a two-line block that keeps the long title fully visible (it no longer slides
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
// The status belongs to the game AppState is about, so it is blank while you look at a DIFFERENT game
// ("Installing…" under another game's cover would be a lie — the busy game is marked by its pulsing dot
// on the carousel instead).
function applyStatus(): void {
  statusEl.textContent = statusText();
  // The two-line block (status above, title below) is keyed on the TEXT being there, not on the phase:
  // browsing another card while a game installs shows no status, and the title must stay put there.
  if (statusEl.textContent === '') delete app.dataset['status'];
  else app.dataset['status'] = 'shown';
}

/** The status line for what is ON SCREEN — empty while looking at a game the state isn't about. */
function statusText(): string {
  const subject = gameOf(currentState)?.id;
  if (currentBrowse !== null && subject !== undefined && subject !== currentBrowse.id) return '';
  const base = statusOf(currentState, translator);
  return chatterSuffix !== null && currentState.kind === chatterKind
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
  const prev = currentState;
  currentState = state;
  const phase = phaseOf(state);
  const game = gameOf(state);

  app.dataset['phase'] = phase;

  // What is on screen comes from the BROWSE model, not from AppState: with the card pulled the state is
  // `idle` while the history still has games to show, and while game A installs you may be looking at
  // game B. The single-game card case is unchanged by construction — there browse.id === state.game.id.
  const browse = currentBrowse;
  if (browse !== null) {
    // Hero images travel on their own channels (hero:update / browse:hero), independent of state:update —
    // on a window reconnect render can arrive before the payload. Only paint when we already have images;
    // an empty list means "wait for the push" (it back-fills), rather than blanking the background.
    hero.repaint();
    titleEl.textContent = browse.title;
    if (textSwapPending) {
      textSwapPending = false;
      // Next frame, so the browser sees the hidden state first and actually animates the fade back in
      // (dropping the class in the same frame as the text would be coalesced into no transition at all).
      // The status is revealed together with the title — applyStatus (below) has already put the new
      // line in, or emptied it, by the time this frame runs.
      requestAnimationFrame(() => {
        titleEl.classList.remove('is-swapping');
        statusEl.classList.remove('is-swapping');
      });
    }
    buildInfoPanel(browse.stats);
    controls.applyGameButtons();
  } else {
    // No card AND no history → the empty "Insert a game card" screen (wallpaper background). Clear any
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

  // no-play layout: Play is hidden and the title moves to x=50. TWO cases now, both only on the detail
  // screen: (a) a requiresInstall installer/steam game on the ready screen (and NOT steam-busy, when the
  // gear must stay visible) — as before; (b) a HISTORY game, which has no card behind it, so there is
  // nothing to launch — it looks exactly like an uninstalled game (title + More).
  // Whether the selected card has a Play button waiting for it on the detail screen. Unlike `no-play`
  // below this holds on BOTH screens, because it decides how the card TRANSITIONS: with a Play it hands
  // its geometry to the button (a swap, then a morph); without one it has nothing to hand over and
  // shrinks away instead — and coming back, only the morph case waits for the button to grow (styles.css).
  const hasPlay =
    browse !== null &&
    browse.active &&
    !(phase === 'ready' && browse.game?.requiresInstall === true && !busySteam);
  app.dataset['cardMorph'] = hasPlay ? 'on' : 'off';

  // Only on the detail screen: in the carousel Play is hidden anyway, and the attribute's `.title{left:0}`
  // half would fight the carousel's own title placement.
  const noPlay = carousel.screen() === 'detail' && !hasPlay && browse !== null;
  if (noPlay) app.dataset['layout'] = 'no-play';
  else delete app.dataset['layout'];

  // The busy game keeps a pulsing dot on its own card, so "game A is installing" stays visible while you
  // browse game B (whose status line is blank — see applyStatus).
  const busyGame = phase === 'busy' || busySteam ? (gameOf(state)?.id ?? null) : null;
  carousel.setBusyGame(busyGame);

  syncChatter(state);
  applyStatus();

  // Force-close popups off the ready screen, then re-apply the focus highlight (see controls.refresh).
  controls.refresh();
  syncMusic();

  // Empty-screen error (Р8, point 1): a card that fails to load sets state=error with no game. In Game
  // Mode the window is shown (no tray to hide into), so surface the reason over the empty screen via the
  // error popup. Only on ENTERING the error (prev not already error) so a locale/wallpaper re-render
  // doesn't re-pop a popup the user has closed. Desktop/Windows keep hiding, so this rarely fires there.
  if (state.kind === 'error' && game === undefined && prev.kind !== 'error') {
    controls.showError(state.message);
  }
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

// What is on screen (title / stats / active / GameInfo). Subscribe BEFORE the seed, like every other
// channel here, so a push arriving in between isn't lost.
function applyBrowse(browse: BrowseInfo | null): void {
  currentBrowse = browse;
  // Main moved the screen onto a game we didn't ask for — inserting a card switches to ITS game — so the
  // strip must follow, or the title/background belong to one game while the highlighted card is another.
  // Guarded by the requested id: while flipping, a late answer must NOT drag the selection backwards.
  if (browse !== null && browse.id !== requestedBrowseId) {
    requestedBrowseId = browse.id;
    carousel.focusGame(browse.id);
  }
  render(currentState);
}
window.api.onBrowseUpdate(applyBrowse);
void window.api.requestBrowse().then((browse) => {
  applyBrowse(browse);
  // The seed carries the INFO only; asking main to browse the same game again replays its hero/music, so
  // a reloaded window doesn't come back with a blank background.
  if (browse !== null) window.api.browseGame(browse.id);
});

// The browsed game's background: a channel of its own, so a history game can be shown without touching
// the inserted card's hero:update payload (which stays valid for the card's selected game).
window.api.onBrowseHero((assets) => hero.applyBrowseAssets(assets));

// The browsed game's music. Music ONLY — the SFX set is never rebuilt by browsing, so flipping through
// the carousel doesn't re-create the sound elements on every step.
window.api.onBrowseMusic((url) => {
  audio.setBrowseMusic(url);
  syncMusic();
});

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

// The default ambience is app-wide (set in the settings window) and delivered on its own channel; the
// audio engine plays it only while the card has no music of its own (a game's music always wins) and
// crossfades between the two. Seed on startup and update live. syncMusic re-asserts the gate so a seed
// arriving before the first visibility sync still starts (or stays paused) correctly.
window.api.onAmbientUpdate((url) => {
  audio.setAmbient(url);
  syncMusic();
});
void window.api.requestAmbient().then((url) => {
  audio.setAmbient(url);
  syncMusic();
});

// The bundled fallback UI sounds for the carousel level (a game's own sounds stay on its own screen).
window.api.onAudioDefaults((assets) => audio.setFallbackSounds(assets));
void window.api.requestAudioDefaults().then((assets) => audio.setFallbackSounds(assets));

// One-shot UI sounds pushed from main (main has no <audio> — the renderer owns playback). Used for the
// "play" sound when an install/copy/Steam download completes, where the trigger lives in main.
window.api.onSfxPlay((name) => audio.play(name));

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

// The carousel list (the inserted card's games + the play history, already ordered) arrives on its own
// channel. Seed on startup (back-fill after a window reconnect), then live updates.
function applyLibrary(games: readonly LibraryEntry[]): void {
  carousel.setGames(games);
  // The carousel is the default level whenever there is more than one game to flip through — but never
  // yank the user out of a detail screen they opened themselves (they may be watching an install run).
  if (carousel.exists() && !userChoseDetail) carousel.setScreen('carousel');
  render(currentState);
}
window.api.onLibraryUpdate((library) => applyLibrary(library?.games ?? []));
void window.api.requestLibrary().then((library) => applyLibrary(library?.games ?? []));

// Game Mode (gamescope) is static for the process — seed it once so the power menu shows "Close Playhook"
// (full quit) instead of the no-op "Minimize Playhook".
void window.api.requestGameMode().then((value) => controls.setGameMode(value));

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
