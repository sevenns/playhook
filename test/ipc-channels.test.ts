// Completeness guard for the IPC contract bridge (audit C2/M-1). The `satisfies Partial<typeof IPC>`
// in each preload catches wrong values and typo'd keys at compile time, but Partial<> CANNOT catch a
// channel that exists in the shared IPC source of truth yet was never exposed by any preload. This
// test closes that gap by reading each preload's CHANNELS map from source (the preloads import
// `electron`, so they can't be imported into a node test) and checking the union equals `IPC` exactly.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC } from '../src/shared/types';

const PRELOAD_FILES = [
  path.resolve(__dirname, '../src/preload/preload.ts'),
  path.resolve(__dirname, '../src/preload/settings-preload.ts'),
];

/** Extracts the string values of the `const CHANNELS = { … }` object literal from a preload source. */
function readChannelValues(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const block = /const CHANNELS =\s*{([\s\S]*?)}\s*as const/.exec(source);
  if (block === null) throw new Error(`no CHANNELS block found in ${path.basename(file)}`);
  return [...block[1]!.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]!);
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

  it('partitions channels between the two preloads with no overlap', () => {
    const [game, settings] = perFile;
    const overlap = game!.values.filter((v) => settings!.values.includes(v));
    expect(overlap).toEqual([]);
  });

  it('has no duplicate channel literals within a single preload', () => {
    for (const { name, values } of perFile) {
      expect(new Set(values).size, `duplicates in ${name}`).toBe(values.length);
    }
  });
});
