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

/** True if the appmanifest at `acfPath` reports the app as fully installed. Any error → false. */
async function acfFullyInstalled(acfPath: string): Promise<boolean> {
  let content: string;
  try {
    content = await fse.readFile(acfPath, 'utf8');
  } catch {
    return false;
  }
  const match = /"StateFlags"\s+"(\d+)"/.exec(content);
  if (match?.[1] === undefined) return false;
  const flags = Number.parseInt(match[1], 10);
  if (Number.isNaN(flags)) return false;
  return (flags & STATE_FULLY_INSTALLED) === STATE_FULLY_INSTALLED;
}

/**
 * Whether the given Steam app is FULLY installed on this PC (per Steam's .acf state). Walks every Steam
 * library for `appmanifest_<appid>.acf` and checks StateFlags. Best-effort: Steam not found, no manifest,
 * "downloading" state, or any error → false. Windows-only (off-Windows getSteamPath is null ⇒ false).
 */
export async function steamGameInstalled(appid: number): Promise<boolean> {
  try {
    const steamPath = await getSteamPath();
    if (steamPath === null) return false;
    const libs = await steamLibraryDirs(steamPath);
    for (const lib of libs) {
      const acfPath = path.join(lib, 'steamapps', `appmanifest_${appid}.acf`);
      if (await acfFullyInstalled(acfPath)) return true;
    }
    return false;
  } catch (cause) {
    log.warn('[steam] install check failed:', cause instanceof Error ? cause.message : String(cause));
    return false;
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
