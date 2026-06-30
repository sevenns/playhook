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
 *   available WHILE ACTIVE (see AcfState), so the UI shows a plain "Installing…". `paused` is true when
 *   the download is suspended; `progress` (0..1) is the snapshot percent — set ONLY when paused, because
 *   that's the only time Steam's byte counters in the .acf are fresh.
 * - `absent`      — no `.acf` (nothing started), Steam not found, or any error.
 */
export type SteamInstallStatus =
  | { readonly state: 'installed' }
  | { readonly state: 'downloading'; readonly paused: boolean; readonly progress: number | null }
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
 * Per-library .acf reading: install state, pause state, and a snapshot percent. We do NOT report a LIVE
 * percent while actively downloading: Steam has no reliable real-time progress in the files we can read —
 * BytesDownloaded in the .acf is flushed only on state changes (so it freezes mid-download), and the
 * on-disk `downloading` folder is PREALLOCATED to ~full size up front (so its size reads ~100% from the
 * first second). The accurate live percent lives only in the Steam client / Steamworks SDK.
 *
 * Pause detection: StateFlags is IDENTICAL while downloading vs paused (observed 1026 in both). The
 * distinguishing field is `UpdateResult` (EResult of the last update step): 0 = none/in-progress and
 * 1 = k_EResultOK both mean "fine/active", while >=2 (2 fail, 3/4/63 no-connection/retry, 10 busy, …)
 * means the download isn't progressing. We can't tell a user pause from a transient network stall via
 * the files — both land at >=2 — so we treat the whole >=2 range as "paused/stalled". On stop the byte
 * counters ARE fresh, so we derive a snapshot percent there (staged progress, which tracks Steam's own
 * displayed number best, with download progress as a fallback); the caller surfaces it only while
 * paused. null here means the .acf is absent.
 */
type AcfState = {
  readonly fullyInstalled: boolean;
  readonly paused: boolean;
  /** Snapshot completion fraction 0..1 (staged ?? downloaded), or null if not computable. */
  readonly progress: number | null;
};

/** num/den clamped to 0..1, or null when not computable. */
function fraction(num: number | null, den: number | null): number | null {
  if (num === null || den === null || den <= 0) return null;
  return Math.max(0, Math.min(1, num / den));
}

async function readAcfState(acfPath: string): Promise<AcfState | null> {
  let content: string;
  try {
    content = await fse.readFile(acfPath, 'utf8');
  } catch {
    return null; // no .acf in this library
  }
  const flags = readAcfNumber(content, 'StateFlags');
  if (flags === null) return null;
  // Staged progress matches Steam's displayed percent best; fall back to download progress.
  const progress =
    fraction(readAcfNumber(content, 'BytesStaged'), readAcfNumber(content, 'BytesToStage')) ??
    fraction(readAcfNumber(content, 'BytesDownloaded'), readAcfNumber(content, 'BytesToDownload'));
  // EResult: 0 (none/in-progress) and 1 (OK) are "active/fine"; >=2 means the download isn't moving.
  const updateResult = readAcfNumber(content, 'UpdateResult') ?? 0;
  return {
    fullyInstalled: (flags & STATE_FULLY_INSTALLED) === STATE_FULLY_INSTALLED,
    paused: updateResult >= 2,
    progress,
  };
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
      // .acf exists but not fully installed → downloading/updating in this library. The percent is only
      // trustworthy when paused (byte counters are stale while actively downloading).
      downloading = { state: 'downloading', paused: acf.paused, progress: acf.paused ? acf.progress : null };
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
