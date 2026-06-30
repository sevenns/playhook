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
 * - `downloading` — an `.acf` exists but not fully installed (downloading/updating). No live percent is
 *   available from the files (see AcfState) — the UI shows a plain "Installing…".
 * - `absent`      — no `.acf` (nothing started), Steam not found, or any error.
 */
export type SteamInstallStatus =
  | { readonly state: 'installed' }
  | { readonly state: 'downloading' }
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

/**
 * Per-library .acf reading: just whether the app is fully installed. We do NOT report a download
 * percent: Steam has no reliable real-time progress in the files we can read — BytesDownloaded in the
 * .acf is flushed only on state changes (so it freezes mid-download), and the on-disk `downloading`
 * folder is PREALLOCATED to ~full size up front (so its size reads ~100% from the first second). The
 * accurate live percent lives only in the Steam client / Steamworks SDK. So the UI shows a plain
 * "Installing…" with a spinner. null here means the .acf is absent.
 */
type AcfState = { readonly fullyInstalled: boolean };

async function readAcfState(acfPath: string): Promise<AcfState | null> {
  let content: string;
  try {
    content = await fse.readFile(acfPath, 'utf8');
  } catch {
    return null; // no .acf in this library
  }
  const flags = readAcfNumber(content, 'StateFlags');
  if (flags === null) return null;
  return { fullyInstalled: (flags & STATE_FULLY_INSTALLED) === STATE_FULLY_INSTALLED };
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
      // .acf exists but not fully installed → downloading/updating in this library.
      downloading = { state: 'downloading' };
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
