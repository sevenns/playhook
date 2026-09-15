// The Customize screen's controller — the launcher's per-game manifest editor, and the fifth surface of
// the UI. It owns the loaded manifest, the form state, the row focus and the stack of surfaces that open
// on top of it, and exposes the SAME six navigation primitives everything else does, so controls.ts only
// has to route to it.
//
// Three things are worth knowing before reading the rest:
//
//  • THE FILE IS THE UNIT, THE GAME IS THE SLOT. gameConfig:read hands over the whole game.json text; the
//    screen finds ITS slot by `id` (never by an index from main: the file can change under it), edits
//    that one, and serializes every slot back. A neighbour the form cannot represent is carried through verbatim as a
//    raw slot, so saving one game never destroys another.
//
//  • SAVING IS EXPLICIT. Unlike Settings, a value change writes nothing: every keystroke would mean a
//    write to removable media plus a manifest reload, and an intermediate invalid state cannot be written
//    at all. Save & Apply is gated on the validator; Reset re-reads from disk; leaving while dirty asks.
//
//  • ONE data-overlay, A STACK OF SURFACES. `#app[data-overlay='game-settings']` is a single attribute
//    value carrying every CSS rule that makes this screen visible, so the keyboard and the file picker
//    are NOT overlays of their own (switching the value would extinguish the screen under them). They are
//    surfaces on a stack inside it, and the six primitives are routed to whichever is on top.
import type {
  BrowseInfo,
  ConfigMoveResult,
  ConfigPickResult,
  ConfigRootReadResult,
  ConfigSaveResult,
  ConfigValidationResult,
  DriveCandidate,
  GameConfigAcceptRequest,
  GameConfigReadResult,
  HistoryConfigReadResult,
  HistoryConfigSaveRequest,
  GameConfigSaveRequest,
  GameMoveRequest,
  GameCandidate,
  GameDetails,
  HostPlatform,
  ManifestSource,
  MetadataApplyRequest,
  MetadataApplyResult,
  MetadataResult,
} from '../shared/types.js';
import type { MessageKey, Translator } from '../shared/i18n/index.js';
import { type AudioController } from './audio.js';
import { pressFlash, req } from './dom.js';
import { createEntrance } from './entrance.js';
import { createHoverGuard } from './hover-guard.js';
import { wrapIndex } from './index-math.js';
import { createScroller } from './screen-scroller.js';
import { createSidebar } from './screen-sidebar.js';
import { createListScreenCore, sectionByKey } from './list-screen-core.js';
import { createMenuStack, type MenuEntry } from './menu-stack.js';
import { createAssetLightbox } from './asset-lightbox.js';
import { createListEditor } from './list-editor.js';
import { createOnlineFlow } from './online-flow.js';
import { createManifestValidator, issueKey } from './manifest-validation.js';
import type { FilePickerSurface, NavSurface, TextEntrySurface } from './nav-surface.js';
import type { ApplyOutcome, OnlinePickerSurface } from './online-picker.js';
import {
  emptyFormModel,
  gamesToText,
  isInstallType,
  isLaunchMode,
  isRawSlot,
  slotsWithInsertedGame,
  slotsWithNewGame,
  textToGames,
  type GameFormState,
  type ManifestFormModel,
} from './configure-form-model.js';
import {
  buildGameSettingsModel,
  carryFormAcrossSources,
  carryFormToCard,
  defaultLaunchMode,
  draftModeFor,
  hasSourceBoundValues,
  pickKindFor,
  withField,
  withInstallType,
  withLaunchMode,
  withList,
  withToggle,
  type GameRowId,
  type GameSettingsModel,
  type GameSettingsRow,
} from './game-settings-model.js';
import {
  artworkSignature,
  buildStatusNote,
  columnEntries,
  isFocusable,
  patchGameRow,
  relocalizeGameRow,
  relocalizeGameSections,
  renderGameSettings,
  screenHeading,
  statusNotes,
  type RenderedGameRow,
} from './game-settings-view.js';
import { optionLabel, rowLabelText, type CoreOption } from './row-view-core.js';

/**
 * How often the screen re-asks whether there is a card to move onto. A poll rather than a push because
 * nothing announces a BLANK card: main's watcher only reports media carrying a game.json, and an empty
 * card is a perfectly good move target. Matched to the TTL main caches its candidate listing under, so a
 * screen left open costs one drive enumeration per tick at most — the same order as the watcher's own.
 */
const MOVE_TARGETS_POLL_MS = 2000;

/** What the screen sends to main. A seam, so app.ts owns the window.api wiring. */
export interface GameSettingsScreenApi {
  read(id: string): Promise<GameConfigReadResult>;
  /** `source` names the dialect when there is no root to imply one (a game from the history). */
  validate(
    root: string,
    text: string,
    source?: ManifestSource,
  ): Promise<ConfigValidationResult>;
  save(request: GameConfigSaveRequest): Promise<ConfigSaveResult>;
  imagePreview(root: string, path: string): Promise<string | null>;

  // ── A game whose card is not in (see history-config.ts) ──
  /** Its stored manifest: the edits waiting for the card, or the snapshot the card was read into. */
  readHistory(id: string): Promise<HistoryConfigReadResult>;
  /** Stores edits for it — they reach the card on its next insertion, not now. */
  saveHistory(request: HistoryConfigSaveRequest): Promise<ConfigSaveResult>;
  /** A thumbnail for one of its asset paths: what is staged on this PC, else the history's own copy. */
  historyAssetPreview(id: string, ref: string): Promise<string | null>;
  /** Where a new game may be added — the cards plus the PC library (add mode only). */
  sources(): Promise<readonly DriveCandidate[]>;
  /** One root's manifest, for adding a game to it — it may carry no game yet (add mode only). */
  readRoot(root: string): Promise<ConfigRootReadResult>;
  /**
   * Drops the game's HISTORY record — its card in the carousel and the artwork copied to this PC. Only
   * ever sent after the game has left the manifest: main refuses to forget a game that is available.
   */
  forgetHistory(id: string): void;
  /** Moves a local (PC-library) game onto a card in one transaction. */
  moveToCard(request: GameMoveRequest): Promise<ConfigMoveResult>;
  /** The same conversion the in-launcher picker uses (main re-checks/converts a picked path) — used
   * outside a Browse to carry an absolute PC-side pcSavePath over as a %PREFIX% string when moving a
   * game onto a card, without making the user re-pick the same folder. */
  acceptPath(request: GameConfigAcceptRequest): Promise<ConfigPickResult>;

  // ── "Find online" (see main/metadata/) ──
  /** Search every online source for a game by title. */
  searchMetadata(query: string): Promise<MetadataResult<readonly GameCandidate[]>>;
  /** The candidate behind a Steam appid the manifest already names — no search needed. */
  requestSteamCandidate(appId: number): Promise<MetadataResult<GameCandidate>>;
  /** The candidate's descriptions, genres, release date and platforms — carried into the manifest
   * through the form's `rest` (see GameDetails). */
  metadataDescriptions(candidateKey: string): Promise<MetadataResult<GameDetails>>;
  /** Downloads the chosen variant into the game's root; answers with the manifest-relative path. */
  applyMetadata(request: MetadataApplyRequest): Promise<MetadataApplyResult>;
  /** Aborts whatever main is still fetching (the user left the flow). */
  cancelMetadata(): void;
}

/**
 * The questions this screen asks through the launcher's shared confirm popup. Deleting is TWO of them:
 * `delete` removes the game from the manifest and leaves its card in the history, `delete-history` takes
 * the card too. Which one arrives back is the user's answer to the second question — see controls.ts.
 */
export type GameSettingsConfirm =
  | 'reset'
  | 'delete'
  | 'delete-history'
  | 'discard'
  | 'switch-source'
  | 'cancel-move'
  // Asked by the "Find online" surface, answered here: taking the store's spelling into Title.
  | 'replace-title';

export interface GameSettingsScreenDeps {
  readonly audio: AudioController;
  getTranslator(): Translator;
  readonly api: GameSettingsScreenApi;
  /** The on-screen keyboard — without it there is no way to type on a gamepad. */
  readonly keyboard: TextEntrySurface;
  /** The in-launcher file browser — the native dialog cannot be driven in Game Mode. */
  readonly picker: FilePickerSurface;
  /** The online artwork gallery — the surface "Find online" picks a cover or a background in. */
  readonly onlinePicker: OnlinePickerSurface;
  /** The screen closed itself (B / Esc / veil) — controls.ts restores the bar focus. */
  onClosed(): void;
  /** Asks the shared confirm popup; the answer arrives back through confirmAccepted. */
  /**
   * Opens the launcher's confirm popup for one of this screen's questions. `options.title` is the name
   * the question QUOTES — the popup builds its other messages from the open game, but "replace the
   * title with X?" is about a candidate the popup has never heard of.
   */
  onConfirmRequested(kind: GameSettingsConfirm, options?: { readonly title?: string }): void;
  /** Whether the game is running / installing / being force-closed — Delete is hidden then. */
  isBusy(): boolean;
  /** A game was added AND applied: the launcher's library has it now, so the carousel goes to it. */
  onAdded(id: string): void;
  /**
   * The launcher's own two channels, used for everything this screen has to SAY. A confirmation is the
   * notification plate (top-right, goes by itself); a failure is the error popup, which waits to be
   * closed — the same split the "Find online" surface makes, and for the same reason: a save that failed
   * must not scroll away with the form.
   */
  notify(text: string): void;
  showError(text: string): void;
}

export interface GameSettingsScreen extends NavSurface {
  /** Opens the screen for one game, reading its manifest. */
  open(id: string): void;
  /**
   * The same screen for a game whose card is NOT in: the stored manifest is read from the history, the
   * fields that name files on the card are inert, and Save queues the edits for the card's next
   * insertion instead of writing anything (see history-config.ts).
   */
  openFromHistory(id: string): void;
  /** Opens the same screen with no game behind it — the form CREATES one (see `mode`). */
  openNew(): void;
  close(): void;
  /** browse:update arrived: the screen closes when its game is gone or no longer playable. */
  applyBrowse(browse: BrowseInfo | null): void;
  /** The confirm popup answered yes for `kind`. */
  confirmAccepted(kind: GameSettingsConfirm): void;
  /** Whether there are unsaved edits (controls.ts wording for the leave confirm). */
  isDirty(): boolean;
  /** Whether the loaded game is a LOCAL one — its save backups outlive a deletion, and the confirm says so. */
  deletesLocalGame(): boolean;

  // What the "Find online" surface cannot do for itself: this screen owns the form, the files that land
  // beside the game, and the on-screen keyboard. The surface asks; these answer.

  /** Opens the keyboard for a new search query. */
  askOnlineQuery(initial: string, onDone: (query: string) => void): void;
  /**
   * Asks the launcher's confirm popup whether the store's spelling may replace the Title field. Routed
   * through this screen because that popup answers to `confirmAccepted`, which is this screen's channel.
   */
  askOnlineTitle(title: string, onYes: () => void): void;
  /** Downloads the chosen pictures into the game and writes their paths into the form. */
  applyOnlineArtwork(
    kind: 'grid' | 'hero',
    variantKeys: readonly string[],
    mode: 'replace' | 'append',
  ): Promise<ApplyOutcome>;
  applyOnlineTrack(trackKey: string): Promise<ApplyOutcome>;
  applyOnlineTitle(title: string): void;
  /** The user named the game — its description, genres and dates are fetched from here. */
  onOnlineCandidate(candidate: GameCandidate): void;
  /** How many backgrounds the form already holds — what makes "add or replace" a question at all. */
  heroCount(): number;
}

export function createGameSettingsScreen(deps: GameSettingsScreenDeps): GameSettingsScreen {
  const app = req('app');
  const screen = req('game-settings');
  const veil = screen.querySelector<HTMLElement>('.settings-veil');
  const listEl = req('game-settings-list');
  const navEl = req('game-settings-nav');
  const statusEl = req('game-settings-status');
  const headingEl = req('game-settings-heading');
  /** The screen's own name — "Customize" or "Add game". See the note on the element in index.html. */
  const titleEl = req('game-settings-title');
  const menuEl = req('game-settings-options');
  const menuListEl = req('game-settings-options-list');
  const sourceEl = req('game-settings-source');

  const t = (): Translator => deps.getTranslator();

  let open = false;
  let gameId = '';
  /**
   * What this visit is doing: editing the game named by `gameId`, or creating one. It decides the
   * heading, the Save wording, which actions the column offers, and — in a dozen small places below —
   * which half of a branch runs. Explicit, because "no gameId" is true of a screen that is still loading.
   */
  let mode: 'edit' | 'add' = 'edit';
  /** Where a new game may go. Loaded once per add visit; empty in edit mode. */
  let sources: readonly DriveCandidate[] = [];
  /** The root a pending "switch the source?" confirm is about — applied when the answer comes back. */
  let pendingSource: string | null = null;
  /**
   * The root an adoptRoot is currently reading, and the guard that keeps a late answer from overwriting a
   * newer one. Stepping the source row with the D-pad can start a second read before the first lands, and
   * the two would otherwise race — the slower one wins and the form ends up describing another root.
   */
  let adoptingRoot: string | null = null;
  let adoptToken = 0;
  /**
   * Where the manifest came from. Two kinds, because the screen now edits games whose file it cannot
   * reach:
   *
   *   `media`   — the ordinary case: a real root (a card, or the PC library) plus the content signature
   *               it was read against, which is the swap guard every save is checked against.
   *   `history` — a game whose card is NOT in. There is no root to browse, no signature to guard and no
   *               file to write; everything is addressed by the game's ID instead, and the edits are
   *               stored on this PC until that card comes back (see history-config.ts).
   *
   * A union rather than an "empty root", so every place that needs a real path has to say which case it
   * is handling instead of quietly reaching for ''.
   */
  type MediaOrigin = {
    readonly kind: 'media';
    readonly root: string;
    readonly source: ManifestSource;
    readonly signature: string;
    /** Read alongside the manifest — main answers it, the renderer never asks the OS itself. */
    readonly platform: HostPlatform;
  };
  type Origin = MediaOrigin | { readonly kind: 'history'; readonly id: string; readonly platform: HostPlatform };
  let origin: Origin | null = null;
  /** The media origin, or null when this visit is a history one — the guard for anything path-shaped. */
  const mediaOrigin = (): MediaOrigin | null =>
    origin !== null && origin.kind === 'media' ? origin : null;
  /** The game's id when the screen is editing from the history, else null. */
  const historyId = (): string | null =>
    origin !== null && origin.kind === 'history' ? origin.id : null;
  // Every game in the file. Ours is `slots[slotIndex]`; the others are only ever carried through.
  let slots: GameFormState[] = [];
  let slotIndex = -1;
  /**
   * A SECOND, PARALLEL set of "which file, which slot" — active only while moving a local game onto a
   * card. The screen still works against one file at a time, but which one flips: `currentText` /
   * `runValidate` / `canSave` all read `pendingMove` first and fall back to `origin`/`slots`/`slotIndex`
   * only when it is null. Nothing is written to disk while this is set — see beginMove/adoptMoveTarget.
   */
  interface PendingMove {
    readonly target: DriveCandidate;
    readonly targetSlots: readonly GameFormState[];
    readonly targetIndex: number;
    readonly targetSignature: string;
    readonly targetBaselineOtherIssues: ReadonlySet<string>;
    /**
     * Destination (card) path → source (PC-library) path, for the hero/grid images `carryFormToCard`
     * carried over unedited. The files those destination paths name are NOT on the card yet — main only
     * copies them once Save actually commits the move — so a thumbnail/lightbox for one of them has to
     * read the PC-library copy, which is the only place the bytes exist right now. A path the user
     * replaced via Browse after choosing the target is deliberately absent here: it already names a real
     * file on the target card (browseInto only ever offers paths that are already there).
     */
    readonly sourceAssetPaths: ReadonlyMap<string, string>;
  }
  let pendingMove: PendingMove | null = null;
  let form: ManifestFormModel = emptyFormModel();
  let rest: Readonly<Record<string, unknown>> = {};
  let corrupt: Readonly<Record<string, unknown>> = {};
  let mixed = false;
  let loadedId = '';
  /** The text as it was read. Dirty is "what we would write differs from this". */
  let baseline = '';
  /**
   * A write of this screen's (Save, Add, Move) is in flight. It gates `canSave`, which every one of the
   * three checks first and which the Save row's own enabled state is drawn from — so the second press is
   * refused both as a gesture and as a button.
   */
  let writing = false;
  /** Set when OUR slot cannot be represented at all — the screen shows the reason and two ways out. */
  let unreadable: string | null = null;

  let issues: ReadonlyMap<string, string> = new Map();
  let otherIssues: readonly string[] = [];
  /**
   * The problems that were ALREADY in the other games' slots when the screen opened. Save is allowed
   * while they are there — the file is not ours to fix from a per-game screen, and a game that failed to
   * resolve is not even in the carousel — but a NEW one means we introduced it.
   */
  let baselineOtherIssues: ReadonlySet<string> = new Set();
  /**
   * The problems OUR OWN slot already had when the screen opened — only ever non-empty for a game edited
   * from the history, whose stored manifest may predate the editor's gates entirely. Save is allowed
   * while they are there; a NEW one is ours (the same rule main applies, see GameConfigService).
   */
  let baselineOwnIssues: ReadonlySet<string> = new Set();
  let ownIssues = false;
  let status: string | null = null;

  let model: GameSettingsModel | null = null;
  /**
   * Whether a card is plugged in for "Move to card…" to reach. Starts false: the row is offered inert
   * until the first listing says otherwise, which is the honest order — an item that looks pressable
   * before anything has been read is the very thing that made the action lie about an empty reader.
   */
  let moveTargets = false;
  let moveTargetsTimer = 0;


  const listScroller = createScroller(listEl);
  const hover = createHoverGuard();
  /** The column menu — a row's dropdown, a path's actions, the list editor (menu-stack.ts). */
  const menu = createMenuStack({
    audio: deps.audio,
    screen,
    menuEl,
    listEl: menuListEl,
    hover,
    closeLabel: () => t()('launcher.menu.close'),
    onLeave: () => onlineFlow.stop(),
  });
  /** The artwork viewer and the thumbnail strips (asset-lightbox.ts); where a path is READ from is answered here. */
  const lightbox = createAssetLightbox({
    audio: deps.audio,
    locate: (path) => {
      // A history game's files are not on any root the renderer can name: what is staged sits in the app's
      // own storage, and the rest exists only as the copy the history keeps (see historyAssetPreview).
      const id = historyId();
      if (id !== null) {
        return { key: `history:${id} ${path}`, read: () => deps.api.historyAssetPreview(id, path) };
      }
      const at = assetPreviewRoot(path);
      if (at === null) return null;
      return {
        key: `${at.root} ${at.relative}`,
        read: () => deps.api.imagePreview(at.root, at.relative),
      };
    },
  });
  /** The debounced whole-file validation (manifest-validation.ts); the request is assembled in runValidate. */
  const validator = createManifestValidator({
    validate: (root, text, source) => deps.api.validate(root, text, source),
    getTranslator: () => deps.getTranslator(),
    onDue: () => void runValidate(),
  });
  /** The list rows' editor — its own levels of the column menu (list-editor.ts). */
  const listEditor = createListEditor({
    menu,
    keyboard: deps.keyboard,
    getTranslator: () => deps.getTranslator(),
    browse: (id, current, multi, onPicked) => browseInto(id, current, multi, onPicked),
    showImage: (path) => void lightbox.show(path),
    setList,
    rowTitle,
  });
  /** The "Find online" half that touches this screen: the query, the downloads, the fields (online-flow.ts). */
  const onlineFlow = createOnlineFlow({
    api: deps.api,
    onlinePicker: deps.onlinePicker,
    keyboard: deps.keyboard,
    getTranslator: () => deps.getTranslator(),
    isOpen: () => open,
    form: () => form,
    // Mirrors browseInto's choice of root: a pending move is already about the TARGET card, so the
    // assets belong there too. A history game downloads nothing — there is no game root to put a file
    // beside, which is why the online surface offers it the TEXT only.
    assetRoot: () => (pendingMove !== null ? pendingMove.target.root : (mediaOrigin()?.root ?? null)),
    isHistoryGame: () => historyId() !== null,
    setField,
    setList,
    mergeRest: (known) => {
      // `rest` is the screen's own slot for keys the form model has no field for; currentText() folds it
      // back into the manifest text, so this alone makes the screen dirty and Save carries it through.
      rest = { ...rest, ...known };
      updateForm(form);
    },
    requestTitleConfirm: (title) => deps.onConfirmRequested('replace-title', { title }),
  });

  /**
   * The section column. It carries this screen's actions too — Save, Discard edits, Delete, Close —
   * which is the whole point: they used to sit under six sections of form, so committing an edit meant
   * scrolling past every field you had just finished with.
   */
  const sidebar = createSidebar<MessageKey, GameRowId>(navEl, {
    audio: deps.audio,
    onSection: (id, entered) => {
      core.selectSection(id);
      if (entered) {
        core.enterPane();
        return;
      }
      core.schedulePreview();
    },
    onAction: (id) => runAction(id),
  });

  /** The row focus, the column ⇄ pane steps and the delayed section preview — shared with Settings. */
  const core = createListScreenCore<GameSettingsRow, RenderedGameRow>({
    audio: deps.audio,
    listEl,
    sidebar,
    scroller: listScroller,
    hover,
    isFocusable,
    renderPane: () => renderPane(),
    stepRow: (row, delta) => {
      if (row.kind === 'select') {
        cycleSelect(row, delta);
        return true;
      }
      if (row.kind === 'number') {
        stepNumber(row, delta);
        return true;
      }
      return false;
    },
    onLeavePane: () => menu.close(),
  });

  // ── Form state ─────────────────────────────────────────────────────────────

  /**
   * The whole file as it would be written right now — the PC library's, or (while a move is pending) the
   * TARGET card's, with `form` inserted at the slot the move claimed. See PendingMove.
   */
  function currentText(): string {
    if (pendingMove !== null) {
      const next = [...pendingMove.targetSlots];
      next[pendingMove.targetIndex] = { model: form, rest, corrupt };
      return gamesToText(next);
    }
    if (slotIndex < 0) return baseline;
    const next = [...slots];
    next[slotIndex] = { model: form, rest, corrupt };
    return gamesToText(next);
  }

  function dirty(): boolean {
    // A pending move is itself the change — there is no "back to how it was" text to compare against
    // (the comparison would be against the PC library's baseline, which a move never touches).
    if (pendingMove !== null) return true;
    return unreadable === null && currentText() !== baseline;
  }

  /**
   * Deleting a game is allowed for a local one always, and for a card game only while it is not the last
   * (a card with no manifest is a card the launcher cannot see). Never while the game is busy: the file
   * would lose a game the running launcher still holds a manifest for. Never mid-move either — Delete acts
   * on the PC library, which a pending move has not written to yet, and the two actions racing is not a
   * combination worth supporting.
   */
  function canDelete(): boolean {
    if (pendingMove !== null) return false;
    // Deleting a history game would mean deleting it from a card that is not here. "Remove from history"
    // in the carousel menu is the action that DOES apply there, and it is a different thing entirely.
    const at = mediaOrigin();
    if (at === null || deps.isBusy()) return false;
    return at.source === 'pc' ? true : slots.length >= 2;
  }

  /** Whether "Move to card…" (the action row above Delete) may run right now — a card has nowhere to
   * move TO that would mean anything, so this is local games only; same busy guard as Delete. */
  function canMove(): boolean {
    if (pendingMove !== null) return false;
    const at = mediaOrigin();
    if (at === null || deps.isBusy()) return false;
    return at.source === 'pc';
  }

  /**
   * Re-reads whether any card is plugged in, and repaints when the answer changed. Cheap enough to run on
   * a timer (main caches the listing) and skipped outright whenever the row it feeds is not on screen.
   */
  async function refreshMoveTargets(): Promise<void> {
    if (!open || mode !== 'edit' || pendingMove !== null) return;
    const list = await deps.api.sources();
    if (!open || mode !== 'edit') return;
    const present = list.some((candidate) => candidate.kind === 'card');
    if (present === moveTargets) return;
    moveTargets = present;
    render();
  }

  /** Starts that poll (once per visit), so a card inserted while the screen is open lights the row up. */
  function watchMoveTargets(): void {
    if (moveTargetsTimer !== 0) return;
    void refreshMoveTargets();
    moveTargetsTimer = window.setInterval(() => void refreshMoveTargets(), MOVE_TARGETS_POLL_MS);
  }

  function stopWatchingMoveTargets(): void {
    if (moveTargetsTimer === 0) return;
    window.clearInterval(moveTargetsTimer);
    moveTargetsTimer = 0;
  }

  function canSave(): boolean {
    // A write of this screen's is in flight. Nothing here is idempotent — main's swap guard rejects the
    // second Save of the same signature AFTER the first has already landed, so the user is shown an error
    // for a save that worked — and Add/Move remove things the retry then cannot find.
    if (writing) return false;
    const move = pendingMove;
    if (move !== null) {
      if (unreadable !== null) return false;
      if (ownIssues) return false;
      return otherIssues.every((issue) => move.targetBaselineOtherIssues.has(issue));
    }
    if (origin === null || unreadable !== null) return false;
    if (ownIssues) return false;
    // A problem in someone else's slot that was NOT there when we opened is one we introduced.
    return otherIssues.every((issue) => baselineOtherIssues.has(issue));
  }

  /** The source row's options: one per candidate root, labelled the way the picker labels them. */
  function sourceOptions(): readonly CoreOption[] {
    return sources.map((candidate) => ({ value: candidate.root, label: candidate.label }));
  }

  function currentModel(): GameSettingsModel | null {
    const where = origin;
    if (where === null) return null;
    const move = pendingMove;
    const media = mediaOrigin();
    const at = move !== null ? move.target.root : (media?.root ?? '');
    return buildGameSettingsModel(form, {
      mode,
      move: move !== null,
      sources: mode === 'add' ? sourceOptions() : [],
      sourceLabel:
        move !== null
          ? move.target.label
          : (sources.find((candidate) => candidate.root === at)?.label ?? null),
      // While a move is pending the form is edited AS THE TARGET CARD would read it — the whole point of
      // "the form expands": rows, launch modes and pickers all key off this.
      // A history game is a card's game by definition — its manifest came off one.
      source: move !== null || media === null ? 'card' : media.source,
      platform: where.platform,
      root: at,
      historyMode: where.kind === 'history',
      loadedId,
      mixed,
      issues,
      otherIssues,
      status,
      canSave: canSave(),
      dirty: dirty(),
      // A game that does not exist yet cannot be deleted — and for the PC library canDelete() says yes
      // to anything, so without this the column would offer "Delete game" on the Add screen.
      canDelete: mode === 'edit' && canDelete(),
      canMove: mode === 'edit' && canMove(),
      hasMoveTarget: moveTargets,
    });
  }

  /** Applies a new form state: repaint, re-validate, and refresh whatever thumbnails changed. */
  function updateForm(next: ManifestFormModel): void {
    form = next;
    render();
    scheduleValidate();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  /** Whether two models describe the same rows in the same order (a patch is enough when they do). */
  function sameComposition(a: GameSettingsModel, b: GameSettingsModel): boolean {
    const ids = (m: GameSettingsModel): string =>
      visibleRows(m)
        .map((row) => `${row.kind}:${row.id}`)
        .join('|');
    return ids(a) === ids(b);
  }

  function renderMessage(text: string): void {
    listEl.replaceChildren();
    const line = document.createElement('div');
    line.className = 'settings-section-title';
    line.textContent = text;
    listEl.append(line);
    core.setRendered([]);
  }

  /** How long the staggered row entrance runs — the marks come off once it is over. */
  const ENTRANCE_MS = 700;
  /** The stagger stops counting here: past a handful of rows the wave is a wait, not a wave. */
  const ENTRANCE_STEPS = 8;
  /** The one-shot entrance (see .setting-row.is-entering in styles.css, and entrance.ts for the shape). */
  const entrance = createEntrance(listEl, '.setting-row', ENTRANCE_MS);

  /**
   * What the column WOULD show — so it is only rebuilt when that actually changed. `null` means "nothing
   * is known about what is on screen", which is NOT the same as "it is empty": a re-opened screen that
   * confuses the two skips the rebuild and keeps whatever the last visit left in the DOM.
   */
  let columnSignature: string | null = null;

  function renderColumn(from: GameSettingsModel): void {
    const entries = columnEntries(from, t());
    const signature = entries
      .map((entry) => `${entry.id}:${entry.label}:${entry.disabled === true ? '1' : '0'}`)
      .join('|');
    // Save's enabled state follows every keystroke, so this runs constantly — rebuilding the buttons
    // each time would drop the hover state and flicker under the cursor for no reason.
    if (signature === columnSignature) return;
    columnSignature = signature;
    const selectedBefore = sidebar.selected()?.id;
    sidebar.render(entries);
    // The column can rebuild WITHOUT the entry the cursor was standing on — an action that stops applying
    // the moment it is pressed ("Move to card…", which leaves the column as soon as a move begins). The
    // sidebar's own fallback is its first entry, and it reports that to nobody, so the cursor ends up
    // naming one section while the pane still shows another. Put it back on the section actually on
    // screen: `select` only moves the cursor (no onSection), which is the point — the pane must not move.
    const shown = core.paneKey();
    if (selectedBefore !== undefined && sidebar.selected()?.id !== selectedBefore && shown !== null) {
      sidebar.select(shown);
    }
  }

  /** The same, for the status strip — and the same reason for the null. */
  let statusSignature: string | null = null;

  /** The notes, under both columns. */
  function renderStatus(from: GameSettingsModel): void {
    const notes = statusNotes(from);
    const signature = notes.map((note) => `${note.tone}:${rowLabelText(note.text, t())}`).join('|');
    if (signature === statusSignature) return;
    statusSignature = signature;
    statusEl.replaceChildren(...notes.map((note) => buildStatusNote(note, t())));
  }

  function render(): void {
    // A pending preview means `rendered` belongs to the section BEFORE the one sectionKey now names —
    // patching it against the new section's values would write them into the old section's rows.
    core.flushPreview();
    const next = currentModel();
    titleEl.textContent = t()(
      mode === 'add' ? 'gameSettings.addTitle' : 'gameSettings.screenTitle',
    );
    headingEl.textContent = screenHeading(next);
    // Source first, then the game — it reads as a location and its contents ("E:\ · Hades"). The
    // parentheses went with the swap: a parenthetical is an aside, and an aside cannot come first.
    sourceEl.textContent = next === null ? '' : `${rowLabelText(next.source, t())} ·`;
    if (unreadable !== null) {
      renderUnreadable();
      return;
    }
    if (next === null) {
      model = null;
      renderMessage(t()('gameSettings.loading'));
      return;
    }
    const previous = model;
    model = next;
    // The column carries Save's own enabled state, so it follows every edit — unlike the Settings
    // screen's, whose entries only change when a section appears.
    renderColumn(next);
    renderStatus(next);
    if (previous !== null && sameComposition(previous, next) && core.rendered().length > 0) {
      const rows = visibleRows(next);
      const artworkChanged = artworkSignature(previous) !== artworkSignature(next);
      core.rendered().forEach((row, index) => {
        const nextRow = rows[index];
        if (nextRow !== undefined) patchGameRow(row, nextRow, t());
      });
      // A patch keeps the DOM, thumbnails included — so the strip has to be re-read whenever the paths
      // behind it moved. Without this, adding a background to an existing list left the previous strip
      // on screen (the row composition had not changed, so nothing rebuilt).
      if (artworkChanged) void refreshThumbnails();
      return;
    }
    renderPane();
  }

  /** The rows the pane currently shows — one section's worth. */
  function visibleRows(from: GameSettingsModel): readonly GameSettingsRow[] {
    return sectionByKey(from.sections, core.sectionKey())?.rows ?? [];
  }

  function renderPane(): void {
    const from = model;
    if (from === null) return;
    const section = sectionByKey(from.sections, core.sectionKey());
    if (section === undefined) return;
    core.showSection(section.titleKey);
    // WITHOUT its title: the column beside it already names the section, and printing the name again at
    // the top of the pane says the same thing twice.
    core.setRendered(
      renderGameSettings(listEl, { ...from, sections: [{ rows: section.rows }] }, t()).rows,
    );
    core.rendered().forEach((row, at) =>
      row.el.style.setProperty('--row-index', String(Math.min(at, ENTRANCE_STEPS))),
    );
    entrance.play();
    core.seatFocus();
    core.applyRowFocus(true);
    listScroller.to(0, true);
    requestAnimationFrame(() => listScroller.fades());
    void refreshThumbnails();
  }

  /**
   * The state for a slot the form cannot show at all. Sending the user off to "edit game.json by hand" is
   * no answer — in Game Mode on a Deck that means "you cannot" — and the JSON tab the old window fell
   * back to no longer exists. So the screen offers the two things that ARE possible from here.
   */
  function renderUnreadable(): void {
    model = null;
    listEl.replaceChildren();
    const section = document.createElement('div');
    section.className = 'settings-section';
    const title = document.createElement('div');
    title.className = 'settings-section-title';
    title.textContent = t()('gameSettings.slotUnreadable', { message: unreadable ?? '' });
    section.append(title);
    listEl.append(section);
    core.setRendered([]);
  }

  /** The artwork rows' thumbnails, for the pane as it stands (see asset-lightbox.ts). */
  async function refreshThumbnails(): Promise<void> {
    if (origin === null) return;
    await lightbox.refreshThumbnails(core.rendered());
  }

  // ── Field editing ──────────────────────────────────────────────────────────

  /** Writes one field of the form model by row id. Everything a row can change goes through here. */
  function setField(id: GameRowId, value: string): void {
    const next = withField(form, id, value);
    if (next !== form) updateForm(next);
  }

  function setList(id: GameRowId, items: readonly string[]): void {
    const next = withList(form, id, items);
    if (next !== form) updateForm(next);
  }

  function toggleField(id: GameRowId): void {
    const next = withToggle(form, id);
    if (next !== form) updateForm(next);
  }

  function setSelect(id: GameRowId, value: string): void {
    if (id === 'source') {
      requestSource(value);
      return;
    }
    // Guarded, not cast: `value` is a DOM select's, and a cast would let a stale option (a select painted
    // for another mode, an option removed by a re-render) enter the form as a launch mode that is not one.
    if (id === 'launchMode') {
      if (isLaunchMode(value)) updateForm(withLaunchMode(form, value));
      return;
    }
    if (id === 'install.type' && isInstallType(value)) updateForm(withInstallType(form, value));
  }

  /**
   * Steps the source row by `delta`, wrapping like every other select. Measured from the root being
   * ADOPTED when a read is still in flight, so a quick second press moves on rather than re-asking for
   * the same neighbour. A step that would cost something still raises the confirm — and the popup takes
   * the input while it is up, so a HELD direction cannot stack a queue of questions behind it.
   */
  function cycleSource(delta: number): void {
    if (sources.length === 0) return;
    const current = adoptingRoot ?? mediaOrigin()?.root ?? '';
    const at = sources.findIndex((candidate) => candidate.root === current);
    const next = sources[wrapIndex(at === -1 ? 0 : at, delta, sources.length)];
    if (next === undefined || next.root === current) return;
    deps.audio.play('navigate');
    requestSource(next.root);
  }

  /**
   * Moves the new game to another root, asking first only when the move would COST something: the paths
   * and the install block are read against a root, so they cannot travel with it (see
   * carryFormAcrossSources). With nothing but a name typed there is nothing to warn about.
   */
  function requestSource(root: string): void {
    if (root === (adoptingRoot ?? mediaOrigin()?.root)) return;
    if (hasSourceBoundValues(form)) {
      pendingSource = root;
      deps.onConfirmRequested('switch-source');
      return;
    }
    void adoptRoot(root);
  }

  // ── Row activation ─────────────────────────────────────────────────────────

  function openSelectMenu(row: Extract<GameSettingsRow, { kind: 'select' }>): void {
    const options: readonly CoreOption[] = row.options;
    menu.push({
      kind: 'select',
      title: '',
      focus: Math.max(
        0,
        options.findIndex((option) => option.value === row.value),
      ),
      entries: options.map((option) => ({
        label: optionLabel(option, t()),
        current: option.value === row.value,
        run: () => {
          menu.close();
          setSelect(row.id, option.value);
        },
      })),
    });
  }

  function cycleSelect(row: Extract<GameSettingsRow, { kind: 'select' }>, delta: number): void {
    // The source steps through the CANDIDATES, not through the row's own value: a step starts a root read,
    // and until it lands the row still shows the previous root — so stepping again would keep landing on
    // the same neighbour instead of walking down the list.
    if (row.id === 'source') {
      cycleSource(delta);
      return;
    }
    if (row.options.length === 0) return;
    const current = row.options.findIndex((option) => option.value === row.value);
    const next = wrapIndex(current === -1 ? 0 : current, delta, row.options.length);
    const option = row.options[next];
    if (option === undefined) return;
    deps.audio.play('navigate');
    setSelect(row.id, option.value);
  }

  function stepNumber(row: Extract<GameSettingsRow, { kind: 'number' }>, delta: number): void {
    const parsed = Number.parseInt(row.value, 10);
    const base = Number.isFinite(parsed) ? parsed : 0;
    const next = Math.min(row.max, Math.max(row.min, base + delta * row.step));
    if (String(next) === row.value) {
      deps.audio.playLimit(); // already at min / max
      return;
    }
    deps.audio.play('navigate');
    setField(row.id, String(next));
  }

  function openKeyboardFor(row: Extract<GameSettingsRow, { kind: 'text' | 'number' }>): void {
    deps.keyboard.open({
      value: row.value,
      mode: row.kind === 'number' ? 'number' : row.id === 'id' ? 'id' : 'text',
      title: rowTitle(row),
      onDone: (value) => setField(row.id, value),
    });
  }

  function rowTitle(row: GameSettingsRow): string {
    if (row.kind === 'note') return '';
    if (row.kind === 'action') return '';
    return 'key' in row.label ? t()(row.label.key) : row.label.text;
  }

  /** A path row's own little menu: browse for a new value, or clear the one it has. */
  function openPathMenu(row: Extract<GameSettingsRow, { kind: 'path' }>): void {
    const entries: MenuEntry[] = [];
    if (row.value !== '' && row.preview !== undefined) {
      entries.push({
        label: t()('gameSettings.viewImage'),
        run: () => void lightbox.show(row.value),
      });
    }
    entries.push({
      label: t()('gameSettings.browse'),
      run: () => browseInto(row.id, row.value, false),
    });
    if (row.value !== '') {
      entries.push({
        label: t()('gameSettings.clear'),
        run: () => {
          menu.close();
          setField(row.id, '');
        },
      });
    }
    menu.push(menu.asMenu({ title: rowTitle(row), entries }));
  }

  /**
   * Which root a card-relative path should be read FROM: normally wherever the form is currently pointed
   * at, but a hero/grid image carried over by a pending move is an exception — main has not copied it to
   * the target card yet (that only happens on Save), so it has to be read from the PC library, where the
   * bytes still are. See PendingMove.sourceAssetPaths.
   */
  function assetPreviewRoot(
    relative: string,
  ): { readonly root: string; readonly relative: string } | null {
    const media = mediaOrigin();
    const move = pendingMove;
    if (move !== null) {
      const source = move.sourceAssetPaths.get(relative);
      if (source !== undefined) return media === null ? null : { root: media.root, relative: source };
      return { root: move.target.root, relative };
    }
    return media === null ? null : { root: media.root, relative };
  }

  /**
   * Opens the file browser for a field and writes what it picked back into the form.
   *
   * The menu it was opened FROM stays underneath. Closing it up front made backing out of the browser
   * land on the form instead of on the popup the user was in — one press undoing two levels, which is
   * not what back means anywhere else here. The menu is dismissed only once a value has actually been
   * chosen, because then there is nothing left to go back to.
   */
  function browseInto(
    id: GameRowId,
    current: string,
    multi: boolean,
    onPicked?: (paths: readonly string[]) => void,
  ): void {
    const move = pendingMove;
    const media = mediaOrigin();
    // A history game browses THIS PC's filesystem with no root behind it: the picker's listing is
    // root-agnostic already, and what is picked is staged by id rather than measured against a card.
    const forHistory = historyId();
    const at =
      move !== null
        ? { root: move.target.root, source: 'card' as const }
        : media !== null
          ? { root: media.root, source: media.source }
          : forHistory !== null
            ? { root: '', source: 'card' as const }
            : null;
    if (at === null) return;
    const kind = pickKindFor(id, form.launchMode, at.source);
    if (kind === null) return;
    deps.picker.open({
      root: at.root,
      kind,
      current,
      multi,
      ...(forHistory !== null ? { historyId: forHistory } : {}),
      ...(baseFor(id) !== null ? { base: baseFor(id) ?? '' } : {}),
      onDone: (result) => {
        if (!result.ok) {
          if (!('cancelled' in result)) failWith(result.message);
          // Cancelled (or refused): the popup is still up, and the focus goes back to it.
          menu.applyFocus();
          return;
        }
        menu.close({ silent: true }); // the browser's own popup-close already covered this gesture
        if (onPicked !== undefined) {
          onPicked(result.paths);
          return;
        }
        const first = result.paths[0];
        if (first !== undefined) setField(id, first);
      },
    });
  }

  /**
   * The sub-directory a field's paths are relative to, when it is not the root itself.
   *
   * Only "move game to PC" has one, and it is not cosmetic: with the checkbox on, the manifest resolves
   * `executable` under the INSTALL directory, which receives the contents of the game folder named
   * below it (manifest.ts, `<installDir>/<executable>`). A card-relative path would carry that folder's
   * own name as a prefix and point one level too deep — so the browser both starts there and measures
   * from there.
   */
  function baseFor(id: GameRowId): string | null {
    if (id !== 'executable') return null;
    if (form.launchMode !== 'executable' || !form.copyToPc) return null;
    return form.copyInstall.installer === '' ? null : form.copyInstall.installer;
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  function scheduleValidate(): void {
    validator.schedule();
  }

  /**
   * Asks main to judge the WHOLE file, then splits the verdict in two: the problems inside our slot
   * (mapped onto rows) and the ones in the other games (a summary line). The split is why the issue paths
   * matter — the validator reports a multi-game file's paths as `games.<i>.<field>`.
   */
  async function runValidate(): Promise<void> {
    const move = pendingMove;
    const media = mediaOrigin();
    // A history game has no root to imply a dialect, so the dialect is named outright: its manifest came
    // off a card and has to keep validating as one.
    const root = move !== null ? move.target.root : (media?.root ?? '');
    if (origin === null || unreadable !== null) return;
    const verdict = await validator.run({
      root,
      text: currentText(),
      ...(origin.kind === 'history' ? { source: 'card' } : {}),
      index: move !== null ? move.targetIndex : slotIndex,
      slots: move !== null ? move.targetSlots : slots,
    });
    if (verdict === null) return; // a newer edit already asked
    issues = verdict.own;
    // Only issues this VISIT introduced block Save. For a game edited from the history the baseline is
    // its stored manifest, which — on a card written by hand years ago — can fail the editor's stricter
    // gates all by itself (see manifest.ts). Without this mirror of main's own rule the button would be
    // dead for such a card and the user would never reach the message explaining why.
    ownIssues = [...verdict.own].some(
      ([path, message]) => !baselineOwnIssues.has(issueKey(path, message)),
    );
    otherIssues = verdict.others;
    render();
  }

  /**
   * The line under the columns. It now says only what is HAPPENING (a save in flight) — a result that
   * lives there is a result the user can scroll away from, so those go to the notification plate and the
   * error popup instead (see `notify` / `showError` above).
   */
  function setStatus(next: string | null): void {
    status = next;
    render();
  }

  /** Said and done: the plate takes it, and the form's own line is cleared of whatever was in flight. */
  function notifyDone(text: string): void {
    setStatus(null);
    deps.notify(text);
  }

  /** Something went wrong: the popup holds it until the user closes it. */
  function failWith(text: string): void {
    setStatus(null);
    deps.showError(text);
  }

  // ── Load / save / delete ───────────────────────────────────────────────────

  async function load(id: string): Promise<void> {
    gameId = id;
    origin = null;
    unreadable = null;
    status = null;
    issues = new Map();
    otherIssues = [];
    ownIssues = false;
    render();
    const result = await deps.api.read(id);
    if (!open || gameId !== id) return; // closed (or moved on) while main was reading
    if (!result.ok) {
      origin = null;
      unreadable = result.message;
      render();
      return;
    }
    deps.audio.play('button'); // the screen is entered like a button, not like a popup
    origin = {
      kind: 'media',
      root: result.root,
      source: result.source,
      signature: result.signature,
      platform: result.platform,
    };
    if (result.source === 'pc') watchMoveTargets();
    adoptText(result.text);
    await runValidate();
    baselineOtherIssues = new Set(otherIssues);
  }

  /**
   * The same screen for a game whose card is NOT in. What comes back is one game's manifest — the edits
   * waiting for that card, or the snapshot taken of it — and everything that would need the card
   * (browsing for a file, the swap guard, writing) is answered by the history instead.
   */
  async function loadHistory(id: string): Promise<void> {
    gameId = id;
    origin = null;
    unreadable = null;
    status = null;
    issues = new Map();
    otherIssues = [];
    ownIssues = false;
    baselineOwnIssues = new Set();
    render();
    const result = await deps.api.readHistory(id);
    if (!open || gameId !== id) return; // closed (or moved on) while main was reading
    if (!result.ok) {
      origin = null;
      unreadable = result.message;
      render();
      return;
    }
    deps.audio.play('button');
    origin = { kind: 'history', id, platform: result.platform };
    adoptText(result.text);
    await runValidate();
    baselineOtherIssues = new Set(otherIssues);
    // What was already wrong with the stored manifest is not this visit's doing — see runValidate.
    baselineOwnIssues = new Set([...issues].map(([path, message]) => issueKey(path, message)));
    ownIssues = false;
    render();
  }

  /**
   * "Move to card…": lists the cards a local game may move to and lets the user pick one. Called
   * once `load` has landed — re-checks the source itself, since the menu item's own visibility rule
   * (controls.ts) can go stale between the press and the read completing.
   */
  async function beginMove(): Promise<void> {
    if (mediaOrigin()?.source !== 'pc') return;
    const forGame = gameId;
    const list = await deps.api.sources();
    // Closed, reopened for another game / in add mode, or a target was already picked meanwhile.
    if (!open || mode !== 'edit' || gameId !== forGame || pendingMove !== null) return;
    const cards = list.filter((candidate) => candidate.kind === 'card');
    if (cards.length === 0) {
      failWith(t()('gameSettings.moveNoCards'));
      return;
    }
    menu.push(
      menu.asMenu({
        title: t()('gameSettings.moveToCardTitle'),
        entries: cards.map((candidate) => ({
          label: candidate.label,
          run: () => {
            menu.close();
            void adoptMoveTarget(candidate);
          },
        })),
      }),
    );
  }

  /**
   * Reads the chosen target card and inserts the moved game (see `carryFormToCard`) as a slot of its own —
   * exactly what `adoptRoot` does for a brand new ADD game, except the inserted model carries a REAL
   * game's data across instead of starting blank. Nothing is written here; see PendingMove.
   */
  async function adoptMoveTarget(candidate: DriveCandidate): Promise<void> {
    if (pendingMove !== null) return; // a target is already chosen — this answer is a stale second one
    const token = ++adoptToken;
    const forGame = gameId;
    setStatus(null);
    const result = await deps.api.readRoot(candidate.root);
    // The same guards `adoptRoot` uses, and for the same reason: this answer describes a place the user
    // may have left — the screen could have been closed, reopened for another game, or reopened in add
    // mode, and applying a move target to any of those writes the wrong file.
    if (!open || mode !== 'edit' || gameId !== forGame || token !== adoptToken) return;
    if (!result.ok) {
      failWith(result.message);
      return;
    }
    const originalPcSavePath = form.pcSavePath;
    const carried = carryFormToCard(form);
    const parsed = slotsWithInsertedGame(result.hasManifest ? result.text : null, carried);
    if (!parsed.ok) {
      failWith(parsed.message);
      return;
    }
    // dest → source, by matching position in the two arrays carryFormToCard read and wrote — see
    // PendingMove.sourceAssetPaths.
    const sourceAssetPaths = new Map<string, string>();
    form.heroImage.forEach((source, index) => {
      const dest = carried.heroImage[index];
      if (dest !== undefined) sourceAssetPaths.set(dest, source);
    });
    if (carried.gridImage !== '') sourceAssetPaths.set(carried.gridImage, form.gridImage);
    pendingMove = {
      target: candidate,
      targetSlots: parsed.slots,
      targetIndex: parsed.index,
      targetSignature: result.signature,
      targetBaselineOtherIssues: new Set(),
      sourceAssetPaths,
    };
    form = carried;
    rest = {};
    corrupt = {};
    core.setFocusIndex(0);
    model = null;
    render();
    await runValidate();
    // canSave() must judge against issues that were ALREADY there when the target was read, exactly like
    // baselineOtherIssues for a normal edit — a bad neighbour on the target card is not ours to fix either.
    if (pendingMove !== null) {
      pendingMove = { ...pendingMove, targetBaselineOtherIssues: new Set(otherIssues) };
    }
    // Best-effort backfill: an absolute pcSavePath (the common shape for a local, non-Steam game — see
    // %PREFIX%/%APPDATA% handling in manifest.ts) was dropped by carryFormToCard because a card cannot
    // store one. Converting it into the %PREFIX% form a card DOES accept needs main (the same conversion
    // the picker itself makes), so it happens here, after the target is already adopted, instead of
    // blocking on it — a folder that no longer exists or sits outside every known base just leaves the
    // field for the user to fill in, exactly as it did before this backfill existed.
    if (form.pcSavePath === '' && originalPcSavePath !== '') {
      const converted = await deps.api.acceptPath({
        root: candidate.root,
        kind: 'pc-save',
        paths: [originalPcSavePath],
      });
      if (
        open &&
        mode === 'edit' &&
        gameId === forGame &&
        token === adoptToken &&
        pendingMove !== null
      ) {
        const first = converted.ok ? converted.paths[0] : undefined;
        if (first !== undefined) updateForm({ ...form, pcSavePath: first });
      }
    }
  }

  /**
   * Add mode's counterpart of `load`: the roots a game may be added to, and then the one it starts on —
   * the active card if a card is inserted, this PC otherwise. The card is where the user's attention
   * already is (they just plugged it in); the library is the one root that is always there.
   */
  async function loadSources(): Promise<void> {
    const list = await deps.api.sources();
    if (!open || mode !== 'add') return; // closed (or reopened for a game) while main was listing
    sources = list;
    const card = list.find((candidate) => candidate.kind === 'card' && candidate.isActive);
    const first = card ?? list.find((candidate) => candidate.kind === 'pc') ?? list[0];
    if (first === undefined) {
      failWith(t()('errors.driveUnavailable'));
      return;
    }
    await adoptRoot(first.root);
  }

  /**
   * Points the add form at one root: reads what that root already carries, appends the new game as a slot
   * of its own (see slotsWithNewGame) and re-validates. On a SWITCH the half-filled form travels with it,
   * minus everything that was measured against the old root.
   */
  async function adoptRoot(root: string): Promise<void> {
    const carried = origin === null ? null : form;
    const token = ++adoptToken;
    adoptingRoot = root;
    setStatus(null);
    const result = await deps.api.readRoot(root);
    // A newer step already asked for another root — this answer describes a place the user has left.
    if (!open || mode !== 'add' || token !== adoptToken) return;
    adoptingRoot = null;
    if (!result.ok) {
      failWith(result.message);
      return;
    }
    origin = {
      kind: 'media',
      root: result.root,
      source: result.source,
      signature: result.signature,
      platform: result.platform,
    };
    const blankMode = defaultLaunchMode(result.source);
    const parsed = slotsWithNewGame(result.hasManifest ? result.text : null, blankMode);
    if (!parsed.ok) {
      unreadable = parsed.message;
      render();
      return;
    }
    slots = [...parsed.slots];
    slotIndex = parsed.index;
    form =
      carried === null ? emptyFormModel(blankMode) : carryFormAcrossSources(carried, result.source);
    rest = {};
    corrupt = {};
    mixed = false;
    loadedId = '';
    unreadable = null;
    // Exactly as in edit mode: the baseline is the file as the screen would write it RIGHT NOW, so
    // `dirty` means "the user typed something" rather than "the screen appended an empty game".
    baseline = currentText();
    core.setFocusIndex(0);
    model = null;
    render();
    await runValidate();
    baselineOtherIssues = new Set(otherIssues);
  }

  /** Parses a whole file into slots and picks OURS out by id. */
  function adoptText(text: string): void {
    baseline = text;
    const parsed = textToGames(text);
    if (!parsed.ok) {
      unreadable = parsed.message;
      render();
      return;
    }
    slots = parsed.games.map((game, index) =>
      game.ok
        ? { model: game.model, rest: game.rest, corrupt: game.corrupt }
        : { raw: parsed.values[index] },
    );
    slotIndex = parsed.games.findIndex((game) => game.ok && game.model.id === gameId);
    const ours = slotIndex === -1 ? undefined : parsed.games[slotIndex];
    if (ours === undefined || !ours.ok) {
      // The file no longer describes the game the carousel showed — main's list and this file disagree,
      // which is a state to report rather than to guess at.
      unreadable = t()('gameSettings.slotNotFound', { id: gameId });
      render();
      return;
    }
    // textToGames has no `source`, so a PC-library draft (no launch block at all) parses indistinguishably
    // from a blank card form and defaults to 'executable' — draftModeFor corrects that with the source the
    // screen actually has.
    // A history game's manifest is a card's, whatever else the screen has to do without.
    const dialect = origin === null ? null : (mediaOrigin()?.source ?? 'card');
    form =
      dialect === null
        ? ours.model
        : { ...ours.model, launchMode: draftModeFor(ours.model, dialect) };
    rest = ours.rest;
    corrupt = ours.corrupt;
    mixed = ours.mixed;
    loadedId = ours.model.id;
    unreadable = null;
    core.setFocusIndex(0);
    model = null; // force a full rebuild — the composition is entirely new
    render();
  }

  /** Runs one write with `writing` held for its whole duration — see the flag. */
  async function writingWith<T>(write: () => Promise<T>): Promise<T> {
    writing = true;
    render(); // the Save row is drawn from canSave(), so it greys out for as long as the write runs
    try {
      return await write();
    } finally {
      writing = false;
    }
  }

  async function runSave(): Promise<void> {
    const at = origin;
    if (at === null || !canSave()) return;
    const text = currentText();
    setStatus(t()('gameSettings.saving'));
    // Nothing is written to any card here when the game came from the history: the edits are stored on
    // this PC and the card picks them up the next time it is inserted (see history-config.ts).
    const result = await writingWith(() =>
      at.kind === 'history'
        ? deps.api.saveHistory({ id: at.id, text })
        : deps.api.save({ root: at.root, signature: at.signature, text }),
    );
    if (!result.saved) {
      failWith(result.message);
      return;
    }
    baseline = text;
    // A save while the game is RUNNING writes the file but cannot reload the manifest (the launcher
    // refuses mid-play). That is not a failure — the file on disk is already right and the launcher picks
    // it up on the next read — so it is reported as what it is.
    if (result.applied === 'applied') notifyDone(t()('gameSettings.savedApplied'));
    else if (result.applied === 'deferred') notifyDone(t()('gameSettings.savedDeferred'));
    else notifyDone(t()('gameSettings.savedNotApplied'));
    render();
  }

  /**
   * The Save button while a move is pending — one IPC, the whole transaction runs in main (see
   * GameConfigService.moveToCard). Closes on success exactly like `runAdd`: the game left the PC library,
   * so there is nothing here to keep editing. `deferred`/a skipped save folder are reported to the user as
   * NOTIFICATIONS main files itself (game-moved-deferred / game-move-save-skipped), not as screen status —
   * the screen is already gone by the time either matters.
   */
  async function runMove(): Promise<void> {
    const move = pendingMove;
    const media = mediaOrigin();
    if (move === null || media === null || !canSave()) return;
    const text = currentText();
    const movedId = form.id;
    setStatus(t()('gameSettings.saving'));
    const result = await writingWith(() =>
      deps.api.moveToCard({
        id: movedId,
        // The id the manifest was READ with — what main addresses the PC-library side by. `form.id` is an
        // editable field and must never be what decides which local game gets removed.
        fromId: loadedId,
        fromRoot: media.root,
        fromSignature: media.signature,
        toRoot: move.target.root,
        toSignature: move.targetSignature,
        toText: text,
      }),
    );
    if (!result.moved) {
      failWith(result.message);
      return;
    }
    close();
    if (result.applied === 'applied') deps.onAdded(movedId);
  }

  /**
   * The Add button. The write is the same one Save makes — the difference is what happens after it, and
   * that follows what main could DO with the file:
   *
   *  • `applied` — the manifest was re-read, so the game exists in the library now: leave the screen and
   *    take the carousel to it;
   *  • `deferred` — it went to a card that is not the active one, so there is nothing to go to. The
   *    screen still closes (keeping the user on a form about a finished job says nothing), and main
   *    posts the notification that says where the game went;
   *  • `failed` — written, but the reload was refused. That is an error to read, so the screen stays.
   */
  async function runAdd(): Promise<void> {
    const at = mediaOrigin();
    if (at === null || !canSave()) return;
    const text = currentText();
    const addedId = form.id;
    setStatus(t()('gameSettings.saving'));
    const result = await writingWith(() =>
      deps.api.save({ root: at.root, signature: at.signature, text }),
    );
    if (!result.saved) {
      failWith(result.message);
      return;
    }
    baseline = text;
    if (result.applied === 'failed') {
      failWith(result.message ?? t()('gameSettings.savedNotApplied'));
      await resyncAfterWrite(at.root, addedId);
      return;
    }
    close();
    if (result.applied === 'applied') deps.onAdded(addedId);
  }

  /**
   * Re-reads the root after a write the launcher could not apply, so a second Add is possible at all: the
   * root's signature carries the new id now, and the swap guard would refuse a retry against the one the
   * screen opened with. The game that was just written comes back with the others and is dropped from
   * them — it is the slot the form is still editing, and keeping both would write it twice.
   */
  async function resyncAfterWrite(root: string, writtenId: string): Promise<void> {
    const token = ++adoptToken;
    const result = await deps.api.readRoot(root);
    // The same guard adoptRoot uses: the user may have moved the game to another root meanwhile, and
    // this answer is about the one they left.
    if (!open || mode !== 'add' || token !== adoptToken || !result.ok) return;
    const parsed = slotsWithNewGame(result.hasManifest ? result.text : null, form.launchMode);
    if (!parsed.ok) return;
    const others = parsed.slots.filter(
      (slot, index) => index !== parsed.index && (isRawSlot(slot) || slot.model.id !== writtenId),
    );
    origin = {
      kind: 'media',
      root: result.root,
      source: result.source,
      signature: result.signature,
      platform: result.platform,
    };
    slots = [...others, { model: form, rest, corrupt }];
    slotIndex = others.length;
    baseline = currentText();
    render();
    await runValidate();
  }

  /**
   * Deleting is IMMEDIATE, unlike the old window's "remove the slot and save later": a confirmed deletion
   * that leaves the game on screen until some later Save reads as a bug. The slot is cut from the text as
   * READ, so unsaved edits are discarded with it — which the confirm says out loud.
   */
  async function runDelete(forgetHistory: boolean): Promise<void> {
    // Delete is not offered for a history game (canDelete), and could not act on one anyway: the file it
    // would cut the slot from is on a card that is not here.
    const at = mediaOrigin();
    if (at === null || slotIndex < 0) return;
    const remaining = slots.filter((_, index) => index !== slotIndex);
    const text = gamesToText(remaining);
    const result = await deps.api.save({ root: at.root, signature: at.signature, text });
    if (!result.saved) {
      failWith(result.message);
      return;
    }
    baseline = text;
    // Only now: main refuses to forget a game it can still see in a manifest, and the save resolves once
    // that manifest has been re-read — so this is the first moment the request can be honoured.
    if (forgetHistory) deps.api.forgetHistory(gameId);
    close();
  }

  function runReset(): void {
    adoptText(baseline);
    status = null;
    void runValidate();
  }

  // ── The six primitives ─────────────────────────────────────────────────────

  /** Which surface the primitives drive right now: the deepest open one wins. */
  function activeSurface(): NavSurface | 'lightbox' | 'menu' | 'form' {
    if (lightbox.isOpen()) return 'lightbox';
    if (deps.keyboard.isOpen()) return deps.keyboard;
    if (deps.picker.isOpen()) return deps.picker;
    if (deps.onlinePicker.isOpen()) return deps.onlinePicker;
    if (menu.isOpen()) return 'menu';
    return 'form';
  }

  function navUp(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') return deps.audio.playLimit(); // nothing to move in a picture
    if (surface === 'menu') return menu.moveFocus(-1);
    if (surface === 'form') return sidebar.hasFocus() ? sidebar.move(-1) : core.moveRowFocus(-1);
    surface.navUp();
  }

  function navDown(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') return deps.audio.playLimit();
    if (surface === 'menu') return menu.moveFocus(1);
    if (surface === 'form') return sidebar.hasFocus() ? sidebar.move(1) : core.moveRowFocus(1);
    surface.navDown();
  }

  function navLeft(repeat = false): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') {
      if (!repeat) deps.audio.playLimit();
      return;
    }
    if (surface === 'menu') {
      // Left leaves a level, the same way it leaves a popup: the column sits on the right edge, so moving
      // off it means "out". A HELD left is ignored, or one press would walk out through every level.
      if (!repeat) menu.pop();
      return;
    }
    if (surface === 'form') {
      core.navHorizontal(-1);
      return;
    }
    surface.navLeft(repeat);
  }

  function navRight(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') return deps.audio.playLimit();
    if (surface === 'menu') return deps.audio.playLimit(); // a menu is vertical — right leads nowhere
    if (surface === 'form') {
      core.navHorizontal(1);
      return;
    }
    surface.navRight();
  }

  function activateRow(target: RenderedGameRow): void {
    const row = target.row;
    // A disabled row is shown for its VALUE, not for editing: a toggle a custom installer forces, and —
    // for a game configured from the history — every field that names something on the card that is not
    // here to be browsed (see buildGameSettingsModel's historyMode).
    if (row.kind !== 'note' && row.kind !== 'action' && row.disabled === true) {
      deps.audio.playLimit();
      return;
    }
    switch (row.kind) {
      case 'toggle':
        deps.audio.play('button');
        pressFlash(target.el);
        toggleField(row.id);
        return;
      // Every row below opens a surface of its own (a menu, the keyboard, the picker), and each of them
      // plays `popup-open` as it appears. The `button` here is the ROW being pressed: two sounds for the
      // gesture, the same pair a launcher card plays when it opens its surface.
      case 'select':
        deps.audio.play('button');
        pressFlash(target.el);
        openSelectMenu(row);
        return;
      case 'text':
      case 'number':
        deps.audio.play('button');
        pressFlash(target.el);
        openKeyboardFor(row);
        return;
      case 'path':
        deps.audio.play('button');
        pressFlash(target.el);
        openPathMenu(row);
        return;
      case 'list':
        deps.audio.play('button');
        pressFlash(target.el);
        listEditor.open(row);
        return;
      case 'action':
        // Actions live in the column now; a row of this kind should never reach the pane.
        return;
      default:
        return;
    }
  }

  /** The screen's actions, now that they live in the column rather than at the end of the form. */
  function runAction(id: GameRowId): void {
    switch (id) {
      case 'find-online':
        deps.audio.play('button');
        onlineFlow.start();
        return;
      case 'save':
        deps.audio.play('button');
        if (mode === 'add') void runAdd();
        else if (pendingMove !== null) void runMove();
        else void runSave();
        return;
      case 'reset':
        // Neither action exists in add mode's column — but the column is not the only way in (a stale
        // model, a click), and both would act on a game that does not exist.
        if (mode === 'add') return deps.audio.playLimit();
        deps.audio.play('button');
        deps.onConfirmRequested('reset');
        return;
      case 'move-to-card':
        if (mode === 'add' || pendingMove !== null) return deps.audio.playLimit();
        deps.audio.play('button'); // beginMove's own popup-open follows, like every other menu it opens
        void beginMove();
        return;
      case 'delete':
        if (mode === 'add') return deps.audio.playLimit();
        deps.audio.play('button');
        deps.onConfirmRequested('delete');
        return;
      case 'close':
        // The same question B asks from the column: leaving with unsaved edits is confirmed first.
        leaveScreen();
        return;
      default:
        return;
    }
  }

  function navActivate(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') {
      lightbox.close();
      return;
    }
    if (surface === 'menu') {
      menu.activate();
      return;
    }
    if (surface === 'form') {
      if (sidebar.hasFocus()) {
        sidebar.activate();
        return;
      }
      const target = core.focusedRow();
      if (target !== undefined) activateRow(target);
      return;
    }
    surface.navActivate();
  }

  function navBack(): void {
    hover.arm();
    const surface = activeSurface();
    if (surface === 'lightbox') {
      lightbox.close();
      return;
    }
    if (surface === 'menu') {
      menu.pop();
      return;
    }
    if (surface !== 'form') {
      surface.navBack();
      return;
    }
    // Out of the pane, back to the column; out of the column, off the screen — which is where the
    // unsaved-edits question belongs, since the column is the only way out. Only the step INSIDE the
    // screen keeps `back`; leaving it is a popup closing, and close() says so.
    if (!sidebar.hasFocus()) {
      deps.audio.play('back');
      core.leavePane();
      return;
    }
    leaveScreen();
  }

  /** Leaves the screen, asking first when there is anything to lose. */
  function leaveScreen(): void {
    // A pending move is its own question — "Yes" drops it and stays on the screen, unlike 'discard',
    // whose "Yes" closes it outright (see PendingMove / cancelMove).
    if (pendingMove !== null) {
      deps.onConfirmRequested('cancel-move');
      return;
    }
    if (dirty()) {
      deps.onConfirmRequested('discard');
      return;
    }
    close();
  }

  /** Drops a pending move and returns the form to the PC library's baseline — same path as Reset. */
  function cancelMove(): void {
    pendingMove = null;
    runReset();
  }

  function close(): void {
    if (!open) return;
    open = false;
    // Anything still in flight belongs to the visit that is ending: a slow readRoot answering after the
    // screen was reopened for ANOTHER game would otherwise pass its own guard (`token === adoptToken`) and
    // drop that game into a move it never asked for. Bumping the token here retires every pending answer.
    adoptToken += 1;
    pendingMove = null;
    deps.audio.play('back');
    // The lightbox, the menu and the keyboard go WITH the screen — one close, one sound.
    lightbox.close({ silent: true });
    menu.close({ silent: true });
    deps.keyboard.close();
    // The online surface holds an audition — real sound, which would outlive the screen otherwise.
    deps.onlinePicker.close();
    entrance.cancel();
    core.cancelPreview();
    validator.cancel();
    stopWatchingMoveTargets();
    delete app.dataset['overlay'];
    screen.setAttribute('aria-hidden', 'true');
    deps.onClosed();
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────

  listEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // A thumbnail IS the "show me this picture" affordance for the mouse; the gamepad reaches the same
    // viewer through the row's own menu. Checked before the row, or the click would also open that menu.
    if (target instanceof HTMLElement && target.classList.contains('setting-thumb')) {
      deps.audio.play('button'); // the press; the viewer plays its own `popup-open`
      void lightbox.show(target.dataset['path'] ?? '');
      return;
    }
    const rowEl = target.closest<HTMLElement>('.setting-row');
    if (rowEl === null) return;
    const index = core.rendered().findIndex((row) => row.el === rowEl);
    const entry = core.rendered()[index];
    if (entry === undefined || !isFocusable(entry.row)) return;
    sidebar.setFocused(false);
    core.setFocusIndex(index);
    core.applyRowFocus();
    const chevronEl = target.closest<HTMLElement>('.setting-chevron');
    if (chevronEl !== null) {
      const delta = chevronEl.dataset['chevron'] === 'prev' ? -1 : 1;
      if (entry.row.kind === 'select') cycleSelect(entry.row, delta);
      else if (entry.row.kind === 'number') stepNumber(entry.row, delta);
      return;
    }
    activateRow(entry);
  });

  veil?.addEventListener('click', () => navBack());

  window.addEventListener(
    'mousemove',
    (event) => {
      hover.track(event.clientX, event.clientY);
      if (!open) return;
      if (document.documentElement.classList.contains('mouse-asleep')) return;
      if (!hover.awake(event.clientX, event.clientY)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (menu.isOpen()) {
        menu.hover(target);
        return;
      }
      const rowEl = target.closest<HTMLElement>('.setting-row');
      if (rowEl === null) return;
      const index = core.rendered().findIndex((row) => row.el === rowEl);
      const entry = core.rendered()[index];
      if (index === -1 || entry === undefined || !isFocusable(entry.row)) return;
      if (index === core.focusIndex() && !sidebar.hasFocus()) return;
      sidebar.setFocused(false);
      core.setFocusIndex(index);
      core.applyRowFocus();
    },
    { passive: true },
  );

  /**
   * Everything a fresh visit starts from, whichever way the screen was opened. Extracted because
   * `openNew` must repeat ALL of it — a visit that inherited half the previous one's state is the kind of
   * bug that only shows up on the second open.
   */
  function resetScreenState(): void {
    open = true;
    app.dataset['overlay'] = 'game-settings';
    screen.setAttribute('aria-hidden', 'false');
    sidebar.reset(); // a re-opened screen starts at the first section, column and pane together
    sidebar.setFocused(true); // the screen opens on its table of contents, not inside a section
    sidebar.animateIn();
    core.reset();
    // NOT '': an empty string is a real signature (a column with no entries, a strip with no notes),
    // and starting a visit on it made the guards claim the screen already showed that. A game left with
    // "fix the errors first" under it then kept that line for every game opened after — the strip was
    // empty in the model and empty in the guard, so nothing ever rewrote the DOM.
    columnSignature = null;
    statusSignature = null;
    hover.arm();
    lightbox.clearCache();
    listScroller.to(0, true);
    core.setFocusIndex(0);
    model = null;
    core.setRendered([]);
    slots = [];
    slotIndex = -1;
    pendingMove = null;
    baseline = '';
    baselineOtherIssues = new Set();
    baselineOwnIssues = new Set();
    sources = [];
    stopWatchingMoveTargets();
    moveTargets = false;
    pendingSource = null;
    adoptingRoot = null;
    form = emptyFormModel(defaultLaunchMode('card'));
  }

  return {
    isOpen: () => open,
    open: (id: string) => {
      if (open) return;
      mode = 'edit';
      resetScreenState();
      void load(id); // the sound waits for the read to land — an unreadable game never became a screen
    },
    openFromHistory: (id: string) => {
      if (open) return;
      mode = 'edit';
      resetScreenState();
      void loadHistory(id);
    },
    openNew: () => {
      if (open) return;
      mode = 'add';
      deps.audio.play('button'); // add mode has no read to fail: the empty form is there at once
      gameId = '';
      origin = null;
      unreadable = null;
      status = null;
      issues = new Map();
      otherIssues = [];
      ownIssues = false;
      resetScreenState();
      render();
      void loadSources();
    },
    close,
    navUp,
    navDown,
    navLeft,
    navRight,
    navActivate,
    navBack,
    isDirty: dirty,
    deletesLocalGame: () => mediaOrigin()?.source === 'pc',
    askOnlineQuery: (initial, onDone) => onlineFlow.askQuery(initial, onDone),
    askOnlineTitle: (title, onYes) => onlineFlow.askTitle(title, onYes),
    applyOnlineArtwork: (kind, variantKeys, mode) => onlineFlow.applyArtwork(kind, variantKeys, mode),
    applyOnlineTrack: (trackKey) => onlineFlow.applyTrack(trackKey),
    applyOnlineTitle: (title) => {
      setField('title', title);
    },
    onOnlineCandidate: (candidate) => onlineFlow.onCandidate(candidate),
    heroCount: () => form.heroImage.length,
    // The secondary buttons belong to whatever surface is on top, exactly as the six primitives do.
    // controls.ts routes them to the open OVERLAY — that is this screen — so they die here unless they
    // are handed down the stack.
    // The form, the menu and the lightbox claim none of them, and neither does a nested surface that
    // left the method out — one place to say so, the same way controls.ts does it one level up.
    navSecondary: (repeat = false) => {
      const surface = activeSurface();
      if (surface === 'menu') {
        const level = menu.top();
        if (level?.secondary === undefined) {
          if (!repeat) deps.audio.playLimit();
          return;
        }
        if (!repeat) level.secondary(level.focus);
        return;
      }
      if (typeof surface === 'string' || surface.navSecondary === undefined) {
        if (!repeat) deps.audio.playLimit();
        return;
      }
      surface.navSecondary(repeat);
    },
    navTertiary: () => {
      const surface = activeSurface();
      if (typeof surface === 'string' || surface.navTertiary === undefined) {
        deps.audio.playLimit();
        return;
      }
      surface.navTertiary();
    },
    navShoulder: (direction) => {
      const surface = activeSurface();
      if (typeof surface === 'string' || surface.navShoulder === undefined) {
        deps.audio.playLimit();
        return;
      }
      surface.navShoulder(direction);
    },
    navCommit: () => {
      const surface = activeSurface();
      if (typeof surface === 'string' || surface.navCommit === undefined) {
        deps.audio.playLimit();
        return;
      }
      surface.navCommit();
    },
    applyBrowse: (browse) => {
      if (!open) return;
      // Add mode has no game of its own, so every browse push would match `gameId === ''` and close the
      // screen the moment anything at all changed in the carousel.
      if (mode === 'add') return;
      // A history visit is not about a reachable file in the first place — it edits a stored copy — so
      // none of what follows applies to it. A card arriving mid-edit is handled where it matters: the
      // save is refused with a message that says the game is available again. Closing the screen under
      // the user (and discarding what they typed) would be the worse answer.
      if (origin?.kind === 'history') return;
      // The card was pulled, or swapped, or the game stopped being playable: the screen is about a file
      // that is no longer reachable, and everything under it (the carousel, the detail screen) has been
      // rebuilt already. Leaving would be worse than closing, so it closes.
      if (browse !== null && browse.id === gameId && browse.active) return;
      close();
    },
    // Spelled out one kind at a time: a catch-all `else close()` would silently turn any confirm added
    // later into "leave the screen", and nothing in the types would object.
    confirmAccepted: (kind) => {
      if (kind === 'reset') runReset();
      else if (kind === 'delete') void runDelete(false);
      else if (kind === 'delete-history') void runDelete(true);
      else if (kind === 'discard') close();
      else if (kind === 'switch-source') {
        const root = pendingSource;
        pendingSource = null;
        if (root !== null) void adoptRoot(root);
      } else if (kind === 'cancel-move') cancelMove();
      else if (kind === 'replace-title') onlineFlow.titleConfirmed();
    },
    relocalize: () => {
      if (model !== null) {
        const section = sectionByKey(model.sections, core.sectionKey());
        if (section !== undefined) {
          relocalizeGameSections(listEl, { ...model, sections: [section] }, t());
        }
        for (const row of core.rendered()) relocalizeGameRow(row, t());
        // The screen's own name is mode-aware and JS-set, so it is re-read here too — localizeDocument
        // does not touch it (no data-i18n) and would overwrite the mode if it did.
        titleEl.textContent = t()(
          mode === 'add' ? 'gameSettings.addTitle' : 'gameSettings.screenTitle',
        );
        headingEl.textContent = screenHeading(model);
        sourceEl.textContent = `${rowLabelText(model.source, t())} ·`;
        // The column and the status strip ARE labels — rebuilt, not patched.
        renderColumn(model);
        renderStatus(model);
      } else {
        render();
      }
      deps.keyboard.relocalize();
      deps.picker.relocalize();
      deps.onlinePicker.relocalize();
      // A menu's labels are built from the model, so it is rebuilt rather than patched.
      if (menu.isOpen()) menu.paint();
    },
  };
}
