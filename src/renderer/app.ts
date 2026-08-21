// Renderer UI logic — the assembly point. Drives a persistent DOM (built once in index.html) by toggling
// classes and data-attributes per AppState, so CSS transitions animate smoothly between states. The
// autonomous subsystems live in their own modules: hero background + palette (hero.ts), the interaction
// layer — popups, focus, actions (controls.ts) — and the pure state views (state-view.ts). render() here
// wires them together and owns only the bits that don't belong to any one subsystem (phase attribute,
// info panel, title slide, music gating).
// IMPORTANT: title/data come from the card (untrusted) — rendered via textContent, never innerHTML.
import type { AppNotification, AppState, BrowseInfo, LibraryEntry, Stats } from '../shared/types';
import { createTranslator, type Locale, type Translator, type MessageKey } from '../shared/i18n/index.js';
import { localizeDocument } from './i18n-dom.js';
import { AUTO_CHAIN_MS, NAV_REPEAT_MS } from './auto-repeat.js';
import { createAudioController } from './audio.js';
import { createHeroController } from './hero.js';
import { createControls } from './controls.js';
import { createSettingsScreen, type SettingsScreenApi } from './settings-screen.js';
import {
  createGameSettingsScreen,
  type GameSettingsScreenApi,
} from './game-settings-screen.js';
import { createOsk } from './osk.js';
import { createFilePicker } from './file-picker.js';
import { createMetadataPicker } from './metadata-picker.js';
import { createCarousel } from './carousel.js';
import { createCardArtCache } from './card-art.js';
import { createLibraryScreen } from './library-screen.js';
import { createToast } from './toast.js';
import { formatDate, formatNotification, formatPlaytime } from './format.js';
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
// A direction is being held. While it is, the title/status stay hidden rather than being re-revealed on
// every step: at the repeat cadence that is a name flashing nine times a second next to a row that is
// still moving, and nobody can read it anyway. The end of the run brings it back.
let stripFlipping = false;
/**
 * How long after a release the run is still treated as GOING. Letting go for a beat and pressing again
 * is one continuous auto-move to the user (auto-repeat.ts chains the two), and everything that waits for
 * the flip to end is expensive: the hero swap is a megabyte-sized cross-fade, the palette rides along
 * with it, and the carousel fetches the covers around wherever it stopped. Firing all of that into every
 * gap of a rapid press-release-press is exactly what made the background stutter.
 *
 * The window has to outlast the chain itself PLUS the first repeat of the new run — that is when the
 * flip is reported as started again — or a swap would slip through on the boundary.
 */
const FLIP_SETTLE_MS = AUTO_CHAIN_MS + NAV_REPEAT_MS;
/** Pending "the run is really over" (see FLIP_SETTLE_MS); 0 when the strip is at rest or flipping. */
let flipSettleTimer = 0;
// The games the strip currently holds, kept so a notification about one can be resolved to an entry —
// the carousel keeps the list too, but only the id/active pair is needed here (see openGameDetail).
let currentGames: readonly LibraryEntry[] = [];
// The notification inbox, exactly as main last pushed it. The popup list and the More item's unread dot
// are drawn from this and nothing else: main owns the inbox, the renderer only shows it.
let notificationItems: readonly AppNotification[] = [];
// UI locale + translator (both refreshed on a language push). The HTML ships English fallback text, so
// until the invoke-seed lands there is no blank flash — the seed then localizes and re-renders.
let currentLocale: Locale = 'en';
let translator: Translator = createTranslator(currentLocale);
const getTranslator = (): Translator => translator;
const audio = createAudioController();

// ── Hero background + palette (own subsystem, see hero.ts) ───────────────────
// The hero layers, cross-fade, renderer-local rotation, the idle wallpaper background and the
// two-color palette live in hero.ts. It reaches back for just two things: whether a game is on screen
// and the current game id (for the per-hero palette cache key). render() drives it via repaint/
// startRotation/applyIdleBackground; the hero:update channel feeds applyAssets; main's wallpaper feeds
// setWallpaper.
// Both hooks read the BROWSE model, not AppState: a history game is browsed while the state is `idle`,
// where `gameOf` is undefined. Left on AppState, hasGameOnScreen would suppress the rotation AND the very
// first frame (hero.ts guards both), and every history game would share the palette cache key `#index`,
// bleeding one game's background colors into another's.
const hero = createHeroController({
  hasGameOnScreen: () => currentBrowse !== null,
  getGameId: () => currentBrowse?.id ?? '',
});

// ── Settings screen (the fourth surface, see settings-screen.ts) ─────────────
// The screen owns its rows and focus; everything it writes goes through this seam, which is main's
// settings:* channels one-to-one. The values it shows come back on settings:update (see the wiring
// below) — never from a setter's own return, so a reset and a live edit take the same path.
const settingsApi: SettingsScreenApi = {
  setAutoUpdate: (mode) => window.api.setAutoUpdate(mode),
  setPrerelease: (on) => window.api.setPrerelease(on),
  setSummonHotkey: (on) => window.api.setSummonHotkey(on),
  setPreventScreensaver: (on) => window.api.setPreventScreensaver(on),
  setKeepOpenWithoutCard: (on) => window.api.setKeepOpenWithoutCard(on),
  setDisableSilentInstall: (on) => window.api.setDisableSilentInstall(on),
  setSteamAutoLaunch: (on) => window.api.setSteamAutoLaunch(on),
  setSoundSet: (set) => window.api.setSoundSet(set),
  setAmbientTrack: (track) => window.api.setAmbientTrack(track),
  setOnlyGlobalAmbient: (on) => window.api.setOnlyGlobalAmbient(on),
  setMusicVolume: (volume) => window.api.setMusicVolume(volume),
  setSfxVolume: (volume) => window.api.setSfxVolume(volume),
  setLanguage: (mode) => window.api.setLanguage(mode),
  setSteamGridDbKey: (key) => window.api.setSteamGridDbKey(key),
  setRawgKey: (key) => window.api.setRawgKey(key),
  resetSettings: () => {
    void window.api.resetSettings();
  },
  checkForUpdates: () => window.api.checkForUpdates(),
  downloadUpdate: () => window.api.downloadUpdate(),
  installUpdate: () => window.api.installUpdate(),
};

// ── Interaction layer (popups + focus + actions, see controls.ts) ────────────
// Owns the popups (Details / Power / Confirm / Error), the focus groups and the
// actions they trigger, plus their wiring (clicks, hover, gamepad, Esc). render() drives it via
// applyGameButtons/clearGameButtons/refresh; main's error goes to showError; the gamepad loop starts
// with start(). The carousel seam below routes A/B/left/right when the strip is the active surface.
// The on-screen keyboard is built before the screens that use it: both Settings (the SteamGridDB key)
// and Customize (every text field) take it as a dependency, and only one of them is ever open.
const osk = createOsk({
  audio,
  getTranslator,
  readClipboard: () => window.api.readClipboard(),
});

const settingsScreen = createSettingsScreen({
  audio,
  getTranslator,
  api: settingsApi,
  keyboard: osk,
  // Read lazily for the same reason the carousel seam is: `controls` is created just below.
  onClosed: () => controls.settingsClosed(),
  onResetRequested: () => controls.confirmResetSettings(),
});

// ── Customize screen (the fifth surface, see game-settings-screen.ts) ────────
// Its two sub-surfaces are built first because the screen takes them as dependencies: the keyboard
// (above) is the only way to type anything here, and the file browser the only way to name a path with a
// gamepad.
const gameSettingsApi: GameSettingsScreenApi = {
  read: (id) => window.api.readGameConfig(id),
  validate: (root, text) => window.api.validateGameConfig(root, text),
  save: (request) => window.api.saveGameConfig(request),
  imagePreview: (root, path) => window.api.getGameConfigImage(root, path),
  sources: () => window.api.listGameConfigSources(),
  readRoot: (root) => window.api.readGameConfigRoot(root),
  forgetHistory: (id) => window.api.forgetGame(id),
  moveToCard: (request) => window.api.moveGameConfigToCard(request),
  acceptPath: (request) => window.api.acceptGameConfigPaths(request),
  searchMetadata: (query) => window.api.searchMetadata(query),
  requestSteamCandidate: (appId) => window.api.requestMetadataSteamCandidate(appId),
  metadataArtworkPreview: (variantKey) => window.api.requestMetadataArtworkPreview(variantKey),
  metadataMusicAlbums: (query) => window.api.searchMetadataMusic(query),
  metadataTracks: (albumKey) => window.api.requestMetadataTracks(albumKey),
  metadataTrackPreview: (trackKey) => window.api.requestMetadataTrackPreview(trackKey),
  metadataDescriptions: (candidateKey) => window.api.requestMetadataDescriptions(candidateKey),
  applyMetadata: (request) => window.api.applyMetadata(request),
  cancelMetadata: () => window.api.cancelMetadata(),
};
const filePicker = createFilePicker({
  audio,
  getTranslator,
  api: {
    listDir: (request) => window.api.listGameConfigDir(request),
    acceptPaths: (request) => window.api.acceptGameConfigPaths(request),
  },
});
// The online artwork gallery — the third surface that opens on top of Customize, beside the keyboard
// and the file browser. Its own picker seam keeps app.ts the only place window.api is touched.
const metadataPicker = createMetadataPicker({
  audio,
  getTranslator,
  api: {
    artwork: (candidateKey, kind) => window.api.requestMetadataArtwork(candidateKey, kind),
    cancel: () => window.api.cancelMetadata(),
  },
  // Read lazily: the screen is created just below, and it owns the lightbox the preview opens in.
  onPreview: (variantKey) => gameSettingsScreen.previewMetadataArtwork(variantKey),
});

const gameSettingsScreen = createGameSettingsScreen({
  audio,
  getTranslator,
  api: gameSettingsApi,
  keyboard: osk,
  picker: filePicker,
  metadataPicker,
  // Read lazily for the same reason the carousel seam is: `controls` is created just below.
  onClosed: () => {
    controls.settingsClosed();
    // Cancelled out of "Add game" — back to the library it was started from. On a SUCCESSFUL add this
    // still runs first (the screen closes before it reports the new game), and showAddedGame undoes it.
    //
    // Only when this screen was the TOP one, though. Reached through More → Customize it sits over a
    // DETAIL screen, and that screen is what closing it returns to — the Library's turn comes later,
    // when the detail screen itself is left (leaveDetail consumes the same flag).
    if (carousel.screen() !== 'detail') restoreOrigin();
  },
  onConfirmRequested: (kind) => controls.confirmGameSettings(kind),
  onAdded: (id) => showAddedGame(id),
  // Editing while the game runs is legal (Р3); DELETING it is not — the launcher would be left holding a
  // manifest the file no longer has.
  isBusy: () =>
    currentState.kind === 'running' ||
    currentState.kind === 'installing' ||
    currentState.kind === 'uninstalling' ||
    steamBusy(currentState),
});

// ── The notification toast (see toast.ts) ────────────────────────────────────
// Read lazily, for the same reason the carousel seam is: `controls` is created just below, and the two
// point at each other — the plate shares its corner with the popup column, so it waits while a popup is
// up and resumes when one closes.
// ── Library screen (the sixth surface, see library-screen.ts) ───────────────
// Its artwork cache is created here rather than inside it so the bound stays visible where the rest of
// the renderer's memory decisions are: it is the library's alone, the carousel keeps its own.
const libraryArt = createCardArtCache({ requestGrid: (id) => window.api.requestGrid(id) });
const libraryScreen = createLibraryScreen({
  audio,
  getTranslator,
  art: libraryArt,
  getGames: () => currentGames,
  // Read lazily for the same reason the carousel seam is: `controls` is created just below.
  onOpenGame: (id) => openGameDetail(id, 'library'),
  onAddGame: () => {
    // The Customize screen closing is what brings the library back (see restoreOrigin) — cancelled or
    // not. Set BEFORE the hand-over: openAddGame closes this screen on its way in.
    returnTo = 'library';
    controls.openAddGame();
  },
  onClosed: () => {
    controls.settingsClosed();
    // Opening this screen told main "nothing is on screen" (its card is a launcher card). Closing it
    // hands the carousel back, so main has to hear what the row is standing on — which is not
    // necessarily what it was: deleting a game from here moves the highlight onto its neighbour, and
    // without this that neighbour would sit under the launcher's idle background and silence.
    carousel.announce();
  },
});

const toast = createToast({
  audio,
  isBlocked: () => controls.isPopupOpen(),
});

const controls = createControls({
  getState: () => currentState,
  getLocale: () => currentLocale,
  getNotifications: () => notificationItems,
  onPopupClosed: () => toast.resume(),
  openGameDetail: (id) => openGameDetail(id),
  // Read lazily, like the carousel seam: the boot state is declared further down this module, and the
  // first press cannot arrive before it exists.
  isBooting: () => !bootRevealed,
  getBrowse: () => currentBrowse,
  audio,
  getTranslator,
  settings: settingsScreen,
  gameSettings: gameSettingsScreen,
  library: libraryScreen,
  onFlipping: (flipping) => {
    if (flipping) {
      if (flipSettleTimer !== 0) {
        window.clearTimeout(flipSettleTimer);
        flipSettleTimer = 0;
      }
      stripFlipping = true;
      hero.setFlipping(true);
      carousel.setFlipping(true);
      libraryScreen.setFlipping(true);
      return;
    }
    if (flipSettleTimer !== 0) return;
    flipSettleTimer = window.setTimeout(() => {
      flipSettleTimer = 0;
      stripFlipping = false;
      hero.setFlipping(false);
      carousel.setFlipping(false);
      libraryScreen.setFlipping(false);
      // The title stays hidden for the whole run (see textSwapPending) — this is where it comes back, on
      // the game the row finally came to rest on.
      render(currentState);
    }, FLIP_SETTLE_MS);
  },
  // Read lazily: the carousel is created below (it needs `controls` for its own callbacks), so the seam
  // is a set of thunks rather than the object itself.
  carousel: {
    screen: () => carousel.screen(),
    move: (delta) => carousel.move(delta),
    activate: () => carousel.activate(),
    leaveDetail: () => leaveDetail(),
    setUnread: (unread) => carousel.setUnread(unread),
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
  // A launcher card is selected: there is no game on screen at all. main answers with an empty browse on
  // the same channels, so the title, the background and the music all clear through their usual path.
  browseNone: () => {
    requestedBrowseId = null;
    window.api.browseGame(null);
  },
  getTranslator,
  onScreenChange: () => {
    controls.refresh();
    render(currentState);
  },
  onActivate: (item) => {
    // Entering a card is an ordinary button press — same cue as any other "open" action, and a launcher
    // card is no different (the surface it opens then plays its own popup-open on top).
    audio.play('button');
    if (item.kind === 'game') openGameDetail(item.game.id);
    else controls.openSystemCard(item.card.id);
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

/**
 * Where the screen ABOVE this one goes back to. A detail screen — and the Customize screen in add mode —
 * can be reached from the carousel or from the Library, and "back" has to mean the place it was actually
 * entered from. One flag for both, because it is one question: the surface underneath is either standing
 * open behind them or it is not.
 */
type ReturnTo = 'carousel' | 'library';
let returnTo: ReturnTo = 'carousel';

/** Brings the Library back up if that is where the top screen was entered from. Consumes the flag. */
function restoreOrigin(): void {
  if (returnTo !== 'library') return;
  returnTo = 'carousel';
  libraryScreen.restore();
  // …and undo what opening the game did to everything AROUND the screen. The detail screen took the
  // game's wallpaper, its palette and its music with it; the library is a launcher surface and belongs
  // over the launcher's own. The strip goes back to the Library card the screen was opened from (the
  // only way in), and main is told nothing is on screen — the same thing selecting that card does.
  carousel.focusSystem();
  requestedBrowseId = null;
  window.api.browseGame(null);
}

/**
 * Open one game's detail screen. Lifted out of the carousel's activate callback, because it is now
 * reached from three places: pressing a card, pressing a notification about that game, and the Library's
 * grid — which is what `origin` records, so B and up come back to the grid rather than to the strip.
 *
 * A game that is not in the list has nowhere to open — its card is out and its history record was
 * evicted — so the press simply does nothing rather than opening an empty screen.
 */
function openGameDetail(id: string, origin: ReturnTo = 'carousel'): void {
  const entry = currentGames.find((game) => game.id === id);
  if (entry === undefined) return;
  returnTo = origin;
  if (origin === 'library') {
    // The play button morphs out of the card's artwork, and it reads the CAROUSEL's cache synchronously
    // — so the cover the grid already decoded is handed over, or the screen would open on an empty plate.
    const url = libraryScreen.artFor(id);
    if (url !== null) carousel.primeArt(entry, url);
    libraryScreen.close(true);
  }
  userChoseDetail = true;
  // Committing to a game outranks the debounce main applies while flipping: ask for its hero and music
  // NOW. Without this, opening a game straight out of a fast flip leaves the previous game's background
  // and music on its screen until the debounce elapses.
  requestedBrowseId = id;
  window.api.browseGame(id, true);
  // An active game must also become the CARD's selected game (main rebuilds its hero/audio/GameInfo).
  // If that is refused — a launch or install is in flight — the detail screen is still correct: it is
  // drawn from the browse model, so it shows the game you picked, just without an actionable Play.
  if (entry.active && gameOf(currentState)?.id !== id) window.api.selectGame(id);
  // A no-op when the strip is already on it (the carousel path), and the whole point when it is not.
  carousel.focusGame(id);
  // The row is a SHORTLIST (MAX_STRIP_GAMES), so a game reached from the Library or from a notification
  // may have no card in it — and then the morph would wear whichever card happens to be selected, i.e.
  // another game's cover. Name the source explicitly in that case; null is an honest empty plate.
  const onStrip = carousel.selected();
  if (!(onStrip?.kind === 'game' && onStrip.game.id === id)) {
    carousel.setDetailArt(libraryScreen.artFor(id));
  }
  // Keeps the row out of sight for this screen — it has no hand-over to play here (see the rule in
  // styles.css). Cleared by leaveDetail / showAddedGame, i.e. wherever the carousel becomes the screen.
  if (origin === 'library') app.dataset['detailFrom'] = 'library';
  else delete app.dataset['detailFrom'];
  carousel.setScreen('detail');
}

/**
 * A game was just added AND applied: put the user in front of it. Not `openGameDetail` — that one looks
 * the game up in `currentGames`, and the library push that will carry it has not arrived yet, so it would
 * find nothing and silently do nothing.
 *
 * `focusGame` is written for exactly this race: an unknown id is remembered and honoured when the list
 * arrives. Clearing `userChoseDetail` is what lets `applyLibrary` raise the strip once it does — the flag
 * is set by opening a detail screen, and it exists to stop the launcher yanking the user out of one.
 * With a single game there IS no carousel, and staying on that game's detail screen is the right answer.
 */
function showAddedGame(id: string): void {
  // The Customize screen reported the new game AFTER announcing it closed, so onClosed has already put
  // the library back up. A brand-new game belongs on the carousel, in front of the user — and both
  // happen in one task, so no frame is drawn in between and nothing flickers.
  returnTo = 'carousel';
  libraryScreen.close(true);
  delete app.dataset['detailFrom'];
  userChoseDetail = false;
  carousel.focusGame(id);
  // focusGame moves the STRIP and nothing else — it does not tell main the browse cursor moved (a real
  // flip does that through the carousel's own onNavigate). Without this the row lands on the new card
  // while the title, the background and the info panel still describe whatever was on screen before.
  // Immediate, like opening a detail screen: committing to a game outranks the flip debounce.
  requestedBrowseId = id;
  window.api.browseGame(id, true);
  // `applied` is main saying it re-read the manifest, so the game is playable NOW — and Play acts on the
  // CARD's selected game, not on the browse cursor, so it has to move too or Play would launch the game
  // the user was looking at before.
  if (gameOf(currentState)?.id !== id) window.api.selectGame(id);
  carousel.setScreen('carousel');
}

/** Back out of a detail screen to the carousel (B). False when the carousel is already the screen. */
function leaveDetail(): boolean {
  if (carousel.screen() !== 'detail') return false;
  userChoseDetail = false;
  delete app.dataset['detailFrom'];
  // BEFORE setScreen: switching the level fires onScreenChange, whose refresh() has to see the library
  // already open — otherwise the focus is computed for a carousel that is about to be covered again.
  restoreOrigin();
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

/**
 * Fills the Details popup's stats panel. Rebuilt only when the panel is empty — otherwise the three rows
 * are updated IN PLACE. Not a micro-optimization: the rows carry the popup's staggered entrance (see
 * popup-item-in in styles.css), which replays whenever the nodes are recreated. render() runs on every
 * state push and on every carousel step, so rebuilding here would restart that entrance mid-view and the
 * stats would flicker while the user reads them.
 */
function buildInfoPanel(stats: Stats): void {
  const rows: readonly (readonly [string, string])[] = [
    [translator('launcher.info.lastPlayed'), formatDate(stats.lastPlayedAt, translator, currentLocale)],
    [translator('launcher.info.playtime'), formatPlaytime(stats.totalPlaySeconds, translator)],
    [translator('launcher.info.launches'), String(stats.launchCount)],
  ];
  const existing = [...infoPanel.children];
  if (existing.length === rows.length) {
    existing.forEach((item, i) => {
      const row = rows[i];
      if (row === undefined) return;
      const [label, value] = row;
      const labelEl = item.querySelector('.info-label');
      const valueEl = item.querySelector('.info-value');
      if (labelEl !== null) labelEl.textContent = label;
      if (valueEl !== null) valueEl.textContent = value;
    });
    return;
  }
  while (infoPanel.firstChild !== null) infoPanel.removeChild(infoPanel.firstChild);
  infoPanel.append(...rows.map(([label, value]) => infoItem(label, value)));
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
  // Nothing on screen is a state of its own now — a launcher card — and the state's status belongs to a
  // game, so it says nothing there: "Installing…" under "Settings" would be a lie, and the line's mere
  // presence shifts the title (see [data-status] in styles.css).
  if (currentBrowse === null || (subject !== undefined && subject !== currentBrowse.id)) return '';
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
  // The title/status were hidden for a pending selection change (see onNavigate); this is where they come
  // back — for whatever the row came to rest on, a game OR a launcher card. ABOVE the branch on purpose:
  // done inside the `browse !== null` half, a launcher card's name was written and never revealed.
  if (textSwapPending && !stripFlipping) {
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
  if (browse !== null) {
    // Hero images travel on their own channels (hero:update / browse:hero), independent of state:update —
    // on a window reconnect render can arrive before the payload. Only paint when we already have images;
    // an empty list means "wait for the push" (it back-fills), rather than blanking the background.
    hero.repaint();
    titleEl.textContent = browse.title;
    buildInfoPanel(browse.stats);
    controls.applyGameButtons();
  } else {
    // No game on screen: the carousel is standing on one of the launcher's own cards. It names itself in
    // the title line, exactly where a game's name goes — except the power card, which the mockup leaves
    // unnamed. The BACKGROUND is deliberately not touched here: it arrives on the debounced browse:hero
    // channel (see onBrowseHero), so flipping past these cards doesn't make the wallpaper blink.
    const item = carousel.selected();
    const titleKey = item !== undefined && item.kind === 'system' ? item.card.titleKey : null;
    titleEl.textContent = titleKey === null ? '' : translator(titleKey);
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
  // (c) a LOCAL game whose executable is no longer on disk: it is active (it is in the library and keeps
  // its art and stats) but there is nothing to start, so it gets the same title + More layout, with the
  // status line saying why.
  const hasPlay =
    browse !== null &&
    browse.active &&
    browse.game?.unavailable !== true &&
    browse.game?.unconfigured !== true &&
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
  libraryScreen.setBusyGame(busyGame);

  syncChatter(state);
  applyStatus();

  // Force-close popups off the ready screen, then re-apply the focus highlight (see controls.refresh).
  controls.refresh();
  syncMusic();

  // Empty-screen error (Р8, point 1): a card that fails to load sets state=error with no game. In Game
  // Mode the window is shown (no tray to hide into), so surface the reason over the idle screen via the
  // error popup. Only on ENTERING the error (prev not already error) so a locale/wallpaper re-render
  // doesn't re-pop a popup the user has closed. Desktop/Windows keep hiding, so this rarely fires there.
  if (state.kind === 'error' && game === undefined && prev.kind !== 'error') {
    controls.showError(state.message);
  }
}

// ── Boot reveal ─────────────────────────────────────────────────────────────
// index.html ships #app[data-boot], which hides the bar and the carousel strip (styles.css):
// the launcher opens on the background alone. The order is deliberate — wallpaper, then the game's own
// hero, then the UI:
//   1. the bundled wallpaper is the fastest image main can hand over, so it paints on the boot backdrop
//      (#hero-boot — a layer of its own, ABOVE the hero) and keeps the screen for WALLPAPER_HOLD_MS,
//      however quickly the rest arrives;
//   2. the card's hero paints on the hero layers UNDERNEATH it as soon as it lands, and the backdrop
//      then dissolves to reveal a background that is already settled — the alternative, unwinding a
//      shared zoom, made the picture travel backwards at the exact moment the UI arrived;
//   3. only then does the UI fade in — so it is never seen assembling itself, and never changes colour
//      under the user's eyes a beat after appearing.
// The UI waits for ALL THREE seeds — the state, a settled background, and the carousel list — and never
// appears before BOOT_MIN_MS, so the reveal reads as an intro rather than as a stutter. The list is a
// seed in its own right because the strip's container is switched on in ONE frame (its opacity
// transition belongs to the card morph, see styles.css): arriving after the reveal, the whole carousel
// simply appeared, as if it had been display:none. The deadline covers a seed that never arrives
// (unreadable wallpaper, no hero, no library at all): the UI must not stay hidden forever.
/**
 * How long the bundled wallpaper owns the screen at startup. A hero arriving earlier is painted right
 * away but stays hidden under the backdrop, so the launcher always opens on the same picture for the
 * same beat instead of flashing whatever loaded first. It is also the length of the startup jingle's
 * FIRST half (assets/playhook-startup.mp3): the swell is the backdrop's, the tail plays over the UI
 * arriving — which is why the countdown runs from the moment the sound starts, not from window load.
 */
const WALLPAPER_HOLD_MS = 2000;
/** The UI never appears before this — the hold plus the cross-fade it hands over to. */
const BOOT_MIN_MS = WALLPAPER_HOLD_MS;
const BOOT_DEADLINE_MS = 5000;
/** Matches the backdrop's fade in styles.css (#hero-boot.is-gone). */
const BOOT_FADE_MS = 1000;
const bootBackdrop = req('hero-boot');
const bootStart = performance.now();
let bootStateReady = false;
let bootHeroReady = false;
let bootLibraryReady = false;
let bootRevealed = false;
let revealTimer = 0;
// When the startup jingle actually began playing; null until it does (or forever, if it can't).
let jingleStartedAt: number | null = null;

/**
 * Hands the screen over to the hero underneath: the backdrop fades out and, over the same beat, travels
 * to where that hero layer currently sits. Converging rather than parting matters because the two are
 * often the SAME image — with no game on screen the background is this very wallpaper — and any offset left
 * between them shows up as a double image sliding apart. Then it is taken out of the page entirely: it
 * has nothing left to show, and a full-screen composited layer is not free.
 */
function dissolveBootBackdrop(): void {
  const settled = hero.currentLayerTransform();
  // 'none' means there is no image under it at all (no wallpaper, no hero) — then there is nothing to
  // converge on, and pulling the backdrop back to the identity transform would be the very lurch this
  // whole arrangement exists to avoid. It just fades where it is.
  if (settled !== 'none') bootBackdrop.style.transform = settled;
  bootBackdrop.classList.add('is-gone');
  window.setTimeout(() => {
    bootBackdrop.hidden = true;
  }, BOOT_FADE_MS);
}

function revealUi(): void {
  if (bootRevealed) return;
  bootRevealed = true;
  delete app.dataset['boot'];
  dissolveBootBackdrop();
  // The strip's cards were held at zero behind the boot screen — let them fan in now, so the carousel's
  // own entrance is actually seen instead of having happened under the wallpaper.
  carousel.playIntro();
}

/**
 * When the boot image's turn is up: BOOT_MIN_MS after the jingle started, or — when there is no jingle
 * (unreadable file, muted output, a refused autoplay) — after the window itself opened. The jingle is
 * fetched over IPC and can start a beat late; letting the hold slide with it is what keeps the swell and
 * the picture in step, rather than the sound arriving over a UI that is already up.
 */
function bootHoldEndsAt(): number {
  return (jingleStartedAt ?? bootStart) + BOOT_MIN_MS;
}

/** Arms (or re-arms) the reveal for the end of the hold. No-op until every seed is in. */
function scheduleReveal(): void {
  if (bootRevealed || !bootStateReady || !bootHeroReady || !bootLibraryReady) return;
  if (revealTimer !== 0) window.clearTimeout(revealTimer);
  revealTimer = window.setTimeout(revealUi, Math.max(0, bootHoldEndsAt() - performance.now()));
}

function noteBootSeed(seed: 'state' | 'hero' | 'library'): void {
  if (seed === 'state') bootStateReady = true;
  else if (seed === 'hero') bootHeroReady = true;
  else bootLibraryReady = true;
  scheduleReveal();
}

window.setTimeout(revealUi, BOOT_DEADLINE_MS);

// The startup jingle, played once. Requested as early as everything else and started the moment it
// lands; the boot hold is then re-armed around it (see bootHoldEndsAt). The deadline above is the
// backstop: a jingle that arrives absurdly late can delay the reveal, but never hold it hostage.
void window.api.requestStartupSound().then(async (url) => {
  if (url === null || bootRevealed) return;
  await audio.playStartup(url);
  if (bootRevealed) return;
  jingleStartedAt = performance.now();
  scheduleReveal();
});

// The startup push on the backdrop (#hero-boot in styles.css): a wider, faster drift than the hero's
// perpetual pan, and it never unwinds — the layer dissolves mid-travel instead. Two frames of delay
// because a transition needs its starting value painted first: set in the same frame as the load and
// there is nothing to move from. The direction is randomized like the layers' own pan, so the launcher
// doesn't always open drifting the same way.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    if (bootRevealed) return;
    bootBackdrop.style.setProperty('--boot-pan', Math.random() < 0.5 ? '4.5%' : '-4.5%');
    bootBackdrop.classList.add('is-panning');
  });
});

// Whether the background that will STAY is up: the card's hero when it has one, the wallpaper when it
// does not. The wallpaper alone is not enough while a hero is still expected — that is the cross-fade
// the reveal is supposed to happen after, not during.
let heroPayload: 'pending' | 'none' | 'present' = 'pending';
let wallpaperPainted = false;

function noteBackgroundSettled(): void {
  if (heroPayload === 'present' || (heroPayload === 'none' && wallpaperPainted)) noteBootSeed('hero');
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
  // The Settings screen builds its rows from JS, so localizeDocument doesn't reach them — and render()
  // knows nothing about it. It keeps its focus and scroll position across the swap.
  settingsScreen.relocalize();
  gameSettingsScreen.relocalize();
  libraryScreen.relocalize();
  // The notification list is built from JS too, and its text is ASSEMBLED from the kind rather than
  // stored — which is the whole reason it is not stored: a language change rewrites it in place.
  controls.applyNotifications();
}
window.api.onLanguageUpdate(applyLocale);
void window.api.getLanguage().then(applyLocale);

window.api.onStateUpdate(render);
void window.api.requestState().then((state) => {
  render(state);
  noteBootSeed('state');
});

// What is on screen (title / stats / active / GameInfo). Subscribe BEFORE the seed, like every other
// channel here, so a push arriving in between isn't lost.
function applyBrowse(browse: BrowseInfo | null): void {
  // Whether there WAS a game on screen a moment ago — the detail screen below acts on the transition, not
  // on the state (at startup there is no game on screen yet either, and that is not a game going away).
  const hadGame = currentBrowse !== null;
  currentBrowse = browse;
  // The Customize screen is about ONE game's file. When the card carrying it is pulled or swapped —
  // everything under the screen is rebuilt by then — there is nothing left to edit, so it closes rather
  // than staying open over a game that is gone (see the plan, Р6.2).
  gameSettingsScreen.applyBrowse(browse);
  // The game the screen was about is GONE — the last history entry was forgotten, the card was pulled —
  // and main has nothing to put in its place. A detail screen is one game's screen, so with no game there
  // is nothing left for it to show: step back to the row, which is what the user would otherwise be
  // looking at a launcher card's "detail screen" instead of. `userChoseDetail` is cleared with it (that
  // is what leaveDetail does) — the choice was about a game that no longer exists.
  if (hadGame && browse === null && carousel.screen() === 'detail') leaveDetail();
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
  if (browse !== null) {
    window.api.browseGame(browse.id);
    return;
  }
  // Nothing on screen — the user is parked on a launcher card. There is no game for main to replay, but
  // the audio engine still has to be told: left at its default it would fall through to the inserted
  // card's music and play a game's theme under a launcher card until the user moved off it.
  audio.setBrowseMusic(null, true);
  syncMusic();
});

// The browsed game's background: a channel of its own, so a history game can be shown without touching
// the inserted card's hero:update payload (which stays valid for the card's selected game).
window.api.onBrowseHero((assets) => {
  // Nothing on screen (a launcher card) → the idle wallpaper. It has to happen HERE rather than in
  // render(): this channel is the debounced one, so the background changes when the row STOPS on a card,
  // the same way it does between games. applyBrowseAssets(null) would not do — it paints only while a
  // game is on screen (hero.ts), which is exactly what this case is not.
  if (currentBrowse === null) hero.applyIdleBackground();
  else hero.applyBrowseAssets(assets);
});

// The browsed game's music. Music ONLY — the SFX set is never rebuilt by browsing, so flipping through
// the carousel doesn't re-create the sound elements on every step.
window.api.onBrowseMusic((url) => {
  // On the same (debounced) channel as the background, for the same reason: a launcher card means the
  // ambience, and switching to it while merely flipping PAST the card would tear the music. Not in
  // applyBrowse — that one rides the instant channel.
  audio.setBrowseMusic(url, currentBrowse === null);
  syncMusic();
});

// A failed launch returns to 'ready' and sends the reason here to open the error popup.
window.api.onError((messageText) => controls.showError(messageText));

// Settings screen data. Subscribe BEFORE the seeds (the pattern every channel here follows) so a push
// arriving in between isn't lost. The push is the ONLY source of values — a reset lands here too, so
// the screen never has to reconcile an invoke result with a push.
window.api.onSettingsUpdate((settings) => settingsScreen.applySettings(settings));
window.api.onUpdateStatus((status) => settingsScreen.applyUpdateStatus(status));
void window.api.getSettings().then((settings) => settingsScreen.applySettings(settings));
void window.api.requestUpdateStatus().then((status) => settingsScreen.applyUpdateStatus(status));
// The environment seeds: they never change during a session.
void Promise.all([
  window.api.isSteamAvailable(),
  window.api.getAudioOptions(),
  window.api.getAppVersion(),
]).then(([steamAvailable, audioOptions, appVersion]) => {
  settingsScreen.applyEnv({ steamAvailable, audioOptions, appVersion });
});

// Fallback wallpaper for the idle background (data URL from main). It doubles as the session's OPENING
// backdrop: it paints on #hero-boot, above the hero layers, and holds the screen while the rest of the
// launcher loads underneath (see the boot reveal above). It ALSO goes on a hero layer, as it always has:
// that is the background a card whose hero never arrives is left with once the backdrop dissolves.
void window.api.requestWallpaper().then((url) => {
  hero.setWallpaper(url);
  if (url === null) bootBackdrop.hidden = true;
  else bootBackdrop.style.backgroundImage = `url("${url}")`;
  if (gameOf(currentState) === undefined) {
    hero.applyIdleBackground();
    // The title the empty screen used to carry belongs to render() now (a launcher card names itself).
    render(currentState);
  } else hero.showWallpaperBackdrop();
  wallpaperPainted = url !== null;
  noteBackgroundSettled();
});

// The card's music is delivered on its own channel (not in AppState); load it and keep music in sync.
window.api.onCardMusic((url) => {
  audio.setCardMusic(url);
  syncMusic();
});
void window.api.requestCardMusic().then((url) => {
  audio.setCardMusic(url);
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

// The bundled UI sound set — every sound the app plays, on every screen (chosen in Settings → Audio).
window.api.onSfxSet((set) => audio.setSounds(set));
void window.api.requestSfxSet().then((set) => audio.setSounds(set));


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
window.api.onHeroUpdate((assets) => {
  hero.applyAssets(assets);
  if (assets !== null) {
    heroPayload = 'present';
    noteBackgroundSettled();
  }
});
void window.api.requestHero().then((assets) => {
  hero.applyAssets(assets);
  heroPayload = assets === null ? 'none' : 'present';
  noteBackgroundSettled();
});

// The carousel list (the inserted card's games + the play history, already ordered) arrives on its own
// channel. Seed on startup (back-fill after a window reconnect), then live updates.
function applyLibrary(games: readonly LibraryEntry[]): void {
  currentGames = games;
  carousel.setGames(games);
  // The grid re-flows the same way the strip does — the screen may be open while a card goes in or out.
  libraryScreen.setGames(games);
  // main says nothing is on screen while the row is standing on a GAME: the user was parked on a launcher
  // card and this window is a fresh one (a reload re-seeds the list, but which of the three cards it was
  // is remembered nowhere), so the strip lands on games[0] with an idle background over it. Put it back on
  // the launcher cards, without telling main anything — its cursor did not move.
  //
  // ONLY while we have not asked for a game ourselves. `currentBrowse` is null for the beat between the
  // question and the answer too, and a list update landing inside it reads that beat as "parked on a
  // launcher card" — which is exactly what a freshly added game does: main copies its assets in the
  // background and refreshes the row when it is done, right while the browse answer for that game is
  // still in flight. The strip was dragged off the very card the answer was about, and the game's
  // background and colours then arrived under a launcher card.
  const selected = carousel.selected();
  if (currentBrowse === null && requestedBrowseId === null && selected?.kind !== 'system') {
    carousel.focusSystem();
  }
  // The carousel is the default level — but never yank the user out of a detail screen they opened
  // themselves (they may be watching an install run).
  if (!userChoseDetail) carousel.setScreen('carousel');
  render(currentState);
}
window.api.onLibraryUpdate((library) => applyLibrary(library?.games ?? []));
void window.api.requestLibrary().then((library) => {
  applyLibrary(library?.games ?? []);
  // Even an empty list counts: it settles `data-screen`, which is what decides whether the strip's
  // container is on at all. Waiting for it is what keeps the carousel from popping in afterwards.
  noteBootSeed('library');
});

// The notification inbox and the plates main asks us to show. The list is the popup's only source of
// truth; the plate is a one-shot surface of our own (see toast.ts). Subscribe BEFORE the seed, like
// every other channel here, so a push arriving in between isn't lost.
function applyNotifications(items: readonly AppNotification[]): void {
  notificationItems = items;
  controls.applyNotifications();
}
window.api.onNotifications(applyNotifications);
void window.api.requestNotifications().then(applyNotifications);

window.api.onNotificationToast((incoming) => {
  if (incoming.kind === 'unread-summary') {
    toast.show(translator.tp('notifications.unread', incoming.count));
    return;
  }
  // A plate is never a read receipt: it is up for a few seconds and the user may be looking elsewhere,
  // so the dot beside the More item has to outlive it. Only opening the popup clears the unread state.
  toast.show(formatNotification(incoming.item, translator));
});

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
