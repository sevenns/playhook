// Shared safe-read for zod-validated JSON stores. PcStore and AppSettingsStore both
// had the identical `try → readJson → safeParse → success ? data : DEFAULT` shape, and both swallowed
// failures silently. This is the single home for that pattern, and it distinguishes the
// two failure modes: a MISSING file is the normal first-run case (silent), while a file that exists
// but fails to read or validate is a real anomaly (corruption / incompatible shape) that gets a
// log.warn breadcrumb instead of a silent fallback that could mask damaged user data.
import fs from 'node:fs/promises';
import fse from 'fs-extra';
import type { z } from 'zod';
import { log } from './logger';
import { withRetry } from './save-sync';

function isMissingFile(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    'code' in cause &&
    (cause as { readonly code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Reads and validates a JSON file against `schema`, returning `fallback` if it is missing, unreadable
 * or fails validation. A missing file is silent (expected first-run); every other failure is warned.
 */
export async function readJsonValidated<S extends z.ZodTypeAny>(
  filePath: string,
  schema: S,
  fallback: z.infer<S>,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await fse.readJson(filePath);
  } catch (cause) {
    if (!isMissingFile(cause)) {
      log.warn(`[store] failed to read "${filePath}", using default:`, cause);
    }
    return fallback;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    log.warn(`[store] "${filePath}" failed validation, using default:`, parsed.error.message);
    return fallback;
  }
  return parsed.data;
}

/**
 * Atomically writes `value` as pretty JSON to `filePath` (temp file → rename). The final step is a bare
 * `fs.rename`, NOT `fse.move(overwrite)`: in fs-extra 11 the latter is remove+rename, which leaves a
 * window where the file is ABSENT (ENOENT → a silent fallback to defaults on the next read). `fs.rename`
 * maps to MoveFileEx (MOVEFILE_REPLACE_EXISTING) on Windows — an atomic same-volume replace, so an
 * interrupted write leaves either the old or the new complete file, never a truncated/missing one. A
 * transient EBUSY/EPERM (AV/indexer holding the target) is retried, and a target that refuses the
 * replace outright falls back to an in-place write (see replaceInPlace). Callers must ensure the parent
 * directory exists (a drive-root parent already does; nested dirs need an ensureDir first).
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The same temp-file → rename guarantee for arbitrary content (added for the binary `shortcuts.vdf`
 * write, where a torn file costs the user every non-Steam shortcut they have). `writeJsonAtomic` is now a
 * thin wrapper over this — see its doc comment for why the final step is a bare `fs.rename`.
 */
/**
 * How many times the replace is retried before the fallback below takes over. Deliberately short of the
 * default five (~6.2s): the codes that reach the fallback — a read-only attribute, an ACL without delete
 * — do not clear up on their own, so the extra waiting buys nothing and the user watches a toggle hang
 * for six seconds on its way to working. A genuinely busy file (an antivirus mid-scan) still gets three
 * tries and ~1.4s, and anything not covered by the fallback keeps failing exactly as it did.
 */
const REPLACE_ATTEMPTS = 3;

export async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  const tmp = tmpNameFor(filePath);
  try {
    await writeRaw(tmp, data);
  } catch (cause) {
    // The temp could not even be STAGED — the directory itself refuses new files. Writing through the
    // existing target is still worth a try: that needs permission on the file, not on its directory.
    if (!isPermissionError(cause)) throw cause;
    await writeThrough(filePath, data, cause);
    return;
  }
  try {
    await withRetry(() => fs.rename(tmp, filePath), REPLACE_ATTEMPTS);
    return;
  } catch (cause) {
    if (!isPermissionError(cause)) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw cause;
    }
    await replaceInPlace(filePath, tmp, data, cause);
  }
}

let tmpCounter = 0;

/**
 * A temp name unique to THIS write. A shared `<file>.tmp` is shared mutable state between concurrent
 * writers of the same file: both write the one temp, the first rename consumes it, and the second fails
 * with ENOENT on a file that was never theirs — which is exactly how the history index lost five writes
 * in a row while several games were being copied into it at once. The pid keeps two processes (the GUI
 * and the Game Mode daemon share `%APPDATA%`) from colliding on the counter.
 */
function tmpNameFor(filePath: string): string {
  tmpCounter += 1;
  return `${filePath}.${process.pid}.${tmpCounter}.tmp`;
}

function isPermissionError(cause: unknown): boolean {
  if (!(cause instanceof Error) || !('code' in cause)) return false;
  const code = (cause as { readonly code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES';
}

async function writeRaw(target: string, data: string | Buffer): Promise<void> {
  if (typeof data === 'string') await fs.writeFile(target, data, 'utf8');
  else await fs.writeFile(target, data);
}

/**
 * Last resort when the atomic replace is refused OUTRIGHT (not the transient EBUSY/EPERM withRetry
 * already rides out): the rename needs DELETE on the existing target, which is a different right from
 * "may write to it", and a file can be left without it by something other than this app — a read-only
 * attribute, or an ACL inherited from an install under another account (a per-user install taking over a
 * `%APPDATA%` file an all-users one created is the case that surfaced this).
 *
 * So: clear the read-only attribute and try the atomic path once more; failing that, write THROUGH the
 * existing file, which needs only write access. That gives up atomicity — an interrupted write can leave
 * the file torn — which is why it is reached only after the safe path has genuinely failed: a settings
 * file that cannot be saved at all is a worse outcome than one with a small window of risk, and the
 * caller is told either way (the original error is re-thrown if even this does not land).
 */
async function replaceInPlace(
  filePath: string,
  tmp: string,
  data: string | Buffer,
  original: unknown,
): Promise<void> {
  try {
    // On Windows this is the read-only ATTRIBUTE (the only bit chmod maps to there); on posix it restores
    // owner/group write. Best-effort: a target that is missing or already writable just falls through.
    await fs.chmod(filePath, 0o666).catch(() => undefined);
    await fs.rename(tmp, filePath);
    return;
  } catch {
    // fall through to the non-atomic write
  }
  try {
    await writeThrough(filePath, data, original);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Writes straight over `filePath`, giving up atomicity — an interrupted write can leave the file torn.
 * Reached only once the safe path has genuinely failed: a settings file that cannot be saved AT ALL is a
 * worse outcome than one with a small window of risk. `original` is re-thrown when even this does not
 * land, so the caller still learns the real reason rather than a symptom of the recovery.
 */
async function writeThrough(
  filePath: string,
  data: string | Buffer,
  original: unknown,
): Promise<void> {
  try {
    await writeRaw(filePath, data);
  } catch {
    throw original;
  }
  log.warn(
    `[store] "${filePath}" could not be replaced atomically; wrote it in place instead:`,
    original,
  );
}
