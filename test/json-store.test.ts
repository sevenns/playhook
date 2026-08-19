// The atomic write and its fallback. The fallback is the interesting half: a per-user install taking
// over a %APPDATA% file an all-users one left behind cannot RENAME over it (that needs delete rights,
// which are separate from write rights), and every settings change then failed silently.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/main/json-store';

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-json-store-'));
  });

  afterEach(async () => {
    // chmod back first: a read-only file inside the dir would otherwise block the cleanup on some hosts.
    await fs
      .chmod(path.join(dir, 'settings.json'), 0o666)
      .catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a file that is not there yet', async () => {
    const target = path.join(dir, 'settings.json');
    await writeFileAtomic(target, '{"a":1}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"a":1}');
  });

  it('replaces an existing file', async () => {
    const target = path.join(dir, 'settings.json');
    await fs.writeFile(target, 'old');
    await writeFileAtomic(target, 'new');
    expect(await fs.readFile(target, 'utf8')).toBe('new');
  });

  it('leaves no .tmp behind on a normal write', async () => {
    const target = path.join(dir, 'settings.json');
    await writeFileAtomic(target, 'x');
    expect(await fs.readdir(dir)).toEqual(['settings.json']);
  });

  // The regression this was written for: a READ-ONLY target. On Windows that alone makes the atomic
  // replace fail outright (EPERM), which is what left settings silently unsaved — so it is the WINDOWS
  // CI job that exercises the fallback here. On posix `rename` only needs write on the DIRECTORY, so the
  // same case goes through the normal atomic path; the assertion holds either way, which is the point.
  it('still writes when the target is read-only', async () => {
    const target = path.join(dir, 'settings.json');
    await fs.writeFile(target, 'old');
    await fs.chmod(target, 0o444);
    await writeFileAtomic(target, 'new');
    expect(await fs.readFile(target, 'utf8')).toBe('new');
    expect(await fs.readdir(dir)).toEqual(['settings.json']);
  });

  it('propagates a failure that no fallback can rescue (unwritable directory)', async () => {
    const target = path.join(dir, 'missing-dir', 'settings.json');
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow();
  });

  it('leaves no .tmp behind when the write fails', async () => {
    await expect(writeFileAtomic(path.join(dir, 'missing-dir', 'x.json'), 'x')).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  // Concurrent writers of the SAME file used to share one `<file>.tmp`: the first rename consumed it and
  // the rest failed with ENOENT (the history index lost five writes in a row this way while a card's
  // games were copied in). Each write now gets a temp of its own, so they all land.
  it('survives concurrent writes to the same file', async () => {
    const target = path.join(dir, 'index.json');
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => writeFileAtomic(target, `write-${i}`)),
    );
    expect(await fs.readFile(target, 'utf8')).toMatch(/^write-\d$/);
    expect(await fs.readdir(dir)).toEqual(['index.json']);
  });
});
