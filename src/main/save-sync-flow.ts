// The save sync around a session, and the deferred flush a card receives on insert: the change-based
// card↔PC sync before a launch (sync-in) and after it (sync-out), the pending-flush queue for a card that
// was pulled mid-game, and the baseline the next change-detection reads. Split out of the sequences so
// the launch sequence reads as launch → wait → sync, and the insert path shares the same flush.
import fse from 'fs-extra';
import { type Stats } from '../shared/types';
import type { ResolvedManifest } from './manifest-types';
import { type ControllerDeps } from './controller-deps';
import { acceptsPendingFlush, type SyncSlot } from './pc-store';
import { syncDir, syncByChange, snapshotTree } from './save-sync';
import { type PcSaveLocation, type Platform } from './platform';
import { describe } from './util';
import { log } from './logger';

export type SaveSyncFlowDeps = Pick<ControllerDeps, 'store' | 'stats'> & {
  readonly savePathResolver: Platform['savePathResolver'];
  /** Whether this game's source is available right now (a card game needs its card in). */
  readonly sourceAvailable: (manifest: ResolvedManifest) => boolean;
};

export class SaveSyncFlow {
  constructor(private readonly deps: SaveSyncFlowDeps) {}

  async flushPendingIfAny(manifest: ResolvedManifest): Promise<void> {
    // Enforced by the predicate rather than by "we only call this from loadCard": a local game HAS a
    // saveOnCardPath (its own backup), so a future symmetrical call from the PC-library path would
    // otherwise empty the queue into that backup and lose the progress meant for the card.
    const cardPath = manifest.saveOnCardPath;
    if (!acceptsPendingFlush(manifest) || cardPath === undefined) return;
    const pending = await this.deps.store.getPending(manifest.raw.id);
    if (pending === null) return;
    // Direct, NOT change-based (deliberate): the snapshot exists precisely because
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
   * Resolves the manifest's DEFERRED pcSavePath to this game's save location via the platform
   * SavePathResolver, or null when there's nothing to sync (no pcSavePath declared, or a steam game with
   * no compatdata yet). win32 keeps the exact env-based expansion the manifest used to do eagerly; linux
   * maps inside the game's prefix. `containerExists` tells whether that prefix is actually there — see
   * runSaveSync for why that matters.
   */
  async resolvePcSavePath(manifest: ResolvedManifest): Promise<PcSaveLocation | null> {
    if (manifest.pcSavePath === undefined) return null;
    return this.deps.savePathResolver.resolvePcSavePath(manifest, manifest.pcSavePath);
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
  async runSaveSync(
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
      log.info(
        `[save-sync] id=${id} PC container absent → baseline discarded, card is authoritative`,
      );
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

  async performSyncOut(manifest: ResolvedManifest, stats: Stats): Promise<void> {
    const id = manifest.raw.id;
    // Resolve the deferred pcSavePath once for this game. The game just ran, so its prefix exists
    // and (on win32) the env expansion always succeeds — this matches the pre-port physical path exactly.
    // A prefix that is somehow absent here means the game wrote nothing we could carry back: there is no
    // source to copy from, so treat it as "no PC side" rather than syncing an emptiness onto the card.
    const resolved = await this.resolvePcSavePath(manifest);
    const pcPath = resolved !== null && resolved.containerExists ? resolved.path : null;
    if (resolved !== null && !resolved.containerExists) {
      log.warn(
        `[sync-out] the Wine prefix for id=${id} is gone — nothing to copy back to the card`,
      );
    }
    // The card is already removed (the expected scenario) → defer PC→SD into pending-flush. A local game
    // is never "removed", so it always takes the sync path below (its backup is always reachable).
    if (!this.deps.sourceAvailable(manifest)) {
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
  private async queueLocalProgressForCard(
    manifest: ResolvedManifest,
    pcPath: string,
  ): Promise<void> {
    const id = manifest.raw.id;
    if (!(await this.deps.store.hasCardSyncState(id))) return;
    await this.deps.store.enqueuePcToSd(id, pcPath);
    log.info(`[sync-out] id=${id} local session queued for the card it was last synced with`);
  }
}
