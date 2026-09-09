// Resolving the real executable inside a macOS `.app` bundle (Д2). A `.app` is a DIRECTORY, so it cannot
// be spawned — the binary lives at `Contents/MacOS/<CFBundleExecutable>`, named by the bundle's Info.plist.
// Spawning that binary directly (rather than `open -a`) is what keeps the pid valid, so the existing
// pid-based tracking works for a local mac game exactly as it does for a Windows .exe.
//
// Info.plist may be XML or Apple's binary plist format. The XML case is parsed here (one key is all we
// need); a binary one is converted with `plutil -convert xml1 -o -` first. The parsing/path helpers are
// pure so they are unit-tested; only readInfoPlist touches fs/execFile.
//
// Paths are built with `path.posix` (CLAUDE.md): a bundle path is a macOS path and the suite runs on the
// Windows CI runner too.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fse from 'fs-extra';

const execFileAsync = promisify(execFile);

/** Magic header of Apple's binary plist format — an XML plist starts with `<?xml`/`<!DOCTYPE` instead. */
const BINARY_PLIST_MAGIC = 'bplist00';

/** Whether a path names a `.app` bundle (case-insensitive, as HFS+/APFS are case-preserving by default). */
export function isAppBundlePath(target: string): boolean {
  return /\.app\/*$/i.test(target);
}

/** `<bundle>/Contents/Info.plist` — the bundle's metadata file. */
export function infoPlistPath(bundle: string): string {
  return path.posix.join(bundle, 'Contents', 'Info.plist');
}

/** `<bundle>/Contents/MacOS/<executable>` — where the bundle's real binary lives. */
export function bundleExecutablePath(bundle: string, executable: string): string {
  return path.posix.join(bundle, 'Contents', 'MacOS', executable);
}

/** The five XML entities a plist string may carry. Anything else is already literal text. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The `CFBundleExecutable` value of an XML plist, or null when the key is absent (or the value is empty).
 * A single-key regexp rather than a full XML parse on purpose: the file is Apple's own, the key is a flat
 * top-level string, and a dependency-free reader keeps this module pure and testable. Pure.
 */
export function parseCFBundleExecutable(plistXml: string): string | null {
  const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/.exec(plistXml);
  if (match === null) return null;
  const value = decodeXmlEntities(match[1] ?? '').trim();
  return value === '' ? null : value;
}

/** Reads Info.plist as XML text, converting a binary plist with `plutil` first. Throws when unreadable. */
async function readInfoPlist(bundle: string): Promise<string> {
  const plist = infoPlistPath(bundle);
  const raw = await fse.readFile(plist);
  if (!raw.subarray(0, BINARY_PLIST_MAGIC.length).toString('latin1').startsWith(BINARY_PLIST_MAGIC)) {
    return raw.toString('utf8');
  }
  // Binary plist: `plutil` ships with macOS and writes the XML form to stdout (`-o -`).
  const { stdout } = await execFileAsync('plutil', ['-convert', 'xml1', '-o', '-', plist]);
  return stdout;
}

/**
 * The absolute path of the binary a `.app` bundle launches, or null when the bundle carries no readable
 * `CFBundleExecutable` or the named binary is missing. Null (not a throw) so the caller can turn it into
 * its own user-facing error alongside the other launch refusals.
 */
export async function resolveAppBundleExecutable(bundle: string): Promise<string | null> {
  let xml: string;
  try {
    xml = await readInfoPlist(bundle);
  } catch {
    return null;
  }
  const executable = parseCFBundleExecutable(xml);
  if (executable === null) return null;
  // The value is a file NAME inside Contents/MacOS; a separator in it would point outside the bundle.
  if (executable.includes('/') || executable.includes('\\')) return null;
  const resolved = bundleExecutablePath(bundle, executable);
  return (await fse.pathExists(resolved)) ? resolved : null;
}
