// Flow orchestrator + IPC registration.
// This is where the state machine lives: the controller listens to drive-watcher, reacts to
// the "Launch" action from the renderer, runs the sequence sync→spawn→wait→sync
// and replicates AppState to the window. All FS/process work happens only here (in main).
import path from 'node:path';
import fse from 'fs-extra';
import { app, clipboard, ipcMain } from 'electron';
import {
  IPC,
  type AppState,
  type SfxSet,
  type BrowseInfo,
  type GameInfo,
  type GameLibrary,
  type HeroAssets,
  type InstallerRunType,
  type ResolvedInstallerRun,
  type ResolvedCopyInstall,
  type LaunchTarget,
  type ManifestSource,
  type ResolvedManifest,
  type SfxName,
  type Stats,
} from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { type StateManager } from './state';
import { type GameWindow } from './window';
import { acceptsPendingFlush, type PcStore, type SyncSlot } from './pc-store';
import { type StatsService } from './stats';
import { type LibraryStore } from './library-store';
import { type PcLibraryStore } from './pc-library';
import { byRecentlyPlayed } from './library-index';
import { type DriveWatcher } from './drive-watcher';
import { readManifests, findCaseInsensitiveName, type ManifestEnv } from './manifest';
import { syncDir, syncByChange, snapshotTree } from './save-sync';
import {
  waitForExit,
  waitForStart,
  waitForWatchedExit,
  waitForWatchedStart,
  waitForSteamStart,
  waitForSteamExit,
  killImagesElevated,
  LaunchAbortedError,
  type GameProcess,
} from './game-launcher';
import { findUninstallEntry } from './registry';
import { steamInstallStatus } from './steam';
import { openSteamUri } from './steam-uri';
import { type PcSaveLocation, type Platform, type ProcessMonitor } from './platform';
import { AssetReader } from './asset-reader';
import { type AppSettingsStore } from './app-settings';
import { focusGameWindow } from './window-finder';
import { normalizeImageNames } from './image-names';
import { SteamInstallWatch } from './steam-install-watch';
import { describe, delay } from './util';
import { log } from './logger';

export interface ControllerDeps {
  readonly state: StateManager;
  readonly window: GameWindow;
  readonly store: PcStore;
  readonly stats: StatsService;
  /** The play history behind the carousel: copied art/audio of every game inserted on this device. */
  readonly library: LibraryStore;
  /** The local games added from this PC's own disk — a second, always-present manifest source. */
  readonly pcLibrary: PcLibraryStore;
  readonly watcher: DriveWatcher;
  /** App-wide settings store — read/patched by the custom-wallpaper handlers (they own AssetReader). */
  readonly settings: AppSettingsStore;
  /** Platform services (process monitor, Steam locator, launcher, save-path resolver, power) for the OS. */
  readonly platform: Platform;
  /**
   * Whether this is a SteamOS Game Mode (gamescope) session. In Game Mode there is no tray, so every path
   * that would hide the window to the tray instead keeps the empty/error screen up (Р8). Always false on
   * Windows/desktop, so their behaviour is unchanged.
   */
  readonly isGamescope: boolean;
  /** The current translator (read live so a language change applies to freshly-generated messages). */
  readonly getTranslator: () => Translator;
}

// How long the browsed game's HEAVY assets (hero images, music — megabytes of data URL each) wait before
// being read. The light BrowseInfo goes out immediately, so the title/status/stats track the carousel
// with no lag; only the expensive half is debounced, and a burst of moves reads the disk once.
const BROWSE_ASSETS_DEBOUNCE_MS = 250;

// Grace-poll cadence after the installer exits, waiting for the game executable to appear.
const INSTALL_POLL_INTERVAL_MS = 1000;

// Force-close verification: after issuing the kills, a `taskkill /F` (or TerminateProcess) returns
// BEFORE the process actually leaves tasklist — a killed process in teardown still shows for a beat, and
// a launcher/wrapper can take longer (the very reason the exit waiters debounce). So we don't judge on a
// single instant snapshot: poll the targets over a window bounded by the manifest's killTimeoutSec
// (default 60s), succeeding as soon as they're all gone, and only reporting killFailed if something is
// STILL alive when the window elapses (a genuine failure, e.g. an elevated handle without
// PROCESS_TERMINATE rights). The poll cadence between snapshots:
const KILL_VERIFY_INTERVAL_MS = 500;

// For a runAsAdmin (elevated) game, the non-elevated kill can't touch its high-integrity processes. We
// give that first attempt a short grace to prove itself (a normal game dies well within this), and only
// if the targets survive it do we escalate to an elevated taskkill (one UAC prompt). Kept short so the
// UAC prompt isn't needlessly delayed for a game that genuinely needs it.
const KILL_ELEVATE_GRACE_SEC = 3;

// Directory removal retries: an Inno uninstaller forks a copy of itself into
// temp and exits early, so right after waitForExit it may still hold `unins000.*` for a moment — a
// few backed-off retries let the lock clear before fse.remove succeeds.
const REMOVE_RETRY_ATTEMPTS = 3;
const REMOVE_RETRY_BASE_MS = 300;

// ── Uninstaller resolution (FS search in the install dir → registry fallback) ──

/** Silent flags we build ourselves per installer family (the same families' silent semantics, minus
 * the dir-key). Never used for `custom` (it has no known silent-uninstall convention). */
function silentUninstallArgs(type: InstallerRunType): string[] {
  switch (type) {
    case 'nsis':
      return ['/S'];
    case 'inno':
      return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
    case 'custom':
      return [];
  }
}

/**
 * Step 1 — deterministic FS search for the uninstaller INSIDE the app-controlled install dir (we put
 * it there via the installer's dir-key, so it lives in the root): Inno drops `unins###.exe` (pick the
 * highest if several), NSIS drops `Uninstall.exe`/`uninst*.exe`. `custom` has no known convention → null.
 *
 * `copy` is excluded by TYPE, not by a branch: a copied directory is a game somebody else installed
 * earlier, so it may well carry a foreign `unins000.exe` that the nsis fallback below would happily
 * find and run with `/S` — silently uninstalling from the wrong machine's point of view.
 */
async function findUninstallerInDir(
  dir: string,
  type: InstallerRunType,
): Promise<string | null> {
  if (type === 'custom') return null;
  let names: readonly string[];
  try {
    names = await fse.readdir(dir);
  } catch {
    return null;
  }
  if (type === 'inno') {
    const candidates = names.filter((name) => /^unins\d{3}\.exe$/i.test(name)).sort();
    const chosen = candidates.at(-1);
    return chosen !== undefined ? path.join(dir, chosen) : null;
  }
  // nsis: the name is set by the .nsi but is almost always Uninstall.exe / uninst*.exe in the root.
  const match = names.find((name) => /^uninst(all)?.*\.exe$/i.test(name));
  return match !== undefined ? path.join(dir, match) : null;
}

/**
 * Parses a Windows command line into LOGICAL argv tokens following CommandLineToArgvW's backslash/quote
 * rules (2n backslashes + quote → n backslashes and a quote toggle; 2n+1 → n backslashes and a literal
 * quote). Used to split a registry UninstallString into exe + args; the original quoting is dropped (the
 * launcher re-quotes uniformly under verbatim:false).
 */
function parseCommandLine(command: string): string[] {
  const args: string[] = [];
  let arg = '';
  let inQuotes = false;
  let started = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === undefined) break;
    if (ch === '\\') {
      let backslashes = 0;
      while (command[i] === '\\') {
        backslashes += 1;
        i += 1;
      }
      if (command[i] === '"') {
        arg += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          arg += '"'; // escaped literal quote
        } else {
          inQuotes = !inQuotes;
        }
        i += 1;
      } else {
        arg += '\\'.repeat(backslashes);
      }
      started = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
      i += 1;
      continue;
    }
    if ((ch === ' ' || ch === '\t') && !inQuotes) {
      if (started) {
        args.push(arg);
        arg = '';
        started = false;
      }
      i += 1;
      continue;
    }
    arg += ch;
    started = true;
    i += 1;
  }
  if (started) args.push(arg);
  return args;
}

/**
 * Resolves what to launch to uninstall an install-mode game: FS search in the install dir first
 * (deterministic, no parsing/encoding issues — we build the silent args), then a registry fallback for a
 * rare nonstandard NSIS uninstaller name. Returns null → the caller does a plain directory removal.
 */
async function resolveUninstaller(install: ResolvedInstallerRun): Promise<LaunchTarget | null> {
  // Linux (Р7f): uninstall removes the WHOLE per-game Wine prefix (see GameProcessLauncher.uninstallDir),
  // so running the game's own in-prefix uninstaller first is pointless (its registry/shortcut cleanup
  // lives in the prefix we're about to delete). Skip it — win32 still runs it (no prefix; it must clean
  // the shared system before the install dir is removed).
  if (process.platform !== 'win32') return null;

  // Step 1: FS search in the install dir, with self-built silent flags.
  const found = await findUninstallerInDir(install.dir, install.type);
  if (found !== null) {
    return {
      file: found,
      args: silentUninstallArgs(install.type),
      cwd: install.dir,
      runAsAdmin: install.runAsAdmin,
    };
  }
  if (install.type === 'custom') return null; // no FS match and no silent convention → plain remove

  // Step 2: registry fallback (rare — nonstandard NSIS uninstaller name). win32-only (reached only on
  // win32; the non-win32 early return above skips the whole uninstaller path).
  const entry = await findUninstallEntry(install.dir);
  if (entry === null) return null;
  const command = entry.quietUninstallString ?? entry.uninstallString;
  if (command === undefined) return null;
  const tokens = parseCommandLine(command);
  const file = tokens[0];
  if (file === undefined) return null;
  const rest = tokens.slice(1);
  // QuietUninstallString is already silent; a plain UninstallString needs the family's silent flag.
  const args =
    entry.quietUninstallString !== undefined ? rest : [...rest, ...silentUninstallArgs(install.type)];
  return {
    file,
    args,
    cwd: install.dir,
    runAsAdmin: entry.fromHKLM || install.runAsAdmin,
  };
}

/**
 * Removes a directory with a few backed-off retries: the forked Inno uninstaller may still hold
 * files for a moment after waitForExit. Checks `signal.aborted` between attempts (fse.remove itself is
 * not interruptible). Throws the last error if every attempt fails.
 */
async function removeWithRetry(dir: string, signal?: AbortSignal): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REMOVE_RETRY_ATTEMPTS; attempt += 1) {
    if (signal?.aborted === true) return;
    try {
      await fse.remove(dir);
      return;
    } catch (cause) {
      lastError = cause;
      if (attempt < REMOVE_RETRY_ATTEMPTS) await delay(REMOVE_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

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
  // True while a game is launching/running: main is "locked" on that game — a game switch is refused and
  // the carousel cannot enter another game's detail as actionable (its guard is `kind==='ready'`).
  private locked = false;
  private cardPresent = false;
  // The id of the game with a Steam download/removal in flight, or null. Steam operations are the one
  // kind of activity that leaves the state `ready`, so this is what stops a SECOND game from being
  // launched or installed underneath them (see onLaunchRequested).
  private steamBusyId: string | null = null;
  // Mirror of AppSettings.alwaysShowEmptyScreen (seeded at startup, toggled live from the settings
  // window): when true the launcher stays on the empty "no card" screen instead of hiding to the tray.
  private alwaysShowEmptyScreen = false;
  private launchInFlight = false;
  // A manifest reload from the Customize screen is in flight. Unlike launchInFlight it does NOT
  // gate on state kind (the reload runs from `ready`), so onLaunchRequested/onUninstallRequested check
  // it explicitly: during the reload's awaits (readManifest + hero/audio on a slow SD — hundreds of ms)
  // the state stays `ready`, and a gamepad Play would otherwise start a game mid-reload (enterReady over
  // launching). Only the reload path is raced like this — an ordinary insert never is.
  private reloadInFlight = false;
  private abort: AbortController | null = null;
  // A card swapped in WHILE a launch/install was in flight: DriveWatcher can swap without an
  // empty tick, so we stash the new root, abort the in-flight sequence, and replay onInsert from its
  // finally (after launchInFlight clears) — otherwise the aborted sequence could set state over the new card.
  private pendingRoot: string | null = null;
  // Image names (lower-case *.exe basenames) of the currently-running game, captured on entry to
  // `running` so a Play press in that state can find and raise the game's window (return-to-game). Null
  // whenever no game is running; reset in the launch sequence's finally. Matched by image name rather than
  // pid so it covers all backends uniformly, incl. elevated games a non-elevated tasklist can't see.
  private runningImageNames: readonly string[] | null = null;
  // The owned GameProcess of the currently-running game, kept so a force-close can terminate it directly:
  // the elevated HANDLE (invisible to taskkill) or the normal pid tree. A REFERENCE to the same object
  // disposed in the launch sequence's finally (the single owner) — set alongside runningImageNames on
  // entry to `running` (normal/elevated + watched branches; null for steam, which owns no process),
  // cleared in that same finally. Never disposed from here.
  private runningProc: GameProcess | null = null;
  // A force-close (onKillRequested) is underway. Local try/finally flag (mirrors reloadInFlight, NOT the
  // launch sequence's finally — a kill has its own short-lived lifecycle) so a double Yes / repeat is a no-op.
  private killInFlight = false;
  // The installing/launching state to restore once winetricks provisioning ends (Р7g). Null when not
  // provisioning. The "Configuring Proton" screen + its rotating funny suffix are the renderer's job (Р7j).
  private protonConfigPriorState: AppState | null = null;
  // The inserted card's background music, sent on its own channel (not on every AppState) — it is the
  // card's only audio contribution. Null when there is no card, or when "only global ambience" mutes it.
  private currentCardMusic: string | null = null;
  // The bundled UI sound set chosen in Settings — the only source of UI sounds there is, on every screen.
  // Read once at init (warmSfxSet); null until then.
  private sfxSet: SfxSet | null = null;
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
  // Steam-mode background re-detect poller (timer + tick + optimistic uninstall request), extracted from
  // this controller. Reaches back only through the narrow accessor seam below.
  private readonly steamWatch = new SteamInstallWatch({
    getManifest: () => this.current(),
    isLaunchInFlight: () => this.launchInFlight,
    getState: () => this.deps.state.get(),
    isSourceAvailable: () => this.currentSourceAvailable(),
    enterReady: (info) => this.enterReady(info),
    onInstallCompleted: () => this.playSfx('play'),
    steamLocator: () => this.deps.platform.steamLocator,
  });

  constructor(private readonly deps: ControllerDeps) {}

  /** The current translator (a message is fixed at the language of the moment it is generated). */
  private get t(): Translator {
    return this.deps.getTranslator();
  }

  /** The platform process monitor (win32 tasklist / linux /proc), threaded into the launcher + waits. */
  private get monitor(): ProcessMonitor {
    return this.deps.platform.processMonitor;
  }

  /** The platform game launcher (win32 spawn/ShellExecuteEx / linux umu-run/Proton). */
  private get launcher(): Platform['gameLauncher'] {
    return this.deps.platform.gameLauncher;
  }

  /**
   * Linux prefix provisioning (winetricks) started/finished — the launcher's onProvisioning callback
   * (Р7g). On start: stash the current installing/launching state and show the rotating "Configuring
   * Proton" screen. On finish: stop the rotation and restore the stashed state (the launch/install
   * sequence then continues from where it was). No-op on win32 (the launcher never fires this).
   */
  private setProvisioning(active: boolean, game: GameInfo): void {
    if (active) {
      this.protonConfigPriorState = this.deps.state.get();
      this.deps.state.set({ kind: 'configuringProton', game });
    } else if (this.protonConfigPriorState !== null) {
      this.deps.state.set(this.protonConfigPriorState);
      this.protonConfigPriorState = null;
    }
  }

  /** True if any of the given image names is currently running (fresh snapshot; empty list → false). */
  private async anyTargetAlive(targets: readonly string[]): Promise<boolean> {
    if (targets.length === 0) return false;
    const snapshot = await this.monitor.snapshot();
    return targets.some((name) => snapshot.hasImageName(name));
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

  /**
   * Ids that must survive a history eviction: everything on the card AND everything in the PC library —
   * including a local game currently shadowed by the card (its record is the same one). Passing only one
   * source's ids would let a full history evict the other source's games (see LibraryStore.gc).
   */
  private protectedIds(): readonly string[] {
    return [...this.cardGames, ...this.pcGames].map((manifest) => manifest.raw.id);
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
  private firstCarouselGame(library: GameLibrary | null = this.currentLibrary): ResolvedManifest | null {
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
    this.locked = false;
    this.forgetCardStats();
    // Music is card-only, so there is none on the empty screen. UI sounds are unaffected: they come from
    // the bundled set on its own channel, which no card ever touched.
    this.setCardMusic(null);
    this.setHero(null);
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
   * no tray to hide into — keeps the empty "insert a card" screen up instead (Р8). Used at every "no card"
   * exit point. On Windows/desktop this is a plain hide (unchanged behaviour).
   */
  private hideToTrayOrKeepEmpty(): void {
    if (this.deps.isGamescope) this.deps.window.showAndFocus();
    else this.deps.window.hide();
  }

  /** Subscriptions to drive-watcher, state replication to the window, IPC handlers. */
  init(): void {
    const { state, window, watcher } = this.deps;

    state.subscribe((next) => {
      const browserWindow = window.browserWindow;
      if (browserWindow !== null && !browserWindow.isDestroyed()) {
        browserWindow.webContents.send(IPC.stateUpdate, next);
      }
    });

    watcher.onInsert((root) => void this.onInsert(root));
    watcher.onRemove(() => this.onRemove());
    watcher.onError((error) => log.error('[drive-watcher]', error));

    ipcMain.handle(IPC.stateRequest, (): AppState => state.get());
    // Static for the process lifetime — seeds the renderer's Game Mode UI (e.g. "Close Playhook").
    ipcMain.handle(IPC.gameModeRequest, (): boolean => this.deps.isGamescope);
    ipcMain.handle(IPC.cardMusicRequest, (): string | null => this.currentCardMusic);
    ipcMain.handle(IPC.ambientRequest, (): string | null => this.currentAmbient);
    ipcMain.handle(IPC.heroRequest, (): HeroAssets | null => this.currentHero);
    ipcMain.handle(IPC.libraryRequest, (): GameLibrary | null => this.currentLibrary);
    ipcMain.handle(IPC.browseRequest, (): BrowseInfo | null => this.currentBrowse);
    ipcMain.handle(IPC.sfxSetRequest, (): SfxSet | null => this.sfxSet);
    // The clipboard as text, for the on-screen keyboard's Paste. Trimmed of nothing here — what the
    // field will accept is the keyboard's own rule (osk-text.ts sanitize), and it differs per field.
    ipcMain.handle(IPC.clipboardRead, (): string => clipboard.readText());
    // The carousel asks for one card's artwork at a time, only for what is on screen, and caches it by id
    // — that is what keeps the list channel light enough to re-push on every change (Р5).
    ipcMain.handle(IPC.libraryGridRequest, (_event, id: unknown): Promise<string | null> => {
      if (typeof id !== 'string') return Promise.resolve(null);
      return this.deps.library.readGridThumb(id);
    });
    ipcMain.on(
      IPC.libraryBrowse,
      (_event, id: unknown, immediate: unknown) => void this.onBrowseRequested(id, immediate),
    );
    ipcMain.on(IPC.libraryForget, (_event, id: unknown) => void this.onForgetRequested(id));
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
    ipcMain.on(IPC.actionKill, () => void this.onKillRequested());
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
    this.sfxSet = await this.assets.readSfxSet();
    this.pushSfxSet();
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
    this.currentAmbient = await this.assets.readAmbientDataUrl(track);
    this.pushAmbient(this.currentAmbient);
  }

  /** Sends a transient error to the renderer to surface in the error popup. */
  private sendError(message: string): void {
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.errorShow, message);
    }
  }

  /** Stops the process waits and the watcher (on application exit). */
  shutdown(): void {
    if (this.browseAssetsTimer !== null) clearTimeout(this.browseAssetsTimer);
    this.abort?.abort();
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
    // Poll for ANY steam game whose source is available: it catches install completion (Install→Play),
    // uninstall completion (Play→Install) — incl. an uninstall the user triggers in Steam directly — and
    // download progress. A LOCAL steam game's source is always available, so this poll is no longer bounded
    // by how long a card stays in: the launcher sitting on such a game polls it for as long as it is shown.
    // The .acf read is cheap enough for that to be an acceptable price (see the plan, §9.3).
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
    if (this.launchInFlight) {
      log.info(`[insert] card swapped during launch/install — deferring root="${root}"`);
      this.pendingRoot = root;
      this.abort?.abort();
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
    this.cardPresent = true;
    log.info(`[insert] card detected at root="${root}"`);
    // Documents is resolved via the system Known Folder API (the same one the game uses),
    // so %DOCUMENTS% in the manifest maps to the real save folder regardless of UI
    // language or OneDrive redirection. Safe to read here — app is ready by now.
    const env: ManifestEnv = { documents: app.getPath('documents'), t: this.t };
    const result = await readManifests(root, env, this.deps.platform.resolveInstallDir);
    if (!result.ok) {
      // No valid game determined → keep the window hidden (the reason is in the log). We still set
      // the error state so a manually-summoned window can show it, but we never auto-surface it.
      log.warn(`[insert] manifest rejected: ${result.message}`);
      this.clearCard();
      this.deps.state.set({ kind: 'error', message: result.message });
      // Desktop/Windows: keep the window hidden (background app — the error is in the log and only shows
      // if the user summons the window). Game Mode: there is no tray to hide into, so surface the manifest
      // error on screen instead of hiding (Р8, point 1).
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
    this.locked = false;
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
        await this.flushPendingIfAny(manifest);
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
      this.setCardMusic(await this.assets.readMusicDataUrl(selected));
      this.setHero(await this.assets.readHeroAssets(selected));
      this.enterReady(await this.buildGameInfo(selected, stats));
      // The card's own game is what you look at on insert (the single-game case is then exactly today's
      // screen: browse.id === AppState.game.id).
      await this.browseTo(selected.raw.id);
    }
    // …and only now the row, so it lands with the cursor already on the card it is about to put first.
    this.setLibrary(library);
    if (opts.focus) this.deps.window.showAndFocus();

    // Copy this card's art/audio into the history IN THE BACKGROUND: a card is slow media and the window
    // is already on screen. One sequential task for the whole card (index.json is a single file — see
    // LibraryStore.saveFromCard), then a list refresh so the freshly-copied games get their artwork.
    void this.deps.library
      .saveFromCard(manifests, this.protectedIds())
      .then(() => this.refreshLibrary())
      .catch((cause: unknown) => log.warn('[library] copying the card assets failed:', describe(cause)));
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
    for (const manifest of read.manifests) {
      this.statsById.set(manifest.raw.id, await this.deps.stats.read(manifest.raw.id));
    }
    this.refreshLibrary();
    // With no card in, the local games are what the launcher has to show: leave `idle` for the first of
    // them instead of the empty screen. A card (or any activity) present → don't touch the state machine.
    if (!this.cardPresent && this.deps.state.get().kind === 'idle' && !this.launchInFlight) {
      // The row's first card, not the library file's first entry — see firstCarouselGame. refreshLibrary
      // above has already built the row this reads, so the two can't disagree.
      const selected = this.firstCarouselGame();
      if (selected !== null) {
        this.selectedId = selected.raw.id;
        this.setHero(await this.assets.readHeroAssets(selected));
        this.setCardMusic(await this.assets.readMusicDataUrl(selected));
        this.enterReady(await this.buildGameInfo(selected, this.statsById.get(selected.raw.id) ?? (await this.deps.stats.read(selected.raw.id))));
        await this.browseTo(selected.raw.id);
      }
    } else if (!this.cardPresent) {
      await this.reseedBrowse();
    }

    // Same background copy a card gets: the artwork already lives in the library root, but the history is
    // what the carousel draws from, and it is also what keeps a local game's card on screen after the
    // game itself is deleted from disk. A local game SHADOWED by the card is skipped — both would write
    // the same history record, and re-inserting the card would then flip its artwork back and forth.
    const visibleLocal = this.games.filter((manifest) => manifest.source === 'pc');
    void this.deps.library
      .saveFromCard(visibleLocal, this.protectedIds())
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
    if ((kind !== 'ready' && kind !== 'error' && kind !== 'idle') || this.launchInFlight) {
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
        await this.browseTo(selected.raw.id);
      }
      return { ok: true };
    } finally {
      this.reloadInFlight = false;
    }
  }

  /**
   * Enters `ready` on a local game with its assets, without touching the window's visibility: this runs
   * when a card was pulled, and a launcher the user had hidden must stay hidden (the same intent
   * onRemove's hide/show branch respects).
   */
  private async enterReadyForLocal(manifest: ResolvedManifest): Promise<void> {
    this.selectedId = manifest.raw.id;
    const stats = this.statsById.get(manifest.raw.id) ?? (await this.deps.stats.read(manifest.raw.id));
    this.setHero(await this.assets.readHeroAssets(manifest));
    this.setCardMusic(await this.assets.readMusicDataUrl(manifest));
    this.enterReady(await this.buildGameInfo(manifest, stats));
    await this.browseTo(manifest.raw.id);
  }

  /**
   * Where one game's manifest lives, by id — the bridge the Customize screen crosses from "the game I am
   * looking at" to "the file that describes it". Only games that can be acted on right now are answered
   * for (`games`), which is the same rule the screen's menu item is gated on.
   *
   * The INDEX is deliberately not part of the answer: `games` is a filtered, reordered union of the card
   * and the library (a shadowed local game is hidden, the carousel order is applied elsewhere), so a
   * position here says nothing about the slot's position inside game.json. The screen finds its slot by
   * `id` instead — see the plan, Р2.
   */
  findGameSource(id: string): { readonly root: string; readonly source: ManifestSource } | null {
    const manifest = this.games.find((game) => game.raw.id === id);
    if (manifest === undefined) return null;
    return { root: manifest.root, source: manifest.source };
  }

  /** Logs the local games the inserted card currently shadows (same id — the card wins, see `games`). */
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
    if ((kind !== 'ready' && kind !== 'error' && kind !== 'idle') || this.launchInFlight) {
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

  private async flushPendingIfAny(manifest: ResolvedManifest): Promise<void> {
    // Enforced by the predicate rather than by "we only call this from loadCard": a local game HAS a
    // saveOnCardPath (its own backup), so a future symmetrical call from the PC-library path would
    // otherwise empty the queue into that backup and lose the progress meant for the card.
    const cardPath = manifest.saveOnCardPath;
    if (!acceptsPendingFlush(manifest) || cardPath === undefined) return;
    const pending = await this.deps.store.getPending(manifest.raw.id);
    if (pending === null) return;
    // Direct, NOT change-based (deliberate — see the plan, part B): the snapshot exists precisely because
    // the card was yanked mid-game and we are OBLIGED to top up the promised PC progress onto the card.
    // LWW here would silently drop that flush if the card looked "unchanged"/newer, so keep it a plain
    // snapshot→card replace.
    await syncDir(pending.savesSnapshotDir, cardPath);
    const stats = await this.deps.stats.read(manifest.raw.id);
    await this.deps.stats.copyToCard(manifest.root, manifest.raw.id, stats);
    await this.deps.store.clearPending(manifest.raw.id);
    // The card now holds the flushed progress, so both sides are back in sync. Rebase the baseline from
    // the real folders (each in its own mtime scale) so the next launch sees them as synced, not as a
    // spurious card-side change that would trigger a needless card→PC.
    await this.rebaseSyncStateAfterFlush(manifest);
  }

  /**
   * Resolves the manifest's DEFERRED pcSavePath (Р5/Э6) to this game's save location via the platform
   * SavePathResolver, or null when there's nothing to sync (no pcSavePath declared, or a steam game with
   * no compatdata yet). win32 keeps the exact env-based expansion the manifest used to do eagerly; linux
   * maps inside the game's prefix. `containerExists` tells whether that prefix is actually there — see
   * runSaveSync for why that matters.
   */
  private async resolvePcSavePath(manifest: ResolvedManifest): Promise<PcSaveLocation | null> {
    if (manifest.pcSavePath === undefined) return null;
    return this.deps.platform.savePathResolver.resolvePcSavePath(manifest, manifest.pcSavePath);
  }

  /** Records a fresh sync baseline from both real save folders (used after a direct pending-flush). */
  private async rebaseSyncStateAfterFlush(manifest: ResolvedManifest): Promise<void> {
    const cardPath = manifest.saveOnCardPath;
    if (cardPath === undefined || manifest.pcSavePath === undefined) return;
    const pcSave = await this.resolvePcSavePath(manifest);
    // No prefix → no PC half worth recording: a baseline whose `pc` describes a non-existent container is
    // exactly what makes the next sync-in mistake "prefix wiped" for "saves deleted" (see runSaveSync).
    if (pcSave === null || !pcSave.containerExists) return;
    await this.deps.store.writeSyncState(manifest.raw.id, {
      card: await snapshotTree(cardPath),
      pc: await snapshotTree(pcSave.path),
      syncedAt: Date.now(),
    });
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
    // Normally the background app hides to the tray when no card is present. With "always show the no-card
    // screen" on, keep the launcher up on the empty screen instead — BUT only if it's currently on screen.
    // If the user minimized it to the tray, pulling the card must not pop it back up (respect that intent).
    if (this.deps.isGamescope) {
      // Game Mode: no tray — always keep the empty "insert a card" screen up (forces alwaysShowEmptyScreen).
      this.deps.window.showAndFocus();
    } else if (this.alwaysShowEmptyScreen) {
      if (this.deps.window.isShown()) this.deps.window.showAndFocus();
    } else {
      this.deps.window.hide();
    }
  }

  /**
   * Applies the "always show the no-card screen" setting (seeded at startup, toggled live from the
   * settings window). Besides caching the flag it reconciles the launcher NOW when we're idle with no
   * card: show the empty screen when turning it on, or hide back to the tray when turning it off. When a
   * card is present (ready/busy) nothing changes — the launcher is already visible for the game.
   */
  setAlwaysShowEmptyScreen(on: boolean): void {
    this.alwaysShowEmptyScreen = on;
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
    if (snapshot.kind !== 'ready' || this.launchInFlight || this.reloadInFlight) return;
    const manifest = this.current();
    if (manifest === null) return;
    // A local game whose .exe is gone (deleted, or an external drive unplugged). The renderer already
    // disables Play, but a gamepad press must not slip past it into a launch that can only fail.
    if (snapshot.game.unavailable === true) {
      log.info(`[launch] refused id=${manifest.raw.id}: "${manifest.executablePath}" is not on disk`);
      this.sendError(this.t('launcher.state.gameFilesMissing'));
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
        void this.runSteamInstall(manifest, snapshot.game);
      } else {
        void this.runLaunchSequence(manifest, snapshot.game);
      }
      return;
    }
    // Card-install mode + not yet installed → run the installer; otherwise it's an ordinary launch
    // (this includes a fully-installed game, whose executable now exists → requiresInstall=false).
    if (manifest.install !== undefined && snapshot.game.requiresInstall) {
      void this.runInstallSequence(manifest, snapshot.game);
    } else {
      void this.runLaunchSequence(manifest, snapshot.game);
    }
  }

  /**
   * Return-to-game: raise the running game's own window to the foreground (restoring it if it minimized
   * when it lost focus). Best-effort — if the window isn't found (the game is already closing, a race with
   * waitForExit) it's a silent no-op; the state machine will move to syncing-out → ready on its own.
   */
  private resumeRunningGame(): void {
    const names = this.runningImageNames;
    if (names === null) return;
    if (!focusGameWindow(names)) {
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
    if (snapshot.kind !== 'ready' || this.locked || this.launchInFlight || this.reloadInFlight) return;
    const manifest = this.games.find((m) => m.raw.id === idRaw);
    if (manifest === undefined) {
      log.warn(`[select] no game with id="${idRaw}" on the current card or in the PC library — ignoring`);
      return;
    }
    this.selectedId = manifest.raw.id;
    // Build the switched-to game's assets on demand (mirrors loadCard). Stats come from the loadCard cache
    // (buildGameInfo still re-reads a steam game's .acf); fall back to a fresh read if somehow absent.
    const stats = this.statsById.get(manifest.raw.id) ?? (await this.deps.stats.read(manifest.raw.id));
    this.setHero(await this.assets.readHeroAssets(manifest));
    this.setCardMusic(await this.assets.readMusicDataUrl(manifest));
    this.enterReady(await this.buildGameInfo(manifest, stats));
    // Keep what's on screen in step with the selection (the renderer reads the title/stats from here).
    await this.browseTo(manifest.raw.id);
  }

  /**
   * Force-close the running game (More → Force close → confirmed Yes). Flips the running snapshot into its
   * `killing` sub-state (the launcher shows "Force closing…" and hides the Force close button), kills the
   * main executable AND every watchProcess, then lets the EXISTING exit waiters (waitForExit /
   * waitForWatchedExit) notice the processes vanish and carry the flow through syncing-out → sync → ready
   * (K-Д3) — no state machine of its own. Guarded by the running state + a killInFlight flag (double Yes /
   * repeat is a no-op).
   *
   * A non-elevated launcher can't terminate a runAsAdmin game's high-integrity processes (taskkill →
   * ACCESS_DENIED, the ShellExecuteEx HANDLE lacks PROCESS_TERMINATE). So for a runAsAdmin game, if the
   * targets survive a short grace, we escalate to ONE elevated `taskkill /F /T /IM …` (a single UAC
   * prompt). Non-elevated games never trigger UAC.
   *
   * Success is judged by FACT, not command exit codes: a "not found" from taskkill just means the target
   * is already dead (success). After the kills we verify over a WINDOW bounded by killTimeoutSec (a killed
   * process lingers in tasklist for a beat, so a single instant snapshot would false-positive): success as
   * soon as the targets are gone (the `killing` indicator stays until an exit waiter advances the flow).
   * If something is still alive when the window elapses, we DROP back to plain running (the game is still
   * up) and surface a soft errors.killFailed.
   */
  private async onKillRequested(): Promise<void> {
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'running') return; // only meaningful while a game is running
    if (this.killInFlight) return; // a force-close is already underway (double Yes / repeat)
    const manifest = this.current();
    if (manifest === null) return; // defensive: `running` always has a current manifest
    this.killInFlight = true;
    // Show "Force closing…" and hide the Force close button immediately (cleared back on failure).
    this.deps.state.set({ ...snapshot, killing: true });
    try {
      // Steam mode is tracked/killed by SteamAppId (native + Proton games), with no owned pid and no
      // elevation (the schema forbids runAsAdmin there). Every other mode kills the owned process + the
      // target image names, escalating to an elevated taskkill for a runAsAdmin game. Both end in the same
      // fact-based verdict below (stillAlive).
      let stillAlive: boolean;
      if (manifest.steam !== undefined) {
        const appid = manifest.steam.appid;
        const names = manifest.raw.watchProcesses ?? [];
        log.info(`[kill] force-close requested id=${manifest.raw.id} steam appid=${appid}`);
        await this.monitor.killSteamGame(appid, names);
        stillAlive = await this.steamGameStillAlive(appid, names, manifest.raw.killTimeoutSec);
      } else {
        // Targets are computed HERE from this.current, leaving runningImageNames untouched: a union there
        // would regress return-to-game (focusGameWindow picks the first Z-order match — the launcher name
        // could steal focus from the game).
        const targets = normalizeImageNames([
          manifest.executablePath,
          ...(manifest.raw.watchProcesses ?? []),
        ]);
        log.info(`[kill] force-close requested id=${manifest.raw.id} targets=[${targets.join(',')}]`);

        // 1. Terminate the owned process (elevated HANDLE, or the normal pid tree with an isAlive re-check
        //    inside kill()). In the watched path this is usually the already-dead launcher — its "not
        //    found" is normal, not an error.
        const proc = this.runningProc;
        if (proc !== null) {
          try {
            await proc.kill();
          } catch (cause) {
            log.warn('[kill] owned-process kill failed (continuing to kill by name):', describe(cause));
          }
        }

        // 2. Kill each target image by name (non-elevated): win32 `taskkill /F /IM`, linux SIGTERM/SIGKILL
        //    to every /proc match. Failures are normal ("not found" = already dead).
        await this.monitor.killByName(targets);

        // 2b. Elevated escalation (runAsAdmin games only). A non-elevated taskkill / the ShellExecuteEx
        //     HANDLE can't terminate high-integrity processes, so if the targets survive a short grace we
        //     run ONE elevated `taskkill /F /T /IM …` (a single UAC prompt). Non-elevated games never reach
        //     here (no UAC for them). A declined UAC just leaves the targets up → killFailed below.
        if (manifest.raw.runAsAdmin && (await this.killTargetsStillAlive(targets, proc, KILL_ELEVATE_GRACE_SEC))) {
          log.info(`[kill] elevated game survived non-elevated kill id=${manifest.raw.id} — escalating to elevated taskkill (UAC)`);
          killImagesElevated(targets);
        }

        // 3. Fact-based verdict over a window bounded by killTimeoutSec (a killed process lingers for a
        //    beat — a single instant snapshot would false-positive).
        stillAlive = await this.killTargetsStillAlive(targets, proc, manifest.raw.killTimeoutSec);
      }

      // killFailed only if something is STILL alive when the window elapsed.
      if (stillAlive) {
        log.warn(`[kill] targets still alive after force-close id=${manifest.raw.id} — reporting killFailed`);
        // The game is still up → back to plain running (status "Running…", Force close button returns),
        // then surface the error. Re-read in case a waiter advanced the state (then leave it be).
        const current = this.deps.state.get();
        if (current.kind === 'running') this.deps.state.set({ ...current, killing: false });
        this.sendError(this.t('errors.killFailed'));
      } else {
        log.info(`[kill] force-close done id=${manifest.raw.id} — exit waiters will finish the flow`);
      }
    } finally {
      this.killInFlight = false;
    }
  }

  /**
   * Polls the kill targets for up to `timeoutSec`, returning false (success — everything is gone) as soon
   * as no target image is present AND the owned process (elevated HANDLE / normal pid) is dead, OR once an
   * exit waiter has already advanced the state out of `running` (it saw the exit → definitely killed).
   * Returns true only if something is still alive when the window elapses — a genuine failure.
   */
  private async killTargetsStillAlive(
    targets: readonly string[],
    proc: GameProcess | null,
    timeoutSec: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      // An exit waiter that already left `running` proves the process is gone — treat as killed.
      if (this.deps.state.get().kind !== 'running') return false;
      const ownedAlive = proc !== null && (await proc.isAlive());
      if (!ownedAlive && !(await this.anyTargetAlive(targets))) return false;
      if (Date.now() >= deadline) return true; // window elapsed and something is still alive → real fail
      await delay(KILL_VERIFY_INTERVAL_MS);
    }
  }

  /**
   * Steam-mode analogue of killTargetsStillAlive: polls the monitor's SteamAppId signal (linux) / watch
   * names (win32) until the game is gone or the window elapses. Returns true only if it is STILL running.
   */
  private async steamGameStillAlive(
    appid: number,
    watchNames: readonly string[],
    timeoutSec: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      if (this.deps.state.get().kind !== 'running') return false; // an exit waiter already left `running`
      if (!(await this.monitor.isSteamGameRunning(appid, watchNames))) return false;
      if (Date.now() >= deadline) return true;
      await delay(KILL_VERIFY_INTERVAL_MS);
    }
  }

  /** "Uninstall" action (the user confirmed in the popup). Only for an installed install-mode game. */
  private onUninstallRequested(): void {
    const snapshot = this.deps.state.get();
    if (snapshot.kind !== 'ready' || this.launchInFlight || this.reloadInFlight) return;
    const manifest = this.current();
    if (manifest === null) return;
    if (!snapshot.game.canUninstall) return; // nothing installed to remove
    // Steam: delegate removal to Steam (steam://uninstall) — fire-and-forget, the poller flips to Install.
    if (manifest.steam !== undefined) {
      void this.runSteamUninstall(manifest, snapshot.game);
      return;
    }
    if (manifest.install === undefined) {
      // Normal executable game: the only "uninstall" is clearing its Wine prefix (Linux; the game stays on
      // the card). canUninstall is set only when that prefix exists — see buildGameInfo / prefixCleanupOnly.
      if (snapshot.game.prefixCleanupOnly === true) {
        void this.runPrefixCleanupSequence(manifest, snapshot.game);
      }
      return;
    }
    void this.runUninstallSequence(manifest, snapshot.game);
  }

  /**
   * Clears a normal executable game's Wine prefix (Linux). No installer/uninstaller is involved — the game
   * lives on the card, its only PC footprint is the prefix — so this is just the directory sweep + the same
   * card-swap / rebuild-info handling as runUninstallSequence, minus the uninstaller run.
   */
  private async runPrefixCleanupSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const dir = await this.deps.platform.gameLauncher.prefixCleanupDir(manifest.raw.id);
    if (dir === null) return; // defensive: canUninstall was set only when the prefix existed
    const { state, window, stats } = this.deps;
    this.launchInFlight = true;
    const abort = new AbortController();
    this.abort = abort;
    try {
      state.set({ kind: 'uninstalling', game: info });
      await removeWithRetry(dir, abort.signal);
      if (abort.signal.aborted) return;
      // Card yanked mid-cleanup (this targets the PC, so it completed): idle + hide, like runUninstall.
      // A local game's source cannot go away, so it always continues to the rebuild below.
      if (!this.sourceAvailable(manifest)) {
        this.cardGoneAfterSequence();
        return;
      }
      // Prefix gone → prefixCleanupDir now returns null → canUninstall recomputes false → "Uninstall"
      // disappears, leaving just "Play".
      const currentStats = await stats.read(manifest.raw.id);
      const updatedInfo = await this.buildGameInfo(manifest, currentStats);
      log.info(`[prefix-cleanup] removed "${dir}" id=${manifest.raw.id}`);
      this.enterReady(updatedInfo);
      window.showAndFocus();
    } catch (cause) {
      if (cause instanceof LaunchAbortedError) return; // aborted by shutdown or a card swap
      this.failSequence('uninstall', info, describe(cause));
    } finally {
      this.launchInFlight = false;
      this.abort = null;
      this.resumePendingInsert();
    }
  }

  /**
   * Steam install action: fire-and-forget. Opens `steam://install/<appid>` (Steam shows its own dialog
   * and the download — possibly hours/GBs) and returns WITHOUT entering a blocking `installing` state.
   * We stay on the `ready` ("Install") screen; the background re-detect poller (started by enterReady)
   * flips the button to "Play" once Steam's .acf reports the game fully installed. Steam itself collapses
   * repeated `steam://install` calls, so no debounce is needed. Pre-checks getSteamPath: openExternal
   * doesn't reliably reject when steam:// is unregistered.
   */
  private async runSteamInstall(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const appid = manifest.steam?.appid;
    if (appid === undefined) return; // defensive: onLaunchRequested only calls this in steam mode
    if ((await this.deps.platform.steamLocator.locateSteam()) === null) {
      this.sendError(this.t('errors.steamNotInstalled'));
      return;
    }
    try {
      await openSteamUri(`steam://install/${appid}`);
      log.info(`[steam-install] opened steam://install/${appid} id=${manifest.raw.id}`);
    } catch (cause) {
      this.sendError(this.t('errors.steamOpenInstall', { cause: describe(cause) }));
      return;
    }
    // Ensure the re-detect poller is running so the button flips to "Play" when the download completes
    // (no-op if already running; info confirms this is a steam game still requiring install).
    if (info.installVia === 'steam' && info.requiresInstall && this.sourceAvailableFor(info.id)) {
      this.steamWatch.start();
    }
  }

  /**
   * Steam uninstall action: fire-and-forget, mirroring runSteamInstall. Opens `steam://uninstall/<appid>`
   * (Steam shows its own confirmation/removal UI) and returns WITHOUT a blocking `uninstalling` state. We
   * stay on the `ready` ("Play"/"Uninstall") screen; the background poller flips the button back to
   * "Install" once Steam removes the .acf. Pre-checks getSteamPath.
   */
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

  private async runSteamUninstall(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const appid = manifest.steam?.appid;
    if (appid === undefined) return; // defensive: onUninstallRequested only calls this in steam mode
    if ((await this.deps.platform.steamLocator.locateSteam()) === null) {
      this.sendError(this.t('errors.steamNotInstalled'));
      return;
    }
    try {
      await openSteamUri(`steam://uninstall/${appid}`);
      log.info(`[steam-uninstall] opened steam://uninstall/${appid} id=${manifest.raw.id}`);
    } catch (cause) {
      this.sendError(this.t('errors.steamOpenUninstall', { cause: describe(cause) }));
      return;
    }
    // Optimistically show "Uninstalling…": record the request and flip the UI. The poller clears it when
    // the .acf is gone (→ Install) or on timeout (assumed cancel → back to Play/Uninstall). enterReady
    // (re)arms the poller for the inserted steam card.
    this.steamWatch.requestUninstall(appid);
    this.enterReady({ ...info, steamUninstalling: true, canUninstall: false });
  }

  private async runLaunchSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const { state, window, stats } = this.deps;
    this.launchInFlight = true;
    // Lock the launcher on this game for the launching→running span: a game switch is refused and the
    // switching the card's game is refused. Cleared in the finally alongside the other running-scoped fields.
    this.locked = true;
    const abort = new AbortController();
    this.abort = abort;
    // Declared before the try so `finally` can dispose the kept HANDLE (elevated path).
    let proc: GameProcess | null = null;
    try {
      // 1. Change-based sync before the game (phase = sync-in). No longer a blind card→PC: if the PC
      // saves changed since the last sync (e.g. played on another PC last, or this PC is newer) they are
      // NOT overwritten — the changed side wins (see save-sync change-detection). The old card→PC is only
      // the first-run fallback (no baseline yet).
      state.set({ kind: 'syncing-in', game: info });
      if (manifest.pcSavePath !== undefined && manifest.saveOnCardPath !== undefined) {
        // Resolve the deferred pcSavePath to this game's save location (Р5/Э6). null → nothing to sync
        // with at all (a steam game with no compatdata) — a logged no-op.
        const pcSave = await this.resolvePcSavePath(manifest);
        if (pcSave === null) {
          log.info(
            `[sync-in] pcSavePath "${manifest.pcSavePath}" not resolvable yet — skipping sync`,
          );
        } else {
          // A MISSING prefix is not a reason to skip: the launch below creates it, and the card's saves
          // must be in place before the game reads them (e.g. after an uninstall wiped the prefix). The
          // copy targets the prefix path directly — launchGame ensureDir's that prefix anyway — and
          // runSaveSync drops the stale baseline so the empty PC side can't erase the card.
          try {
            log.info(
              `[sync-in] change-based sync between card "${manifest.saveOnCardPath}" and PC "${pcSave.path}"${pcSave.containerExists ? '' : ' (prefix absent — restoring from card)'}`,
            );
            // Soft catch: sync-in can now WRITE to the card (change-detection may pick PC→card) — a new
            // failure point BEFORE launch (a full / write-protected / slow card). The launch never depended
            // on a card write before, so keep it that way: log and start the game regardless (mirrors sync-out).
            await this.runSaveSync(
              manifest,
              manifest.saveOnCardPath,
              pcSave.path,
              'card-to-pc',
              pcSave.containerExists,
            );
          } catch (cause) {
            log.warn('[sync-in] change-based sync failed, launching anyway:', describe(cause));
          }
        }
      }

      // 2/3/4. launch, then wait for the game to appear and to exit. THREE backends:
      //  - steam: open steam://rungameid (no proc of ours); wait by watched names only (launcherPid=null).
      //  - watched (launcher/wrapper, manifest.watchProcesses): the game is a SEPARATE process; we wait
      //    for one of the watched image names to appear (HANDOFF — the launcher may live on in its menu),
      //    then track that process's presence for exit.
      //  - normal: the spawned pid IS the game; wait for that pid to appear, then disappear.
      // Running-phase note (all paths): gamepad input is ignored (outside ready). The window stays put —
      // the game takes the foreground on its own and simply covers the launcher, which avoids the jerky
      // hide/show flash. We grab the foreground back in step 6 once the game exits. The global Start+Back
      // hotkey is intentionally a no-op while running, so there's nothing to re-summon.
      const watchProcesses = manifest.raw.watchProcesses;
      let since: number;
      if (manifest.steam !== undefined) {
        state.set({ kind: 'launching', game: info });
        // Pre-check: openExternal doesn't reliably reject when steam:// is unregistered, so gate the
        // launch on Steam actually being installed instead of relying on a reject.
        if ((await this.deps.platform.steamLocator.locateSteam()) === null) {
          this.failSequence('launch', info, this.t('errors.steamNotInstalled'));
          return;
        }
        try {
          await openSteamUri(`steam://rungameid/${manifest.steam.appid}`);
        } catch (cause) {
          this.failSequence('launch', info, this.t('errors.launchViaSteam', { cause: describe(cause) }));
          return;
        }
        // Track by SteamAppId (via the monitor): on linux that reads /proc environ, so native-Linux AND
        // Proton games are detected regardless of their binary name; on win32 it maps to the watch names.
        const { started } = await waitForSteamStart(
          manifest.steam.appid,
          watchProcesses ?? [],
          manifest.raw.launchTimeoutSec,
          this.monitor,
          abort.signal,
        );
        if (!started) {
          // Known MVP limitation: a Steam cold-start or an auto-update before launch may not fit
          // launchTimeoutSec → the game-process never appears in the window. We can't tell that apart
          // from "didn't start", so we return quietly (recommend a larger launchTimeoutSec).
          log.info(
            `[launch] steam game never appeared within ${manifest.raw.launchTimeoutSec}s id=${manifest.raw.id} (cold-start/update?)`,
          );
          this.abandonWatchedLaunch(info);
          return;
        }
        since = Date.now();
        this.runningImageNames = normalizeImageNames(watchProcesses ?? []);
        // Steam owns no process of ours (steam://rungameid returns instantly) — a force-close relies on
        // taskkill /IM over the watchProcesses alone.
        this.runningProc = null;
        state.set({ kind: 'running', game: info, since });
        log.info(`[launch] running (steam) id=${manifest.raw.id} appid=${manifest.steam.appid}`);
        await waitForSteamExit(manifest.steam.appid, watchProcesses ?? [], this.monitor, abort.signal);
        log.info(`[launch] exited (steam) id=${manifest.raw.id}`);
      } else {
        // 2. launch → GameProcess (spawn, or elevated ShellExecuteEx per manifest.runAsAdmin)
        state.set({ kind: 'launching', game: info });
        try {
          proc = await this.launcher.launchGame(manifest, (active) => this.setProvisioning(active, info));
        } catch (cause) {
          this.failSequence('launch', info, this.t('errors.launchGame', { cause: describe(cause) }));
          return;
        }
        if (watchProcesses !== undefined && watchProcesses.length > 0) {
          const { started } = await waitForWatchedStart(
            proc.pid,
            watchProcesses,
            manifest.raw.launchTimeoutSec,
            this.monitor,
            abort.signal,
          );
          if (!started) {
            // The user closed the launcher without playing, or the game never became visible (often an
            // elevated/anticheat launcher — see README). Neither a failure nor a play session.
            this.abandonWatchedLaunch(info);
            return;
          }
          // The watched game is up: start the clock now (more accurate than the launcher's spawn time).
          since = Date.now();
          this.runningImageNames = normalizeImageNames(watchProcesses);
          // The spawned launcher (proc) — usually already dead here; kept so a force-close can also take
          // down its pid tree. The game itself is killed by taskkill /IM over the watchProcesses.
          this.runningProc = proc;
          state.set({ kind: 'running', game: info, since });
          log.info(`[launch] running (watched) id=${manifest.raw.id} watch=${watchProcesses.join(',')}`);
          await waitForWatchedExit(watchProcesses, this.monitor, abort.signal);
          log.info(`[launch] exited (watched) id=${manifest.raw.id}`);
        } else {
          const started = await waitForStart(proc, manifest.raw.launchTimeoutSec, abort.signal);
          if (!started) {
            this.failSequence('launch', info, this.t('errors.gameDidNotStart'));
            return;
          }
          since = Date.now();
          // normal AND elevated share this branch (differing only by manifest.raw.runAsAdmin): the game
          // IS the spawned exe, so its image name is the executable's basename.
          this.runningImageNames = normalizeImageNames([manifest.executablePath]);
          // The game process itself — a force-close terminates it directly (elevated: via the HANDLE
          // invisible to taskkill; normal: its pid tree with an isAlive re-check inside kill()).
          this.runningProc = proc;
          state.set({ kind: 'running', game: info, since });
          log.info(`[launch] running id=${manifest.raw.id} pid=${proc.pid}`);
          await waitForExit(proc, abort.signal);
          log.info(`[launch] exited id=${manifest.raw.id} pid=${proc.pid}`);
        }
      }

      // 5. game closed → write stats to the PC (source of truth)
      const playSeconds = (Date.now() - since) / 1000;
      const updatedStats = await stats.recordPlay(manifest.raw.id, playSeconds);
      const updatedInfo = await this.buildGameInfo(manifest, updatedStats);
      // The history's cached stats follow the authority, and the game may have just EARNED its place in
      // the carousel (an inserted-but-never-played game is not listed until now). The GC runs here too:
      // recordPlay is the one moment the ordering that decides eviction actually changes.
      await this.deps.library.noteLaunch(manifest.raw.id, updatedStats);
      await this.deps.library.gc(this.protectedIds());
      // Before the refresh, not after: the card's own games are ordered by these very dates, and this
      // game has just become the most recently played one.
      this.statsById.set(manifest.raw.id, updatedStats);
      this.refreshLibrary();

      // 6. PC→SD + stats copy (or pending-flush, if the card is already gone). The game just exited,
      // so reclaim the foreground (forceForeground) to surface the launcher over Steam/desktop.
      state.set({ kind: 'syncing-out', game: updatedInfo });
      window.showAndFocus(true);
      await this.performSyncOut(manifest, updatedStats);

      // 7. done
      this.enterReady(updatedInfo);
      // Refresh what's on screen too: the play time / launch count the detail screen shows just changed.
      await this.browseTo(manifest.raw.id);
      window.showAndFocus();
    } catch (cause) {
      if (cause instanceof LaunchAbortedError) return; // application is shutting down
      this.failSequence('launch', info, describe(cause));
    } finally {
      // Release the elevated HANDLE (no-op for the normal spawn path).
      proc?.dispose();
      this.launchInFlight = false;
      // The game is done → unlock (switching the card's game is allowed again).
      this.locked = false;
      this.abort = null;
      // The game is no longer running → forget its image names (return-to-game only applies while running).
      this.runningImageNames = null;
      // Drop the owned-process reference (proc.dispose() above is the single owner-side release; this is
      // just the reference the force-close used while running).
      this.runningProc = null;
      // Replay a card that was swapped in mid-flight, now that launchInFlight has cleared.
      this.resumePendingInsert();
    }
  }

  /**
   * Runs the installer for an install-mode game that isn't installed yet (mirrors runLaunchSequence's
   * infrastructure: launchInFlight/abort, the LaunchAbortedError guard, the pendingRoot replay).
   * Pre-cleans the install dir, runs the installer silently, then grace-polls for the executable —
   * on success the button becomes "Play"; otherwise we stay on "Install" and surface the reason.
   */
  private async runInstallSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const install = manifest.install;
    if (install === undefined) return; // defensive: onLaunchRequested only calls this in install mode
    const { state, window, stats } = this.deps;
    this.launchInFlight = true; // set/cleared explicitly, like runLaunchSequence
    const abort = new AbortController();
    this.abort = abort;
    let proc: GameProcess | null = null;
    try {
      state.set({ kind: 'installing', game: info });

      // Pre-clean: a partial install left by a previous failed attempt could carry a stale <exe> →
      // a bogus "Play". We're (re)installing anyway, so a clean directory is safe.
      await fse.remove(install.dir);

      if (install.type === 'copy') {
        // "Move game to PC": no installer to run — copy the card's game directory into the install dir.
        if (!(await this.runCopyInstall(install, manifest, info, abort))) return;
      } else {
        // Silent by default; a user who enabled "disable silent installer mode" gets the visible wizard
        // (needed for repacks that skip a crack/patch step under silent — `skipifsilent`).
        const silent = !(await this.deps.settings.read()).disableSilentInstall;
        try {
          proc = await this.launcher.launchInstaller(install, silent, (active) =>
            this.setProvisioning(active, info),
          );
        } catch (cause) {
          this.failSequence('install', info, this.t('errors.startInstaller', { cause: describe(cause) }));
          return;
        }

        // Wait for the installer to exit, then grace-poll for the executable: some installers (often
        // custom wrappers) fork a child and exit early, so <exe> may appear shortly AFTER waitForExit.
        await waitForExit(proc, abort.signal);
        const installed = await this.pollForExecutable(
          manifest.executablePath,
          manifest.raw.launchTimeoutSec,
          abort.signal,
        );
        if (!installed) {
          this.failSequence('install', info, this.t('errors.installIncomplete'));
          return;
        }
      }

      // Installed: rebuild GameInfo so requiresInstall recomputes to false (the executable now exists),
      // flipping the button back to "Play". The next press launches normally from the install dir.
      const currentStats = await stats.read(manifest.raw.id);
      const installedInfo = await this.buildGameInfo(manifest, currentStats);
      log.info(`[install] completed id=${manifest.raw.id} dir="${install.dir}"`);
      this.enterReady(installedInfo);
      // Audible "install finished" cue — covers both an installer run and the `copy` type (both reach
      // here only on a real completion, never on a plain card insert of an already-installed game).
      this.playSfx('play');
      window.showAndFocus();
    } catch (cause) {
      if (cause instanceof LaunchAbortedError) return; // aborted by shutdown or a card swap
      this.failSequence('install', info, describe(cause));
    } finally {
      proc?.dispose();
      this.launchInFlight = false;
      this.abort = null;
      this.resumePendingInsert();
    }
  }

  /**
   * The `copy` install type ("move game to PC"): instead of running an installer, copy the game
   * directory from the card into the app-controlled install dir. Called by runInstallSequence, which
   * owns the state/abort infrastructure and the shared tail — this only covers copy's own steps.
   *
   * Returns true when the game is in place and the caller should finish the sequence; false when it must
   * stop (a failure was already surfaced, or the sequence was aborted and must unwind silently).
   */
  private async runCopyInstall(
    install: ResolvedCopyInstall,
    manifest: ResolvedManifest,
    info: GameInfo,
    abort: AbortController,
  ): Promise<boolean> {
    // Prepare the destination's environment BEFORE the files land in it (linux: create + provision the
    // Wine prefix; win32: no-op). This is what launchInstaller does implicitly on the installer path —
    // without it a copied game would sit in a bare prefix with none of the baseline runtimes that the
    // installer it originally came from would have pulled in. A failure here propagates to the caller's
    // catch (it is an environment fault, like a failed installer launch).
    await this.launcher.prepareInstallDir(install, (active) => this.setProvisioning(active, info));

    try {
      // `dereference: false` — copy symlinks as symlinks (a game's own internal links stay internal).
      await fse.copy(install.installerPath, install.dir, { dereference: false });
    } catch (cause) {
      // fse.copy takes no AbortSignal, so a card swap mid-copy surfaces as a plain ENOENT (the source
      // vanished) rather than a LaunchAbortedError. Check the flag before reporting: the new card is
      // already on screen, and an error popup about the old one over it would be nonsense.
      if (abort.signal.aborted) return false;
      this.failSequence('install', info, this.t('errors.copyGameFailed', { cause: describe(cause) }));
      return false;
    }

    // Same reason as in runUninstallSequence: the copy itself isn't interruptible, so check the abort
    // flag manually before touching any state.
    if (abort.signal.aborted) return false;

    // A single existence check, not pollForExecutable: the grace-poll exists for installers that fork a
    // child and exit early, whereas fse.copy is done when it resolves. Polling would only add
    // launchTimeoutSec of waiting on an already-known-bad path.
    if (!(await fse.pathExists(manifest.executablePath))) {
      // The usual cause is a wrong source root: `executable` is card-relative in the form, but here it
      // resolves inside the copied directory. Second most likely on linux: a Windows-authored card whose
      // exe case doesn't match the files copied onto a case-sensitive FS — say so instead of "not found".
      const shown = manifest.raw.executable ?? path.basename(manifest.executablePath);
      const found = await findCaseInsensitiveName(manifest.executablePath);
      this.failSequence(
        'install',
        info,
        found !== null
          ? this.t('errors.copyExeNotFoundCase', { path: shown, found })
          : this.t('errors.copyExeNotFound', { path: shown }),
      );
      return false;
    }

    log.info(
      `[install] copied id=${manifest.raw.id} from="${install.installerPath}" to="${install.dir}"`,
    );
    return true;
  }

  /**
   * Polls for the game executable to appear within `timeoutSec` (grace window after the installer
   * exits). Throws LaunchAbortedError if aborted, so a mid-install card swap unwinds WITHOUT
   * setting state over the new card — never returns false on abort.
   */
  private async pollForExecutable(
    executablePath: string,
    timeoutSec: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      if (signal.aborted) throw new LaunchAbortedError();
      if (await fse.pathExists(executablePath)) return true;
      if (Date.now() >= deadline) return false;
      await delay(INSTALL_POLL_INTERVAL_MS);
    }
  }

  /**
   * Uninstalls an installed install-mode game (mirrors runInstallSequence's infrastructure:
   * launchInFlight/abort, the LaunchAbortedError guard, the pendingRoot replay). Runs the game's own
   * uninstaller (best-effort — it cleans the registry/shortcuts), then ALWAYS sweeps the app-controlled
   * install dir, so on success the executable is gone → requiresInstall recomputes true → "Install".
   */
  private async runUninstallSequence(manifest: ResolvedManifest, info: GameInfo): Promise<void> {
    const install = manifest.install;
    if (install === undefined) return; // defensive: onUninstallRequested only calls this in install mode
    const { state, window, stats } = this.deps;
    this.launchInFlight = true; // set/cleared explicitly, like runInstallSequence
    const abort = new AbortController();
    this.abort = abort;
    let proc: GameProcess | null = null;
    try {
      state.set({ kind: 'uninstalling', game: info });

      // Run the game's own uninstaller if we can resolve one (FS search → registry fallback). Any
      // launch/wait failure is NON-fatal: we log it and fall through to the directory sweep. Only a
      // LaunchAbortedError (from waitForExit on a card swap) propagates to unwind cleanly.
      //
      // `copy` is skipped entirely: nothing was installed, so there is no uninstaller of OURS to run.
      // A copied game directory is one that was installed on some OTHER machine, so any `unins*.exe`
      // inside it belongs to that install — running it would clean a foreign registry and might pop a
      // wizard. Straight to the sweep instead (which is the whole uninstall for copy).
      if (install.type !== 'copy') {
        const target = await resolveUninstaller(install);
        if (target !== null) {
          try {
            proc = await this.launcher.launchUninstaller(target);
            await waitForExit(proc, abort.signal);
          } catch (cause) {
            if (cause instanceof LaunchAbortedError) throw cause;
            log.warn(`[uninstall] uninstaller failed, continuing to cleanup: ${describe(cause)}`);
          }
        }
      }

      // Sweep the platform's uninstall target — after the uninstaller, and as the fallback when no target
      // was resolved (custom / nothing found). win32: the install dir. linux: the whole per-game Wine
      // prefix (game files + provisioned runtimes), so the full disk footprint is reclaimed (Р7f).
      const uninstallDir = this.launcher.uninstallDir(install);
      await removeWithRetry(uninstallDir, abort.signal);

      // fse.remove is NOT interrupted by the signal (unlike waitForExit), so check the abort flag
      // manually — strictly BEFORE reading cardPresent / rebuilding info — so a mid-uninstall card swap
      // doesn't set state over the new card (the finally → resumePendingInsert handles it).
      if (abort.signal.aborted) return;

      // The card may have been yanked during the uninstall (it targets the PC, so it completed): no card
      // → idle + hide, mirroring abandonWatchedLaunch / onRemove's cleanup.
      if (!this.sourceAvailable(manifest)) {
        this.cardGoneAfterSequence();
        return;
      }

      // Done: rebuild GameInfo so requiresInstall recomputes true and canUninstall false (the executable
      // is gone) → the button flips back to "Install" and "Uninstall" disappears.
      const currentStats = await stats.read(manifest.raw.id);
      const updatedInfo = await this.buildGameInfo(manifest, currentStats);
      log.info(`[uninstall] completed id=${manifest.raw.id} removed="${uninstallDir}"`);
      this.enterReady(updatedInfo);
      window.showAndFocus();
    } catch (cause) {
      if (cause instanceof LaunchAbortedError) return; // aborted by shutdown or a card swap
      this.failSequence('uninstall', info, describe(cause));
    } finally {
      proc?.dispose();
      this.launchInFlight = false;
      this.abort = null;
      this.resumePendingInsert();
    }
  }

  /** Replays a card insertion deferred during an in-flight launch/install. No-op if none pending. */
  private resumePendingInsert(): void {
    const root = this.pendingRoot;
    if (root === null) return;
    this.pendingRoot = null;
    void this.onInsert(root);
  }

  /**
   * A launch/install/uninstall attempt failed: return to the 'ready' screen with the SAME info and
   * surface the reason in the error popup. The info is unchanged, so the flags recompute to the pre-attempt
   * button (launch → "Play", failed install → still "Install", failed uninstall → still "Uninstall"); the
   * user can read the error, close it (B / veil) and retry. Only the log prefix differs per phase.
   */
  private failSequence(phase: 'launch' | 'install' | 'uninstall', game: GameInfo, message: string): void {
    log.warn(`[${phase}] failed: ${message}`);
    this.enterReady(game);
    this.deps.window.showAndFocus();
    this.sendError(message);
  }

  /**
   * The watched-launcher path ended without the game ever becoming visible: the user closed the launcher
   * without playing, or the game runs elevated / as a service and `tasklist` can't see it. This is
   * neither a failure nor a play session — we do NOT call stats.recordPlay (it would bump launchCount and
   * lastPlayedAt for a 0s session) and we do NOT surface an error popup. Back to the normal screen; if the
   * card is already gone, go idle and hide, mirroring onRemove's cleanup.
   */
  private abandonWatchedLaunch(game: GameInfo): void {
    log.info('[launch] watched game never appeared — returning without recording a session');
    if (!this.currentSourceAvailable()) {
      this.steamWatch.stop();
      this.cardGoneAfterSequence();
      return;
    }
    this.enterReady(game);
    this.deps.window.showAndFocus();
  }

  /**
   * Runs a bidirectional, change-based save sync (syncByChange) and persists the new baseline. The
   * `fallback` direction is used only on the FIRST run (no baseline yet): 'card-to-pc' for sync-in,
   * 'pc-to-card' for sync-out — i.e. the phase's old deterministic direction. Otherwise the direction is
   * chosen by which side changed since the last sync. A conflict (both changed) and a fallback are logged.
   * Throws propagate to the caller (sync-in swallows them softly; sync-out defers to pending-flush).
   */
  /**
   * Runs one change-detected sync between the card and this game's PC save folder.
   *
   * `containerExists=false` (linux: the game's Wine prefix is gone — never created, or wiped by an
   * uninstall) DISCARDS the baseline. That is a data-integrity rule, not an optimisation: change-detection
   * reads an empty PC side against a baseline that lists files as "every save was deleted here" and would
   * replicate that deletion onto the card — destroying the only surviving copy. The container being absent
   * means the PC side has no authority at all, so the baseline describes a world that no longer exists;
   * dropping it falls back to the phase direction (card→PC on sync-in), which restores the card's saves.
   */
  private async runSaveSync(
    manifest: ResolvedManifest,
    cardPath: string,
    pcPath: string,
    fallback: 'card-to-pc' | 'pc-to-card',
    containerExists: boolean,
  ): Promise<void> {
    const id = manifest.raw.id;
    // A local game syncs against its own backup, not against a card, so it keeps its baseline in its own
    // slot: one shared baseline for both pairings would make each sync see the other's changes as a
    // conflict (see PcStore.syncStatePath).
    const slot: SyncSlot = manifest.source === 'pc' ? 'pc' : 'card';
    const baseline = containerExists ? await this.deps.store.readSyncState(id, slot) : null;
    if (!containerExists) {
      log.info(`[save-sync] id=${id} PC container absent → baseline discarded, card is authoritative`);
    }
    const result = await syncByChange(cardPath, pcPath, baseline, fallback);
    if (result.conflict) {
      // The only branch that can lose data: both sides changed, LWW picked one. The losing side survives
      // only as syncDir's `<dest>.bak`. Logged loudly so it's visible in the diagnostics.
      log.warn(
        `[save-sync] CONFLICT id=${id}: both sides changed since last sync → ${result.direction} by LWW (losing side kept as <dest>.bak)`,
      );
    }
    log.info(
      `[save-sync] id=${id} direction=${result.direction}${result.usedFallback ? ' (fallback: no baseline)' : ''}`,
    );
    await this.deps.store.writeSyncState(id, result.state, slot);
  }

  private async performSyncOut(manifest: ResolvedManifest, stats: Stats): Promise<void> {
    const id = manifest.raw.id;
    // Resolve the deferred pcSavePath once for this game (Р5/Э6). The game just ran, so its prefix exists
    // and (on win32) the env expansion always succeeds — this matches the pre-port physical path exactly.
    // A prefix that is somehow absent here means the game wrote nothing we could carry back: there is no
    // source to copy from, so treat it as "no PC side" rather than syncing an emptiness onto the card.
    const resolved = await this.resolvePcSavePath(manifest);
    const pcPath = resolved !== null && resolved.containerExists ? resolved.path : null;
    if (resolved !== null && !resolved.containerExists) {
      log.warn(`[sync-out] the Wine prefix for id=${id} is gone — nothing to copy back to the card`);
    }
    // The card is already removed (the expected scenario) → defer PC→SD into pending-flush. A local game
    // is never "removed", so it always takes the sync path below (its backup is always reachable).
    if (!this.sourceAvailable(manifest)) {
      if (pcPath !== null) {
        await this.deps.store.enqueuePcToSd(id, pcPath);
      }
      return;
    }
    if (pcPath !== null && manifest.saveOnCardPath !== undefined) {
      // Diagnostic (silent-failure guard): syncDir no-ops when the source is missing. If the PC save
      // folder doesn't exist after a play session, pcSavePath is almost certainly wrong in game.json
      // (e.g. %APPDATA% used for an AppData\LocalLow path) — warn instead of failing silently.
      if (!(await fse.pathExists(pcPath))) {
        log.warn(
          `[sync-out] pcSavePath does not exist — nothing copied to the card. Check the manifest path: "${manifest.pcSavePath}" (resolved: "${pcPath}")`,
        );
      } else {
        try {
          // Change-based sync after the game (phase = sync-out). The old blind PC→card is only the
          // first-run fallback; normally the changed side wins (this PC just played → usually PC→card).
          log.info(
            `[sync-out] change-based sync between PC "${pcPath}" and card "${manifest.saveOnCardPath}"`,
          );
          // containerExists is true here by construction (pcPath is null otherwise), so the baseline is
          // honoured exactly as before — sync-out semantics are unchanged.
          await this.runSaveSync(manifest, manifest.saveOnCardPath, pcPath, 'pc-to-card', true);
          if (manifest.source === 'pc') await this.queueLocalProgressForCard(manifest, pcPath);
        } catch (cause) {
          // The card may have been yanked during the sync → saves.bak is intact, we'll finish on insertion.
          log.warn('[sync-out] failed, deferring to pending-flush:', describe(cause));
          await this.deps.store.enqueuePcToSd(id, pcPath);
          return;
        }
      }
    }
    // A local game's stats mirror lives on the PC and is the only copy there is — there is no card to
    // write a travelling stats.json to, and writing one into userData would mean nothing.
    if (manifest.source === 'card') {
      await this.deps.stats.copyToCard(manifest.root, manifest.raw.id, stats);
    }
  }

  /**
   * "The saves move to the card": after a local game's session, ALSO queue a PC→SD flush, so inserting a
   * card that carries the same game tops it up with the progress made without it (the existing
   * flushPendingIfAny on insert does the actual copy).
   *
   * Only when a CARD baseline exists for this id — i.e. that card has been seen on this machine before.
   * Without that condition every local session would leave a third full copy of the saves behind, growing
   * on disk forever, for a card that may never exist.
   */
  private async queueLocalProgressForCard(manifest: ResolvedManifest, pcPath: string): Promise<void> {
    const id = manifest.raw.id;
    if (!(await this.deps.store.hasCardSyncState(id))) return;
    await this.deps.store.enqueuePcToSd(id, pcPath);
    log.info(`[sync-out] id=${id} local session queued for the card it was last synced with`);
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
    return {
      id: manifest.raw.id,
      title: manifest.raw.title,
      lastPlayedAt: stats.lastPlayedAt,
      totalPlaySeconds: stats.totalPlaySeconds,
      launchCount: stats.launchCount,
      requiresInstall,
      canUninstall,
      // Installer-view dir (Р7): on linux this is the `C:\playhook\games\<id>` the user would paste into a
      // non-silent Wine picker; on win32 it equals the host dir.
      ...(manifest.install !== undefined ? { installDir: manifest.install.installerDir } : {}),
      ...(installVia !== undefined ? { installVia } : {}),
      ...(prefixCleanupOnly ? { prefixCleanupOnly: true } : {}),
      ...(steamInstalling ? { steamInstalling: true } : {}),
      ...(steamPaused ? { steamPaused: true } : {}),
      ...(steamPausedProgress !== undefined ? { steamPausedProgress } : {}),
      ...(unavailable ? { unavailable: true } : {}),
    };
  }

  // ── Hero images (delivered once per card, rotated in the renderer) ───────

  /** Stores the current hero images and pushes them to the window (null when no card / on error). */
  private setHero(assets: HeroAssets | null): void {
    this.currentHero = assets;
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.heroUpdate, assets);
    }
  }

  // ── Audio (the card's music + the bundled UI sound set) ──────────────────

  /** Stores the current card's music and pushes it to the window (null when no card / on error). */
  private setCardMusic(url: string | null): void {
    this.currentCardMusic = url;
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.cardMusicUpdate, url);
    }
  }

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
    this.sfxSet = await this.assets.readSfxSet();
    const manifest = this.current();
    this.setCardMusic(manifest === null ? null : await this.assets.readMusicDataUrl(manifest));
    // The carousel plays the BUNDLED set, and what you hear on screen comes from the browse channel —
    // both have to follow the setting too, or a change only lands after you flip to another card (the
    // browse music outranks the card's own, so a stale value would keep playing over it).
    this.pushSfxSet();
    await this.refreshBrowseMusic();
  }

  /**
   * Re-sends the browsed game's music after an audio-settings change ("only global ambience", the sound
   * set). Music only — re-running the whole browse would re-encode the hero images for nothing.
   */
  private async refreshBrowseMusic(): Promise<void> {
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
    const manifest = this.games.find((m) => m.raw.id === id) ?? null;
    if (manifest !== null) return this.assets.readMusicDataUrl(manifest);
    if ((await this.deps.settings.read()).onlyGlobalAmbient) return null;
    return (await this.deps.library.readBrowseAssets(id)).music;
  }

  /** Applies a default-ambience change live: re-reads the track as a data URL and pushes it to the game
   *  window (the renderer crossfades; a card's own music still wins). */
  async setAmbientTrack(track: string | null): Promise<void> {
    this.currentAmbient = await this.assets.readAmbientDataUrl(track);
    this.pushAmbient(this.currentAmbient);
  }

  /** Pushes the default-ambience data URL (or null) to the game window. */
  private pushAmbient(url: string | null): void {
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.ambientUpdate, url);
    }
  }

  /** Asks the game renderer to play a one-shot UI sound (main owns no <audio> — the renderer does). */
  private playSfx(name: SfxName): void {
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.sfxPlay, name);
    }
  }

  // ── Carousel list (the card's games + the play history) ────────────────────

  /** Stores the current carousel list and pushes it to the window (null when there is nothing to show). */
  private setLibrary(library: GameLibrary | null): void {
    this.currentLibrary = library;
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.libraryUpdate, library);
    }
  }

  /**
   * Rebuilds and pushes the carousel list: the inserted card's games first (they are the ones that can be
   * launched right now), then the played history — each group most recently played first. No stats are
   * read from disk here: the index caches launchCount/lastPlayedAt for exactly this (Р1), and the card's
   * own games use the reconciled stats already in memory (statsById), falling back to the index for a
   * game whose reconcile hasn't happened yet.
   *
   * A card game is listed even when the library has no record for it yet — the asset copy runs in the
   * background after the window is already up, and the carousel must not wait for it.
   */
  private refreshLibrary(): void {
    this.setLibrary(this.buildLibrary());
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
          ...(stored !== null ? { artRev: stored.savedAt } : {}),
        };
      }),
      ...this.deps.library
        .entriesForCarousel(activeIds)
        .filter((entry) => !active.has(entry.id))
        .map((entry) => ({
          id: entry.id,
          title: entry.title,
          active: false,
          artRev: entry.savedAt,
        })),
    ];
    return games.length > 0 ? { games } : null;
  }

  /** One source's games, most recently played first — the per-group ordering refreshLibrary applies. */
  private orderedForCarousel(
    manifests: readonly ResolvedManifest[],
  ): readonly { readonly id: string; readonly title: string }[] {
    return byRecentlyPlayed(
      manifests.map((manifest) => ({
        id: manifest.raw.id,
        title: manifest.raw.title,
        lastPlayedAt:
          this.statsById.get(manifest.raw.id)?.lastPlayedAt ??
          this.deps.library.entry(manifest.raw.id)?.lastPlayedAt ??
          null,
      })),
    );
  }

  // ── Browse (what is on screen) ─────────────────────────────────────────────

  /** Stores the browsed game and pushes it to the window (null = nothing to show at all). */
  private pushBrowse(browse: BrowseInfo | null): void {
    this.currentBrowse = browse;
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.browseUpdate, browse);
    }
  }

  /** Pushes the browsed game's backgrounds. A SEPARATE channel from hero:update on purpose: that one
   * keeps carrying the inserted card's selected game, so browsing can never overwrite (and strand) it. */
  private pushBrowseHero(assets: HeroAssets | null): void {
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.browseHero, assets);
    }
  }

  /** Pushes the browsed game's music (music only — the SFX set is never rebuilt by browsing). */
  private pushBrowseMusic(url: string | null): void {
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.browseMusic, url);
    }
  }

  /** Pushes the bundled UI sound set (every UI sound the app plays). */
  private pushSfxSet(): void {
    const browserWindow = this.deps.window.browserWindow;
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send(IPC.sfxSetUpdate, this.sfxSet);
    }
  }

  /**
   * `library:browse` — the carousel moved onto `id`. Answers with the browse info + that game's assets.
   * Deliberately does NOT touch `selectedIndex` or the AppState: looking at a game is not choosing it, so
   * this works while another game installs (and with no card at all).
   */
  private async onBrowseRequested(idRaw: unknown, immediateRaw: unknown): Promise<void> {
    if (typeof idRaw !== 'string') return;
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
    if (this.currentBrowse?.id === idRaw) await this.reseedBrowse();
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
      this.pushBrowse({ id, title: manifest.raw.title, active: true, stats, game: info });
      this.scheduleBrowseAssets(id, immediate);
      return;
    }
    const entry = this.deps.library.entry(id);
    if (entry === null) {
      log.warn(`[browse] no game with id="${id}" on the card or in the history — ignoring`);
      return;
    }
    const stats = await this.deps.stats.read(id);
    this.pushBrowse({ id, title: entry.title, active: false, stats });
    this.scheduleBrowseAssets(id, immediate);
  }

  /** Debounced read+push of the browsed game's hero/music; a newer browse cancels the pending one. */
  private scheduleBrowseAssets(id: string, immediate = false): void {
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

  private async pushBrowseAssets(id: string): Promise<void> {
    const seq = ++this.browseAssetsSeq;
    // Checked before EVERY push, not just on entry. Each read below is megabytes off the disk plus a
    // base64 encode, and the selection keeps moving while it runs — so a read started for a game the user
    // flipped past would otherwise land on the game they stopped on, dragging its background, its colours
    // and its music along. The sequence covers the other half: two reads in flight at once (a debounced
    // one and an immediate one) can finish out of order, and only the newest may speak.
    const current = (): boolean => seq === this.browseAssetsSeq && this.currentBrowse?.id === id;
    if (!current()) return;
    const manifest = this.games.find((m) => m.raw.id === id) ?? null;
    if (manifest !== null) {
      const hero = await this.assets.readHeroAssets(manifest);
      if (!current()) return;
      this.pushBrowseHero(hero);
      const music = await this.assets.readMusicDataUrl(manifest);
      if (!current()) return;
      this.pushBrowseMusic(music);
      return;
    }
    const assets = await this.deps.library.readBrowseAssets(id);
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
    const wallpaper = await this.assets.readWallpaperDataUrl();
    return wallpaper === null ? null : { images: [wallpaper] };
  }

  /**
   * Moves the browse cursor after the list changed (a card removed, an entry evicted): keep the current
   * game if it is still listed, otherwise fall back to the first entry — or to nothing, which is the
   * genuine "no card and no history" empty screen.
   */
  private async reseedBrowse(): Promise<void> {
    const games = this.currentLibrary?.games ?? [];
    const current = this.currentBrowse?.id;
    const next = games.find((game) => game.id === current) ?? games[0];
    if (next === undefined) {
      this.pushBrowse(null);
      this.pushBrowseHero(null);
      this.pushBrowseMusic(null);
      return;
    }
    await this.browseTo(next.id);
  }
}
