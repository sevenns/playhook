// A ratchet on the size of the largest source files and screen factories: they may only shrink.
//
// The July 2026 audit split ipc.ts (→ 953 lines) and app.ts (→ 195). Six hundred commits later they were
// 2833 and 1168, and game-settings-screen.ts had grown from nothing to 2942 — a split that is not held in
// place mechanically does not hold. A `max-lines` threshold would not do: it measures with `skipComments`
// (different numbers from every plan and PR description), a threshold invites arguing about the number,
// and it cannot see a 3000-line file split into four files of 1400. A ratchet has no threshold to argue
// about: nobody may grow, and whoever shrinks a file records the win here so it cannot be given back.
//
// Both baselines are RAW line counts (`wc -l`, comments included) — the one metric everybody can reproduce
// from the shell. When you shrink a file, lower its entry; when a file drops below the free limit, delete
// the entry. When you grow one, split it instead.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/** Any `src/**` file NOT listed in `FILE_BASELINE` must stay at or under this. */
const FREE_LIMIT = 1000;

/** A file that shrank by more than this since its entry must have the entry lowered (keeps the ratchet honest). */
const SLACK = 50;

/** Baseline `wc -l` per file over the free limit at the time of writing (playhook v0.8.1). */
const FILE_BASELINE: Readonly<Record<string, number>> = {
  'src/main/game-config.ts': 1478,
  'src/main/ipc.ts': 2561,
  'src/main/manifest.ts': 1125,
  'src/renderer/app.ts': 1168,
  'src/renderer/controls.ts': 2188,
  'src/renderer/game-settings-screen.ts': 2942,
  'src/renderer/online-picker.ts': 1322,
  'src/renderer/settings-screen.ts': 1193,
  'src/shared/types.ts': 1693,
};

interface FactoryBaseline {
  readonly file: string;
  readonly name: string;
  readonly lines: number;
}

/**
 * The screen factories that are each a single closure: measured from `export function <name>(` to the
 * next `}` alone on a line at column zero. Anything moved out of the closure into a module of its own
 * (a menu stack, a lightbox, a popup) lowers the number here.
 */
const FACTORY_BASELINE: readonly FactoryBaseline[] = [
  { file: 'src/renderer/game-settings-screen.ts', name: 'createGameSettingsScreen', lines: 2627 },
  { file: 'src/renderer/controls.ts', name: 'createControls', lines: 1936 },
  { file: 'src/renderer/online-picker.ts', name: 'createOnlinePicker', lines: 1174 },
  { file: 'src/renderer/settings-screen.ts', name: 'createSettingsScreen', lines: 998 },
];

/** Source lines regardless of line endings (a Windows checkout without .gitattributes has CRLF). */
function splitLines(source: string): readonly string[] {
  return source.split(/\r?\n/);
}

/** `wc -l`: the number of newline characters. */
function lineCount(source: string): number {
  let count = 0;
  for (const char of source) if (char === '\n') count += 1;
  return count;
}

/** Every `.ts` under `src/`, recursively, as repo-relative POSIX paths. */
function sourceFiles(dir = SRC_ROOT): readonly string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
  }
  return found.sort();
}

function readSource(file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/**
 * Lines spanned by the top-level function `name`, from its `export function` line to the first `}` on a
 * line of its own at column zero after it; null when the function is not found.
 */
function functionSpan(source: string, name: string): number | null {
  const lines = splitLines(source);
  const start = lines.findIndex((line) => line.startsWith(`export function ${name}(`));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line === '}');
  return end === -1 ? null : end - start + 1;
}

/** One `file: actual > allowed` line per file that grew past its baseline (or past the free limit). */
function grownFiles(): readonly string[] {
  return sourceFiles().flatMap((file) => {
    const actual = lineCount(readSource(file));
    const allowed = FILE_BASELINE[file] ?? FREE_LIMIT;
    return actual > allowed ? [`${file}: ${actual} > ${allowed}`] : [];
  });
}

/** Baseline entries that no longer describe the file: stale (file gone / below the free limit) or too generous. */
function staleFileEntries(): readonly string[] {
  return Object.entries(FILE_BASELINE).flatMap(([file, baseline]) => {
    if (!fs.existsSync(path.join(REPO_ROOT, file))) return [`${file}: file is gone — delete its entry`];
    const actual = lineCount(readSource(file));
    if (actual <= FREE_LIMIT) return [`${file}: ${actual} ≤ ${FREE_LIMIT} — delete its entry, the free limit covers it`];
    if (actual < baseline - SLACK) return [`${file}: ${actual}, entry says ${baseline} — lower the entry`];
    return [];
  });
}

describe('file size ratchet (raw lines, wc -l)', () => {
  it('no src/** file grew past its baseline (or past the free limit when it has none)', () => {
    // Split the file; do not raise the number. The baseline exists to be lowered.
    expect(grownFiles()).toEqual([]);
  });

  it('every baseline entry still describes its file (lower it after a split; delete it under the free limit)', () => {
    expect(staleFileEntries()).toEqual([]);
  });

  it('the screen factories did not grow, and a shrink was recorded', () => {
    const problems = FACTORY_BASELINE.flatMap(({ file, name, lines }) => {
      const actual = functionSpan(readSource(file), name);
      if (actual === null) return [`${file}: ${name} not found — update or delete its entry`];
      if (actual > lines) return [`${file}: ${name} is ${actual} lines > ${lines}`];
      if (actual < lines - SLACK) return [`${file}: ${name} is ${actual} lines, entry says ${lines} — lower the entry`];
      return [];
    });
    expect(problems).toEqual([]);
  });

  it('measures like wc -l and finds a function span (guards the detectors themselves)', () => {
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\nb')).toBe(1);
    expect(lineCount('')).toBe(0);
    const sample = ['import x from "y";', '', 'export function createThing(deps: Deps): Thing {', '  return {};', '}', ''].join('\n');
    expect(functionSpan(sample, 'createThing')).toBe(3);
    expect(functionSpan(sample, 'createOther')).toBeNull();
    expect(functionSpan(sample.replace(/\n/g, '\r\n'), 'createThing')).toBe(3);
    expect(sourceFiles().length).toBeGreaterThan(50);
  });
});
