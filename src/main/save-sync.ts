// Save synchronization: the low-level folder swap (syncDir) plus change-detection (snapshotTree /
// treeChanged / syncByChange) that picks the direction by which side actually changed since the last sync.
// Atomicity for a FOLDER is unachievable (rename is atomic only for a single object),
// so we minimize the inconsistency window: copy into `<dest>.tmp` on the SAME volume,
// then do a quick swap (old → `<dest>.bak` as a rollback, `<dest>.tmp` → `<dest>`).
// We copy WITH preserveTimestamps so mtime survives the sync — it feeds change-detection (a side is
// "changed" if a file was added/removed or its mtime grew). Precision is effectively per-second
// (utimes/FAT), so treeChanged compares against a tolerance (see toleranceMs) rather than exact mtime.
import path from 'node:path';
import fse from 'fs-extra';
import { delay } from './util';

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 200;

function errorCode(cause: unknown): string | undefined {
  if (cause instanceof Error && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Retry with exponential backoff on "busy" files (EBUSY and related). Exported for unit tests. */
export async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (cause) {
      lastError = cause;
      const code = errorCode(cause);
      if (code === undefined || !RETRYABLE_CODES.has(code)) throw cause;
      await delay(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * Copies directory `src` into `dest` via temp+swap on the `dest` volume.
 * If `src` is missing — there's nothing to copy, so we exit quietly (no progress to transfer).
 * The previous version of `dest` is kept in `dest.bak` as a rollback in case of interruption.
 */
export async function syncDir(src: string, dest: string): Promise<void> {
  if (!(await fse.pathExists(src))) return;

  const tmp = `${dest}.tmp`;
  const bak = `${dest}.bak`;

  await withRetry(() => fse.remove(tmp));
  await withRetry(() => fse.copy(src, tmp, { preserveTimestamps: true }));

  // Swap: free up the dest name (into bak), then move tmp into its place.
  if (await fse.pathExists(dest)) {
    await withRetry(() => fse.remove(bak));
    await withRetry(() => fse.move(dest, bak, { overwrite: false }));
  }
  await withRetry(() => fse.move(tmp, dest, { overwrite: false }));
}

// ── Change-detection (bidirectional, last-writer-wins) ─────────────────────────
//
// The direction of a sync is decided by which side changed since the last successful sync, not by the
// phase (card-insert vs game-exit). We compare each side against its OWN previous snapshot (kept per-side
// because the card's FAT/exFAT mtime scale differs from the PC's NTFS one — an absolute card-vs-PC mtime
// compare is unreliable across FAT32/DST). A side "changed" iff a file was added/removed or a common
// file's mtime grew beyond a tolerance. Deletions are caught for free: a file present in the snapshot but
// missing now means that side changed → it becomes the source, and the folder-level replace carries the
// deletion across. See the plan (part B) for the full rationale.

/** A snapshot of a save folder: relative file path (POSIX-normalized) → mtimeMs. Empty for a missing folder. */
export type TreeSnapshot = Record<string, number>;

/** The last-sync baseline for one game: a per-side snapshot plus when it was taken. */
export interface SyncState {
  readonly card: TreeSnapshot;
  readonly pc: TreeSnapshot;
  readonly syncedAt: number;
}

/** Physical direction of a resolved sync (or `noop` when neither side changed). */
export type SyncDirection = 'card-to-pc' | 'pc-to-card' | 'noop';

/** Outcome of syncByChange: the chosen direction, whether it was a conflict / fallback, and the new baseline. */
export interface SyncByChangeResult {
  readonly direction: SyncDirection;
  /** Both sides changed → an LWW tiebreak by max(mtime) picked the source (the loser may be lost). */
  readonly conflict: boolean;
  /** No baseline existed → the deterministic phase fallback direction was used (first run / post-update). */
  readonly usedFallback: boolean;
  /** The baseline to persist for the next sync (re-snapshotted from both sides after the replace). */
  readonly state: SyncState;
}

/**
 * Recursively snapshots the files under `root` (relative POSIX path → mtimeMs). A missing folder yields
 * `{}`; directories that contain no files don't appear (only files are recorded).
 */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const result: TreeSnapshot = {};
  if (!(await fse.pathExists(root))) return result;

  async function walk(dir: string): Promise<void> {
    const entries = await fse.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const stat = await fse.stat(full);
        // POSIX-normalize the key so a persisted snapshot stays comparable regardless of path.sep.
        const rel = path.relative(root, full).split(path.sep).join('/');
        result[rel] = stat.mtimeMs;
      }
    }
  }

  await walk(root);
  return result;
}

/**
 * True when `current` differs from `baseline`: a file was added or removed, or a common file's mtime grew
 * by more than `toleranceMs`. A shrink (or a grow within tolerance) is ignored — utimes/FAT give only
 * per-second precision, so tiny deltas aren't real edits (FAT mtime can jitter ±2s).
 */
export function treeChanged(
  current: TreeSnapshot,
  baseline: TreeSnapshot,
  toleranceMs = 2000,
): boolean {
  const currentKeys = Object.keys(current);
  const baselineKeys = Object.keys(baseline);
  // A different file count means an add or a delete. Equal counts with a swapped key are caught by the
  // per-key `baseValue === undefined` check below (a current key absent from the baseline = added).
  if (currentKeys.length !== baselineKeys.length) return true;
  for (const key of currentKeys) {
    const baseValue = baseline[key];
    if (baseValue === undefined) return true; // present now, absent in the baseline → added
    const currentValue = current[key];
    if (currentValue !== undefined && currentValue - baseValue > toleranceMs) return true;
  }
  return false;
}

/** The largest mtimeMs in a snapshot (0 for an empty tree) — the LWW clock of that side for the tiebreak. */
function maxMtime(tree: TreeSnapshot): number {
  let max = 0;
  for (const value of Object.values(tree)) {
    if (value > max) max = value;
  }
  return max;
}

/**
 * Bidirectional save sync by change-detection. Snapshots both sides, compares each against its own
 * `baseline` half, and replaces the UNCHANGED side with the CHANGED one (folder-level, via syncDir):
 *  - only the card changed → card→PC;
 *  - only the PC changed   → PC→card;
 *  - both changed → CONFLICT: an LWW tiebreak by max(mtime) picks the source (the losing side survives
 *    only as syncDir's `<dest>.bak`); flagged in the result so the caller logs it;
 *  - neither changed → noop (no `.tmp`/`.bak` churn).
 * With no baseline (`baseline === null`: first run / post-update) it falls back to the deterministic
 * `fallback` direction of the phase and records a fresh baseline. After any replace the baseline is
 * re-snapshotted from both sides (identical content post-replace). syncDir errors propagate to the caller.
 */
export async function syncByChange(
  cardPath: string,
  pcPath: string,
  baseline: SyncState | null,
  fallback: 'card-to-pc' | 'pc-to-card',
): Promise<SyncByChangeResult> {
  const cardTree = await snapshotTree(cardPath);
  const pcTree = await snapshotTree(pcPath);

  let direction: SyncDirection;
  let conflict = false;
  const usedFallback = baseline === null;

  if (baseline === null) {
    direction = fallback;
  } else {
    const cardChanged = treeChanged(cardTree, baseline.card);
    const pcChanged = treeChanged(pcTree, baseline.pc);
    if (cardChanged && pcChanged) {
      // Real conflict (both edited since the last sync). Without a per-file merge one side must lose;
      // pick the newer by max(mtime). Same-side mtime scale isn't an issue here — we compare the two
      // sides' clocks directly, which is the documented residual risk (a DST-skewed card can win).
      conflict = true;
      direction = maxMtime(cardTree) >= maxMtime(pcTree) ? 'card-to-pc' : 'pc-to-card';
    } else if (cardChanged) {
      direction = 'card-to-pc';
    } else if (pcChanged) {
      direction = 'pc-to-card';
    } else {
      direction = 'noop';
    }
  }

  if (direction === 'card-to-pc') {
    await syncDir(cardPath, pcPath);
  } else if (direction === 'pc-to-card') {
    await syncDir(pcPath, cardPath);
  }

  // Re-snapshot both sides for the next baseline. After a replace they're identical; on noop nothing moved
  // and this just refreshes the timestamps we already read (cheap — no extra fs mutation).
  const nextState: SyncState =
    direction === 'noop'
      ? { card: cardTree, pc: pcTree, syncedAt: Date.now() }
      : { card: await snapshotTree(cardPath), pc: await snapshotTree(pcPath), syncedAt: Date.now() };

  return { direction, conflict, usedFallback, state: nextState };
}

/** Atomic (within a volume) write of a single file: temp → rename. Best-effort on the card. */
export async function writeFileAtomic(targetPath: string, data: string): Promise<void> {
  const tmp = `${targetPath}.tmp`;
  const dir = path.dirname(targetPath);
  // Only create the directory when it's genuinely missing. On Windows, mkdir of a DRIVE ROOT
  // (e.g. "E:\", the card root for stats.json) throws EPERM even though it already exists — so an
  // unconditional ensureDir would make every card-root write fail. The parent is always present
  // for our targets (card root / existing save dir); create it only for nested paths that need it.
  if (!(await fse.pathExists(dir))) await fse.ensureDir(dir);
  await fse.writeFile(tmp, data, 'utf8');
  await withRetry(() => fse.move(tmp, targetPath, { overwrite: true }));
}
