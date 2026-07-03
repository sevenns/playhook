// Shared safe-read for zod-validated JSON stores. PcStore and AppSettingsStore both
// had the identical `try → readJson → safeParse → success ? data : DEFAULT` shape, and both swallowed
// failures silently. This is the single home for that pattern, and it distinguishes the
// two failure modes: a MISSING file is the normal first-run case (silent), while a file that exists
// but fails to read or validate is a real anomaly (corruption / incompatible shape) that gets a
// log.warn breadcrumb instead of a silent fallback that could mask damaged user data.
import fse from 'fs-extra';
import type { z } from 'zod';
import { log } from './logger';

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
