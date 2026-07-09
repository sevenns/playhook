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
 * transient EBUSY/EPERM (AV/indexer holding the target) is retried. Callers must ensure the parent
 * directory exists (a drive-root parent already does; nested dirs need an ensureDir first).
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await withRetry(() => fs.rename(tmp, filePath));
}
