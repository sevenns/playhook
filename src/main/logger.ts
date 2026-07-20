// File logger for the main process. There's no console on the target machine (packaged background
// app), so we append timestamped lines to a log file under userData and mirror them to the console
// during development. Logs are split PER CALENDAR DAY (main-YYYY-MM-DD.log) so they're easy to browse
// and a long-running instance rolls over to a fresh file at midnight; old day-files are pruned after
// RETENTION_DAYS to keep the folder from growing unbounded (replacing the old single-file size cap).
// Writes are synchronous and best-effort: logging must never throw into a flow.
//
// NOTE — this module must NOT import `electron`. It is loaded by the Game Mode daemon, which runs under
// ELECTRON_RUN_AS_NODE where the `electron` module does not exist at all (it is a devDependency, and the
// runtime only injects it for a normal Electron start) — importing it there fails with MODULE_NOT_FOUND
// before a single line of ours runs. The GUI passes its real userData through setLogBaseDir().
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

type Level = 'INFO' | 'WARN' | 'ERROR';

const RETENTION_DAYS = 14; // keep the last two weeks of day-files; drop older ones
const LOG_FILE_RE = /^main-\d{4}-\d{2}-\d{2}\.log$/;

let logDir: string | null = null;
// Explicit base directory, set by a process that has no Electron `app` to ask — the Game Mode daemon runs
// under ELECTRON_RUN_AS_NODE, where `require('electron')` yields a path string and `app` is undefined.
// The GUI never calls this and keeps resolving through app.getPath() exactly as before.
let explicitBaseDir: string | null = null;

/**
 * Points the logger at `baseDir` (logs land in `<baseDir>/logs`). Both entry points call it as their very
 * first action — main.ts with `app.getPath('userData')`, the daemon with the same path derived by hand —
 * so the fallback below is only ever a safety net, never the normal path.
 */
export function setLogBaseDir(baseDir: string): void {
  explicitBaseDir = baseDir;
  logDir = null; // drop a cached dir so a later call actually takes effect
}

/**
 * Electron's userData location, reproduced without Electron, for the case where a log line somehow beats
 * setLogBaseDir. Matches app.getPath('userData') on both platforms so logs never split across two folders.
 */
function fallbackBaseDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    const base = appData !== undefined && appData !== '' ? appData : os.homedir();
    return path.join(base, 'playhook');
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg !== '' ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'playhook');
}

// Resolves (and lazily creates) the log directory, pruning stale day-files the first time.
function resolveDir(): string {
  if (logDir !== null) return logDir;
  const dir = path.join(explicitBaseDir ?? fallbackBaseDir(), 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort; appendFileSync below will surface nothing if this failed
  }
  logDir = dir;
  pruneOldLogs(dir);
  return dir;
}

// Deletes day-files older than RETENTION_DAYS. Only touches files matching the log naming pattern, so
// nothing else in the folder is at risk. Best-effort, per file.
function pruneOldLogs(dir: string): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!LOG_FILE_RE.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full);
      } catch {
        // best-effort: skip a file we can't stat/remove
      }
    }
  } catch {
    // best-effort: the directory read failed, nothing to prune
  }
}

// Local calendar date as YYYY-MM-DD (wall-clock, not UTC) so a day's file matches the user's day.
function dateStamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Recomputed on every write so a running instance rolls over to the new day's file automatically.
function currentLogPath(): string {
  return path.join(resolveDir(), `main-${dateStamp()}.log`);
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: Level, args: readonly unknown[]): void {
  const line = `${new Date().toISOString()} [${level}] ${args.map(format).join(' ')}\n`;
  const mirror = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  mirror(line.trimEnd());
  try {
    fs.appendFileSync(currentLogPath(), line);
  } catch {
    // best-effort: never let logging break the flow
  }
}

export const log = {
  info: (...args: unknown[]): void => write('INFO', args),
  warn: (...args: unknown[]): void => write('WARN', args),
  error: (...args: unknown[]): void => write('ERROR', args),
};

/** Absolute path to today's log file (for the "Open logs" action — its folder — and startup banner). */
export function logFilePath(): string {
  return currentLogPath();
}
