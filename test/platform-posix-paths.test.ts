// The Linux/macOS side of the platform layer must build paths with `path.posix`, never bare `path.*`.
//
// `path.join` follows the OS the code RUNS on. A Linux path built with it comes out as `\home\deck\...` on
// the Windows CI runner and fails a test that (correctly) expects `/home/deck/...` — and when the value is
// DERIVED from a path (the Steam shortcut appid is a CRC32 of it) nothing fails at all, the number is just
// wrong. CLAUDE.md states the rule and offers a grep; this test is that grep with teeth, in the same
// source-as-text style as daemon-imports.test.ts. Only the win32 modules are exempt: there plain `path`
// IS the right choice.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PLATFORM_DIR = path.join(REPO_ROOT, 'src/main/platform');

/** The win32 bundle and any `*.win32.ts` helper: the only files where bare `path.*` is correct. */
function isWin32Module(file: string): boolean {
  return file === 'win32.ts' || file.endsWith('.win32.ts');
}

/** Every `.ts` under `src/main/platform/`, recursively, as paths relative to that directory. */
function platformSources(dir = PLATFORM_DIR): readonly string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...platformSources(full));
    else if (entry.name.endsWith('.ts')) found.push(path.relative(PLATFORM_DIR, full));
  }
  return found.sort();
}

/**
 * A bare `path.<fn>(` or `path.sep` — `path.posix.join(` does not match because `posix` follows the dot,
 * which is exactly the distinction the rule draws.
 */
const BARE_PATH_CALL = /\bpath\.(?:join|dirname|basename|resolve|relative|normalize|isAbsolute)\(|\bpath\.sep\b/;

/** `file:line: source` for every offending line in a source text. */
function offendingLines(file: string, source: string): readonly string[] {
  return source
    .split('\n')
    .flatMap((line, index) => (BARE_PATH_CALL.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []));
}

/** All violations across the posix-side platform modules. */
function violations(): readonly string[] {
  return platformSources()
    .filter((file) => !isWin32Module(file))
    .flatMap((file) => offendingLines(file, fs.readFileSync(path.join(PLATFORM_DIR, file), 'utf8')));
}

describe('the posix side of the platform layer', () => {
  it('builds every path with `path.posix`, never bare `path.*`', () => {
    // A failure here would surface as a red Windows job with `\home\deck\...` in the assertion diff — or
    // not surface at all when the path only feeds a checksum. Fix the SOURCE (path.posix.join), never the
    // test expectation.
    expect(violations()).toEqual([]);
  });

  it('actually scans the modules the rule is about (guards the test against matching nothing)', () => {
    const scanned = platformSources().filter((file) => !isWin32Module(file));
    expect(scanned).toContain('umu.ts');
    expect(scanned).toContain('game-launcher.linux.ts');
    expect(scanned).toContain('save-path.darwin.ts');
    expect(scanned).not.toContain('win32.ts');
  });

  it('would catch a violation if one were introduced', () => {
    const sample = [
      "const a = path.join(home, 'x');",
      'const b = path.posix.join(home, "x");',
      'const c = path.dirname(file);',
      'const d = path.sep;',
      'const e = path.posix.sep;',
    ].join('\n');
    expect(offendingLines('sample.ts', sample)).toEqual([
      "sample.ts:1: const a = path.join(home, 'x');",
      'sample.ts:3: const c = path.dirname(file);',
      'sample.ts:4: const d = path.sep;',
    ]);
  });
});
