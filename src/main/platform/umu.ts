// Pure helpers for launching Windows games through umu-launcher / Proton on Linux (Р1/Р2). No electron,
// no child_process — just the path/env/argv construction — so they are unit-tested directly. The bundled
// umu-run is a python zipapp; we invoke it as `python3 <umu-run> <exe> <args…>` (no reliance on the
// executable bit surviving packaging — Р11) with the WINEPREFIX/GAMEID/PROTONPATH env umu expects.
import path from 'node:path';

/** Default PROTONPATH: umu downloads and caches the latest GE-Proton into Steam's compatibilitytools.d. */
export const DEFAULT_PROTON = 'GE-Proton' as const;

/** The umu GAMEID for a non-Steam title (umu requires one; `umu-default` is the generic id). */
export const UMU_GAMEID = 'umu-default' as const;

/**
 * The per-game Wine prefix directory: `<userData>/prefixes/<id>` (Р2). `id` is already validated as
 * `[A-Za-z0-9._-]` (no separators, not `.`/`..`), so it is a safe single path segment.
 */
export function prefixDir(userData: string, id: string): string {
  // Always POSIX-join: this is a Linux path (the launcher only runs on Linux), so it must use `/`
  // regardless of the OS the tests run on (a win32 `path.join` would emit backslashes and fail CI).
  return path.posix.join(userData, 'prefixes', id);
}

/**
 * The environment umu-run reads: the game's own Wine prefix, the generic GAMEID, and PROTONPATH (a Proton
 * name like `GE-Proton` that umu resolves/downloads, or an absolute path to a specific Proton). Layered
 * over the inherited env so system PATH (→ python3) and the display/session vars survive.
 */
export function buildUmuEnv(
  base: NodeJS.ProcessEnv,
  opts: { readonly prefix: string; readonly proton: string },
): NodeJS.ProcessEnv {
  return {
    ...base,
    WINEPREFIX: opts.prefix,
    GAMEID: UMU_GAMEID,
    PROTONPATH: opts.proton,
  };
}

/**
 * The argv for `python3`: the umu-run zipapp, then the (host-path) Windows executable and its game args.
 * Proton maps the host filesystem into the prefix (the card exe is reached via the `Z:` drive), so the
 * plain host path is what umu-run receives.
 */
export function buildUmuArgs(
  umuRunPath: string,
  executablePath: string,
  gameArgs: readonly string[],
): string[] {
  return [umuRunPath, executablePath, ...gameArgs];
}
