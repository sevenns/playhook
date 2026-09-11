// What the launcher window is SHOWING, and the pushes that keep it so: the selected card game's hero and
// music, the bundled UI sound set, the default ambience, the carousel row, and the browse cursor with its
// debounced hero/music reads. Split out of GameController, which decides WHAT to show (which game is
// selected, where the cursor lands) and hands the result here; this holds the last value per channel so
// the renderer's `*:request` invokes can be answered, and owns the debounce + ticket that keep a fast flip
// through the carousel from reading the disk once per step.
import { IPC, type BrowseInfo, type GameLibrary, type HeroAssets, type ResolvedManifest, type SfxSet } from '../shared/types';
import { type AssetReader } from './asset-reader';
import { type BrowseAssets } from './library-store';

// How long the browsed game's HEAVY assets (hero images, music — megabytes of data URL each) wait before
// being read. The light BrowseInfo goes out immediately, so the title/status/stats track the carousel
// with no lag; only the expensive half is debounced, and a burst of moves reads the disk once.
//
// It must outlast the GAP the renderer leaves between two chained auto-moves — releasing the pad for a
// beat and pressing again (AUTO_CHAIN_MS + NAV_REPEAT_MS in auto-repeat.ts, ~310 ms). Shorter than that
// and every such gap starts a megabyte-sized read plus a base64 encode for a game the user is already
// flipping past, which is what made a rapid press-release-press stutter. The renderer holds the swap for
// the same span (FLIP_SETTLE_MS in app.ts), so the two wait side by side rather than one after the other
// — this costs nothing on a single step. Keep the three in step if any of them changes.
const BROWSE_ASSETS_DEBOUNCE_MS = 320;

export interface BrowsePresenterDeps {
  /** Reads card assets (hero/audio/wallpaper) into data URLs. */
  readonly assets: AssetReader;
  /** Pushes one message to the launcher window (a no-op while there is none). */
  readonly send: (channel: string, payload: unknown) => void;
  /** The manifest of a game that can be acted on right now, by id — null for a history-only entry. */
  readonly findManifest: (id: string) => ResolvedManifest | null;
  /** The history's copy of a game's hero/music (the LibraryStore read). */
  readonly readBrowseAssets: (id: string) => Promise<BrowseAssets>;
  /** The "only global ambience" setting, read live. */
  readonly onlyGlobalAmbient: () => Promise<boolean>;
}

export class BrowsePresenter {
  // The inserted card's background music, sent on its own channel (not on every AppState) — it is the
  // card's only audio contribution. Null when there is no card, or when "only global ambience" mutes it.
  private currentCardMusic: string | null = null;
  // The bundled UI sound set chosen in Settings — the only source of UI sounds there is, on every screen.
  // Read once at init (warmSfxSet); null until then.
  private currentSfxSet: SfxSet | null = null;
  // The default ambience data URL, delivered on its own channel (independent of the card's music). The
  // renderer prioritizes a card's own music over this and crossfades between them. Null = no ambience.
  private currentAmbient: string | null = null;
  // Hero images for the current card, sent on their own channel (not on every AppState) — see HeroAssets.
  private currentHero: HeroAssets | null = null;
  // The light carousel list ({id,title,active}) — the inserted card's games plus the play history — in
  // display order, pushed on every change (insert / removal / finished session / eviction). Null when
  // there is nothing at all to show. The artwork travels separately, per card, on library:grid-request.
  private currentLibrary: GameLibrary | null = null;
  // What is on screen (see BrowseInfo): the truth for the title/stats/hero/music, INDEPENDENT of AppState
  // — which describes one game's process and cannot represent "a history game while no card is in", nor
  // "browsing game B while game A installs". Null only when there is neither a card nor any history.
  private currentBrowse: BrowseInfo | null = null;
  // Monotonic ticket for browse-asset reads: only the newest may push (see pushBrowseAssets).
  private browseAssetsSeq = 0;
  // Pending read of the browsed game's hero/music (see BROWSE_ASSETS_DEBOUNCE_MS).
  private browseAssetsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: BrowsePresenterDeps) {}

  // ── The last value per channel (the `*:request` invokes) ──────────────────

  get cardMusic(): string | null {
    return this.currentCardMusic;
  }

  get sfxSet(): SfxSet | null {
    return this.currentSfxSet;
  }

  get ambient(): string | null {
    return this.currentAmbient;
  }

  get hero(): HeroAssets | null {
    return this.currentHero;
  }

  get library(): GameLibrary | null {
    return this.currentLibrary;
  }

  get browse(): BrowseInfo | null {
    return this.currentBrowse;
  }

  /** Drops the pending browse-asset read (on application exit). */
  dispose(): void {
    if (this.browseAssetsTimer !== null) clearTimeout(this.browseAssetsTimer);
  }

  // ── Hero images (delivered once per card, rotated in the renderer) ───────

  /** Stores the current hero images and pushes them to the window (null when no card / on error). */
  setHero(assets: HeroAssets | null): void {
    this.currentHero = assets;
    this.deps.send(IPC.heroUpdate, assets);
  }

  // ── Audio (the card's music + the bundled UI sound set) ──────────────────

  /**
   * The music that belongs to the CARD channel — the one a game with no music of its own falls back to
   * (see the fallback chain in audio.ts: browsed game → card → ambience).
   *
   * A LOCAL game never fills it, and that is the whole point of this helper. The fallback says "you are
   * looking at a game with no theme, so keep playing the card's" — which is right for a card, whose
   * games travel together, and wrong for the PC library, where the selected game is just whichever one
   * happens to be highlighted: its theme would then play under every other local game, drowning out the
   * ambience the user chose in Settings. A local game's own music still reaches the ear through the
   * browse channel, which is what plays the game you are actually looking at.
   */
  async cardMusicFor(manifest: ResolvedManifest | null): Promise<string | null> {
    if (manifest === null || manifest.source !== 'card') return null;
    return this.deps.assets.readMusicDataUrl(manifest);
  }

  /** Stores the current card's music and pushes it to the window (null when no card / on error). */
  setCardMusic(url: string | null): void {
    this.currentCardMusic = url;
    this.deps.send(IPC.cardMusicUpdate, url);
  }

  /** Stores the bundled UI sound set and pushes it (every UI sound the app plays). */
  setSfxSet(set: SfxSet | null): void {
    this.currentSfxSet = set;
    this.pushSfxSet();
  }

  /** Pushes the bundled UI sound set (every UI sound the app plays). */
  pushSfxSet(): void {
    this.deps.send(IPC.sfxSetUpdate, this.currentSfxSet);
  }

  /**
   * Re-sends the browsed game's music after an audio-settings change ("only global ambience", the sound
   * set). Music only — re-running the whole browse would re-encode the hero images for nothing.
   */
  async refreshBrowseMusic(): Promise<void> {
    const browse = this.currentBrowse;
    if (browse === null) return;
    this.pushBrowseMusic(await this.browseMusicFor(browse.id));
  }

  /**
   * The music to play for a browsed game: the card's own file when it is on the inserted card, else the
   * copy in the history. "Only global ambience" suppresses BOTH — AssetReader applies it for the card,
   * and the history copy is checked here (LibraryStore knows nothing about settings), so a history game
   * cannot smuggle its theme past a setting that silenced the card games.
   */
  private async browseMusicFor(id: string): Promise<string | null> {
    const manifest = this.deps.findManifest(id);
    if (manifest !== null) return this.deps.assets.readMusicDataUrl(manifest);
    if (await this.deps.onlyGlobalAmbient()) return null;
    return (await this.deps.readBrowseAssets(id)).music;
  }

  /** Stores the default-ambience data URL (or null) and pushes it to the game window. */
  setAmbient(url: string | null): void {
    this.currentAmbient = url;
    this.deps.send(IPC.ambientUpdate, url);
  }

  // ── Carousel list (the card's games + the play history) ────────────────────

  /** Stores the current carousel list and pushes it to the window (null when there is nothing to show). */
  setLibrary(library: GameLibrary | null): void {
    this.currentLibrary = library;
    this.deps.send(IPC.libraryUpdate, library);
  }

  // ── Browse (what is on screen) ─────────────────────────────────────────────

  /** Stores the browsed game and pushes it to the window (null = nothing to show at all). */
  pushBrowse(browse: BrowseInfo | null): void {
    this.currentBrowse = browse;
    this.deps.send(IPC.browseUpdate, browse);
  }

  /** Pushes the browsed game's backgrounds. A SEPARATE channel from hero:update on purpose: that one
   * keeps carrying the inserted card's selected game, so browsing can never overwrite (and strand) it. */
  pushBrowseHero(assets: HeroAssets | null): void {
    this.deps.send(IPC.browseHero, assets);
  }

  /** Pushes the browsed game's music (music only — the SFX set is never rebuilt by browsing). */
  pushBrowseMusic(url: string | null): void {
    this.deps.send(IPC.browseMusic, url);
  }

  /** Debounced read+push of the browsed game's hero/music; a newer browse cancels the pending one.
   *  `null` is the launcher-card case: the same debounce, pushing empty assets at the end of it. */
  scheduleBrowseAssets(id: string | null, immediate = false): void {
    if (this.browseAssetsTimer !== null) clearTimeout(this.browseAssetsTimer);
    this.browseAssetsTimer = null;
    // `immediate` is the renderer saying the user has COMMITTED to this game (opened its screen) rather
    // than flipped onto it. Waiting out the debounce there means a quarter second of the previous game's
    // background and music on a screen that is already the new game's.
    if (immediate) {
      void this.pushBrowseAssets(id);
      return;
    }
    this.browseAssetsTimer = setTimeout(() => {
      this.browseAssetsTimer = null;
      void this.pushBrowseAssets(id);
    }, BROWSE_ASSETS_DEBOUNCE_MS);
  }

  private async pushBrowseAssets(id: string | null): Promise<void> {
    const seq = ++this.browseAssetsSeq;
    // Checked before EVERY push, not just on entry. Each read below is megabytes off the disk plus a
    // base64 encode, and the selection keeps moving while it runs — so a read started for a game the user
    // flipped past would otherwise land on the game they stopped on, dragging its background, its colours
    // and its music along. The sequence covers the other half: two reads in flight at once (a debounced
    // one and an immediate one) can finish out of order, and only the newest may speak.
    const current = (): boolean =>
      seq === this.browseAssetsSeq &&
      (id === null ? this.currentBrowse === null : this.currentBrowse?.id === id);
    if (!current()) return;
    // A launcher card: no background and no music of its own. The renderer answers an empty payload with
    // the idle wallpaper and the global ambience (see hero.applyIdleBackground / audio.setIdle).
    if (id === null) {
      this.pushBrowseHero(null);
      this.pushBrowseMusic(null);
      return;
    }
    const manifest = this.deps.findManifest(id);
    if (manifest !== null) {
      const hero = await this.deps.assets.readHeroAssets(manifest);
      if (!current()) return;
      this.pushBrowseHero(hero);
      const music = await this.deps.assets.readMusicDataUrl(manifest);
      if (!current()) return;
      this.pushBrowseMusic(music);
      return;
    }
    const assets = await this.deps.readBrowseAssets(id);
    if (!current()) return;
    // A history game with no hero of its own falls back to the wallpaper, exactly like a card game does
    // (readHeroAssets). Without it this push carried `null`, the renderer had nothing to paint, and the
    // PREVIOUS game's background stayed on screen under the new game's name.
    const hero = assets.hero ?? (await this.wallpaperHero());
    if (!current()) return;
    this.pushBrowseHero(hero);
    const music = await this.browseMusicFor(id);
    if (!current()) return;
    this.pushBrowseMusic(music);
  }

  /** The wallpaper as a one-image hero payload — the per-game fallback shared by both browse paths. */
  private async wallpaperHero(): Promise<HeroAssets | null> {
    const wallpaper = await this.deps.assets.readWallpaperDataUrl();
    return wallpaper === null ? null : { images: [wallpaper] };
  }
}
