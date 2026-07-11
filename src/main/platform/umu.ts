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

/** The `drive_c`-relative install root inside a prefix: `playhook/games` (then `<id>`). */
const INSTALL_HOST_SUBPATH = ['drive_c', 'playhook', 'games'] as const;

/**
 * The app-controlled install directory for an install-mode game, in BOTH views (Р7):
 * - `hostDir` — the real path inside the game's Wine prefix (`<pfx>/drive_c/playhook/games/<id>`),
 *   where the installed files physically land (all fs ops + the resolved executable);
 * - `installerDir` — the SAME place as the installer sees it under Wine (`C:\playhook\games\<id>`),
 *   fed to the silent dir-arg. The path has no spaces by construction (`id` ∈ `[A-Za-z0-9._-]`), so the
 *   Linux dir-arg can be passed unquoted (Р7).
 */
export function installDirs(
  userData: string,
  id: string,
): { readonly hostDir: string; readonly installerDir: string } {
  const hostDir = path.posix.join(prefixDir(userData, id), ...INSTALL_HOST_SUBPATH, id);
  const installerDir = `C:\\playhook\\games\\${id}`;
  return { hostDir, installerDir };
}

/**
 * Baseline winetricks verbs provisioned into every install-mode prefix before the installer runs (Р7b).
 * These runtimes are what skinned Inno installers (isskin.dll) and many games need under a bare Proton
 * prefix; installing them proactively makes install mode work out of the box. Card-specific extras
 * (`install.winetricks`) are appended on top.
 */
export const INSTALL_BASELINE_WINETRICKS = [
  'mfc42',
  'gdiplus',
  'vcrun6',
  'vcrun2008',
  'riched20',
] as const;

/**
 * The winetricks verbs that still need applying: baseline + card `extra`, minus those already recorded as
 * done in the prefix sentinel, de-duplicated and order-preserving. Empty → nothing to do (skip the run).
 * Pure so the set logic is unit-tested without fs.
 */
export function pendingWinetricks(extra: readonly string[], done: readonly string[]): string[] {
  const doneSet = new Set(done);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const verb of [...INSTALL_BASELINE_WINETRICKS, ...extra]) {
    if (doneSet.has(verb) || seen.has(verb)) continue;
    seen.add(verb);
    out.push(verb);
  }
  return out;
}

/**
 * The Wine prefix that hosts an install whose host-view dir is `hostDir` (inverse of installDirs): the
 * installer's `C:\playhook\games\<id>` maps to `hostDir` only when WINEPREFIX is the path segment before
 * `/drive_c/`. Used to launch the installer/uninstaller in the game's own prefix from the resolved
 * install descriptor (which carries the host dir, not the id). Falls back to `hostDir` if the marker is
 * absent (defensive — never expected for a resolved install dir).
 */
export function prefixForInstall(hostDir: string): string {
  const marker = '/drive_c/';
  const idx = hostDir.indexOf(marker);
  return idx === -1 ? hostDir : hostDir.slice(0, idx);
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
  const env: NodeJS.ProcessEnv = {
    ...base,
    WINEPREFIX: opts.prefix,
    GAMEID: UMU_GAMEID,
    PROTONPATH: opts.proton,
  };
  // The Electron AppImage injects LD_LIBRARY_PATH / LD_PRELOAD pointing at its OWN bundled libraries. A
  // spawned system binary (python3 → umu → Proton) that inherits them loads mismatched libs and dies
  // instantly (§5.1). Strip them so umu-run runs against the clean system libraries. umu/Proton set up
  // their own library environment from scratch, so nothing of ours needs to survive here.
  for (const key of ENV_STRIP_KEYS) delete env[key];
  return env;
}

/** Dynamic-linker vars the Electron AppImage sets that must NOT leak into the spawned Proton toolchain. */
const ENV_STRIP_KEYS = ['LD_LIBRARY_PATH', 'LD_PRELOAD'] as const;

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
