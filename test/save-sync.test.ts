import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withRetry,
  snapshotTree,
  treeChanged,
  syncByChange,
  type SyncState,
  type TreeSnapshot,
} from '../src/main/save-sync';

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('withRetry (busy-file backoff)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the value when the operation succeeds on the first try', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const promise = withRetry(op);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable code (EBUSY) and eventually succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(fsError('EBUSY'))
      .mockRejectedValueOnce(fsError('EPERM'))
      .mockResolvedValue('done');
    const promise = withRetry(op);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('done');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('rethrows a non-retryable error immediately without retrying', async () => {
    const op = vi.fn().mockRejectedValue(fsError('ENOENT'));
    const promise = withRetry(op);
    const assertion = expect(promise).rejects.toThrow('ENOENT');
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after MAX_ATTEMPTS and throws the last error', async () => {
    const op = vi.fn().mockRejectedValue(fsError('EBUSY'));
    const promise = withRetry(op);
    const assertion = expect(promise).rejects.toThrow('EBUSY');
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(5);
  });
});

// ── Change-detection (real fs; each test gets a fresh tmp dir) ─────────────────

// Writes a file with `content` under `dir/rel`, optionally forcing its mtime to `mtimeMs`.
async function putFile(dir: string, rel: string, content: string, mtimeMs?: number): Promise<void> {
  const full = path.join(dir, rel);
  await fse.ensureDir(path.dirname(full));
  await fse.writeFile(full, content);
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000;
    await fse.utimes(full, seconds, seconds);
  }
}

describe('snapshotTree', () => {
  let root: string;
  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'snap-'));
  });
  afterEach(async () => {
    await fse.remove(root);
  });

  it('returns {} for a missing folder', async () => {
    const snap = await snapshotTree(path.join(root, 'nope'));
    expect(snap).toEqual({});
  });

  it('records files with POSIX-relative keys, recursing into subfolders', async () => {
    await putFile(root, 'a.sav', 'a');
    await putFile(root, path.join('sub', 'b.sav'), 'b');
    const snap = await snapshotTree(root);
    expect(Object.keys(snap).sort()).toEqual(['a.sav', 'sub/b.sav']);
    expect(typeof snap['a.sav']).toBe('number');
  });

  it('ignores empty subfolders (only files are recorded)', async () => {
    await fse.ensureDir(path.join(root, 'empty', 'deeper'));
    const snap = await snapshotTree(root);
    expect(snap).toEqual({});
  });
});

describe('treeChanged', () => {
  const base: TreeSnapshot = { 'a.sav': 1_000_000, 'b.sav': 2_000_000 };

  it('is false for an identical tree', () => {
    expect(treeChanged({ ...base }, base)).toBe(false);
  });

  it('is true when a file was added', () => {
    expect(treeChanged({ ...base, 'c.sav': 3_000_000 }, base)).toBe(true);
  });

  it('is true when a file was removed', () => {
    expect(treeChanged({ 'a.sav': 1_000_000 }, base)).toBe(true);
  });

  it('is true when a common file mtime grew beyond tolerance', () => {
    expect(treeChanged({ ...base, 'a.sav': 1_000_000 + 5_000 }, base)).toBe(true);
  });

  it('is false when a common file mtime grew within tolerance (FAT jitter)', () => {
    expect(treeChanged({ ...base, 'a.sav': 1_000_000 + 1_000 }, base)).toBe(false);
  });

  it('is false when a common file mtime shrank', () => {
    expect(treeChanged({ ...base, 'a.sav': 1_000_000 - 5_000 }, base)).toBe(false);
  });
});

describe('syncByChange', () => {
  let card: string;
  let pc: string;
  beforeEach(async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'sync-'));
    card = path.join(tmp, 'card');
    pc = path.join(tmp, 'pc');
    await fse.ensureDir(card);
    await fse.ensureDir(pc);
  });
  afterEach(async () => {
    await fse.remove(path.dirname(card));
  });

  // Snapshots both sides into a baseline "as if just synced".
  async function baselineNow(): Promise<SyncState> {
    return { card: await snapshotTree(card), pc: await snapshotTree(pc), syncedAt: Date.now() };
  }

  it('with no baseline uses the fallback direction and records a baseline', async () => {
    await putFile(card, 'save.dat', 'from-card');
    const result = await syncByChange(card, pc, null, 'card-to-pc');
    expect(result.direction).toBe('card-to-pc');
    expect(result.usedFallback).toBe(true);
    expect(await fse.readFile(path.join(pc, 'save.dat'), 'utf8')).toBe('from-card');
    expect(Object.keys(result.state.pc)).toContain('save.dat');
  });

  it('noop when neither side changed — no .tmp/.bak churn', async () => {
    await putFile(card, 'save.dat', 'x');
    await putFile(pc, 'save.dat', 'x');
    const baseline = await baselineNow();
    const result = await syncByChange(card, pc, baseline, 'card-to-pc');
    expect(result.direction).toBe('noop');
    expect(await fse.pathExists(`${pc}.bak`)).toBe(false);
    expect(await fse.pathExists(`${card}.bak`)).toBe(false);
  });

  it('card changed → card-to-pc', async () => {
    await putFile(card, 'save.dat', 'old');
    await putFile(pc, 'save.dat', 'old');
    const baseline = await baselineNow();
    await putFile(card, 'save.dat', 'new-card', Date.now() + 60_000);
    const result = await syncByChange(card, pc, baseline, 'pc-to-card');
    expect(result.direction).toBe('card-to-pc');
    expect(await fse.readFile(path.join(pc, 'save.dat'), 'utf8')).toBe('new-card');
  });

  it('pc changed → pc-to-card', async () => {
    await putFile(card, 'save.dat', 'old');
    await putFile(pc, 'save.dat', 'old');
    const baseline = await baselineNow();
    await putFile(pc, 'save.dat', 'new-pc', Date.now() + 60_000);
    const result = await syncByChange(card, pc, baseline, 'card-to-pc');
    expect(result.direction).toBe('pc-to-card');
    expect(await fse.readFile(path.join(card, 'save.dat'), 'utf8')).toBe('new-pc');
  });

  it('a deletion on one side propagates (that side is the source)', async () => {
    await putFile(card, 'keep.dat', 'k');
    await putFile(card, 'gone.dat', 'g');
    await putFile(pc, 'keep.dat', 'k');
    await putFile(pc, 'gone.dat', 'g');
    const baseline = await baselineNow();
    await fse.remove(path.join(card, 'gone.dat')); // deleted on the card → card is the changed side
    const result = await syncByChange(card, pc, baseline, 'pc-to-card');
    expect(result.direction).toBe('card-to-pc');
    expect(await fse.pathExists(path.join(pc, 'gone.dat'))).toBe(false);
    expect(await fse.pathExists(path.join(pc, 'keep.dat'))).toBe(true);
  });

  it('both changed → conflict, LWW tiebreak to the newer side (card newer)', async () => {
    await putFile(card, 'save.dat', 'old');
    await putFile(pc, 'save.dat', 'old');
    const baseline = await baselineNow();
    const now = Date.now();
    await putFile(pc, 'save.dat', 'pc-edit', now + 10_000);
    await putFile(card, 'save.dat', 'card-edit', now + 90_000); // card is newer → wins
    const result = await syncByChange(card, pc, baseline, 'card-to-pc');
    expect(result.conflict).toBe(true);
    expect(result.direction).toBe('card-to-pc');
    expect(await fse.readFile(path.join(pc, 'save.dat'), 'utf8')).toBe('card-edit');
  });

  it('a folder of only empty subdirs reads as "not changed"', async () => {
    await fse.ensureDir(path.join(card, 'empty'));
    await fse.ensureDir(path.join(pc, 'empty'));
    const baseline = await baselineNow();
    const result = await syncByChange(card, pc, baseline, 'card-to-pc');
    expect(result.direction).toBe('noop');
  });
});
