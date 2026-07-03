// Tiny shared helpers used across main-process modules (de-duplicates the copies of
// `delay`/`describe` that had drifted into individual files).

/** Human-readable message for an unknown thrown value. */
export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Promise that resolves after `ms` milliseconds. */
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
