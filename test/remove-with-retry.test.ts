// The backed-off directory sweep behind every uninstall path (win32 uninstall, linux prefix cleanup).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeWithRetry } from '../src/main/remove-with-retry';

describe('removeWithRetry', () => {
  it('removes a directory and treats an already-missing one as done', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-remove-'));
    await fs.writeFile(path.join(dir, 'file'), '');
    await removeWithRetry(dir);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await removeWithRetry(dir);
  });

  it('gives up after the retries with the last error, and returns silently once aborted', async () => {
    // A NUL byte makes every attempt throw, so the loop actually retries (300 + 600 ms of back-off).
    const bad = path.join(os.tmpdir(), 'playhook\0remove');
    await expect(removeWithRetry(bad)).rejects.toBeInstanceOf(Error);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    await expect(removeWithRetry(bad, abort.signal)).resolves.toBeUndefined();
  }, 5000);
});
