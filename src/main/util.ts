// Tiny shared helpers used across main-process modules (the copies of `delay`/`describe` that had
// drifted into individual files were folded in here).

/** Human-readable message for an unknown thrown value. */
export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Promise that resolves after `ms` milliseconds. */
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
