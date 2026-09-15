// The card session + IPC registration.
// This is where the state machine lives: the controller listens to drive-watcher, reads the inserted
// card and the PC library, replicates AppState to the window, and dispatches the "Launch" / "Uninstall"
// actions from the renderer to GameSequences (sync→spawn→wait→sync lives there). What the window shows
// is held and pushed by BrowsePresenter. All FS/process work happens only in main.
import fse from 'fs-extra';
import { app, clipboard, ipcMain } from 'electron';
import {
  IPC,
  type AppState,
  type SfxSet,
  type BrowseInfo,
  type ConfigSaveResult,
  type GameCollision,
  type GameCollisionAnswer,
  type GameInfo,
  type GameLibrary,
  type HeroAssets,
  type ManifestSource,
  type Stats,
} from '../shared/types';
import type { ResolvedManifest } from './manifest-types';
import { type Translator } from '../shared/i18n/index';
import { byRecentlyPlayed } from './library-index';
import {
  commitHistorySync,
  rollbackHistorySync,
  syncHistoryConfig,
  type HistorySyncResult,
} from './history-sync';
import { localGameGoesAfterMerge } from './history-config';
import { sweepAtomicTemps } from './json-store';
import { readManifests, isSafeGameId, type ManifestEnv } from './manifest';
import { type CollisionResolver, type ControllerDeps } from './controller-deps';
import { steamInstallStatus } from './steam';
import { openSteamUri } from './steam-uri';
import { AssetReader } from './asset-reader';
import { BrowsePresenter } from './browse-presenter';
import { GameSequences } from './game-sequences';
import { SaveSyncFlow } from './save-sync-flow';
import { SteamInstallWatch } from './steam-install-watch';
import { describe } from './util';
import { log } from './logger';

/**
 * The root-relative asset paths one manifest references (art + music), as written in game.json. Used to
 * tell the PC library which files in its `assets/` are still in use — see PcLibraryStore.gcOrphans.
 */
function referencedAssets(manifest: ResolvedManifest): readonly string[] {
  const { heroImage, gridImage, backgroundMusic } = manifest.raw;
  const heroes = heroImage === undefined ? [] : typeof heroImage === 'string' ? [heroImage] : heroImage;
  return [...heroes, ...(gridImage !== undefined ? [gridImage] : []), ...(backgroundMusic !== undefined ? [backgroundMusic] : [])];
}

export class GameController {
  // A card carries one OR MANY games (game.json is an object or an array). `cardGames` holds every game
  // resolved from the inserted card; `pcGames` the local ones from the PC library, which are available
  // whether or not a card is in. `games` (below) is their union — the list every consumer reads — and
  // `selectedId` names the one currently selected. `current()` derives the single "active" manifest that
  // all the existing launch/kill/uninstall/save-sync/stats code reads, so those bodies stay untouched.
  // Empty (`cardGames=[]`) whenever no card / rejected.
  private cardGames: ResolvedManifest[] = [];
  private pcGames: ResolvedManifest[] = [];
  // The SELECTION is by id, not by index: with two sources the list is rebuilt from both (a card comes and
  // goes underneath it), and an index would silently point at a different game every time it changed.
  private selectedId: string | null = null;
  private cardPresent = false;
  // True for the whole body of loadCard. A game on the card being read right now is about to become
  // available, so save-from-history must refuse: an invoke that slipped in after the sync step and before
  // the manifests landed would be stored as "pending" and sit there until the NEXT insertion.
  private cardLoadInFlight = false;
  // True while a collision answer is being carried out. The merge writes the card and reloads it, which
  // re-enters loadCard — and the detection at the end of it would ask the very question being answered.
  private collisionInFlight = false;
  // The id of the game with a Steam download/removal in flight, or null. Steam operations are the one
  // kind of activity that leaves the state `ready`, so this is what stops a SECOND game from being
  // launched or installed underneath them (see onLaunchRequested).
  private steamBusyId: string | null = null;
  // Mirror of AppSettings.keepOpenWithoutCard (seeded at startup, toggled live from the settings
  // window): when true the launcher stays on screen with no card in instead of hiding to the tray.
  // Initialized to the SCHEMA's default so the sliver between constructing this controller and the seed
  // behaves like the setting it mirrors — keep the two in step if that default ever changes.
  private keepOpenWithoutCard = true;
  // A manifest reload from the Customize screen is in flight. Unlike launchInFlight it does NOT
  // gate on state kind (the reload runs from `ready`), so onLaunchRequested/onUninstallRequested check
  // it explicitly: during the reload's awaits (readManifest + hero/audio on a slow SD — hundreds of ms)
  // the state stays `ready`, and a gamepad Play would otherwise start a game mid-reload (enterReady over
  // launching). Only the reload path is raced like this — an ordinary insert never is.
  private reloadInFlight = false;
  // The renderer parked the cursor on one of the launcher's own cards (browse:game with null). While it
  // holds, main NEVER moves the cursor on its own — a card inserted, a session finished, a library
  // reloaded: the row stays where the user left it (see browseToUnlessPinned). Only the renderer clears
  // it, by browsing a game again. Not "main knowing about the UI": currentBrowse is the view model
  // already, and this flag is what tells "the cursor was set on purpose" from "there is nothing to show".
  private browsePinned = false;
  // The reconciled Stats per game id, captured in loadCard so onSelectRequested can rebuild the selected
  // game's GameInfo without re-reading stats (buildGameInfo still re-reads the .acf for a steam game).
  private statsById = new Map<string, Stats>();
  // Reads card assets (hero/audio/wallpaper) into data URLs; owns the bundled-wallpaper cache and reads
  // the live audio settings via DI.
  private readonly assets = new AssetReader({
    getSoundSet: async () => (await this.deps.settings.read()).soundSet,
    getAmbientTrack: async () => (await this.deps.settings.read()).ambientTrack,
    getOnlyGlobalAmbient: async () => (await this.deps.settings.read()).onlyGlobalAmbient,
  });
  // What the window shows (hero/music/ambience/sfx/row/browse cursor) and the pushes that keep it so —
  // see browse-presenter.ts. The controller decides which game; the presenter holds and delivers it.
  private readonly presenter = new BrowsePresenter({
    assets: this.assets,
    send: (channel, payload) => this.deps.window.send(channel, payload),
    findManifest: (id) => this.games.find((m) => m.raw.id === id) ?? null,
    readBrowseAssets: (id) => this.deps.library.readBrowseAssets(id),
    onlyGlobalAmbient: async () => (await this.deps.settings.read()).onlyGlobalAmbient,
  });
  // Steam-mode background re-detect poller (timer + tick + optimistic uninstall request), extracted from
  // this controller. Reaches back only through the narrow accessor seam below.
  private readonly steamWatch: SteamInstallWatch = new SteamInstallWatch({
    getManifest: () => this.current(),
    isLaunchInFlight: () => this.sequences.inFlight,
    getState: () => this.deps.state.get(),
    isSourceAvailable: () => this.currentSourceAvailable(),
    enterReady: (info) => this.enterReady(info),
    onInstallCompleted: (game) =>
      this.deps.notifications.notify({
        kind: 'game-installed',
        gameId: game.id,
        gameTitle: game.title,
      }),
    onUninstallCompleted: (game) =>
      this.deps.notifications.notify({
        kind: 'game-uninstalled',
        gameId: game.id,
        gameTitle: game.title,
      }),
    steamLocator: () => this.deps.platform.steamLocator,
  });
  // The process lifecycle (launch / install / uninstall / prefix cleanup, force-close, the save sync
  // around a session) — see game-sequences.ts. Dispatched to from the renderer's actions below; it
  // reaches back through the SequenceHost seam for the card session's answers and transitions.
  private readonly sequences: GameSequences;
  // The card↔PC save sync: the deferred flush on insert (used here) and the sync-in / sync-out the launch
  // sequence brackets a game with — see save-sync-flow.ts.
  private readonly saveSync: SaveSyncFlow;

  constructor(private readonly deps: ControllerDeps) {
    this.saveSync = new SaveSyncFlow({
      store: this.deps.store,
      stats: this.deps.stats,
      savePathResolver: this.deps.platform.savePathResolver,
      sourceAvailable: (manifest) => this.sourceAvailable(manifest),
    });
    this.sequences = new GameSequences({
      state: this.deps.state,
      window: this.deps.window,
      stats: this.deps.stats,
      store: this.deps.store,
      library: this.deps.library,
      settings: this.deps.settings,
      notifications: this.deps.notifications,
      platform: this.deps.platform,
      processControl: this.deps.processControl,
      getTranslator: this.deps.getTranslator,
      steamWatch: this.steamWatch,
      saveSync: this.saveSync,
      host: {
        current: () => this.current(),
        buildGameInfo: (manifest, stats) => this.buildGameInfo(manifest, stats),
        enterReady: (info) => this.enterReady(info),
        sourceAvailable: (manifest) => this.sourceAvailable(manifest),
        currentSourceAvailable: () => this.currentSourceAvailable(),
        sourceAvailableFor: (id) => this.sourceAvailableFor(id),
        cardGoneAfterSequence: () => this.cardGoneAfterSequence(),
        browseToUnlessPinned: (id) => this.browseToUnlessPinned(id),
        refreshLibrary: () => this.refreshLibrary(),
        rememberStats: (id, stats) => this.statsById.set(id, stats),
        sendError: (message) => this.sendError(message),
        onInsert: (root) => this.onInsert(root),
      },
    });
  }

  /** The current translator (a message is fixed at the language of the moment it is generated). */
  private get t(): Translator {
    return this.deps.getTranslator();
  }

  /**
   * Every game that can be acted on right now: the inserted card's, then the PC library's. A local game
   * whose id is ALSO on the card is dropped here — the card wins (it is the removable, user-visible
   * medium, and `id` keys every piece of PC state, so the two cannot coexist). Recomputed on read: both
   * lists are tiny, and a cached union would be one more thing to invalidate on every insert/removal.
   */
  private get games(): readonly ResolvedManifest[] {
    const cardIds = new Set(this.cardGames.map((manifest) => manifest.raw.id));
    return [...this.cardGames, ...this.pcGames.filter((m) => !cardIds.has(m.raw.id))];
  }

  /** Tells the user what the sync step did with their pending edits — one entry per game. */
  private notifyHistorySync(sync: HistorySyncResult): void {
    for (const gameTitle of sync.applied) {
      this.deps.notifications.notify({ kind: 'history-config-applied', gameTitle });
    }
    for (const gameTitle of sync.discarded) {
      this.deps.notifications.notify({ kind: 'history-config-discarded', gameTitle });
    }
  }

  /**
   * The single "active" manifest — the selected game — that every existing consumer reads
   * (launch/kill/uninstall/save-sync/stats). Read-only: the games live in `cardGames`/`pcGames`, the
   * choice in `selectedId`. Falls back to the first available game when the selection is gone (the card
   * carrying it was pulled), and is null only when there is nothing at all.
   */
  private current(): ResolvedManifest | null {
    const games = this.games;
    return games.find((manifest) => manifest.raw.id === this.selectedId) ?? games[0] ?? null;
  }

  /**
   * The game the CAROUSEL shows first, as a manifest — where a cursor with no opinion of its own belongs.
   * `games` is in source order (the card's manifest as authored, then the library's `game.json`), while
   * the row is sorted by how recently each game was touched: "the first game" means two different things,
   * and the one the user can point at is the row's. Falls back to source order before the row exists, and
   * to `current()` for a head that has no manifest (a history entry — only reachable with no game at all,
   * since refreshLibrary puts every available game ahead of the history).
   */
  private firstCarouselGame(library: GameLibrary | null = this.presenter.library): ResolvedManifest | null {
    const headId = library?.games[0]?.id;
    if (headId === undefined) return this.current();
    return this.games.find((manifest) => manifest.raw.id === headId) ?? this.current();
  }

  /**
   * Whether this game's source is available right now. A card game needs its card in; a local game is on
   * this machine's disk, so it always is. Everything that used to read `cardPresent` for a SPECIFIC
   * manifest goes through here — with two sources, "no card" no longer means "this game is gone".
   */
  private sourceAvailable(manifest: ResolvedManifest): boolean {
    return manifest.source === 'pc' || this.cardPresent;
  }

  /** sourceAvailable for the selected game; false when there is no game at all (nothing to show). */
  private currentSourceAvailable(): boolean {
    const manifest = this.current();
    return manifest !== null && this.sourceAvailable(manifest);
  }

  /**
   * sourceAvailable for a game named by id — for the callers that hold a GameInfo, not a manifest. An
   * unknown id is `false` on purpose: `games` hides a local game shadowed by the card (see the getter),
   * and there is nothing to poll about a game that cannot be acted on right now.
   */
  private sourceAvailableFor(id: string): boolean {
    const manifest = this.games.find((m) => m.raw.id === id);
    return manifest !== undefined && this.sourceAvailable(manifest);
  }

  /**
   * The "the card went away while we were busy" landing, shared by the sequences that target the PC and
   * therefore finish anyway (uninstall, prefix cleanup, an abandoned watched launch). With a local game
   * left it stays on screen with that game selected; with nothing left it is the previous behaviour
   * exactly — idle and out of the way.
   */
  private cardGoneAfterSequence(): void {
    this.clearCard();
    const remaining = this.firstCarouselGame();
    if (remaining !== null) {
      void this.enterReadyForLocal(remaining);
      return;
    }
    this.deps.state.set({ kind: 'idle' });
    this.hideToTrayOrKeepEmpty();
  }

  /** Clears all card-scoped state (games, selection, lock, audio/hero/library channels). The caller sets
   * the follow-up AppState (idle/error) and window visibility, exactly as before. */
  private clearCard(): void {
    // Only a CARD game's Steam operation stops being ours to guard when the card goes: a local game's
    // download keeps running and must keep refusing a second launch/install on top of it. Read before the
    // list is emptied — afterwards there is no way to tell whose id it was.
    if (this.steamBusyId !== null && this.cardGames.some((m) => m.raw.id === this.steamBusyId)) {
      this.steamBusyId = null;
    }
    this.cardGames = [];
    // The selection falls back to whatever is still there (a local game), or to nothing — see current().
    this.selectedId = null;
    this.sequences.unlock();
    this.forgetCardStats();
    // Music is card-only, so there is none on the empty screen. UI sounds are unaffected: they come from
    // the bundled set on its own channel, which no card ever touched.
    this.presenter.setCardMusic(null);
    this.presenter.setHero(null);
    // NOT setLibrary(null): the history outlives the card, and this runs from FIVE places (a rejected
    // card, onRemove, and a card pulled mid-install/launch/uninstall). Blanking the list in any of them
    // would collapse a populated carousel into the empty screen. The list is rebuilt with no active
    // games, and the browse cursor moves onto whatever is left (a history entry, or nothing).
    this.refreshLibrary();
    void this.reseedBrowse();
  }

  /**
   * Drops the CARD games' cached stats, keeping the local library's. The cache is per-id and shared by
   * both sources, so a blanket clear on card removal would strip the local games of their reconciled
   * values (they'd fall back to a disk read — correct, but needlessly).
   */
  private forgetCardStats(): void {
    const localIds = new Set(this.pcGames.map((manifest) => manifest.raw.id));
    for (const id of [...this.statsById.keys()]) {
      if (!localIds.has(id)) this.statsById.delete(id);
    }
  }

  /**
   * Hides the launcher to the tray (the background-app default), OR — in SteamOS Game Mode, where there is
   * no tray to hide into — keeps the empty "insert a card" screen up instead. Used at every "no card"
   * exit point. On Windows/desktop this is a plain hide (unchanged behaviour).
   */
  private hideToTrayOrKeepEmpty(): void {
    if (this.deps.isGamescope) this.deps.window.showAndFocus();
    else this.deps.window.hide();
  }

  /** Subscriptions to drive-watcher, state replication to the window, IPC handlers. */
  init(): void {
    const { state, window, watcher } = this.deps;

    state.subscribe((next) => window.send(IPC.stateUpdate, next));

    watcher.onInsert((root) => void this.onInsert(root));
    watcher.onRemove(() => this.onRemove());
    watcher.onError((error) => log.error('[drive-watcher]', error));

    ipcMain.handle(IPC.stateRequest, (): AppState => state.get());
    // Static for the process lifetime — seeds the renderer's Game Mode UI (e.g. "Close Playhook").
    ipcMain.handle(IPC.gameModeRequest, (): boolean => this.deps.isGamescope);
    ipcMain.handle(IPC.cardMusicRequest, (): string | null => this.presenter.cardMusic);
    ipcMain.handle(IPC.ambientRequest, (): string | null => this.presenter.ambient);
    ipcMain.handle(IPC.heroRequest, (): HeroAssets | null => this.presenter.hero);
    ipcMain.handle(IPC.libraryRequest, (): GameLibrary | null => this.presenter.library);
    ipcMain.handle(IPC.browseRequest, (): BrowseInfo | null => this.presenter.browse);
    ipcMain.handle(IPC.sfxSetRequest, (): SfxSet | null => this.presenter.sfxSet);
    // The clipboard as text, for the on-screen keyboard's Paste. Trimmed of nothing here — what the
    // field will accept is the keyboard's own rule (osk-text.ts sanitize), and it differs per field.
    ipcMain.handle(IPC.clipboardRead, (): string => clipboard.readText());
    // The carousel asks for one card's artwork at a time, only for what is on screen, and caches it by id
    // — that is what keeps the list channel light enough to re-push on every change.
    ipcMain.handle(IPC.libraryGridRequest, (_event, id: unknown): Promise<string | null> => {
      if (typeof id !== 'string') return Promise.resolve(null);
      return this.deps.library.readGridThumb(id);
    });
    ipcMain.on(
      IPC.libraryBrowse,
      (_event, id: unknown, immediate: unknown) => void this.onBrowseRequested(id, immediate),
    );
    ipcMain.on(IPC.libraryForget, (_event, id: unknown) => void this.onForgetRequested(id));
    ipcMain.handle(
      IPC.gameCollisionResolve,
      (_event, answer: GameCollisionAnswer): Promise<ConfigSaveResult> =>
        this.resolveCollision(answer),
    );
    ipcMain.handle(IPC.wallpaperRequest, (): Promise<string | null> => this.assets.readWallpaperDataUrl());
    ipcMain.handle(
      IPC.startupSoundRequest,
      (): Promise<string | null> => this.assets.readStartupSoundDataUrl(),
    );
    ipcMain.on(IPC.actionLaunch, () => void this.onLaunchRequested());
    ipcMain.on(IPC.actionUninstall, () => void this.onUninstallRequested());
    // Game Mode: hiding is meaningless (no tray, and on Linux no summon hotkey) — ignore the Hide button
    // so the only window can't vanish with no way back. Desktop/Windows hide to the tray as before.
    ipcMain.on(IPC.actionHide, () => {
      if (!this.deps.isGamescope) this.deps.window.hide();
    });
    ipcMain.on(IPC.actionOpenSteamDownloads, () => void this.onOpenSteamDownloads());
    ipcMain.on(IPC.actionKill, () => void this.sequences.onKillRequested());
    ipcMain.on(IPC.actionSelect, (_event, id: unknown) => void this.onSelectRequested(id));

    void this.warmSfxSet();
    void this.warmAmbient();
    // Chained, not fired in parallel: both seed the carousel and the browse cursor, and warmLibrary's
    // "no card → show the history" would otherwise race the local games onto the same screen.
    void this.warmLibrary()
      .then(() => this.loadPcLibrary())
      .catch((cause: unknown) => log.warn('[pc-library] initial load failed:', describe(cause)));
  }

  /** Reads the bundled UI sound set once and delivers it to the window. It is screen-independent — the
   *  same set clicks on the empty screen, the carousel and a game's detail screen. */
  private async warmSfxSet(): Promise<void> {
    this.presenter.setSfxSet(await this.assets.readSfxSet());
  }

  /** Seeds the history carousel at startup: with no card inserted, the list and the browse cursor come
   *  purely from the library (this is what makes "pull the card, keep browsing" work). */
  private async warmLibrary(): Promise<void> {
    this.refreshLibrary();
    if (!this.cardPresent) await this.reseedBrowse();
  }

  /** Reads the default ambience from settings once at startup and pushes it to the game window (the
   *  renderer plays it only while no card music is present — it decides the priority + crossfade). */
  private async warmAmbient(): Promise<void> {
    const track = await this.deps.settings.read().then((s) => s.ambientTrack);
    this.presenter.setAmbient(await this.assets.readAmbientDataUrl(track));
  }

  /** Sends a transient error to the renderer to surface in the error popup. */
  private sendError(message: string): void {
    this.deps.window.send(IPC.errorShow, message);
  }

  /** Stops the process waits and the watcher (on application exit). */
  shutdown(): void {
    this.presenter.dispose();
    this.sequences.abortInFlight();
    this.steamWatch.stop();
    this.steamWatch.clearUninstallRequest();
    this.deps.watcher.stop();
  }

  // ── Ready transition + Steam re-detect poller ──────────────────────────────

  /**
   * The single entry point for the `ready` state. Besides setting the state, it manages the Steam
   * background re-detect poller: started when the current game is a Steam game still showing "Install"
   * (and the card is present), stopped otherwise. ALL ready transitions go through here so the poller's
   * lifecycle is governed in exactly one place (StateManager is not a controller hook).
   */
  private enterReady(info: GameInfo): void {
    // Remember WHICH game Steam is busy with. A Steam download/removal keeps the state `ready` (it is
    // non-blocking by design — it can run for hours), so the usual `kind !== 'ready'` guard does not cover
    // it; and switching to another game rebuilds AppState around THAT game, which would otherwise erase
    // the only trace of the operation. Cleared by the same game reporting itself idle again.
    if (info.steamInstalling === true || info.steamUninstalling === true) this.steamBusyId = info.id;
    else if (this.steamBusyId === info.id) this.steamBusyId = null;
    this.deps.state.set({ kind: 'ready', game: info });
    // AppState and BrowseInfo carry the SAME GameInfo whenever they are about the same game — and the
    // detail screen reads the BROWSE one (`browse.game.requiresInstall` decides whether Play is there,
    // `canUninstall` whether the menu offers Uninstall). Pushing only the state left the screen showing
    // "Install" after an install had finished, until the user stepped out to the carousel and back in,
    // which is what re-asked for the browse info.
    //
    // Only the INFO is re-pushed, never the assets: the hero images and the music have not changed, and
    // re-reading them on every state change would cost megabytes per transition.
    const browse = this.presenter.browse;
    if (browse !== null && browse.id === info.id && browse.active) {
      this.presenter.pushBrowse({ ...browse, game: info });
    }
    // Poll for ANY steam game whose source is available: it catches install completion (Install→Play),
    // uninstall completion (Play→Install) — incl. an uninstall the user triggers in Steam directly — and
    // download progress. A LOCAL steam game's source is always available, so this poll is no longer bounded
    // by how long a card stays in: the launcher sitting on such a game polls it for as long as it is shown.
    // The .acf read is cheap enough for that to be an acceptable price.
    if (info.installVia === 'steam' && this.sourceAvailableFor(info.id)) {
      this.steamWatch.start();
    } else {
      this.steamWatch.stop();
    }
  }

  // ── Reaction to card insertion ───────────────────────────────────────────

  private async onInsert(root: string): Promise<void> {
    // A card was swapped in mid-flight (no empty tick). Don't process it now — that would race the
    // in-flight sequence. Stash it, abort the current flow; its finally replays this once it unwinds.
    if (this.sequences.inFlight) {
      log.info(`[insert] card swapped during launch/install — deferring root="${root}"`);
      this.sequences.deferInsert(root);
      return;
    }
    await this.loadCard(root, { focus: true });
  }

  /**
   * Reads a card at `root` and drives the launcher to `ready` for the selected game (single- or
   * multi-game card), or to `error` — the shared body of an ordinary insert AND a Customize save.
   * A multi-game card exposes its other games through the history carousel (the light game list). `focus`
   * controls whether the launcher pops to the front: true for a real insertion (unchanged behaviour), false
   * for a reload so a Save from the Customize screen doesn't raise the window over what is on top. Returns the
   * readManifests verdict so the caller (reloadManifest) can report it; onInsert ignores it.
   */
  private async loadCard(
    root: string,
    opts: { readonly focus: boolean },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    this.cardLoadInFlight = true;
    try {
      return await this.loadCardBody(root, opts);
    } finally {
      this.cardLoadInFlight = false;
    }
  }

  private async loadCardBody(
    root: string,
    opts: { readonly focus: boolean },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    this.cardPresent = true;
    log.info(`[insert] card detected at root="${root}"`);
    // A card that was pulled mid-write leaves the temp file of that write behind, under a name unique to
    // it that nothing will ever reuse. The card root is where the user SEES it, so it is swept here — in
    // the background, because an insertion waits for nothing that is merely tidy.
    void sweepAtomicTemps(root).catch((cause: unknown) =>
      log.warn('[insert] sweeping the card temp files failed:', describe(cause)),
    );
    // Documents is resolved via the system Known Folder API (the same one the game uses),
    // so %DOCUMENTS% in the manifest maps to the real save folder regardless of UI
    // language or OneDrive redirection. Safe to read here — app is ready by now.
    const env: ManifestEnv = { documents: app.getPath('documents'), t: this.t };
    // BEFORE the manifests are read: edits the user made from the history are written onto the card here,
    // so everything downstream — validation, the resolved manifests, the history copy — sees one already
    // reconciled file. It also runs on a plain reload (a Save from Customize), where it is a no-op: an
    // available game cannot have pending edits, since save-from-history refuses one.
    let sync = await syncHistoryConfig(root, { library: this.deps.library, t: this.t });
    let result = await readManifests(root, env, this.deps.platform.resolveInstallDir);
    if (!result.ok && sync.textBefore !== null) {
      // We rewrote the file and the card stopped reading. Put the author's own text back and try again
      // rather than leave a card that the launcher itself bricked. `sync` becomes the undone version of
      // itself, so the commit below leaves the edits pending and the user is told they were NOT applied.
      const reverted = await rollbackHistorySync(root, sync);
      if (reverted !== null) {
        sync = reverted;
        result = await readManifests(root, env, this.deps.platform.resolveInstallDir);
      }
    }
    // Only now, and on EVERY path: the card has had its final say, so the history may record it and the
    // user may be told. Both used to sit inside the sync itself, which meant a rollback erased the edits
    // it claims to preserve and said nothing about it.
    await commitHistorySync(sync, this.deps.library);
    this.notifyHistorySync(sync);
    if (!result.ok) {
      // No valid game determined → keep the window hidden (the reason is in the log). We still set
      // the error state so a manually-summoned window can show it, but we never auto-surface it.
      log.warn(`[insert] manifest rejected: ${result.message}`);
      this.clearCard();
      this.deps.state.set({ kind: 'error', message: result.message });
      // Desktop/Windows: keep the window hidden (background app — the error is in the log and only shows
      // if the user summons the window). Game Mode: there is no tray to hide into, so surface the manifest
      // error on screen instead of hiding.
      if (this.deps.isGamescope) this.deps.window.showAndFocus();
      else this.deps.window.hide();
      return { ok: false, message: result.message };
    }
    const manifests = result.manifests;
    // Keep the selection on a reload if it still points at one of this card's games; a real insert starts
    // at the first (an inserted card is what you are meant to be looking at, even mid-browse).
    const keepSelection =
      !opts.focus && manifests.some((manifest) => manifest.raw.id === this.selectedId);
    this.cardGames = manifests;
    if (!keepSelection) this.selectedId = manifests[0]?.raw.id ?? null;
    this.warnShadowedLocalGames();
    this.sequences.unlock();
    log.info(`[insert] manifest ok games=${manifests.length} ids=[${manifests.map((m) => m.raw.id).join(',')}] root="${root}"`);

    // Read the card's traveling stats ONCE to detect the pre-multi-game bare-Stats format. Attribution of
    // that legacy value is decided HERE (only loadCard knows the game count): a single-game card owns it
    // unambiguously; on a multi-game card the owner is unknown → ignore it (the per-id PC mirror is intact).
    const cardStatsRead = await this.deps.stats.readCardStatsMap(root);
    let legacyForSingle: Stats | null = null;
    if (cardStatsRead.kind === 'legacy') {
      if (manifests.length === 1) legacyForSingle = cardStatsRead.stats;
      else log.warn(`[stats] legacy bare card stats on a ${manifests.length}-game card — owner ambiguous, ignoring (PC mirror per-id is intact)`);
    }

    // Reconcile + copy card stats for EVERY game FIRST (so each PC mirror holds the merged value before
    // anything writes the card), caching the merged Stats per id so onSelectRequested can rebuild the
    // switched-to game's GameInfo without re-reading. Order matters vs the flush below.
    this.forgetCardStats();
    for (const manifest of manifests) {
      const stats = await this.deps.stats.reconcileWithCard(manifest.raw.id, root, legacyForSingle);
      await this.deps.stats.copyToCard(root, manifest.raw.id, stats);
      this.statsById.set(manifest.raw.id, stats);
    }

    // If a card was yanked mid-game last time — top up the deferred PC→SD (saves snapshot) for ANY game
    // that has a pending flush, not just the selected one (else game B's flush hangs until B is selected on
    // some future insert). Runs AFTER all reconciles so each flush's stats copy uses the merged value.
    for (const manifest of manifests) {
      try {
        await this.saveSync.flushPendingIfAny(manifest);
      } catch (cause) {
        log.warn(`[pending-flush] failed on insert for id=${manifest.raw.id}:`, describe(cause));
      }
    }

    // The LIGHT carousel list — this card's games (active) followed by the play history. No heavy assets:
    // the selected game's hero/audio are built on demand below, the cards' art on request. Built here but
    // DELIVERED at the end, after the browse cursor: a row that arrives first is reshuffled twice on
    // screen — once into the new order around the game the window is still showing, and again when the
    // cursor moves to the card's own game. The renderer holds an early cursor for a row it does not have
    // yet (see the carousel's pendingFocusId), so the late delivery costs nothing and the cards travel once.
    const library = this.buildLibrary();

    // A real insert starts on the card's first game AS THE ROW ORDERS THEM (by how recently each was
    // played), not as game.json lists them — the cursor has to land where the user can see it. A reload
    // keeps whatever was selected (keepSelection above).
    if (!keepSelection) this.selectedId = this.firstCarouselGame(library)?.raw.id ?? this.selectedId;

    // Always enter `ready` for the selected game (single- or multi-game card). Its hero/audio go out on the
    // existing per-game channels; the carousel handles switching between the card's games.
    const selected = manifests.find((manifest) => manifest.raw.id === this.selectedId) ?? manifests[0];
    if (selected !== undefined) {
      const stats = this.statsById.get(selected.raw.id) ?? (await this.deps.stats.read(selected.raw.id));
      this.presenter.setCardMusic(await this.presenter.cardMusicFor(selected));
      this.presenter.setHero(await this.assets.readHeroAssets(selected));
      this.enterReady(await this.buildGameInfo(selected, stats));
      // The card's own game is what you look at on insert (the single-game case is then exactly today's
      // screen: browse.id === AppState.game.id).
      await this.browseToUnlessPinned(selected.raw.id);
    }
    // …and only now the row, so it lands with the cursor already on the card it is about to put first.
    this.presenter.setLibrary(library);
    if (opts.focus) this.deps.window.showAndFocus();

    // Copy this card's art/audio into the history IN THE BACKGROUND: a card is slow media and the window
    // is already on screen. One sequential task for the whole card (index.json is a single file — see
    // LibraryStore.saveFromCard), then a list refresh so the freshly-copied games get their artwork.
    void this.deps.library
      .saveFromCard(manifests, sync.slots)
      .then(() => this.refreshLibrary())
      .catch((cause: unknown) => log.warn('[library] copying the card assets failed:', describe(cause)));
    // Last, and only now: a game that lives on this card AND on this PC needs an answer from the user,
    // and asking for one is not allowed to hold the card up (see askAboutCollisions).
    this.askAboutCollisions(root);
    return { ok: true };
  }

  /**
   * Reads the PC library and folds it into the launcher, the way loadCard does for a card — minus the two
   * things that belong to removable media: the card's traveling stats (a local game's mirror is the only
   * copy there is) and, deliberately, the pending flush.
   *
   * NOT flushing is load-bearing, not an omission: a local game HAS a `saveOnCardPath` (its backup in the
   * library), so a symmetrical copy of loadCard would pour a snapshot meant for the real card into that
   * backup and then clear the queue — silently losing the progress the next card insertion was supposed
   * to receive. Pending snapshots are for cards only; see performSyncOut.
   */
  private async loadPcLibrary(): Promise<void> {
    const env: ManifestEnv = { documents: app.getPath('documents'), t: this.t };
    const read = await this.deps.pcLibrary.read(env, this.deps.platform.resolveInstallDir);
    this.pcGames = [...read.manifests];
    log.info(`[pc-library] ${read.manifests.length} local game(s) ids=[${read.manifests.map((m) => m.raw.id).join(',')}]`);
    this.warnShadowedLocalGames();
    // A local game that is gone takes its collision answer with it: there is nothing left to collide,
    // and a draft recreated under the same id later deserves the question afresh.
    void this.deps.library
      .clearCollisionAnswers(read.manifests.map((manifest) => manifest.raw.id))
      .catch((cause: unknown) =>
        log.warn('[collision] clearing the answers of removed local games failed:', describe(cause)),
      );
    for (const manifest of read.manifests) {
      this.statsById.set(manifest.raw.id, await this.deps.stats.read(manifest.raw.id));
    }
    this.refreshLibrary();
    // With no card in, the local games are what the launcher has to show: leave `idle` for the first of
    // them instead of the empty screen. A card (or any activity) present → don't touch the state machine.
    if (!this.cardPresent && this.deps.state.get().kind === 'idle' && !this.sequences.inFlight) {
      // The row's first card, not the library file's first entry — see firstCarouselGame. refreshLibrary
      // above has already built the row this reads, so the two can't disagree.
      const selected = this.firstCarouselGame();
      if (selected !== null) {
        this.selectedId = selected.raw.id;
        this.presenter.setHero(await this.assets.readHeroAssets(selected));
        this.presenter.setCardMusic(await this.presenter.cardMusicFor(selected));
        this.enterReady(await this.buildGameInfo(selected, this.statsById.get(selected.raw.id) ?? (await this.deps.stats.read(selected.raw.id))));
        await this.browseToUnlessPinned(selected.raw.id);
      }
    } else if (!this.cardPresent) {
      await this.reseedBrowse();
    } else if (this.browseIsStale()) {
      // A card is in, so neither branch above applies — but a LOCAL game may have just been deleted from
      // the manifest, and it may be the very one on screen. The cursor would go on claiming that game is
      // available, and the Details menu is built from exactly that claim: Customize would still be
      // offered for a game the file no longer has, while "Remove from history" — the item that game now
      // needs — would stay missing until the user left the screen and came back.
      await this.reseedBrowse();
    }
    this.dropStateIfGameGone();

    // Same background copy a card gets: the artwork already lives in the library root, but the history is
    // what the carousel draws from, and it is also what keeps a local game's card on screen after the
    // game itself is deleted from disk. A local game SHADOWED by the card is skipped — both would write
    // the same history record, and re-inserting the card would then flip its artwork back and forth.
    const visibleLocal = this.games.filter((manifest) => manifest.source === 'pc');
    void this.deps.library
      .saveFromCard(visibleLocal)
      .then(() => this.refreshLibrary())
      .catch((cause: unknown) => log.warn('[library] copying the local games\' assets failed:', describe(cause)));

    // Assets of games the user removed are only orphans when the manifest is TRUSTWORTHY — a library that
    // merely failed to parse reports zero games, and sweeping on that would delete every picture in it.
    if (read.intact) {
      void this.deps.pcLibrary
        .gcOrphans(read.manifests.flatMap(referencedAssets))
        .catch((cause: unknown) => log.warn('[pc-library] asset cleanup failed:', describe(cause)));
    }
  }

  /**
   * Re-reads the PC library after the Customize screen saved it (the local twin of reloadManifest). Same
   * busy guards: a reload during a launch/install would swap the manifest under the running sequence.
   */
  async reloadPcLibrary(): Promise<{ ok: true } | { ok: false; message: string }> {
    const kind = this.deps.state.get().kind;
    if ((kind !== 'ready' && kind !== 'error' && kind !== 'idle') || this.sequences.inFlight) {
      return { ok: false, message: this.t('errors.finishBeforeApply') };
    }
    if (this.reloadInFlight) return { ok: false, message: this.t('errors.reloadInProgress') };
    this.reloadInFlight = true;
    try {
      await this.loadPcLibrary();
      // A local game may have just been edited or removed: rebuild what is on screen so the detail screen
      // (title, "Game files not found", Play/Uninstall) matches the manifest that was saved.
      const selected = this.current();
      if (selected !== null && !this.cardPresent && this.deps.state.get().kind === 'ready') {
        const stats = this.statsById.get(selected.raw.id) ?? (await this.deps.stats.read(selected.raw.id));
        this.enterReady(await this.buildGameInfo(selected, stats));
        await this.browseToUnlessPinned(selected.raw.id);
      }
      await this.refreshBrowsedLocalGame();
      return { ok: true };
    } finally {
      this.reloadInFlight = false;
    }
  }

  /**
   * Re-sends the game ON SCREEN once the PC library has been re-read, when that game is a local one.
   *
   * Everything else in the reload speaks for the SELECTED game and only with no card in — both branches
   * here and in loadPcLibrary are gated on `!cardPresent` — while the Customize screen edits the game the
   * cursor is BROWSING. With a card inserted nothing above said a word about it, and even without one the
   * two cursors are free to point at different games. A game's hero and its music are read once per
   * browse, so a track added from that screen stayed unheard until the user flipped to another card and
   * back, which is what re-read the manifest.
   *
   * Nothing to do while the cursor is parked on a launcher card (`currentBrowse` is null there): the
   * launcher's own background and its ambience are not the library's to refresh. Immediate rather than
   * debounced — a press of Save is a commitment, not a flip through the row.
   */
  private async refreshBrowsedLocalGame(): Promise<void> {
    const id = this.presenter.browse?.id;
    if (id === undefined) return;
    // The EFFECTIVE manifest, not the library's own: a local game whose id is also on the card is served
    // by the card (see `games`), and the card's reload speaks for that one.
    const manifest = this.games.find((game) => game.raw.id === id);
    if (manifest === undefined || manifest.source !== 'pc') return;
    await this.browseTo(id, true);
  }

  /**
   * Enters `ready` on a local game with its assets, without touching the window's visibility: this runs
   * when a card was pulled, and a launcher the user had hidden must stay hidden (the same intent
   * onRemove's hide/show branch respects).
   */
  private async enterReadyForLocal(manifest: ResolvedManifest): Promise<void> {
    this.selectedId = manifest.raw.id;
    const stats = this.statsById.get(manifest.raw.id) ?? (await this.deps.stats.read(manifest.raw.id));
    this.presenter.setHero(await this.assets.readHeroAssets(manifest));
    this.presenter.setCardMusic(await this.presenter.cardMusicFor(manifest));
    this.enterReady(await this.buildGameInfo(manifest, stats));
    await this.browseToUnlessPinned(manifest.raw.id);
  }

  /**
   * Where one game's manifest lives, by id — the bridge the Customize screen crosses from "the game I am
   * looking at" to "the file that describes it". Only games that can be acted on right now are answered
   * for (`games`), which is the same rule the screen's menu item is gated on.
   *
   * The INDEX is deliberately not part of the answer: `games` is a filtered, reordered union of the card
   * and the library (a shadowed local game is hidden, the carousel order is applied elsewhere), so a
   * position here says nothing about the slot's position inside game.json. The screen finds its slot by
   * `id` instead.
   */
  findGameSource(id: string): { readonly root: string; readonly source: ManifestSource } | null {
    const manifest = this.games.find((game) => game.raw.id === id);
    if (manifest === undefined) return null;
    return { root: manifest.root, source: manifest.source };
  }

  /** The full RESOLVED manifest of one game, by id — what moveToCard needs to plan its asset/save copies
   * (findGameSource only answers where the file lives, not what it resolves to). */
  findManifest(id: string): ResolvedManifest | null {
    return this.games.find((game) => game.raw.id === id) ?? null;
  }

  /**
   * Whether ANY game is currently running/installing/uninstalling (incl. a Steam op in flight) —
   * main's server-side mirror of the renderer's own isBusy (app.ts), which gates Delete on the Customize
   * screen and — new here — Move to card (GameConfigService.moveToCard): a move started while the
   * game is mid-launch would race the launcher's own manifest handling.
   */
  isBusy(): boolean {
    const kind = this.deps.state.get().kind;
    // Stated as the SETTLED states rather than the busy ones (the shape UpdaterService.isBusy uses): the
    // list of things a game can be in the middle of grew — launching, either save sync, the Proton prefix
    // — and an allow-list that has to be extended for each of them is the reason those four were missing
    // from the deny-list this replaced, JSDoc promise of mid-launch cover notwithstanding.
    const settled = kind === 'idle' || kind === 'ready' || kind === 'error';
    return !settled || this.steamBusyId !== null;
  }

  /** Logs the local games the inserted card currently shadows (same id — the card wins, see `games`). */
  /**
   * The Customize backend, attached after construction — it needs this controller to exist first (see
   * main.ts), and the collision answer needs it back. A narrow view of the service, not the service.
   */
  private collisionResolver: CollisionResolver | null = null;

  setCollisionResolver(resolver: CollisionResolver): void {
    this.collisionResolver = resolver;
  }

  /** The PC library's own manifest for `id`, even while a card of the same id shadows it. */
  findPcManifest(id: string): ResolvedManifest | null {
    return this.pcGames.find((manifest) => manifest.raw.id === id) ?? null;
  }

  /**
   * Asks — once per game — what should happen when the same id turns up on the card AND on this PC.
   *
   * Today the card simply wins, and the local game's name and artwork appear to vanish whenever it is
   * inserted (`warnShadowedLocalGames` says so in the log and nowhere else). A silent reconciliation is
   * not an option: the two manifests are independent, not a copy and its original, so there is no
   * baseline and no "which is newer" to decide by — hence a question rather than a rule.
   *
   * Raised at the END of loadCard: the card is already on screen, so nothing about it is held up by the
   * answer. One game at a time; an answer is remembered per id (collisionResolvedAt).
   */
  private askAboutCollisions(root: string): void {
    if (this.collisionInFlight) return;
    const cardIds = new Set(this.cardGames.map((manifest) => manifest.raw.id));
    const local = this.pcGames.find(
      (manifest) =>
        cardIds.has(manifest.raw.id) &&
        (this.deps.library.entry(manifest.raw.id)?.collisionResolvedAt ?? null) === null,
    );
    if (local === undefined) return;
    void this.pushCollision(root, local);
  }

  private async pushCollision(root: string, local: ResolvedManifest): Promise<void> {
    // The signature is captured WITH the question: the answer may arrive after the card has been pulled,
    // or swapped for a different one carrying the same id, and neither may be written to.
    const signature = await this.collisionResolver?.signatureFor(root);
    if (signature === undefined || signature === null) return;
    const collision: GameCollision = {
      id: local.raw.id,
      title: local.raw.title,
      root,
      signature,
    };
    this.deps.window.send(IPC.gameCollision, collision);
  }

  /**
   * The answer. "Merge" puts the local game's look on the card and — for a DRAFT, which has nothing else
   * to offer — removes it from the PC library, so the collision is gone for good. A fully configured
   * local game stays: it has its own launch and its own saves, and after the merge the flip between the
   * two sources is invisible anyway.
   *
   * The answer is remembered only once it has actually happened: a merge that failed leaves nothing
   * written and no decision recorded, so the question honestly comes back.
   */
  private async resolveCollision(answer: GameCollisionAnswer): Promise<ConfigSaveResult> {
    // The only renderer argument on this channel that used to be taken on trust. An id nothing knows
    // about would still be recorded as "answered", which writes a phantom entry the carousel then shows.
    if (!isSafeGameId(answer.id) || this.findPcManifest(answer.id) === null) {
      return { saved: false, message: this.t('errors.configInvalid') };
    }
    if (answer.choice === 'ignore') {
      await this.deps.library.markCollisionResolved(answer.id);
      return { saved: true, applied: 'deferred' };
    }
    const resolver = this.collisionResolver;
    if (resolver === null) return { saved: false, message: this.t('errors.configInvalid') };
    const local = this.findPcManifest(answer.id);
    this.collisionInFlight = true;
    try {
      const result = await resolver.mergeCollision(answer);
      if (!result.saved) return result;
      if (localGameGoesAfterMerge(result, local)) {
        const removed = await resolver.removeLocalGame(answer.id);
        if (!removed.saved) {
          log.warn(`[collision] the card took id=${answer.id}, but the local draft could not be removed: ${removed.message}`);
        }
      }
      await this.deps.library.markCollisionResolved(answer.id);
      return result;
    } finally {
      this.collisionInFlight = false;
    }
  }

  private warnShadowedLocalGames(): void {
    const cardIds = new Set(this.cardGames.map((manifest) => manifest.raw.id));
    for (const manifest of this.pcGames) {
      if (cardIds.has(manifest.raw.id)) {
        log.warn(`[pc-library] local game id=${manifest.raw.id} is hidden while a card carries the same id`);
      }
    }
  }

  /**
   * Applies an edited game.json to the ACTIVE card without restarting the app (the Customize screen).
   * Re-reads the manifest through the same loadCard path an insert uses (readManifest → stats reconcile
   * → audio/hero → buildGameInfo → enterReady | error), so nothing is duplicated and the steam poller's
   * stale-guard still holds. Focus is NOT taken (opts.focus=false) — the launcher is already in front.
   *
   * Two guards: (1) on ENTRY — refuse unless idle/ready/error and not launchInFlight (busy guard, like
   * UpdaterService.install; also prevents killing an in-flight sequence, since onInsert would abort it);
   * (2) reloadInFlight for the DURATION — checked by onLaunchRequested/onUninstallRequested so a gamepad
   * Play/Uninstall can't slip in during the reload's awaits.
   */
  async reloadManifest(root: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const kind = this.deps.state.get().kind;
    if ((kind !== 'ready' && kind !== 'error' && kind !== 'idle') || this.sequences.inFlight) {
      return { ok: false, message: this.t('errors.finishBeforeApply') };
    }
    if (this.reloadInFlight) return { ok: false, message: this.t('errors.reloadInProgress') };
    this.reloadInFlight = true;
    try {
      return await this.loadCard(root, { focus: false });
    } finally {
      this.reloadInFlight = false;
    }
  }

  // ── Reaction to card removal ─────────────────────────────────────────────

  private onRemove(): void {
    this.cardPresent = false;
    const kind = this.deps.state.get().kind;
    // During play/sync, removal is expected: the flow continues, sync-out
    // will see cardPresent=false and put the task into pending-flush. We don't touch state.
    if (
      kind === 'running' ||
      kind === 'launching' ||
      kind === 'installing' ||
      kind === 'uninstalling' ||
      kind === 'syncing-in' ||
      kind === 'syncing-out'
    ) {
      // During install, removal is also expected: the installer reads from the card, so yanking
      // it makes the install fail → <exe> won't appear → we stay on "Install"; next attempt pre-cleans.
      // During uninstall it targets the PC, so it completes; runUninstallSequence then sees cardPresent
      // = false and goes idle + hide on its own.
      return;
    }
    // ready / error / idle → no card. Stop any Steam re-detect poller (the card is gone; a Steam game in
    // `ready` reaches here since its kind is never running/installing).
    this.steamWatch.stop();
    this.steamWatch.clearUninstallRequest();
    this.clearCard();
    // A local game is still playable with no card in, so pulling one must not collapse the launcher to the
    // empty screen: stay `ready` on the first card of the row clearCard just rebuilt (NOT the first entry
    // of the library file — see firstCarouselGame). Only a truly empty launcher goes idle + hides.
    const remaining = this.firstCarouselGame();
    if (remaining !== null) {
      void this.enterReadyForLocal(remaining);
      return;
    }
    this.deps.state.set({ kind: 'idle' });
    // Normally the background app hides to the tray when no card is present. With "keep the launcher open
    // without a card" on, it stays up instead — BUT only if it's currently on screen. If the user
    // minimized it to the tray, pulling the card must not pop it back up (respect that intent).
    if (this.deps.isGamescope) {
      // Game Mode: no tray — the launcher always stays up (forces keepOpenWithoutCard).
      this.deps.window.showAndFocus();
    } else if (this.keepOpenWithoutCard) {
      if (this.deps.window.isShown()) this.deps.window.showAndFocus();
    } else {
      this.deps.window.hide();
    }
  }

  /**
   * Applies the "keep the launcher open without a card" setting (seeded at startup, toggled live from the
   * Settings screen). Besides caching the flag it reconciles the launcher NOW when we're idle with no
   * card: bring it up when turning it on, or hide back to the tray when turning it off. When a card is
   * present (ready/busy) nothing changes — the launcher is already visible for the game.
   */
  setKeepOpenWithoutCard(on: boolean): void {
    this.keepOpenWithoutCard = on;
    const kind = this.deps.state.get().kind;
    // `ready` counts too when no card is in: that is a LOCAL game on screen, and the setting is about
    // whether the launcher sits there with no card — not about which screen it happens to show.
    if (this.cardPresent || (kind !== 'idle' && kind !== 'ready')) return;
    // Game Mode (gamescope): there is no tray to hide into, and a HIDDEN window leaves gamescope with no
    // surface to present — Steam's launch spinner then hangs forever. So the window is ALWAYS shown there
    // (the empty "insert a card" screen), regardless of the setting. Desktop/Windows honour the flag.
    if (on || this.deps.isGamescope) this.deps.window.showAndFocus();
    else this.deps.window.hide();
  }

  // ── "Launch" action (the A button / click) ──────────────────────────────

  private onLaunchRequested(): void {
    const snapshot = this.deps.state.get();
    // Play pressed while a game is running (the launcher was summoned over it via the tray): return to the
    // game instead of launching. Checked BEFORE the ready-guard — launchInFlight is true during running,
    // but we never reach its check. No-op if we don't have the image names yet.
    if (snapshot.kind === 'running') {
      this.resumeRunningGame();
      return;
    }
    // Ignore input outside the ready state — this is the "ignore-gamepad" during play
    // (harmless under any interpretation of the Gamepad API focus bug).
    if (snapshot.kind !== 'ready' || this.sequences.inFlight || this.reloadInFlight) return;
    const manifest = this.current();
    if (manifest === null) return;
    // A local game whose .exe is gone (deleted, or an external drive unplugged). The renderer already
    // disables Play, but a gamepad press must not slip past it into a launch that can only fail.
    if (snapshot.game.unavailable === true) {
      log.info(`[launch] refused id=${manifest.raw.id}: "${manifest.executablePath}" is not on disk`);
      this.sendError(this.t('launcher.state.gameFilesMissing'));
      return;
    }
    // A local draft with no launch method chosen yet — same guard, different reason. The renderer already
    // disables Play, but a gamepad press must not slip past it into runLaunchSequence.
    if (snapshot.game.unconfigured === true) {
      log.info(`[launch] refused id=${manifest.raw.id}: no launch method is configured`);
      this.sendError(this.t('launcher.state.launchNotConfigured'));
      return;
    }
    // A Steam download/removal of ANOTHER game is in flight. Every other kind of activity moves the state
    // out of `ready` and is caught by the guard above; a Steam operation deliberately does not (it can run
    // for hours and the window stays usable), so it needs this explicit check — otherwise a second game
    // could be launched or installed on top of it from the carousel.
    if (this.steamBusyId !== null && this.steamBusyId !== manifest.raw.id) {
      log.info(`[launch] refused id=${manifest.raw.id}: a Steam operation is in flight for id=${this.steamBusyId}`);
      this.sendError(this.t('errors.steamBusyOther'));
      return;
    }
    // Steam mode: not yet installed → open steam://install (fire-and-forget); otherwise launch via
    // steam://rungameid. Both inside runSteamInstall / runLaunchSequence's steam branch.
    if (manifest.steam !== undefined) {
      if (snapshot.game.requiresInstall) {
        void this.sequences.runSteamInstall(manifest, snapshot.game);
      } else {
        void this.sequences.runLaunchSequence(manifest, snapshot.game);
      }
      return;
    }
    // Card-install mode + not yet installed → run the installer; otherwise it's an ordinary launch
    // (this includes a fully-installed game, whose executable now exists → requiresInstall=false).
    if (manifest.install !== undefined && snapshot.game.requiresInstall) {
      void this.sequences.runInstallSequence(manifest, snapshot.game);
    } else {
      void this.sequences.runLaunchSequence(manifest, snapshot.game);
    }
  }

  /**
   * Return-to-game: raise the running game's own window to the foreground (restoring it if it minimized
   * when it lost focus). Best-effort — if the window isn't found (the game is already closing, a race with
   * waitForExit) it's a silent no-op; the state machine will move to syncing-out → ready on its own.
   */
  private resumeRunningGame(): void {
    const names = this.sequences.runningGameImageNames;
    if (names === null) return;
    if (!this.deps.processControl.focusGameWindow(names)) {
      log.info('[resume] running game window not found — no-op (it may be closing)');
    }
  }

  /**
   * The carousel entered a game's detail screen (renderer sent action:select with the game id). Switches to
   * it: builds that game's hero/audio/GameInfo on demand (only the selected game ever gets heavy assets)
   * and enters `ready`. Selection is by id (not index) so a card reload that reorders games can't pick the
   * wrong one. Rejected unless we're on `ready` and idle (not locked / launching / reloading) — the same
   * guard the launch path enforces, so you can't switch the card's game while one is running.
   */
  private async onSelectRequested(idRaw: unknown): Promise<void> {
    if (typeof idRaw !== 'string') return;
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'ready' || this.sequences.isLocked || this.sequences.inFlight || this.reloadInFlight) return;
    const manifest = this.games.find((m) => m.raw.id === idRaw);
    if (manifest === undefined) {
      log.warn(`[select] no game with id="${idRaw}" on the current card or in the PC library — ignoring`);
      return;
    }
    this.selectedId = manifest.raw.id;
    // Build the switched-to game's assets on demand (mirrors loadCard). Stats come from the loadCard cache
    // (buildGameInfo still re-reads a steam game's .acf); fall back to a fresh read if somehow absent.
    const stats = this.statsById.get(manifest.raw.id) ?? (await this.deps.stats.read(manifest.raw.id));
    this.presenter.setHero(await this.assets.readHeroAssets(manifest));
    this.presenter.setCardMusic(await this.presenter.cardMusicFor(manifest));
    this.enterReady(await this.buildGameInfo(manifest, stats));
    // Keep what's on screen in step with the selection (the renderer reads the title/stats from here).
    await this.browseToUnlessPinned(manifest.raw.id);
  }

  /** "Uninstall" action (the user confirmed in the popup). Only for an installed install-mode game. */
  private onUninstallRequested(): void {
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'ready' || this.sequences.inFlight || this.reloadInFlight) return;
    const manifest = this.current();
    if (manifest === null) return;
    if (!snapshot.game.canUninstall) return; // nothing installed to remove
    // Steam: delegate removal to Steam (steam://uninstall) — fire-and-forget, the poller flips to Install.
    if (manifest.steam !== undefined) {
      void this.sequences.runSteamUninstall(manifest, snapshot.game);
      return;
    }
    if (manifest.install === undefined) {
      // Normal executable game: the only "uninstall" is clearing its Wine prefix (Linux; the game stays on
      // the card). canUninstall is set only when that prefix exists — see buildGameInfo / prefixCleanupOnly.
      if (snapshot.game.prefixCleanupOnly === true) {
        void this.sequences.runPrefixCleanupSequence(manifest, snapshot.game);
      }
      return;
    }
    void this.sequences.runUninstallSequence(manifest, snapshot.game);
  }

  /**
   * Opens Steam's Downloads page (steam://open/downloads). Triggered by the Play button while a Steam
   * download is in progress (its loader is otherwise a no-op) so the user can pause/resume in Steam —
   * we can't control Steam's downloads programmatically (no URI/API for pause/resume).
   */
  private async onOpenSteamDownloads(): Promise<void> {
    try {
      await openSteamUri('steam://open/downloads');
    } catch (cause) {
      this.sendError(this.t('errors.steamOpenDownloads', { cause: describe(cause) }));
    }
  }

  // ── Building GameInfo for the UI ─────────────────────────────────────────

  private async buildGameInfo(manifest: ResolvedManifest, stats: Stats): Promise<GameInfo> {
    // Hero images are NOT part of GameInfo anymore — they travel on the hero:update channel (see
    // readHeroAssets / setHero), delivered once per card on insert (not on every state transition).
    // Three mutually-exclusive modes decide requiresInstall/canUninstall/installVia. Kept as an EXPLICIT
    // 3-way branch (not the old `install !== undefined && !installed` formula, which gives false for a
    // steam game and would always show "Play"). executablePath is only read by pathExists in the
    // install/normal branches, where it is real (in steam mode it is '' and we never reach that read).
    let requiresInstall: boolean;
    let canUninstall: boolean;
    let installVia: 'steam' | 'copy' | undefined;
    let prefixCleanupOnly = false;
    let steamInstalling = false;
    let steamPaused = false;
    let steamPausedProgress: number | undefined;
    if (manifest.steam !== undefined) {
      // Steam mode: "installed" is Steam's own .acf state; uninstall is managed in Steam (never here).
      const status = await steamInstallStatus(manifest.steam.appid, this.deps.platform.steamLocator);
      requiresInstall = status.state !== 'installed';
      // Steam uninstall is delegated to Steam (steam://uninstall) — available once installed.
      canUninstall = status.state === 'installed';
      installVia = 'steam';
      // Non-blocking "Installing…" indicator while Steam is downloading (no live percent — see types.ts);
      // `paused` flips it to "Installing paused on N%…" using the snapshot percent.
      steamInstalling = status.state === 'downloading';
      steamPaused = status.state === 'downloading' && status.paused;
      steamPausedProgress = status.state === 'downloading' ? (status.progress ?? undefined) : undefined;
    } else if (manifest.install !== undefined) {
      // Card-install mode: installed ⇔ the resolved executable exists; that also enables Uninstall.
      const installed = await fse.pathExists(manifest.executablePath);
      requiresInstall = !installed;
      canUninstall = installed;
      // `copy` shares this branch but not its install-confirm copy: no installer runs, so the silent-mode
      // caveat and the destination path (which exists only for the user to paste into an installer's
      // picker) are meaningless there. Tell the renderer which of the two notes to show.
      installVia = manifest.install.type === 'copy' ? 'copy' : undefined;
    } else {
      // Normal card game: always ready to play. On Linux it still creates a per-game Wine prefix on first
      // launch — offer to clear that prefix (the game stays on the card). win32 has no prefix → null → no
      // Uninstall button (unchanged). "Uninstall" here means prefix cleanup, not removing an install.
      // A LOCAL game shares this branch: it is an ordinary executable, only one that lives on the PC.
      requiresInstall = false;
      const cleanupDir = await this.deps.platform.gameLauncher.prefixCleanupDir(manifest.raw.id);
      canUninstall = cleanupDir !== null;
      prefixCleanupOnly = canUninstall;
      installVia = undefined;
    }
    // A local game's executable is checked HERE, not at read time (a card game's is the other way round):
    // its absence must not drop the game from the library — the card, its art and its save backup stay,
    // and only Play is disabled. See ManifestSource / the pc block.
    // Stated POSITIVELY — "this game carries its own executable, and it is gone" — so it stays right for a
    // local STEAM game, whose executablePath is the '' placeholder: `pathExists('')` is false, and a
    // by-source check would strip its Play button. Steam's own "not installed" is `requiresInstall`.
    const unavailable =
      manifest.raw.pc !== undefined && !(await fse.pathExists(manifest.executablePath));
    const unconfigured = manifest.unconfigured === true;
    return {
      id: manifest.raw.id,
      title: manifest.raw.title,
      lastPlayedAt: stats.lastPlayedAt,
      totalPlaySeconds: stats.totalPlaySeconds,
      launchCount: stats.launchCount,
      requiresInstall,
      canUninstall,
      // Installer-view dir: on linux this is the `C:\playhook\games\<id>` the user would paste into a
      // non-silent Wine picker; on win32 it equals the host dir.
      ...(manifest.install !== undefined ? { installDir: manifest.install.installerDir } : {}),
      ...(installVia !== undefined ? { installVia } : {}),
      ...(prefixCleanupOnly ? { prefixCleanupOnly: true } : {}),
      ...(steamInstalling ? { steamInstalling: true } : {}),
      ...(steamPaused ? { steamPaused: true } : {}),
      ...(steamPausedProgress !== undefined ? { steamPausedProgress } : {}),
      ...(unavailable ? { unavailable: true } : {}),
      ...(unconfigured ? { unconfigured: true } : {}),
    };
  }

  // ── Audio (the card's music + the bundled UI sound set) ──────────────────

  /**
   * Recomputes and re-pushes the audio after an audio-settings change (the sound set, "only global
   * ambience"). Re-reads the sound set (the AssetReader cache re-keys on the set) and re-pushes the
   * loaded card's music — that second half is not optional: "only global ambience" is what decides
   * whether the card's music exists at all (readMusicDataUrl), so without a re-push the browse channel
   * would go silent while a stale card music, read while the flag was off, kept playing over it.
   * A set switch leaves the music URL identical, and the renderer treats that as a no-op, so it never
   * restarts the track.
   */
  async refreshAudio(): Promise<void> {
    const sfxSet = await this.assets.readSfxSet();
    const manifest = this.current();
    this.presenter.setCardMusic(await this.presenter.cardMusicFor(manifest));
    // The carousel plays the BUNDLED set, and what you hear on screen comes from the browse channel —
    // both have to follow the setting too, or a change only lands after you flip to another card (the
    // browse music outranks the card's own, so a stale value would keep playing over it).
    this.presenter.setSfxSet(sfxSet);
    await this.presenter.refreshBrowseMusic();
  }

  /** Applies a default-ambience change live: re-reads the track as a data URL and pushes it to the game
   *  window (the renderer crossfades; a card's own music still wins). */
  async setAmbientTrack(track: string | null): Promise<void> {
    this.presenter.setAmbient(await this.assets.readAmbientDataUrl(track));
  }


  // ── Carousel list (the card's games + the play history) ────────────────────

  /**
   * Rebuilds and pushes the carousel list: the inserted card's games first (they are the ones that can be
   * launched right now), then the played history — each group most recently played first. No stats are
   * read from disk here: the index caches launchCount/lastPlayedAt for exactly this, and the card's
   * own games use the reconciled stats already in memory (statsById), falling back to the index for a
   * game whose reconcile hasn't happened yet.
   *
   * A card game is listed even when the library has no record for it yet — the asset copy runs in the
   * background after the window is already up, and the carousel must not wait for it.
   */
  /** True while a card is being read — see cardLoadInFlight (the Customize-from-history guard). */
  isCardLoading(): boolean {
    return this.cardLoadInFlight;
  }

  /** Re-pushes the carousel row (GameConfigService calls it after a save from the history). */
  refreshLibraryRow(): void {
    this.refreshLibrary();
  }

  private refreshLibrary(): void {
    this.presenter.setLibrary(this.buildLibrary());
  }

  /**
   * The same list, BUILT but not delivered — for the one caller that must decide something from it before
   * the renderer sees it (loadCard: the cursor belongs to the row's first card, and the row has to reach
   * the window AFTER that cursor does).
   */
  private buildLibrary(): GameLibrary | null {
    const activeIds = this.games.map((manifest) => manifest.raw.id);
    const active = new Set(activeIds);
    // TWO groups, each sorted on its own: the card's games first, then the local ones. Sorting the union
    // in one pass would interleave them by date, and the card you just inserted would land behind a local
    // game played more recently — the card is the thing the user physically acted on.
    const activeGames = [
      ...this.orderedForCarousel(this.cardGames),
      ...this.orderedForCarousel(this.games.filter((manifest) => manifest.source === 'pc')),
    ];
    const games = [
      ...activeGames.map((game) => {
        // `artRev` (the record's savedAt) changes only when the assets were actually re-copied, which is
        // what lets the renderer keep its decoded covers cached and still pick up an edited gridImage.
        const stored = this.deps.library.entry(game.id);
        return {
          id: game.id,
          title: game.title,
          active: true,
          source: game.source,
          ...(stored !== null ? { artRev: stored.savedAt } : {}),
          ...(game.unconfigured === true ? { unconfigured: true as const } : {}),
        };
      }),
      ...this.deps.library
        .entriesForCarousel(activeIds)
        .filter((entry) => !active.has(entry.id))
        .map((entry) => ({
          id: entry.id,
          title: entry.title,
          active: false,
          // A record written before `sourceKind` existed is a card's: the history was cards only until
          // the PC library came along, and the field fills in the next time the game shows up.
          source: entry.sourceKind ?? ('card' as const),
          artRev: entry.savedAt,
        })),
    ];
    return games.length > 0 ? { games } : null;
  }

  /** One source's games, most recently played first — the per-group ordering refreshLibrary applies. */
  private orderedForCarousel(manifests: readonly ResolvedManifest[]): readonly {
    readonly id: string;
    readonly title: string;
    readonly source: ManifestSource;
    readonly unconfigured?: true;
  }[] {
    return byRecentlyPlayed(
      manifests.map((manifest) => ({
        id: manifest.raw.id,
        title: manifest.raw.title,
        source: manifest.source,
        lastPlayedAt:
          this.statsById.get(manifest.raw.id)?.lastPlayedAt ??
          this.deps.library.entry(manifest.raw.id)?.lastPlayedAt ??
          null,
        ...(manifest.unconfigured === true ? { unconfigured: true as const } : {}),
      })),
    );
  }

  // ── Browse (what is on screen) ─────────────────────────────────────────────

  /**
   * `library:browse` — the carousel moved onto `id`. Answers with the browse info + that game's assets.
   * Deliberately does NOT touch `selectedIndex` or the AppState: looking at a game is not choosing it, so
   * this works while another game installs (and with no card at all).
   */
  private async onBrowseRequested(idRaw: unknown, immediateRaw: unknown): Promise<void> {
    // A launcher card is selected: nothing is on screen. The INFO goes out at once (the title and the
    // status line must clear as promptly as they do between games), while the heavy half rides the same
    // debounce a game's does — a flip PAST the launcher cards must not tear the background and the music.
    if (idRaw === null) {
      this.browsePinned = true;
      this.presenter.pushBrowse(null);
      this.presenter.scheduleBrowseAssets(null, immediateRaw === true);
      return;
    }
    if (typeof idRaw !== 'string') return;
    this.browsePinned = false;
    await this.browseTo(idRaw, immediateRaw === true);
  }

  /**
   * `library:forget` — the user dropped a game from the history. REFUSED for a game that is available
   * right now: the card's and the PC library's games are rebuilt from their manifests on every insert /
   * library load, so forgetting one would achieve nothing but throwing its artwork away until the next
   * refresh copies it back. The menu hides the item for those games; this is the same rule on the side
   * that owns the data (the renderer's list is a view, not an authority).
   */
  private async onForgetRequested(idRaw: unknown): Promise<void> {
    if (typeof idRaw !== 'string') return;
    if (this.games.some((manifest) => manifest.raw.id === idRaw)) {
      log.warn(`[library] refused to forget id=${idRaw}: the game is available right now`);
      return;
    }
    if (!(await this.deps.library.forget(idRaw))) return;
    this.refreshLibrary();
    // Only when it was the game ON SCREEN: reseeding otherwise would drag the cursor off whatever the
    // user is looking at. With it gone the cursor lands on the next game, or on the empty screen.
    if (this.presenter.browse?.id === idRaw) await this.reseedBrowse();
  }

  /**
   * Builds and pushes BrowseInfo for `id` (from the card when it is there, else the history) and schedules
   * its assets. The INFO goes out at once — the title, the stats and the status line hang off it, and a
   * carousel whose name lags behind the highlighted card reads as broken — while the hero images and the
   * music, which are megabytes each, are debounced so flipping through the strip doesn't read the disk
   * once per step.
   */
  private async browseTo(id: string, immediate = false): Promise<void> {
    const manifest = this.games.find((m) => m.raw.id === id) ?? null;
    if (manifest !== null) {
      const stats = this.statsById.get(id) ?? (await this.deps.stats.read(id));
      const info = await this.buildGameInfo(manifest, stats);
      this.presenter.pushBrowse({ id, title: manifest.raw.title, active: true, stats, game: info });
      this.presenter.scheduleBrowseAssets(id, immediate);
      return;
    }
    const entry = this.deps.library.entry(id);
    if (entry === null) {
      log.warn(`[browse] no game with id="${id}" on the card or in the history — ignoring`);
      return;
    }
    const stats = await this.deps.stats.read(id);
    // Read off the in-memory record, never off the disk: browseTo runs on EVERY step through the
    // carousel, with no debounce in front of it.
    const configurable = entry.cardSlotHash !== undefined && entry.sourceKind !== 'pc';
    this.presenter.pushBrowse({
      id,
      title: entry.title,
      active: false,
      stats,
      ...(configurable ? { configurable: true as const } : {}),
    });
    this.presenter.scheduleBrowseAssets(id, immediate);
  }

  /**
   * Where the cursor moves on main's own initiative — a card inserted, a library reloaded, a session
   * finished. Refused while the user is parked on a launcher card: the position in the row is theirs, and
   * an inserted card yanking the screen off Settings is exactly what this exists to prevent. Everything
   * else keeps working meanwhile (state:update, hero:update and card:music are pushed regardless), so the
   * new card is on screen the moment the user steps back onto a game themselves.
   */
  private async browseToUnlessPinned(id: string): Promise<void> {
    if (this.browsePinned) return;
    await this.browseTo(id);
  }

  /**
   * Lets go of a `ready` state whose game this read no longer carries and which nothing can replace.
   *
   * `ready` is not merely a phase: it NAMES a GameInfo. Play launches that GameInfo, and the Details menu
   * falls back to it whenever there is no game on screen at all (see screenGame in controls.ts) — so a
   * state left pointing at a deleted game keeps offering "Install" for it, and Play would try to launch
   * it. The retarget in reloadPcLibrary handles the ordinary case by moving the state onto another game;
   * it cannot help with the case that leaves the ghost behind — deleting the LAST game, where there is no
   * other game to move onto. Then the honest state is `idle`: the launcher is about nothing.
   */
  private dropStateIfGameGone(): void {
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'ready') return;
    if (this.games.some((manifest) => manifest.raw.id === snapshot.game.id)) return;
    if (this.current() !== null) return; // there IS something to be about — the retarget names it
    this.selectedId = null;
    this.presenter.setHero(null);
    this.presenter.setCardMusic(null);
    this.steamWatch.stop();
    this.deps.state.set({ kind: 'idle' });
  }

  /**
   * Whether the browse cursor's `active` flag has stopped matching reality — the game on screen is named
   * as available while it is no longer in any manifest, or the other way round. It is the one field of
   * BrowseInfo that a reload can invalidate WITHOUT moving the cursor, and the renderer decides what the
   * Details menu offers by it.
   */
  private browseIsStale(): boolean {
    const browse = this.presenter.browse;
    if (browse === null) return false;
    return browse.active !== this.games.some((manifest) => manifest.raw.id === browse.id);
  }

  /**
   * Moves the browse cursor after the list changed (a card removed, an entry evicted): keep the current
   * game if it is still listed, otherwise fall back to the first entry — or to nothing, which is the
   * genuine "no card and no history" empty screen.
   */
  private async reseedBrowse(): Promise<void> {
    const games = this.presenter.library?.games ?? [];
    const current = this.presenter.browse?.id;
    const next = games.find((game) => game.id === current) ?? games[0];
    if (next === undefined) {
      this.presenter.pushBrowse(null);
      this.presenter.pushBrowseHero(null);
      this.presenter.pushBrowseMusic(null);
      return;
    }
    await this.browseToUnlessPinned(next.id);
  }
}
