// The daemon's import graph must stay free of `electron` and of the koffi-bound modules.
//
// This test exists because the first daemon build crash-looped on the Deck with
// `Cannot find module 'electron'` — thrown from logger.ts before a single line of our code ran. Under
// ELECTRON_RUN_AS_NODE the `electron` module simply does not exist (it is a devDependency, and the runtime
// only injects it for a normal Electron start), so ANY import of it anywhere on the daemon's path is fatal.
//
// Nothing else catches this: tsc and ESLint are happy, the GUI keeps working, and the unit tests import
// these modules under vitest where `electron` is aliased to a stub. It only surfaces on the device. So the
// graph is walked statically here instead.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..');
const DAEMON_ENTRY = path.join(SRC_ROOT, 'src/main/daemon.ts');

/** Resolves a RELATIVE import specifier to a .ts file (bare specifiers are npm packages — not walked). */
function resolveLocal(specifier: string, importer: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Whether an import clause is type-only, i.e. erased at compile time and harmless at runtime. Covers both
 * `import type { X } from` and `import { type X, type Y } from` (tsc drops an import whose every binding
 * is a type). A default or namespace import is always a value import.
 */
function isTypeOnly(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith('type ')) return true;
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((binding) => binding.trim())
    .filter((binding) => binding !== '')
    .every((binding) => binding.startsWith('type '));
}

/**
 * Specifiers a file imports FOR VALUE — the only ones that survive into the emitted JS and can therefore
 * blow up at runtime. Type-only imports are excluded on purpose: `platform/types.ts` legitimately imports
 * `GameProcess` from the koffi-bound game-launcher, and that costs nothing at runtime.
 */
function importsOf(file: string): readonly string[] {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+'([^']+)'/g)) {
    const [, clause = '', specifier = ''] = match;
    if (!isTypeOnly(clause)) specifiers.push(specifier);
  }
  // Bare side-effect imports (`import 'foo'`) execute the module, so they always count.
  for (const match of source.matchAll(/^\s*import\s+'([^']+)'/gm)) {
    specifiers.push(match[1] ?? '');
  }
  return specifiers;
}

/** Walks the daemon's transitive local import graph. */
function daemonGraph(): ReadonlyMap<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>();
  const queue = [DAEMON_ENTRY];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || graph.has(file)) continue;
    const specifiers = importsOf(file);
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      const local = resolveLocal(specifier, file);
      if (local !== null) queue.push(local);
    }
  }
  return graph;
}

/** Files in the graph that import any of `forbidden`, as repo-relative paths. */
function offenders(forbidden: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const [file, specifiers] of daemonGraph()) {
    if (specifiers.some((specifier) => forbidden.includes(specifier))) {
      found.push(path.relative(SRC_ROOT, file));
    }
  }
  return found.sort();
}

describe("the daemon's import graph", () => {
  it('contains no import of `electron` anywhere', () => {
    // A failure here means the daemon will crash-loop under systemd on the Deck. Fix by moving the
    // electron-dependent code into a module only the GUI imports (see steam-uri.ts, split off steam.ts).
    expect(offenders(['electron'])).toEqual([]);
  });

  it('does not pull the koffi-bound win32 modules', () => {
    // The daemon uses createLinuxPlatform() directly rather than createPlatform(), which would import the
    // win32 bundle (registry / power-native / foreground → koffi) into a Linux-only process.
    expect(offenders(['koffi'])).toEqual([]);
  });

  it('actually walks a real graph (guards the test itself against silently matching nothing)', () => {
    const graph = daemonGraph();
    expect(graph.size).toBeGreaterThan(10);
    expect([...graph.keys()].some((file) => file.endsWith('logger.ts'))).toBe(true);
    expect([...graph.keys()].some((file) => file.endsWith('drive-watcher.ts'))).toBe(true);
  });

  it('would catch a violation if one were introduced', () => {
    // Sanity-check the detector against a specifier that IS present, so a broken matcher cannot make the
    // suite pass by finding nothing at all.
    expect(offenders(['node:path']).length).toBeGreaterThan(0);
  });
});
