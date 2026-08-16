// Backend of the launcher's Customize screen: reading, validating and writing one game's game.json,
// listing directories for the in-launcher file browser, and turning a picked path into what the manifest
// field stores. Interface-DI (like UpdaterService/StatsService): the active-root accessor, the no-restart
// reload and the id→root lookup all come from GameController.
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
// exists, is not a symlink, and its type matches the field (see the plan, Р5.1).
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import fse from 'fs-extra';
import { app, ipcMain } from 'electron';
import {
  IPC,
  MANIFEST_FILENAME,
  type ConfigPickKind,
  type ConfigPickResult,
  type ConfigReadResult,
  type ConfigRootReadResult,
  type ConfigSaveResult,
  type ConfigValidationResult,
  type DirEntry,
  type DirRoot,
  type DriveCandidate,
  type GameConfigAcceptRequest,
  type GameConfigListDirRequest,
  type GameConfigReadResult,
  type GameConfigSaveRequest,
  type ListDirResult,
  type ManifestSource,
  type NotificationInput,
} from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, readImageDataUrl } from './asset-reader';
import {
  acceptsExtensions,
  checkPickedType,
  startDirFor,
  toCardRelative,
  type PickRejection,
} from './config-paths';
import { describeManifestContent, listAllMountpoints, listDriveCandidates } from './drive-watcher';
import { addedGamesOf, rootReadResult } from './game-config-add';
import { type PcLibraryStore } from './pc-library';
import { resolveInside, validateManifestText } from './manifest';
import { writeFileAtomic } from './save-sync';
import { describe } from './util';
import { log } from './logger';

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

/** The extensions a field accepts, with the two asset lists filled in from the AssetReader. */
function extensionsFor(kind: ConfigPickKind): readonly string[] | null {
  if (kind === 'image') return IMAGE_EXTENSIONS;
  if (kind === 'audio') return AUDIO_EXTENSIONS;
  return acceptsExtensions(kind);
}

/** The localized wording of a refusal from checkPickedType. */
function rejectionMessage(rejection: PickRejection, t: Translator): string {
  switch (rejection) {
    case 'missing':
      return t('gameConfig.pickMissing');
    case 'symlink':
      return t('gameConfig.pickSymlink');
    case 'needs-folder':
      return t('gameConfig.pickNeedsFolder');
    case 'needs-file':
      return t('gameConfig.pickNeedsFile');
    case 'wrong-type':
      return t('gameConfig.pickWrongType');
  }
}

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
   * Reverse-maps an absolute PC folder (from the pcSavePath browse) to a `%PREFIX%/…` manifest
   * string via the platform SavePathResolver (Р5), or null when it lives under none of the allowed bases.
   * win32 uses the env-based table; linux returns null (the user types the Windows-dictionary string).
   */
  readonly toManifestPcSavePath: (absolute: string) => string | null;
  /**
   * Where one game's manifest lives, BY ID (GameController.findGameSource) — the bridge from what the
   * carousel shows to the file the Customize screen edits. An index is deliberately not part of the
   * answer: the controller's list is a filtered, reordered union of two sources, so its position says
   * nothing about the slot's position in the text (see the plan, Р2).
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
      (_event, payload: { readonly root: string; readonly text: string }): ConfigValidationResult =>
        validateManifestText(payload.text, this.deps.getTranslator(), this.sourceOf(payload.root)),
    );
    ipcMain.handle(
      IPC.gameConfigSave,
      (_event, payload: GameConfigSaveRequest): Promise<ConfigSaveResult> =>
        this.saveChecked(payload),
    );
    ipcMain.handle(
      IPC.gameConfigImagePreview,
      (_event, payload: { readonly root: string; readonly path: string }): Promise<string | null> =>
        this.imagePreview(payload.root, payload.path),
    );
    ipcMain.handle(
      IPC.gameConfigAcceptPath,
      (_event, payload: GameConfigAcceptRequest): Promise<ConfigPickResult> =>
        this.acceptPickedPaths(payload.root, payload.kind, payload.paths, payload.base),
    );
    ipcMain.handle(
      IPC.gameConfigListDir,
      (_event, payload: GameConfigListDirRequest): Promise<ListDirResult> => this.listDir(payload),
    );
    ipcMain.handle(IPC.gameConfigSources, (): Promise<readonly DriveCandidate[]> =>
      this.candidates(),
    );
    ipcMain.handle(IPC.gameConfigReadRoot, (_event, root: unknown): Promise<ConfigRootReadResult> =>
      this.readRoot(typeof root === 'string' ? root : ''),
    );
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
  private invalidateCandidates(): void {
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
  private sourceOf(root: string): ManifestSource {
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
      windows: process.platform === 'win32',
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
      windows: process.platform === 'win32',
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
   * the FILE underneath is someone else's (see the plan, Р6.2). Our own edits do not move it (the ids
   * stay), so a second save after the first still goes through.
   */
  private async signatureOf(root: string): Promise<string> {
    const manifestPath = path.join(root, MANIFEST_FILENAME);
    const { signature } = await describeManifestContent(
      manifestPath,
      await fse.pathExists(manifestPath),
      this.deps.getTranslator(),
      '',
    );
    return signature;
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

  private async readConfig(root: string): Promise<ConfigReadResult> {
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
      const first = validation.issues[0];
      return {
        saved: false,
        message:
          first !== undefined ? `${first.path}: ${first.message}` : t('errors.configInvalid'),
      };
    }
    if (source === 'pc') return this.savePcLibrary(text, t);
    // 3. atomic write — reuse the card-hardened writer (temp→move, EBUSY/EPERM retry, drive-root nuance).
    // Write the user's text verbatim so their formatting is preserved (no reserialize).
    try {
      await writeFileAtomic(path.join(root, MANIFEST_FILENAME), text);
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
      else await writeFileAtomic(path.join(this.deps.pcLibrary.root, MANIFEST_FILENAME), text);
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

  /**
   * Turns absolute path(s) into what the manifest field actually stores: card-RELATIVE with forward
   * slashes, a `%PREFIX%/…` save path, a verbatim absolute, or a library-relative asset that was copied
   * in. Shared by the native dialog and the in-launcher picker.
   *
   * The dialog used to be the consent gate for all of this: an absolute path could only arrive because
   * the OS handed it over, which is why this file could say "main never trusts the renderer's path" and
   * still copy whatever it was given. The in-launcher picker takes that gate away, so the checks are
   * stated here instead (see the plan, Р5.1) — the root must be a live candidate, the path must exist and
   * not be a symlink, and its TYPE must match the field: an `~/.ssh/id_rsa` offered as a hero image is
   * refused before anything reads or copies it.
   */
  private async acceptPickedPaths(
    root: string,
    kind: ConfigPickKind,
    absolutePaths: readonly string[],
    base?: string,
  ): Promise<ConfigPickResult> {
    const t = this.deps.getTranslator();
    if (!(await this.isAllowedRoot(root))) {
      return { ok: false, message: t('errors.driveUnavailable') };
    }
    // A field measured from a sub-directory (see GameConfigAcceptRequest.base) still lives inside the
    // root, and `resolveInside` is what proves it: the renderer names the sub-path, so it gets the same
    // anti-traversal treatment every other manifest path does.
    const measureFrom = base === undefined || base === '' ? root : resolveInside(root, base);
    if (measureFrom === null) return { ok: false, message: t('gameConfig.pickOutsideCard') };
    if (absolutePaths.length === 0) return { ok: false, cancelled: true };
    const isPcLibrary = this.sourceOf(root) === 'pc';
    // A local game's own executable and its host-side save folder only exist in the PC library.
    if ((kind === 'pc-executable' || kind === 'pc-save-local') && !isPcLibrary) {
      return { ok: false, message: t('errors.driveUnavailable') };
    }
    for (const absolute of absolutePaths) {
      const rejection = await this.checkPickedType(absolute, kind);
      if (rejection !== null) return { ok: false, message: rejection };
    }

    // pcSavePath points at a PC folder OUTSIDE the card (env-prefixed), so the absolute result is
    // converted back to a %PREFIX%/… form the validator accepts. A local game running from this machine's
    // own disk keeps the absolute path VERBATIM (`pc-save-local`). Converting it would be actively wrong
    // there: on Linux the reverse mapping only knows folders inside a Wine prefix and rejects everything
    // else, so the typical local save folder (`~/Games/Hades/Saves`) could not be picked at all — and pc
    // mode accepts an absolute path precisely because a %PREFIX% cannot express it. It is the form that
    // decides which of the two kinds applies, by launch mode: a local STEAM game keeps `pc-save`, because
    // ITS saves sit inside Steam's Proton prefix and only the %PREFIX% form maps onto compatdata (an
    // absolute path there would also be read with containerExists: true, which would let a deleted prefix
    // be mistaken for deleted saves).
    const first = absolutePaths[0];
    if (first === undefined) return { ok: false, cancelled: true };
    if (kind === 'pc-save-local' || kind === 'pc-executable') return { ok: true, paths: [first] };
    if (kind === 'pc-save') {
      const pcSavePath = this.deps.toManifestPcSavePath(first);
      if (pcSavePath === null) return { ok: false, message: t('gameConfig.pickPcSaveOutside') };
      return { ok: true, paths: [pcSavePath] };
    }
    // Art and music for a local game are picked from anywhere and COPIED into the library, so what the
    // manifest stores is a library-relative path — the same shape a card's asset has, which is what keeps
    // resolveInside and the AssetReader free of any PC-specific branch (and the art alive after the user
    // deletes the original).
    if (isPcLibrary && (kind === 'image' || kind === 'audio')) {
      const extensions = kind === 'image' ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
      const relatives: string[] = [];
      for (const absolute of absolutePaths) {
        try {
          relatives.push(await this.deps.pcLibrary.importAsset(absolute, kind, extensions));
        } catch (cause) {
          log.warn('[game-config] importing a local asset failed:', describe(cause));
          return { ok: false, message: t('gameConfig.pickImportFailed') };
        }
      }
      return { ok: true, paths: relatives };
    }

    const relatives: string[] = [];
    for (const absolute of absolutePaths) {
      const relative = toCardRelative(measureFrom, absolute);
      if (relative === null) {
        return {
          ok: false,
          message: t(
            kind === 'directory' ? 'gameConfig.pickChooseSubfolder' : 'gameConfig.pickOutsideCard',
          ),
        };
      }
      relatives.push(relative);
    }
    return { ok: true, paths: relatives };
  }

  /** Whether one picked path may be used for `kind`; a localized reason when it may not, else null. */
  private async checkPickedType(absolute: string, kind: ConfigPickKind): Promise<string | null> {
    const t = this.deps.getTranslator();
    let stat: Parameters<typeof checkPickedType>[2] = null;
    try {
      const stats = await fs.lstat(absolute);
      stat = {
        isSymbolicLink: stats.isSymbolicLink(),
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
      };
    } catch {
      stat = null;
    }
    const rejection = checkPickedType(absolute, kind, stat, extensionsFor(kind));
    return rejection === null ? null : rejectionMessage(rejection, t);
  }

  // ── Directory listing for the in-launcher file picker ──────────────────────

  /**
   * One directory's contents, plus the starting points offered beside it. READ-ONLY and deliberately
   * unrestricted: where to browse is the user's business (the most common install path of all,
   * `C:\Program Files (x86)\Steam\steamapps\common\…`, is a system directory by any definition). What is
   * guarded is the ACCEPTANCE of a path, not the looking — see acceptPickedPaths.
   */
  private async listDir(request: GameConfigListDirRequest): Promise<ListDirResult> {
    const t = this.deps.getTranslator();
    const roots = await this.pickerRoots();
    // A field measured from a sub-directory browses from there; an unresolvable one falls back to the
    // root rather than failing — this is where the picker OPENS, not what it will accept.
    const baseDir =
      request.root !== undefined && request.base !== undefined && request.base !== ''
        ? resolveInside(request.root, request.base)
        : null;
    const target =
      request.path ??
      startDirFor(
        { ...request, ...(baseDir !== null ? { baseDir } : {}) },
        {
          homeDir: os.homedir(),
          appDataDir: app.getPath('appData'),
          downloadsDir: app.getPath('downloads'),
          rootIsCard: request.root !== undefined && this.sourceOf(request.root) === 'card',
        },
      );
    let names: readonly string[];
    try {
      names = await fs.readdir(target);
    } catch (cause) {
      log.warn(`[game-config] cannot list "${target}":`, describe(cause));
      return { ok: false, message: t('gameConfig.listFailed'), roots };
    }
    const entries: DirEntry[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue; // dotfiles are noise in a picker for games and artwork
      try {
        // stat, not lstat: a symlinked folder is a folder to browse. Accepting what is INSIDE it is a
        // separate decision, made by acceptPickedPaths, which refuses symlinks on its own.
        const stats = await fs.stat(path.join(target, name));
        entries.push({ name, kind: stats.isDirectory() ? 'dir' : 'file' });
      } catch {
        continue; // a dangling link or an unreadable entry — simply not offered
      }
    }
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
    );
    const parent = path.dirname(target);
    return {
      ok: true,
      path: target,
      parent: parent === target ? null : parent,
      entries,
      roots,
    };
  }

  /** The left column: the card, this machine's library, the home folder and every mounted volume. */
  private async pickerRoots(): Promise<readonly DirRoot[]> {
    const t = this.deps.getTranslator();
    const roots: DirRoot[] = [];
    const card = this.deps.getActiveRoot();
    if (card !== null) roots.push({ path: card, label: card, kind: 'card' });
    roots.push({ path: this.deps.pcLibrary.root, label: t('gameConfig.thisPc'), kind: 'pc' });
    roots.push({ path: os.homedir(), label: t('gameConfig.homeFolder'), kind: 'home' });
    try {
      for (const mount of await listAllMountpoints()) {
        if (roots.some((entry) => entry.path === mount)) continue;
        roots.push({ path: mount, label: mount, kind: 'drive' });
      }
    } catch (cause) {
      log.warn('[game-config] enumerating volumes for the picker failed:', describe(cause));
    }
    return roots;
  }

  /**
   * Reads a card-relative image into a data URL for the hero preview. Reuses the manifest's anti-traversal
   * (`resolveInside`) and the untrusted-root check, so the preview can only read files INSIDE the card.
   * Returns null on any rejection/failure (the renderer just shows no thumbnail).
   */
  private async imagePreview(root: string, relative: string): Promise<string | null> {
    if (!(await this.isAllowedRoot(root))) return null;
    const resolved = resolveInside(root, relative);
    if (resolved === null) return null;
    const url = await readImageDataUrl(resolved);
    return url ?? null;
  }

  /**
   * True when `root` is a current removable/non-system mountpoint, or the app's own PC-library root
   * (anti-arbitrary-write check — the closed set of roots this service will ever write to).
   */
  private async isAllowedRoot(root: string): Promise<boolean> {
    const candidates = await this.candidates();
    return candidates.some((candidate) => candidate.root === root);
  }
}
