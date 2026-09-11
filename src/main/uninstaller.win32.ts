// Resolving and running a game's own uninstaller on Windows (FS search in the install dir, then the
// registry), plus the backed-off directory sweep every uninstall path ends in. Split out of the
// controller: the pure parts (the silent flags per installer family, the CommandLineToArgvW parser, the
// in-dir search) are unit-tested on their own — see test/uninstaller.test.ts.
import path from 'node:path';
import fse from 'fs-extra';
import { type InstallerRunType, type LaunchTarget, type ResolvedInstallerRun } from '../shared/types';
import { findUninstallEntry } from './registry';
import { delay } from './util';

// Directory removal retries: an Inno uninstaller forks a copy of itself into
// temp and exits early, so right after waitForExit it may still hold `unins000.*` for a moment — a
// few backed-off retries let the lock clear before fse.remove succeeds.
const REMOVE_RETRY_ATTEMPTS = 3;
const REMOVE_RETRY_BASE_MS = 300;

// ── Uninstaller resolution (FS search in the install dir → registry fallback) ──

/** Silent flags we build ourselves per installer family (the same families' silent semantics, minus
 * the dir-key). Never used for `custom` (it has no known silent-uninstall convention). */
export function silentUninstallArgs(type: InstallerRunType): string[] {
  switch (type) {
    case 'nsis':
      return ['/S'];
    case 'inno':
      return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
    case 'custom':
      return [];
  }
}

/**
 * Step 1 — deterministic FS search for the uninstaller INSIDE the app-controlled install dir (we put
 * it there via the installer's dir-key, so it lives in the root): Inno drops `unins###.exe` (pick the
 * highest if several), NSIS drops `Uninstall.exe`/`uninst*.exe`. `custom` has no known convention → null.
 *
 * `copy` is excluded by TYPE, not by a branch: a copied directory is a game somebody else installed
 * earlier, so it may well carry a foreign `unins000.exe` that the nsis fallback below would happily
 * find and run with `/S` — silently uninstalling from the wrong machine's point of view.
 */
export async function findUninstallerInDir(
  dir: string,
  type: InstallerRunType,
): Promise<string | null> {
  if (type === 'custom') return null;
  let names: readonly string[];
  try {
    names = await fse.readdir(dir);
  } catch {
    return null;
  }
  if (type === 'inno') {
    const candidates = names.filter((name) => /^unins\d{3}\.exe$/i.test(name)).sort();
    const chosen = candidates.at(-1);
    return chosen !== undefined ? path.join(dir, chosen) : null;
  }
  // nsis: the name is set by the .nsi but is almost always Uninstall.exe / uninst*.exe in the root.
  const match = names.find((name) => /^uninst(all)?.*\.exe$/i.test(name));
  return match !== undefined ? path.join(dir, match) : null;
}

/**
 * Parses a Windows command line into LOGICAL argv tokens following CommandLineToArgvW's backslash/quote
 * rules (2n backslashes + quote → n backslashes and a quote toggle; 2n+1 → n backslashes and a literal
 * quote). Used to split a registry UninstallString into exe + args; the original quoting is dropped (the
 * launcher re-quotes uniformly under verbatim:false).
 */
export function parseCommandLine(command: string): string[] {
  const args: string[] = [];
  let arg = '';
  let inQuotes = false;
  let started = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === undefined) break;
    if (ch === '\\') {
      let backslashes = 0;
      while (command[i] === '\\') {
        backslashes += 1;
        i += 1;
      }
      if (command[i] === '"') {
        arg += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          arg += '"'; // escaped literal quote
        } else {
          inQuotes = !inQuotes;
        }
        i += 1;
      } else {
        arg += '\\'.repeat(backslashes);
      }
      started = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
      i += 1;
      continue;
    }
    if ((ch === ' ' || ch === '\t') && !inQuotes) {
      if (started) {
        args.push(arg);
        arg = '';
        started = false;
      }
      i += 1;
      continue;
    }
    arg += ch;
    started = true;
    i += 1;
  }
  if (started) args.push(arg);
  return args;
}

/**
 * Resolves what to launch to uninstall an install-mode game: FS search in the install dir first
 * (deterministic, no parsing/encoding issues — we build the silent args), then a registry fallback for a
 * rare nonstandard NSIS uninstaller name. Returns null → the caller does a plain directory removal.
 */
export async function resolveUninstaller(install: ResolvedInstallerRun): Promise<LaunchTarget | null> {
  // Linux: uninstall removes the WHOLE per-game Wine prefix (see GameProcessLauncher.uninstallDir),
  // so running the game's own in-prefix uninstaller first is pointless (its registry/shortcut cleanup
  // lives in the prefix we're about to delete). Skip it — win32 still runs it (no prefix; it must clean
  // the shared system before the install dir is removed).
  if (process.platform !== 'win32') return null;

  // Step 1: FS search in the install dir, with self-built silent flags.
  const found = await findUninstallerInDir(install.dir, install.type);
  if (found !== null) {
    return {
      file: found,
      args: silentUninstallArgs(install.type),
      cwd: install.dir,
      runAsAdmin: install.runAsAdmin,
    };
  }
  if (install.type === 'custom') return null; // no FS match and no silent convention → plain remove

  // Step 2: registry fallback (rare — nonstandard NSIS uninstaller name). win32-only (reached only on
  // win32; the non-win32 early return above skips the whole uninstaller path).
  const entry = await findUninstallEntry(install.dir);
  if (entry === null) return null;
  const command = entry.quietUninstallString ?? entry.uninstallString;
  if (command === undefined) return null;
  const tokens = parseCommandLine(command);
  const file = tokens[0];
  if (file === undefined) return null;
  const rest = tokens.slice(1);
  // QuietUninstallString is already silent; a plain UninstallString needs the family's silent flag.
  const args =
    entry.quietUninstallString !== undefined ? rest : [...rest, ...silentUninstallArgs(install.type)];
  return {
    file,
    args,
    cwd: install.dir,
    runAsAdmin: entry.fromHKLM || install.runAsAdmin,
  };
}

/**
 * Removes a directory with a few backed-off retries: the forked Inno uninstaller may still hold
 * files for a moment after waitForExit. Checks `signal.aborted` between attempts (fse.remove itself is
 * not interruptible). Throws the last error if every attempt fails.
 */
export async function removeWithRetry(dir: string, signal?: AbortSignal): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REMOVE_RETRY_ATTEMPTS; attempt += 1) {
    if (signal?.aborted === true) return;
    try {
      await fse.remove(dir);
      return;
    } catch (cause) {
      lastError = cause;
      if (attempt < REMOVE_RETRY_ATTEMPTS) await delay(REMOVE_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
