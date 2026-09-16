// Completeness guard for the IPC contract bridge. The `satisfies Partial<typeof IPC>`
// in each preload catches wrong values and typo'd keys at compile time, but Partial<> CANNOT catch a
// channel that exists in the shared IPC source of truth yet was never exposed by any preload. This
// test closes that gap by reading each preload's CHANNELS map from source (the preloads import
// `electron`, so they can't be imported into a node test) and checking the union equals `IPC` exactly.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC } from '../src/shared/types';

// One preload again, now that the Configure window's is gone — but the test stays written for a LIST.
// The invariant it guards ("every channel is exposed by exactly one preload") is what a second window
// would put at risk, and the pairwise check below costs nothing while there is only one.
const PRELOAD_FILES = [path.resolve(__dirname, '../src/preload/preload.ts')];

/** Extracts the string values of the `const CHANNELS = { … }` object literal from a preload source. */
function readChannelValues(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const body = /const CHANNELS =\s*{([\s\S]*?)}\s*as const/.exec(source)?.[1];
  if (body === undefined) throw new Error(`no CHANNELS block found in ${path.basename(file)}`);
  return [...body.matchAll(/:\s*'([^']+)'/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

describe('IPC channel contract (preload ↔ shared/types)', () => {
  const perFile = PRELOAD_FILES.map((f) => ({ name: path.basename(f), values: readChannelValues(f) }));
  const allPreloadValues = perFile.flatMap((f) => f.values);
  const ipcValues = Object.values(IPC);

  it('exposes every IPC channel across the preloads (no channel is forgotten)', () => {
    const missing = ipcValues.filter((v) => !allPreloadValues.includes(v));
    expect(missing).toEqual([]);
  });

  it('exposes no channel that is absent from the shared IPC map', () => {
    const extra = allPreloadValues.filter((v) => !(ipcValues as string[]).includes(v));
    expect(extra).toEqual([]);
  });

  it('partitions channels across the preloads with no overlap between any pair', () => {
    // Pairwise over N preloads (a hard destructuring of exactly two would silently skip a third slice —
    // the project invariant is "every channel is exposed by EXACTLY one preload").
    for (let i = 0; i < perFile.length; i += 1) {
      for (let j = i + 1; j < perFile.length; j += 1) {
        const a = perFile[i];
        const b = perFile[j];
        if (a === undefined || b === undefined) continue;
        const overlap = a.values.filter((v) => b.values.includes(v));
        expect(overlap, `overlap between ${a.name} and ${b.name}`).toEqual([]);
      }
    }
  });

  it('has no duplicate channel literals within a single preload', () => {
    for (const { name, values } of perFile) {
      expect(new Set(values).size, `duplicates in ${name}`).toBe(values.length);
    }
  });
});

/** Every `.ts` under `dir`, recursively. */
function listTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('IPC channel registration (main)', () => {
  // The handlers are registered by six services' `init()` since the controller split, and Electron
  // refuses a second `ipcMain.handle` on a channel at runtime ("Attempted to register a second handler")
  // — a failure the test stub cannot show, because it lets a later registration replace the earlier one
  // so every test can build its own service. So the sources are read as text: each registration names
  // its channel as an `IPC.<key>` literal, and no key may appear in two registrations.
  const mainDir = path.resolve(__dirname, '../src/main');
  const registrations = listTsFiles(mainDir).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    const calls = [...source.matchAll(/ipcMain\.(?:handle|on)\(/g)].length;
    const keys = [...source.matchAll(/ipcMain\.(?:handle|on)\(\s*IPC\.(\w+)/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    return { file: path.relative(mainDir, file), calls, keys };
  });

  it('names every registered channel as an IPC.<key> literal (so the check below sees them all)', () => {
    for (const { file, calls, keys } of registrations) {
      expect(keys.length, `registrations in ${file} not spelled ipcMain.handle(IPC.<key>`).toBe(calls);
    }
  });

  it('registers each channel at most once across every service', () => {
    const owners = new Map<string, string[]>();
    for (const { file, keys } of registrations) {
      for (const key of keys) owners.set(key, [...(owners.get(key) ?? []), file]);
    }
    const twice = [...owners].filter(([, files]) => files.length > 1);
    expect(twice).toEqual([]);
  });

  it('registers only channels that exist in the shared IPC map', () => {
    const unknown = registrations.flatMap(({ keys }) => keys.filter((key) => !(key in IPC)));
    expect(unknown).toEqual([]);
  });
});
