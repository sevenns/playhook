// Backend of the launcher's Customize screen: reading, validating and writing one game's game.json,
// for a card, the PC library and the history. The in-launcher file browser (file-picker-service.ts) and
// the move-to-card transaction (game-move-transaction.ts) are built on top of the root guard and the
// game.json reads/writes this service exposes. Interface-DI (like UpdaterService/StatsService): the
// active-root accessor, the no-restart reload and the id→root lookup all come from GameController.
//
// Two security stances mirror manifest.ts's paranoia about untrusted paths:
//  • the renderer's `root` is NEVER trusted — every read/save re-checks it against a fresh
//    listDriveCandidates() (removable, non-system) PLUS the app's own PC-library root, so a compromised
//    renderer can't write game.json to an arbitrary filesystem location;
//  • Save re-runs the static validation server-side (a race guard against the UI enabling it wrongly),
//    and compares the media SIGNATURE it was read against — a card swapped into the same slot keeps the
//    root valid while the file underneath is somebody else's.
//
// The PC library DELIBERATELY widens the first stance, and it is worth being explicit about: the renderer
// may write `<userData>/pc-games/game.json`, whose `pc.executable` is any binary on the machine, with
// arbitrary `args` and `runAsAdmin`. Before the PC library existed, it could only point at a file that
// physically sat on a removable drive. The feature does not exist without that — picking an arbitrary
// .exe IS the feature — and the widening is bounded: the set of writable ROOTS is still closed (this one
// path plus the removable candidates) and every write still goes through the same server-side validation.
//
// A third stance arrived with the in-launcher file browser, which replaced the native dialog. That dialog
// used to be the CONSENT GATE: an absolute path could only reach this file because the OS handed it over.
// Now the renderer names it, so acceptPickedPaths re-checks what the dialog used to guarantee — the path
// exists, is not a symlink, and its type matches the field.
import path from 'node:path';
import fse from 'fs-extra';
import { ipcMain } from 'electron';
import {
  IPC,
  MANIFEST_FILENAME,
  type ConfigPickResult,
  type ConfigReadResult,
  type ConfigRootReadResult,
  type ConfigSaveResult,
  type ConfigValidationResult,
  type DriveCandidate,
  type GameConfigReadResult,
  type GameConfigSaveRequest,
  type GameCollisionAnswer,
  type HistoryConfigAcceptRequest,
  type HistoryConfigReadResult,
  type HistoryConfigSaveRequest,
  type ManifestValidationIssue,
  type ManifestSource,
  type NotificationInput,
  type ResolvedManifest,
} from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, readImageDataUrl } from './asset-reader';
import { describePickRejection } from './file-picker-service';
import { hostPlatform } from './config-paths';
import { describeManifestContent, listDriveCandidates } from './drive-watcher';
import { addedGamesOf, rootReadResult } from './game-config-add';
import { planAssetCopies, removeGameFromManifestText } from './game-move';
import { type PcLibraryStore } from './pc-library';
import { type LibraryStore } from './library-store';
import { type LibraryEntryRecord } from './library-index';
import {
  extractGameSlot,
  issuesIntroducedBy,
  mergePresentation,
  replaceGameSlot,
  type GameSlot,
} from './history-config';
import {
  movedGridAssetPath,
  movedHeroAssetPath,
  movedMusicAssetPath,
} from '../shared/asset-move-names';
import { isSafeGameId, validateManifestText } from './manifest';
import { writeFileAtomicEnsuringDir } from './json-store';
import { describe } from './util';
import { log } from './logger';

/**
 * Where a staged asset is referenced from in a history game's slot. It is the very path the file will
 * have ON THE CARD once the insertion carries it over, so the slot needs no rewriting on apply — and the
 * AssetReader, resolveInside and the validator all treat it as the ordinary card-relative path it is.
 */
const HISTORY_ASSETS_DIRNAME = 'assets';

/** The editor's verdict on a manifest text as a list of issues ([] when it is happy with it). */
function issuesOfText(text: string, t: Translator): readonly ManifestValidationIssue[] {
  return issuesOfSource(text, t, 'card');
}

/** The same, in a named dialect — the PC library validates by different rules than a card. */
function issuesOfSource(
  text: string,
  t: Translator,
  source: ManifestSource,
): readonly ManifestValidationIssue[] {
  const result = validateManifestText(text, t, source);
  return result.ok ? [] : result.issues;
}

/**
 * Which file inside `library/<id>/` holds the copy of the asset `ref` names, or null when there is none.
 *
 * The mapping runs through the PRISTINE slot and the copies' POSITIONAL names (`hero-<n>`) rather than
 * through `entry.hero`'s order: that array is sparse (an image the copy skipped leaves no element), its
 * extensions change when an oversized image is re-encoded to JPEG, and the edited slot's order need not
 * match the card's at all. `entry.grid` doubles as the copy of the FIRST hero on a card with no cover of
 * its own, which is the one case where two references share a file.
 */
function copiedAssetNameFor(
  pristine: GameSlot,
  entry: LibraryEntryRecord,
  ref: string,
): string | null {
  const gridImage = pristine['gridImage'];
  const heroImage = pristine['heroImage'];
  const heroes = Array.isArray(heroImage) ? heroImage : heroImage === undefined ? [] : [heroImage];
  if (typeof gridImage === 'string' && gridImage === ref) return entry.grid ?? null;
  const index = heroes.indexOf(ref);
  if (index >= 0) {
    const copy = entry.hero.find((name: string) => name.startsWith(`hero-${index}.`));
    if (copy !== undefined) return copy;
    // No cover of its own → the history cropped its card from the first background.
    if (index === 0 && gridImage === undefined) return entry.grid ?? null;
    return null;
  }
  if (pristine['backgroundMusic'] === ref) return entry.music ?? null;
  return null;
}

/**
 * Whether the editor's text is an EMPTY game list — the PC library's way of saying "the last local game
 * was deleted". Only well-formed text reaches this (Save re-validates first), so a parse failure simply
 * means "not the empty list".
 */
function isEmptyManifestList(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

/**
 * How long a candidates() snapshot may be reused. Every call enumerates the machine's drives through the
 * native `drivelist` — "slow on some readers", by this file's own admission — and then reads a game.json
 * per candidate. That was a rare cost while only a window's picker paid it; the Customize screen puts
 * `isAllowedRoot` behind a thumbnail per hero row and a listing per directory step, where it would be
 * paid dozens of times a second. The snapshot is dropped early whenever the ACTIVE CARD changes (which is
 * what a DriveWatcher insert/removal amounts to for this service) and after any save.
 */
const CANDIDATES_TTL_MS = 2000;

export interface GameConfigDeps {
  /** The launcher's currently-active card root (DriveWatcher.getActiveRoot). */
  readonly getActiveRoot: () => string | null;
  /** Applies an edited game.json to the active card without a restart (GameController.reloadManifest). */
  readonly reloadManifest: (root: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * The PC library — a root of its own alongside the card's, so a local game is edited through the same
   * screen a card's game is. See the threat-model note at the top of this file.
   */
  readonly pcLibrary: PcLibraryStore;
  /** Re-reads the PC library after a save (GameController.reloadPcLibrary) — the local reloadManifest. */
  readonly reloadPcLibrary: () => Promise<{ ok: true } | { ok: false; message: string }>;
  /** The current translator (read live so a language change applies to labels/validation/errors). */
  readonly getTranslator: () => Translator;
  /**
   * Where one game's manifest lives, BY ID (GameController.findGameSource) — the bridge from what the
   * carousel shows to the file the Customize screen edits. An index is deliberately not part of the
   * answer: the controller's list is a filtered, reordered union of two sources, so its position says
   * nothing about the slot's position in the text.
   */
  readonly findGameSource: (
    id: string,
  ) => { readonly root: string; readonly source: ManifestSource } | null;
  /**
   * Files a notification (NotificationsService.notify). Used for the one write whose result the user
   * cannot see anywhere else: a game added to a card that is not the active one exists on disk and
   * nowhere in the library. The inbox belongs to main, and so does the decision to post — the renderer
   * asks for a save, not for a notification.
   */
  readonly notify: (input: NotificationInput) => void;
  /**
   * The game HISTORY — where a game with no card in gets its stored manifest, its pending edits and its
   * staged assets (see history-config.ts). The Customize screen reaches it through the `*-history`
   * channels, which is the whole point of the feature: a game the launcher cannot see right now is still
   * configurable, and the card catches up on the next insertion.
   */
  readonly library: LibraryStore;
  /**
   * The RESOLVED manifest of a game as the PC LIBRARY has it, by id — even while an inserted card
   * shadows it (GameController.findPcManifest). `resolveManifest` cannot answer this: it returns
   * whichever copy the launcher currently shows, which for a collision is the card's.
   */
  readonly findPcManifest: (id: string) => ResolvedManifest | null;
  /** True while a card is being read (GameController.loadCard) — save-from-history refuses then, since
   * the game is about to become available and an "applied on the next insertion" edit would sit there. */
  readonly isCardLoading: () => boolean;
  /** Re-pushes the carousel row after an edit changed a history record (GameController.refreshLibrary). */
  readonly refreshLibrary: () => void;
}

export class GameConfigService {
  constructor(private readonly deps: GameConfigDeps) {}

  /** Registers all gameConfig:* invoke handlers once (the service is a singleton). */
  init(): void {
    ipcMain.handle(IPC.gameConfigRead, (_event, id: unknown): Promise<GameConfigReadResult> =>
      this.readGame(typeof id === 'string' ? id : ''),
    );
    ipcMain.handle(
      IPC.gameConfigValidate,
      (
        _event,
        payload: {
          readonly root: string;
          readonly text: string;
          readonly source?: ManifestSource;
        },
      ): ConfigValidationResult =>
        validateManifestText(
          payload.text,
          this.deps.getTranslator(),
          payload.source ?? this.sourceOf(payload.root),
        ),
    );
    ipcMain.handle(
      IPC.gameConfigSave,
      (_event, payload: GameConfigSaveRequest): Promise<ConfigSaveResult> =>
        this.saveChecked(payload),
    );
    ipcMain.handle(IPC.gameConfigSources, (): Promise<readonly DriveCandidate[]> =>
      this.candidates(),
    );
    ipcMain.handle(IPC.gameConfigReadRoot, (_event, root: unknown): Promise<ConfigRootReadResult> =>
      this.readRoot(typeof root === 'string' ? root : ''),
    );
    // Every history channel addresses a game by id ALONE, and that id becomes a directory name under the
    // history (LibraryStore.gameDir). The manifest schema validates the ids that come off a card; these
    // come off the renderer, whose root this file's header says is never trusted — so they are held to
    // the same rule here, before anything reaches `path.join`.
    ipcMain.handle(
      IPC.gameConfigReadHistory,
      (_event, id: unknown): Promise<HistoryConfigReadResult> =>
        this.readHistoryGame(isSafeGameId(id) ? id : ''),
    );
    ipcMain.handle(
      IPC.gameConfigSaveHistory,
      (_event, payload: HistoryConfigSaveRequest): Promise<ConfigSaveResult> =>
        isSafeGameId(payload.id)
          ? this.saveHistoryGame(payload)
          : Promise.resolve({ saved: false, message: this.deps.getTranslator()('errors.configInvalid') }),
    );
    ipcMain.handle(
      IPC.gameConfigAcceptPathHistory,
      (_event, payload: HistoryConfigAcceptRequest): Promise<ConfigPickResult> =>
        isSafeGameId(payload.id)
          ? this.acceptHistoryPaths(payload)
          : Promise.resolve({ ok: false, message: this.deps.getTranslator()('errors.configInvalid') }),
    );
    ipcMain.handle(
      IPC.gameConfigHistoryAssetPreview,
      (_event, payload: { readonly id: string; readonly ref: string }): Promise<string | null> =>
        isSafeGameId(payload.id)
          ? this.historyAssetPreview(payload.id, payload.ref)
          : Promise.resolve(null),
    );
  }

  // ── The same screen, for a game whose card is not in ───────────────────────

  /**
   * The stored manifest of a history game. Answers with the user's pending edits when there are any and
   * the pristine card snapshot otherwise — without that fallback the very first Customize from the
   * history would open onto nothing.
   *
   * A game that IS available is refused: it must be configured through the ordinary path, which writes
   * the card directly instead of queueing an edit for it.
   */
  async readHistoryGame(id: string): Promise<HistoryConfigReadResult> {
    const t = this.deps.getTranslator();
    if (this.deps.findGameSource(id) !== null) {
      return { ok: false, message: t('gameConfig.gameNowAvailable') };
    }
    const text = await this.deps.library.storedManifestText(id);
    if (text === null) return { ok: false, message: t('gameConfig.noStoredConfig') };
    return { ok: true, id, text, platform: hostPlatform() };
  }

  /**
   * Stores edits for a history game. They are NOT written to any card here — the card is not in; the next
   * insertion of it reconciles them (see history-sync.ts).
   *
   * The validation is relative to the card's own snapshot: the editor's gates are stricter than what the
   * launcher needs to run a game, so a hand-written legacy card can be perfectly playable and still fail
   * them. Judging the edit by the raw verdict would lock such a card out of the feature over a problem
   * the user neither made nor can fix from a form whose fields are disabled here.
   */
  async saveHistoryGame(request: HistoryConfigSaveRequest): Promise<ConfigSaveResult> {
    const t = this.deps.getTranslator();
    const { id, text } = request;
    if (this.deps.findGameSource(id) !== null || this.deps.isCardLoading()) {
      return { saved: false, message: t('gameConfig.gameNowAvailable') };
    }
    const baseline = await this.deps.library.readCardSlot(id);
    if (baseline === null) return { saved: false, message: t('gameConfig.noStoredConfig') };
    const introduced = issuesIntroducedBy(
      issuesOfText(text, t),
      issuesOfText(JSON.stringify(baseline), t),
    );
    const first = introduced[0];
    if (first !== undefined) {
      return { saved: false, message: `${first.path}: ${first.message}` };
    }
    const slot = extractGameSlot(text, id);
    if (!slot.ok) return { saved: false, message: t('errors.configInvalid') };
    const title = slot.slot['title'];
    // The SLOT is stored, not the text it was extracted from. What is kept here is one game's edits, and
    // `readEditedSlot` refuses anything that is not a bare object — so a text that arrived as an array
    // would be written, read back as null, and dropped by the apply step as "flagged but has no edits".
    await this.deps.library.saveEdits(
      id,
      `${JSON.stringify(slot.slot, null, 2)}\n`,
      typeof title === 'string' ? title : id,
    );
    this.deps.refreshLibrary();
    // "deferred" in the same sense a write to a non-active card is: the file is stored, and the launcher
    // has nothing to apply it to until that card comes back.
    return { saved: true, applied: 'deferred' };
  }

  /**
   * Stages art/music picked for a history game and answers with the card-relative paths its slot must
   * name. The originals are copied into the history because the card they are meant for is not here: the
   * file a slot points at has to exist somewhere until the insertion can carry it over.
   */
  async acceptHistoryPaths(
    request: HistoryConfigAcceptRequest,
  ): Promise<ConfigPickResult> {
    const t = this.deps.getTranslator();
    const { id, kind, paths } = request;
    if (this.deps.findGameSource(id) !== null) {
      return { ok: false, message: t('gameConfig.gameNowAvailable') };
    }
    if (kind !== 'image' && kind !== 'audio') {
      // Everything else names a file ON the card, and there is no card to measure it against.
      return { ok: false, message: t('gameConfig.pickOutsideCard') };
    }
    if (paths.length === 0) return { ok: false, cancelled: true };
    for (const absolute of paths) {
      const rejection = await describePickRejection(absolute, kind, t);
      if (rejection !== null) return { ok: false, message: rejection };
    }
    const extensions = kind === 'image' ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
    const relatives: string[] = [];
    for (const absolute of paths) {
      try {
        const name = await this.deps.library.importStagedAsset(id, absolute, kind, extensions);
        relatives.push(`${HISTORY_ASSETS_DIRNAME}/${name}`);
      } catch (cause) {
        log.warn('[game-config] staging an asset for a history game failed:', describe(cause));
        return { ok: false, message: t('gameConfig.pickImportFailed') };
      }
    }
    return { ok: true, paths: relatives };
  }

  /**
   * A thumbnail for one asset path of a history game. Two sources, because the game's files live in two
   * places while its card is away: what the user has just picked sits in `staged/`, and everything else
   * is only present as the low-resolution copy the history keeps.
   *
   * The copy is found through the PRISTINE snapshot, never through the edited slot: the copies are named
   * by POSITION as the card listed them (`hero-<n>`), and an edit that reorders or replaces a background
   * would otherwise hand the row another image's thumbnail. A missing copy (music over the cap, a webp
   * the re-encoder could not read) is a normal answer of null — the row stays editable.
   */
  async historyAssetPreview(id: string, ref: string): Promise<string | null> {
    const staged = this.stagedNameOf(ref);
    if (staged !== null) {
      const stagedPath = this.deps.library.stagedFilePath(id, staged);
      if (await fse.pathExists(stagedPath)) {
        return (await readImageDataUrl(stagedPath)) ?? null;
      }
    }
    const entry = this.deps.library.entry(id);
    if (entry === null) return null;
    const pristine = await this.deps.library.readCardSlot(id);
    if (pristine === null) return null;
    const copy = copiedAssetNameFor(pristine, entry, ref);
    if (copy === null) return null;
    return (await readImageDataUrl(this.deps.library.copiedAssetPath(id, copy))) ?? null;
  }

  /**
   * The staged file name an `assets/<name>`-shaped reference points at, or null for anything else. The
   * prefix is HISTORY_ASSETS_DIRNAME — `assets/`, the same convention a card uses — because that is what
   * the path will mean once the edits reach the card; the file only lives under `staged/` until then.
   */
  private stagedNameOf(ref: string): string | null {
    const prefix = `${HISTORY_ASSETS_DIRNAME}/`;
    if (!ref.startsWith(prefix)) return null;
    const name = ref.slice(prefix.length);
    return name.length > 0 && !name.includes('/') ? name : null;
  }

  // ── Drive + PC-library candidates ──────────────────────────────────────────

  /**
   * Everything the picker may edit: the removable candidates, plus the PC library as one more entry.
   * It is always listed and always "active" — it is this machine, it cannot be unplugged — and its
   * `hasManifest: false` (no local game yet) lands the renderer in the SAME blank-drive branch a fresh
   * card takes, so adding the first local game needs no new UI state at all.
   */
  private candidatesCache: {
    readonly at: number;
    readonly activeRoot: string | null;
    readonly value: readonly DriveCandidate[];
  } | null = null;

  private async candidates(): Promise<readonly DriveCandidate[]> {
    const activeRoot = this.deps.getActiveRoot();
    const cached = this.candidatesCache;
    if (
      cached !== null &&
      cached.activeRoot === activeRoot &&
      Date.now() - cached.at < CANDIDATES_TTL_MS
    ) {
      return cached.value;
    }
    const value = await this.readCandidates();
    this.candidatesCache = { at: Date.now(), activeRoot, value };
    return value;
  }

  /** Drops the snapshot: our own write changed a manifest the labels/signatures are derived from. */
  invalidateCandidates(): void {
    this.candidatesCache = null;
  }

  private async readCandidates(): Promise<readonly DriveCandidate[]> {
    const t = this.deps.getTranslator();
    const drives = await listDriveCandidates(this.deps.getActiveRoot(), t);
    const root = this.deps.pcLibrary.root;
    const hasManifest = await this.deps.pcLibrary.hasManifest();
    // Described exactly like a card ("— Hades" / "— 3 games" / "— invalid game.json"), only prefixed with
    // the library's name instead of a mountpoint: the count is as useful here as it is there. The
    // signature comes from the same read, so an edit made elsewhere reloads the picker like a card swap.
    const { suffix, signature } = await describeManifestContent(
      path.join(root, MANIFEST_FILENAME),
      hasManifest,
      t,
      t('drive.noGames'),
    );
    const pc: DriveCandidate = {
      root,
      kind: 'pc',
      label: `${t('gameConfig.thisPc')} — ${suffix}`,
      signature,
      hasManifest,
      isActive: true,
    };
    return [...drives, pc];
  }

  /** Which manifest dialect `root` speaks — the PC library's, or a card's (see ManifestSource). */
  sourceOf(root: string): ManifestSource {
    return root === this.deps.pcLibrary.root ? 'pc' : 'card';
  }

  // ── Per-game access for the launcher's Customize screen ────────────────────

  /**
   * The manifest a game lives in, addressed by id. Returns the WHOLE file's text: a card may carry
   * several games, and the screen edits its own slot in place so the neighbours survive verbatim — the
   * ones that failed to resolve included, which are exactly the ones a naive rewrite would destroy.
   */
  private async readGame(id: string): Promise<GameConfigReadResult> {
    const t = this.deps.getTranslator();
    const found = this.deps.findGameSource(id);
    if (found === null) return { ok: false, message: t('errors.gameNotFound') };
    const read = await this.readConfig(found.root);
    if (!read.ok) return read;
    return {
      ok: true,
      root: found.root,
      source: found.source,
      signature: await this.signatureOf(found.root),
      text: read.text,
      platform: hostPlatform(),
    };
  }

  /**
   * The manifest of one ROOT rather than of one game — what the Add-game screen reads once the user has
   * chosen where the new game goes. `readGame` cannot answer this: it starts from an id, and the whole
   * point here is that the root may not carry a single game yet. A missing game.json is a normal answer
   * (`hasManifest: false`), not an error — only a file that exists and cannot be read is one.
   */
  private async readRoot(root: string): Promise<ConfigRootReadResult> {
    const t = this.deps.getTranslator();
    if (!(await this.isAllowedRoot(root))) {
      return { ok: false, message: t('errors.driveUnavailable') };
    }
    const base = {
      root,
      source: this.sourceOf(root),
      signature: await this.signatureOf(root),
      platform: hostPlatform(),
    };
    const manifestPath = path.join(root, MANIFEST_FILENAME);
    if (!(await fse.pathExists(manifestPath))) return rootReadResult(base, null);
    try {
      return rootReadResult(base, await fse.readFile(manifestPath, 'utf8'));
    } catch (cause) {
      return {
        ok: false,
        message: t('errors.cannotReadManifest', {
          file: MANIFEST_FILENAME,
          cause: describe(cause),
        }),
      };
    }
  }

  /**
   * The media's identity — the same sorted-ids signature a DriveCandidate carries. It answers the one
   * question `isAllowedRoot` cannot: a card swapped into the same mountpoint keeps the root valid while
   * the FILE underneath is someone else's. Our own edits do not move it (the ids
   * stay), so a second save after the first still goes through.
   */
  async signatureOf(root: string): Promise<string> {
    const manifestPath = path.join(root, MANIFEST_FILENAME);
    const { signature } = await describeManifestContent(
      manifestPath,
      await fse.pathExists(manifestPath),
      this.deps.getTranslator(),
      '',
    );
    return signature;
  }

  /** The card's content signature right now, or null when the media is gone (see CollisionResolver). */
  async signatureFor(root: string): Promise<string | null> {
    if (!(await this.isAllowedRoot(root))) return null;
    try {
      return await this.signatureOf(root);
    } catch (cause) {
      log.warn(`[game-config] cannot read the signature of "${root}":`, describe(cause));
      return null;
    }
  }

  /** Save with the swap guard in front of it — everything else is the shared save() path. */
  private async saveChecked(request: GameConfigSaveRequest): Promise<ConfigSaveResult> {
    const t = this.deps.getTranslator();
    if (!(await this.isAllowedRoot(request.root))) {
      return { saved: false, message: t('errors.driveUnavailable') };
    }
    if ((await this.signatureOf(request.root)) !== request.signature) {
      return { saved: false, message: t('errors.mediaChanged') };
    }
    // The signature just checked IS the "before" picture of the file — sorted ids — so what a write adds
    // can be told from it without reading the manifest a second time.
    const result = await this.save(request.root, request.text, request.signature);
    this.invalidateCandidates();
    return result;
  }

  // ── Reading / saving game.json ─────────────────────────────────────────────

  async readConfig(root: string): Promise<ConfigReadResult> {
    const t = this.deps.getTranslator();
    if (!(await this.isAllowedRoot(root))) {
      return { ok: false, message: t('errors.driveUnavailable') };
    }
    try {
      const text = await fse.readFile(path.join(root, MANIFEST_FILENAME), 'utf8');
      return { ok: true, text };
    } catch (cause) {
      return {
        ok: false,
        message: t('errors.cannotReadManifest', {
          file: MANIFEST_FILENAME,
          cause: describe(cause),
        }),
      };
    }
  }

  private async save(
    root: string,
    text: string,
    signatureBefore: string,
    options?: {
      /**
       * The file as it stood BEFORE this write. When given, only the problems the write INTRODUCES are
       * refused — the ones the text already had are not this write's to fix, and a card that fails the
       * editor's stricter gates on its own would otherwise be frozen forever (see issuesIntroducedBy).
       * Internal: no renderer-facing save passes it, they are all judged whole.
       */
      readonly baselineText: string;
    },
  ): Promise<ConfigSaveResult> {
    const t = this.deps.getTranslator();
    // 1. main never trusts the renderer's path — it must be a live removable candidate (or the PC library).
    if (!(await this.isAllowedRoot(root))) {
      return { saved: false, message: t('errors.driveUnavailable') };
    }
    const source = this.sourceOf(root);
    // 2. re-validate server-side (guards against a UI race that enabled Save with a stale verdict).
    const validation = validateManifestText(text, t, source);
    if (!validation.ok) {
      const baseline =
        options === undefined ? [] : issuesOfSource(options.baselineText, t, source);
      const first = issuesIntroducedBy(validation.issues, baseline)[0];
      if (first !== undefined) {
        return { saved: false, message: `${first.path}: ${first.message}` };
      }
    }
    if (source === 'pc') return this.savePcLibrary(text, t);
    // 3. atomic write — reuse the card-hardened writer (temp→move, EBUSY/EPERM retry, drive-root nuance).
    // Write the user's text verbatim so their formatting is preserved (no reserialize).
    try {
      await writeFileAtomicEnsuringDir(path.join(root, MANIFEST_FILENAME), text);
    } catch (cause) {
      return {
        saved: false,
        message: t('errors.cannotWriteManifest', {
          file: MANIFEST_FILENAME,
          cause: describe(cause),
        }),
      };
    }
    // 4. apply. Active card → reload in place; any other (blank/second) card → DriveWatcher handles it
    // (≤1s if no active card; otherwise scan() stabilization keeps the active one and this loads on removal).
    if (root === this.deps.getActiveRoot()) {
      const applied = await this.deps.reloadManifest(root);
      return applied.ok
        ? { saved: true, applied: 'applied' }
        : { saved: true, applied: 'failed', message: applied.message };
    }
    // A deferred write is the one outcome with nothing to show for it: the file is on the card, the card
    // is not the active one, and the library will not mention the game until it becomes active. Say so,
    // from here — the notification follows the WRITE, whoever asked for it and for whatever reason.
    for (const added of addedGamesOf(signatureBefore, text)) {
      this.deps.notify({ kind: 'game-added-deferred', gameTitle: added.title });
    }
    return { saved: true, applied: 'deferred' };
  }

  /**
   * Saves the PC library's game.json and re-reads it into the running launcher. Unlike a card there is no
   * "deferred" outcome: the library is always the app's own directory, so an edit either applies now or
   * reports why it could not.
   *
   * An EMPTY list is not written as a file — it removes game.json entirely. That is how deleting the last
   * local game is spelled (the renderer sends `[]`), and it keeps the "no manifest ⇒ blank form" state the
   * picker relies on from being shadowed by a technically-present but empty file.
   */
  private async savePcLibrary(text: string, t: Translator): Promise<ConfigSaveResult> {
    const emptied = isEmptyManifestList(text);
    try {
      if (emptied) await this.deps.pcLibrary.removeManifest();
      else
        await writeFileAtomicEnsuringDir(
          path.join(this.deps.pcLibrary.root, MANIFEST_FILENAME),
          text,
        );
    } catch (cause) {
      return {
        saved: false,
        message: t('errors.cannotWriteManifest', {
          file: MANIFEST_FILENAME,
          cause: describe(cause),
        }),
      };
    }
    const applied = await this.deps.reloadPcLibrary();
    return applied.ok
      ? { saved: true, applied: 'applied' }
      : { saved: true, applied: 'failed', message: applied.message };
  }

  // ── One game, two places: the card and this PC ────────────────────────────
  //
  // An inserted card SHADOWS a local game of the same id (see GameController), so a draft the user
  // dressed up on this PC appears to lose its name and artwork every time that card goes in — and get
  // them back every time it comes out. The launcher asks once what should happen; this is the "put my
  // version on the card" answer.
  //
  // Only the PRESENTATION travels. The card already has a launch that works there, and a local game's
  // manifest speaks a dialect (absolute executables, no `saveOnCard`) that would make the card
  // unreadable if it were copied over wholesale.

  /**
   * Merges a local game's name and artwork into the card's slot for the same id, then writes the card
   * through the ordinary save path (validate → atomic write → reload). Answers exactly as a save does.
   *
   * Two things are deliberately NOT here: the guard against the card having been pulled or swapped
   * (the caller captured its signature when it asked the question — checked below), and removing the
   * local draft afterwards, which follows the WRITE and belongs to the caller's own bookkeeping.
   */
  async mergeCollision(answer: GameCollisionAnswer): Promise<ConfigSaveResult> {
    const t = this.deps.getTranslator();
    const { id, root } = answer;
    if (!(await this.isAllowedRoot(root))) {
      return { saved: false, message: t('errors.driveUnavailable') };
    }
    if ((await this.signatureOf(root)) !== answer.signature) {
      return { saved: false, message: t('errors.mediaChanged') };
    }
    const local = this.deps.findPcManifest(id);
    if (local === null) return { saved: false, message: t('errors.configInvalid') };
    const read = await this.readConfig(root);
    if (!read.ok) return { saved: false, message: read.message };
    const slot = extractGameSlot(read.text, id);
    if (!slot.ok) return { saved: false, message: t('errors.configInvalid') };

    // The names are derived from the id, so the only file a copy can overwrite is an earlier copy of
    // THIS game's own artwork — the same guarantee moveToCard relies on.
    const copies = planAssetCopies(local, id, root);
    try {
      for (const copy of copies) {
        await fse.ensureDir(path.dirname(copy.to));
        await fse.copy(copy.from, copy.to, { overwrite: true, dereference: true });
      }
    } catch (cause) {
      log.warn(`[collision] copying the local artwork of id=${id} onto the card failed:`, describe(cause));
      return { saved: false, message: t('gameConfig.pickImportFailed') };
    }

    const merged = mergePresentation(slot.slot, {
      title: local.raw.title,
      ...(local.gridImagePath !== undefined
        ? { gridImage: movedGridAssetPath(id, local.gridImagePath) }
        : {}),
      ...(local.heroImagePaths !== undefined && local.heroImagePaths.length > 0
        ? {
            heroImage: local.heroImagePaths.map((source: string, index: number) =>
              movedHeroAssetPath(id, index, source),
            ),
          }
        : {}),
      ...(local.backgroundMusicPath !== undefined
        ? { backgroundMusic: movedMusicAssetPath(id, local.backgroundMusicPath) }
        : {}),
    });
    const replaced = replaceGameSlot(read.text, id, merged);
    if (!replaced.ok) return { saved: false, message: t('errors.configInvalid') };
    // Judged against the card's own text: a card written by hand years ago can fail the editor's
    // stricter gates all by itself, and refusing the merge over a problem it did not introduce would
    // lock such a card out of the answer entirely (the same rule save-from-history follows).
    return this.save(root, replaced.text, answer.signature, { baselineText: read.text });
  }

  /** Drops a local game from the PC library — the draft whose look has just moved onto the card. */
  async removeLocalGame(id: string): Promise<ConfigSaveResult> {
    const t = this.deps.getTranslator();
    const root = this.deps.pcLibrary.root;
    const read = await this.readConfig(root);
    if (!read.ok) return { saved: false, message: read.message };
    const without = removeGameFromManifestText(id, read.text);
    if (without === null) return { saved: false, message: t('errors.configInvalid') };
    return this.savePcLibrary(without, t);
  }

  /** Writes (or removes, if empty) the PC library's game.json and reloads it — the shared half of
   * savePcLibrary that moveToCard also needs, without savePcLibrary's ConfigSaveResult shape. */
  async writePcLibraryText(
    text: string,
    t: Translator,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    const emptied = isEmptyManifestList(text);
    try {
      if (emptied) await this.deps.pcLibrary.removeManifest();
      else
        await writeFileAtomicEnsuringDir(
          path.join(this.deps.pcLibrary.root, MANIFEST_FILENAME),
          text,
        );
    } catch (cause) {
      return {
        ok: false,
        message: t('errors.cannotWriteManifest', {
          file: MANIFEST_FILENAME,
          cause: describe(cause),
        }),
      };
    }
    const reload = await this.deps.reloadPcLibrary();
    if (!reload.ok) {
      log.warn(`[game-move] library write applied, but the reload failed: ${reload.message}`);
    }
    return { ok: true };
  }

  /**
   * The public face of `isAllowedRoot` — true when `root` is a current removable/non-system mountpoint,
   * or the app's own PC-library root (the closed set of roots this service will ever write to) — for the
   * one other service that writes into a game's root:
   * MetadataService puts a downloaded cover or track there, and it must answer the same question this
   * service asks before every write rather than a second, slightly different one.
   */
  isWritableRoot(root: string): Promise<boolean> {
    return this.isAllowedRoot(root);
  }

  private async isAllowedRoot(root: string): Promise<boolean> {
    const candidates = await this.candidates();
    return candidates.some((candidate) => candidate.root === root);
  }
}
