// Steam-mode backend: detecting whether a Steam app is installed (Steam's own .acf state) and opening
// steam:// URIs for launch/install. A separate backend from install mode — no card installer, no
// app-controlled dir. Windows-only in practice (getSteamPath is null off-Windows ⇒ "not installed");
// dev builds on macOS degrade gracefully rather than crashing.
//
// Why .acf and not a registry DWORD: Steam's `appmanifest_<appid>.acf` (in each library's `steamapps`)
// carries `StateFlags`, the source of truth Steam itself uses. Bit 4 (StateFullyInstalled) is set only
// once the game is fully installed — correctly excluding "currently downloading/updating", which a
// stale `HKCU\...\Apps\<appid>\Installed` DWORD cannot distinguish.
import path from 'node:path';
import fse from 'fs-extra';
import { shell } from 'electron';
import { getSteamPath } from './registry';
import { log } from './logger';

/** StateFlags bit set by Steam once an app is fully installed (not merely downloading/updating). */
const STATE_FULLY_INSTALLED = 4;

/**
 * Where a Steam app stands locally, derived from its `.acf`:
 * - `installed`   — fully installed (StateFlags bit 4), ready to launch.
 * - `downloading` — an `.acf` exists but not fully installed (downloading/updating). `progress` is the
 *   0..1 fraction when Steam reports byte counts, or `null` when it hasn't yet.
 * - `absent`      — no `.acf` (nothing started), Steam not found, or any error.
 */
export type SteamInstallStatus =
  | { readonly state: 'installed' }
  | { readonly state: 'downloading'; readonly progress: number | null }
  | { readonly state: 'absent' };

/**
 * Collects the Steam library roots: the default `<steamPath>/steamapps` plus every `"path"` listed in
 * `libraryfolders.vdf`. Robust (not naive): matches ALL `"path"` entries and unescapes VDF's `\\` → `\`.
 * The default library is always included even when the VDF is missing/unreadable.
 */
async function steamLibraryDirs(steamPath: string): Promise<readonly string[]> {
  const defaultLib = steamPath;
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  let content: string;
  try {
    content = await fse.readFile(vdfPath, 'utf8');
  } catch {
    return [defaultLib];
  }
  const dirs = new Set<string>([defaultLib]);
  const pathRegex = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  for (let match = pathRegex.exec(content); match !== null; match = pathRegex.exec(content)) {
    const raw = match[1];
    if (raw === undefined) continue;
    // VDF escapes backslashes as `\\` — unescape so path.join gets a real Windows path.
    const unescaped = raw.replaceAll('\\\\', '\\');
    if (unescaped.trim() !== '') dirs.add(unescaped);
  }
  return [...dirs];
}

/** Reads a numeric `"<key>" "<n>"` value from .acf content. null if missing or unparsable. */
function readAcfNumber(content: string, key: string): number | null {
  const match = new RegExp(`"${key}"\\s+"(\\d+)"`).exec(content);
  if (match?.[1] === undefined) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isNaN(value) ? null : value;
}

/** Reads a string `"<key>" "<value>"` from .acf content. null if missing. */
function readAcfString(content: string, key: string): string | null {
  const match = new RegExp(`"${key}"\\s+"([^"]*)"`).exec(content);
  return match?.[1] ?? null;
}

/**
 * Per-library .acf reading. We deliberately do NOT use BytesDownloaded/BytesToDownload for progress:
 * Steam flushes those to the .acf only on state changes (pause/stop/finish), not live — so the percent
 * would freeze mid-download. Instead we carry `installdir`/`sizeOnDisk` and compute progress from the
 * actual install folder size (see downloadProgress). null if the .acf is absent.
 */
type AcfState = {
  readonly fullyInstalled: boolean;
  readonly installdir: string | null;
  readonly sizeOnDisk: number | null;
};

async function readAcfState(acfPath: string): Promise<AcfState | null> {
  let content: string;
  try {
    content = await fse.readFile(acfPath, 'utf8');
  } catch {
    return null; // no .acf in this library
  }
  const flags = readAcfNumber(content, 'StateFlags');
  if (flags === null) return null;
  const fullyInstalled = (flags & STATE_FULLY_INSTALLED) === STATE_FULLY_INSTALLED;
  return {
    fullyInstalled,
    installdir: readAcfString(content, 'installdir'),
    sizeOnDisk: readAcfNumber(content, 'SizeOnDisk'),
  };
}

/** Recursively sums file sizes under `dir`. Unreadable entries are skipped; a missing dir → 0. */
async function dirSize(dir: string): Promise<number> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fse.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSize(full);
      else if (entry.isFile()) total += (await fse.stat(full)).size;
    } catch {
      // skip an entry that vanished / is locked mid-walk
    }
  }
  return total;
}

/**
 * Live download fraction from the actual install-folder size vs SizeOnDisk (Steam's own target). Unlike
 * the .acf byte counters, the folder grows in real time as chunks are committed, so the percent advances
 * smoothly. Clamped to [0, 0.99] — 100%/Play is owned by the StateFullyInstalled flip. null if we can't
 * compute it (missing installdir/SizeOnDisk, or empty folder). NOTE: for an UPDATE (folder already full)
 * this reads ~99% immediately, and if Steam preallocates files it can overshoot — accepted trade-off.
 */
async function downloadProgress(lib: string, acf: AcfState): Promise<number | null> {
  if (acf.installdir === null || acf.sizeOnDisk === null || acf.sizeOnDisk <= 0) return null;
  const gameDir = path.join(lib, 'steamapps', 'common', acf.installdir);
  const size = await dirSize(gameDir);
  if (size <= 0) return null;
  return Math.max(0, Math.min(0.99, size / acf.sizeOnDisk));
}

/**
 * Where the given Steam app stands locally (per Steam's own .acf state), walking every Steam library for
 * `appmanifest_<appid>.acf`. Best-effort: Steam not found, no manifest, or any error → `absent`.
 * Windows-only (off-Windows getSteamPath is null ⇒ `absent`).
 */
export async function steamInstallStatus(appid: number): Promise<SteamInstallStatus> {
  try {
    const steamPath = await getSteamPath();
    if (steamPath === null) return { state: 'absent' };
    const libs = await steamLibraryDirs(steamPath);
    let downloading: SteamInstallStatus | null = null;
    for (const lib of libs) {
      const acfPath = path.join(lib, 'steamapps', `appmanifest_${appid}.acf`);
      const acf = await readAcfState(acfPath);
      if (acf === null) continue;
      if (acf.fullyInstalled) return { state: 'installed' };
      // .acf exists but not fully installed → downloading/updating in this library. Compute a live
      // percent from the install folder size (the byte counters in .acf are not real-time).
      downloading = { state: 'downloading', progress: await downloadProgress(lib, acf) };
    }
    return downloading ?? { state: 'absent' };
  } catch (cause) {
    log.warn('[steam] install check failed:', cause instanceof Error ? cause.message : String(cause));
    return { state: 'absent' };
  }
}

/**
 * Opens a `steam://` URI (rungameid/install) via Electron's shell.openExternal. NOTE: openExternal does
 * NOT reliably reject when `steam://` is unregistered (Steam not installed) — callers must gate on
 * getSteamPath() !== null BEFORE calling this. Here we only guarantee that any sync/async failure
 * propagates as a rejected promise so the caller can surface it.
 */
export async function openSteamUri(uri: string): Promise<void> {
  await shell.openExternal(uri);
}
