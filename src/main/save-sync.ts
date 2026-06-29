// Directional save synchronization (stage 8, section 3).
// Atomicity for a FOLDER is unachievable (rename is atomic only for a single object),
// so we minimize the inconsistency window: copy into `<dest>.tmp` on the SAME volume,
// then do a quick swap (old → `<dest>.bak` as a rollback, `<dest>.tmp` → `<dest>`).
// No preserveTimestamps — on FAT/exFAT mtime is off by ±2s and isn't needed for a "directional" sync.
import path from 'node:path';
import fse from 'fs-extra';

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

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Retry with exponential backoff on "busy" files (EBUSY and related). */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
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
  await withRetry(() => fse.copy(src, tmp, { preserveTimestamps: false }));

  // Swap: free up the dest name (into bak), then move tmp into its place.
  if (await fse.pathExists(dest)) {
    await withRetry(() => fse.remove(bak));
    await withRetry(() => fse.move(dest, bak, { overwrite: false }));
  }
  await withRetry(() => fse.move(tmp, dest, { overwrite: false }));
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
