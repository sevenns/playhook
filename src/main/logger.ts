// File logger for the main process. There's no console on the target machine (packaged background
// app), so we append timestamped lines to a log file under userData and mirror them to the console
// during development. Writes are synchronous and best-effort: logging must never throw into a flow.
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

type Level = 'INFO' | 'WARN' | 'ERROR';

const MAX_BYTES = 5 * 1024 * 1024; // rotate once past ~5 MB so the file can't grow unbounded

let resolvedPath: string | null = null;

function resolvePath(): string {
  if (resolvedPath !== null) return resolvedPath;
  const dir = path.join(app.getPath('userData'), 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort; appendFileSync below will surface nothing if this failed
  }
  const file = path.join(dir, 'main.log');
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) fs.renameSync(file, `${file}.old`);
  } catch {
    // no existing file — nothing to rotate
  }
  resolvedPath = file;
  return file;
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
    fs.appendFileSync(resolvePath(), line);
  } catch {
    // best-effort: never let logging break the flow
  }
}

export const log = {
  info: (...args: unknown[]): void => write('INFO', args),
  warn: (...args: unknown[]): void => write('WARN', args),
  error: (...args: unknown[]): void => write('ERROR', args),
};

/** Absolute path to the current log file (for the tray "Open logs" action and startup banner). */
export function logFilePath(): string {
  return resolvePath();
}
