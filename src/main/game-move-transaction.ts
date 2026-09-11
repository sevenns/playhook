// Move to card: a local game leaves the PC library and lands on a card, in one transaction. The pure
// parts (which assets travel, how a slot leaves the library text) live in game-move.ts; this is the
// orchestration — the order of the steps and the two levels of rollback — split out of GameConfigService,
// which keeps the root guard and the game.json reads/writes the transaction is built from.
//
// ── Move to card: a local game leaves the PC library and lands on a card, in one transaction ───────
import path from 'node:path';
import fse from 'fs-extra';
import { ipcMain } from 'electron';
import {
  IPC,
  type ConfigMoveResult,
  type GameMoveRequest,
} from '../shared/types';
import { MANIFEST_FILENAME, type ResolvedManifest } from './manifest-types';
import { type Translator } from '../shared/i18n/index';
import { type ConfigReadResult } from './game-config';
import { type NotificationInput } from './notifications';
import {
  countGamesWithId,
  expectedGameFilePath,
  findGameInText,
  planAssetCopies,
  removeGameFromManifestText,
} from './game-move';
import { type PcStore } from './pc-store';
import { type SavePathResolver } from './platform/types';
import { resolveInside, validateManifestText } from './manifest';
import { writeFileAtomicEnsuringDir } from './json-store';
import { describe } from './util';
import { log } from './logger';

/**
 * A move that SUCCEEDED but not entirely cleanly. Kept as a discriminated value rather than as the
 * user-facing sentence it turns into: the sentence is localized (comparing against it would break the
 * moment the UI language changes mid-transaction) and there can be more than one of these in one move.
 */
type MoveWarning = 'save-skipped' | 'duplicate';

const MOVE_WARNING_NOTIFICATION: Readonly<
  Record<MoveWarning, 'game-move-save-skipped' | 'game-move-duplicate'>
> = {
  'save-skipped': 'game-move-save-skipped',
  duplicate: 'game-move-duplicate',
};

/** One asset copied onto the card by a move, and whether the destination was already occupied — a
 * rollback removes only what the move itself created (an overwrite cannot be undone, so deleting a file
 * that predates us would turn a failed move into data loss). */
interface AssetCopyRecord {
  readonly to: string;
  readonly existedBefore: boolean;
}

/** The save folder a move copied INTO, if any. `existedBefore` distinguishes "we made this folder" (undo
 * = remove it) from "it was already there and empty" (undo = empty it again, keeping the folder). */
interface SaveCopyRecord {
  dir: string | null;
  existedBefore: boolean;
}

/** What the transaction is built from: GameConfigService's root guard and its game.json reads/writes. */
export interface GameMoveConfig {
  /** True when `root` is a current removable/non-system mountpoint or the app's own PC-library root. */
  isWritableRoot(root: string): Promise<boolean>;
  /** The media's identity — the sorted-ids signature a DriveCandidate carries. */
  signatureOf(root: string): Promise<string>;
  /** One root's game.json text, behind the root guard. */
  readConfig(root: string): Promise<ConfigReadResult>;
  /** Writes (or removes, if empty) the PC library's game.json and reloads it. */
  writePcLibraryText(
    text: string,
    t: Translator,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** Drops the candidates snapshot: our own write changed a manifest the labels/signatures derive from. */
  invalidateCandidates(): void;
}

export interface GameMoveDeps {
  readonly config: GameMoveConfig;
  /** The current translator (read live so a language change applies to labels/validation/errors). */
  readonly getTranslator: () => Translator;
  /** The launcher's currently-active card root (DriveWatcher.getActiveRoot). */
  readonly getActiveRoot: () => string | null;
  /** Applies an edited game.json to the active card without a restart (GameController.reloadManifest). */
  readonly reloadManifest: (root: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Files a notification (NotificationsService.notify) for a deferred move and for its warnings. */
  readonly notify: (input: NotificationInput) => void;
  /**
   * The full RESOLVED manifest of one game, by id (GameController.findManifest) — the transaction needs
   * the actual resolved asset paths and the raw fields (steam/pcSavePath) to plan the asset/save copies,
   * not just where the file lives.
   */
  readonly resolveManifest: (id: string) => ResolvedManifest | null;
  /**
   * Whether ANY game is currently running/installing/uninstalling (GameController.isBusy) — moveToCard's
   * own re-check of the guard the "Move to card…" menu item already applies in the renderer.
   */
  readonly isBusy: () => boolean;
  /** Drops a game's sync-state baseline (PcStore.removeSyncState) — moveToCard clears the "pc" slot once
   * a game leaves the library: the local backup ↔ save-folder pairing it described is gone. */
  readonly pcStore: Pick<PcStore, 'removeSyncState'>;
  /** Resolves a manifest's `pcSavePath` to the LIVE save folder on this machine (platform.savePathResolver)
   * — moveToCard copies from there, not from the PC-library backup, so a stale backup can never
   * overwrite a fresher save. */
  readonly savePathResolver: Pick<SavePathResolver, 'resolvePcSavePath'>;
}

export class GameMoveTransaction {
  constructor(private readonly deps: GameMoveDeps) {}

  /** Registers the move's gameConfig:* invoke handler once (the service is a singleton). */
  init(): void {
    ipcMain.handle(
      IPC.gameConfigMoveToCard,
      (_event, payload: GameMoveRequest): Promise<ConfigMoveResult> => this.moveToCard(payload),
    );
  }

  // Two writes (the card's game.json, the library's) cannot be two separate gameConfig:save calls from the
  // renderer without a window where the game exists in both places or neither — so the whole thing runs
  // here. Order: checks (nothing written) → copy assets → copy saves → write the card → write the
  // library → apply/notify → drop the stale sync-state baseline. A failure before the library write rolls
  // back everything copied to the card; `fromText` is applied ONLY after the card write has already
  // succeeded, and never otherwise (see moveToCard's own comments for exactly where).
  //
  // Public, unlike its sibling write paths, purely so test/game-move-transaction.test.ts can drive it: the
  // rollback branches are the riskiest code in the service and are reachable only through the whole
  // sequence, so they are exercised here rather than approximated by a carved-out core.
  async moveToCard(request: GameMoveRequest): Promise<ConfigMoveResult> {
    const t = this.deps.getTranslator();

    // 1. Checks — nothing is written until every one of these passes.
    if (
      !(await this.deps.config.isWritableRoot(request.fromRoot)) ||
      !(await this.deps.config.isWritableRoot(request.toRoot))
    ) {
      return { moved: false, message: t('errors.driveUnavailable') };
    }
    if (
      (await this.deps.config.signatureOf(request.fromRoot)) !== request.fromSignature ||
      (await this.deps.config.signatureOf(request.toRoot)) !== request.toSignature
    ) {
      return { moved: false, message: t('errors.mediaChanged') };
    }
    if (this.deps.isBusy()) {
      return { moved: false, message: t('gameConfig.moveGameBusy') };
    }
    // A move must not rename: everything this PC remembers about the game is keyed by id (stats, the
    // history record, the pending-flush queue), so a rename mid-move would orphan the lot. The renderer
    // hides the id row while a move is pending; this is the server-side half of that rule, and it is what
    // makes addressing the two sides by two different ids below provably equivalent.
    if (request.fromId !== request.id) {
      return { moved: false, message: t('gameConfig.moveIdChanged') };
    }
    if (countGamesWithId(request.id, request.toText) !== 1) {
      return { moved: false, message: t('gameConfig.moveIdTaken') };
    }
    const toValidation = validateManifestText(request.toText, t, 'card');
    if (!toValidation.ok) {
      return { moved: false, message: this.firstIssueMessage(toValidation.issues, t) };
    }
    // fromText is derived HERE, from a fresh read — never trusted from the renderer (see game-move.ts).
    // Addressed by `fromId` (what the game was READ with), never by the editable `id`.
    const fromRead = await this.deps.config.readConfig(request.fromRoot);
    if (!fromRead.ok) return { moved: false, message: fromRead.message };
    // removeGameFromManifestText is a silent no-op for an id that isn't there, which would write the
    // library back UNCHANGED and report a successful move — so the game's presence is asserted first.
    if (countGamesWithId(request.fromId, fromRead.text) !== 1) {
      return { moved: false, message: t('errors.gameNotFound') };
    }
    const fromText = removeGameFromManifestText(request.fromId, fromRead.text);
    if (fromText === null) return { moved: false, message: t('errors.configInvalid') };
    const fromValidation = validateManifestText(fromText, t, 'pc');
    if (!fromValidation.ok) {
      // Our own slot is gone from this text, so whatever is wrong belongs to a game that stays behind —
      // say so, or the user reads it as a complaint about the game they are moving.
      return {
        moved: false,
        message: t('gameConfig.moveLibraryInvalid', {
          reason: this.firstIssueMessage(fromValidation.issues, t),
        }),
      };
    }
    const manifest = this.deps.resolveManifest(request.fromId);
    if (manifest === null || manifest.source !== 'pc') {
      return { moved: false, message: t('errors.gameNotFound') };
    }
    const targetRaw = findGameInText(request.id, request.toText);
    if (targetRaw === null) return { moved: false, message: t('errors.gameNotFound') };
    // The game's OWN files (its exe) must already be on the card — otherwise the card would read as
    // having an invalid game.json the instant it is inserted.
    const expectedFile = expectedGameFilePath(targetRaw);
    if (expectedFile !== null) {
      const resolvedFile = resolveInside(request.toRoot, expectedFile);
      if (resolvedFile === null || !(await fse.pathExists(resolvedFile))) {
        return { moved: false, message: t('gameConfig.moveFilesNotOnCard') };
      }
    }
    // The card's game.json exactly as it stands right now — the ONLY faithful "before" picture for the
    // step-5 rollback. Reconstructing it by subtracting our slot back out of `toText` would restore a
    // re-serialization of the renderer's making instead (different top-level shape for a single-game
    // card), and would lean on `toSignature === ''` to tell "there was no file" from "there was one".
    const toBefore = await this.readManifestSnapshot(request.toRoot);
    if (!toBefore.ok) return { moved: false, message: toBefore.message };

    const gameTitle = typeof targetRaw['title'] === 'string' ? targetRaw['title'] : request.id;
    // What went not-quite-right, as DATA rather than as prose: the outcomes below drive both the
    // notifications and the result's `warning`, and more than one of them can happen in a single move.
    const warnings: MoveWarning[] = [];

    // 2. Copy assets (hero/grid/music), under the deterministic names the renderer already wrote into
    // toText — see asset-move-names.ts. `existedBefore` is recorded per destination so a rollback removes
    // only what this move created: deleting a file that was already there would destroy it outright,
    // since the overwrite has no undo.
    const copied: AssetCopyRecord[] = [];
    const saveCopy: SaveCopyRecord = { dir: null, existedBefore: false };
    const undo = async (): Promise<void> => {
      await this.rollbackMoveCopies(copied, saveCopy);
    };
    try {
      for (const plan of planAssetCopies(manifest, request.id, request.toRoot)) {
        // Checked BEFORE the copy so a file the user deleted since the game was configured is reported as
        // what it is. Left to fse.copy it would surface as an ENOENT inside the catch below, and the user
        // would be told that game.json could not be written — a file nothing has tried to touch yet.
        if (!(await fse.pathExists(plan.from))) {
          await undo();
          return { moved: false, message: t('gameConfig.moveAssetMissing', { path: plan.from }) };
        }
        const existedBefore = await fse.pathExists(plan.to);
        await fse.ensureDir(path.dirname(plan.to));
        await fse.copy(plan.from, plan.to, { overwrite: true });
        copied.push({ to: plan.to, existedBefore });
      }
    } catch (cause) {
      await undo();
      return {
        moved: false,
        message: t('errors.cannotWriteManifest', {
          file: MANIFEST_FILENAME,
          cause: describe(cause),
        }),
      };
    }

    // 3. Copy saves — only when the TARGET manifest actually names a saveOnCard folder, and PREFERABLY
    // from the LIVE save location rather than the pc-games/saves/<id> backup: with no card-side baseline
    // yet, the first sync-in falls back to the deterministic card→pc direction (save-sync.ts), so what
    // travels here is what that fallback will write back over the live folder. The backup is used only
    // when the live location has nothing to offer at all (no folder, or a Wine prefix that does not exist
    // yet) — there the fallback has nothing to overwrite, so a stale backup beats no saves.
    const targetSaveOnCard =
      typeof targetRaw['saveOnCard'] === 'string' ? targetRaw['saveOnCard'] : undefined;
    if (targetSaveOnCard !== undefined) {
      const saveTargetDir = resolveInside(request.toRoot, targetSaveOnCard);
      if (saveTargetDir === null) {
        await undo();
        return { moved: false, message: t('gameConfig.pickOutsideCard') };
      }
      const sourceDir = await this.liveOrBackupSaveDir(manifest);
      if (sourceDir !== null) {
        const targetExisted = await fse.pathExists(saveTargetDir);
        const targetNonEmpty = targetExisted && (await fse.readdir(saveTargetDir)).length > 0;
        if (targetNonEmpty) {
          warnings.push('save-skipped');
        } else {
          try {
            await fse.ensureDir(path.dirname(saveTargetDir));
            await fse.copy(sourceDir, saveTargetDir, { overwrite: true });
            // Recorded even when the folder was already there (empty): what has to be undone is what we
            // PUT IN it, not merely the folder we may or may not have created.
            saveCopy.dir = saveTargetDir;
            saveCopy.existedBefore = targetExisted;
          } catch (cause) {
            await undo();
            return {
              moved: false,
              message: t('errors.cannotWriteManifest', {
                file: MANIFEST_FILENAME,
                cause: describe(cause),
              }),
            };
          }
        }
      }
    }

    // 4. Write the card. On disk to this exact moment on, `fromText` is the only thing left to apply —
    // everything above only touched the CARD side.
    try {
      await writeFileAtomicEnsuringDir(
        path.join(request.toRoot, MANIFEST_FILENAME),
        request.toText,
      );
    } catch (cause) {
      await undo();
      return {
        moved: false,
        message: t('errors.cannotWriteManifest', {
          file: MANIFEST_FILENAME,
          cause: describe(cause),
        }),
      };
    }

    // 5. Write the library. A failure here triggers a best-effort rollback of the card (step 4) back to
    // its pre-move bytes — `fromText` is NEVER applied when this happens: applying it would make the game disappear from the PC library without landing on the card,
    // which is worse than the duplicate a failed rollback leaves behind.
    const fromWrite = await this.deps.config.writePcLibraryText(fromText, t);
    if (!fromWrite.ok) {
      const restored = await this.rollbackCardWrite(request.toRoot, toBefore.text);
      if (restored) {
        // The card is back to its pre-move bytes, so the copies of steps 2/3 are now referenced by
        // nothing — and only NOW may they go. Undoing them while the card still names them (the branch
        // below) would leave the target manifest pointing at art and saves that are no longer there.
        await undo();
        return { moved: false, message: fromWrite.message };
      }
      // The card write is stuck AND the library still has the game too — a defined outcome (a card game
      // shadows its local twin, README.md "Local games"), not corruption, but worth a loud log: two
      // independent writes failed back to back to get here. The copies STAY: the card's game.json still
      // refers to them, and a duplicate whose art and saves are intact is the whole point of calling this
      // "a defined outcome" rather than damage.
      log.error(
        `[game-move] id=${request.id}: card write kept but the library write failed and the card` +
          ` rollback ALSO failed — the game now exists in both places (${fromWrite.message})`,
      );
      warnings.push('duplicate');
    }

    // 6. Apply / defer, exactly like an ordinary card save.
    this.deps.config.invalidateCandidates();
    let applied: 'applied' | 'deferred' | 'failed';
    if (request.toRoot === this.deps.getActiveRoot()) {
      const reload = await this.deps.reloadManifest(request.toRoot);
      // `failed`, not `applied`, when the re-read was refused — the same verdict `save()` gives for the
      // same case. Reporting it as applied sent the caller off to focus a game the carousel has not got.
      applied = reload.ok ? 'applied' : 'failed';
      if (!reload.ok) {
        log.warn(
          `[game-move] id=${request.id}: moved, but reloading the active card failed: ${reload.message}`,
        );
      }
    } else {
      applied = 'deferred';
      this.deps.notify({ kind: 'game-moved-deferred', gameTitle });
    }
    // Every warning gets its own notification, which is the ONLY channel it has: the screen closes the
    // moment a move succeeds, so a field on the result would have nobody left to show it (and the
    // duplicate case must not be the log's secret alone).
    for (const kind of warnings) {
      this.deps.notify({ kind: MOVE_WARNING_NOTIFICATION[kind], gameTitle });
    }

    // 7. The library backup ↔ save-folder pairing this baseline described is gone now that the game has
    // left the library — a stale one would read as a false conflict if the game is ever moved back. Only
    // when the library write actually went through: in the duplicate case the game is still there, and
    // its baseline is still the truth.
    if (fromWrite.ok) await this.deps.pcStore.removeSyncState(request.fromId, 'pc');

    return { moved: true, applied };
  }

  /**
   * The manifest text of a root as it stands right now, or null when the root carries no game.json. An
   * unreadable-but-present file is an ERROR rather than a null: null means "delete the file to undo", and
   * guessing that for a file we simply failed to read would destroy it.
   */
  private async readManifestSnapshot(
    root: string,
  ): Promise<
    | { readonly ok: true; readonly text: string | null }
    | { readonly ok: false; readonly message: string }
  > {
    const file = path.join(root, MANIFEST_FILENAME);
    if (!(await fse.pathExists(file))) return { ok: true, text: null };
    try {
      return { ok: true, text: await fse.readFile(file, 'utf8') };
    } catch (cause) {
      return {
        ok: false,
        message: this.deps.getTranslator()('errors.cannotReadManifest', {
          file: MANIFEST_FILENAME,
          cause: describe(cause),
        }),
      };
    }
  }

  private firstIssueMessage(
    issues: readonly { readonly path: string; readonly message: string }[],
    t: Translator,
  ): string {
    const first = issues[0];
    return first !== undefined ? `${first.path}: ${first.message}` : t('errors.configInvalid');
  }

  /** The folder a move copies saves FROM: the live location if it (and its container) exist, else the
   * PC-library's own backup (`saves/<id>`) as a fallback. Null when neither has anything to copy. */
  private async liveOrBackupSaveDir(manifest: ResolvedManifest): Promise<string | null> {
    if (manifest.pcSavePath !== undefined) {
      const live = await this.deps.savePathResolver.resolvePcSavePath(
        manifest,
        manifest.pcSavePath,
      );
      if (live !== null && live.containerExists && (await fse.pathExists(live.path))) {
        return live.path;
      }
    }
    if (manifest.saveOnCardPath !== undefined && (await fse.pathExists(manifest.saveOnCardPath))) {
      return manifest.saveOnCardPath;
    }
    return null;
  }

  /**
   * Undoes what steps 2/3 put on the CARD — never touches the PC library.
   *
   * An asset whose destination was ALREADY occupied is deliberately left alone: the copy overwrote it and
   * there is nothing to restore, so removing it would turn "the move failed" into "and your file is gone
   * too". The saves folder is emptied rather than removed when it predates the move.
   */
  private async rollbackMoveCopies(
    copied: readonly AssetCopyRecord[],
    saveCopy: SaveCopyRecord,
  ): Promise<void> {
    for (const asset of copied) {
      if (asset.existedBefore) continue;
      try {
        await fse.remove(asset.to);
      } catch (cause) {
        log.warn(`[game-move] failed to roll back copied asset "${asset.to}":`, describe(cause));
      }
    }
    if (saveCopy.dir === null) return;
    try {
      await fse.remove(saveCopy.dir);
      if (saveCopy.existedBefore) await fse.ensureDir(saveCopy.dir);
    } catch (cause) {
      log.warn(
        `[game-move] failed to roll back the copied save folder "${saveCopy.dir}":`,
        describe(cause),
      );
    }
  }

  /**
   * Best-effort revert of the card's game.json after the library write failed post-write: writes back the
   * bytes the card carried before the move, or deletes the file when it had none (`toTextBefore === null`).
   * Returns whether the revert itself succeeded.
   */
  private async rollbackCardWrite(toRoot: string, toTextBefore: string | null): Promise<boolean> {
    try {
      if (toTextBefore === null) await fse.remove(path.join(toRoot, MANIFEST_FILENAME));
      else await writeFileAtomicEnsuringDir(path.join(toRoot, MANIFEST_FILENAME), toTextBefore);
      return true;
    } catch (cause) {
      log.warn(`[game-move] failed to roll back the card write at "${toRoot}":`, describe(cause));
      return false;
    }
  }
}
