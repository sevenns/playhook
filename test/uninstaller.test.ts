// The pure parts of uninstaller.win32.ts: the silent flags per installer family, the CommandLineToArgvW
// parser behind the registry fallback, the in-dir uninstaller search and the backed-off sweep. The
// registry path itself (advapi32 through koffi) is not driven here.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findUninstallerInDir,
  parseCommandLine,
  removeWithRetry,
  silentUninstallArgs,
} from '../src/main/uninstaller.win32';

describe('silentUninstallArgs', () => {
  it('knows the nsis and inno silent conventions and has none for custom', () => {
    expect(silentUninstallArgs('nsis')).toEqual(['/S']);
    expect(silentUninstallArgs('inno')).toEqual(['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
    expect(silentUninstallArgs('custom')).toEqual([]);
  });
});

describe('parseCommandLine', () => {
  it('splits on unquoted whitespace and drops the quotes around a token', () => {
    expect(parseCommandLine('"C:\\Games\\My Game\\unins000.exe" /SILENT')).toEqual([
      'C:\\Games\\My Game\\unins000.exe',
      '/SILENT',
    ]);
  });

  it('keeps spaces inside quotes and collapses runs of separators', () => {
    expect(parseCommandLine('  a  "b c"\t d ')).toEqual(['a', 'b c', 'd']);
  });

  it('follows the CommandLineToArgvW backslash rules before a quote', () => {
    // 2n backslashes + quote → n backslashes, quote toggles; 2n+1 → n backslashes + a literal quote.
    expect(parseCommandLine('a\\\\"b c"')).toEqual(['a\\b c']);
    expect(parseCommandLine('a\\"b')).toEqual(['a"b']);
    expect(parseCommandLine('"C:\\dir\\\\" x')).toEqual(['C:\\dir\\', 'x']);
  });

  it('keeps backslashes that are not followed by a quote verbatim', () => {
    expect(parseCommandLine('C:\\a\\\\b\\c')).toEqual(['C:\\a\\\\b\\c']);
  });

  it('returns nothing for an empty or blank line', () => {
    expect(parseCommandLine('')).toEqual([]);
    expect(parseCommandLine('   ')).toEqual([]);
  });
});

describe('findUninstallerInDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-uninstaller-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('picks the highest-numbered Inno uninstaller', async () => {
    await fs.writeFile(path.join(dir, 'unins000.exe'), '');
    await fs.writeFile(path.join(dir, 'unins001.exe'), '');
    await fs.writeFile(path.join(dir, 'game.exe'), '');
    expect(await findUninstallerInDir(dir, 'inno')).toBe(path.join(dir, 'unins001.exe'));
  });

  it('finds an NSIS Uninstall.exe / uninst*.exe in the root, case-insensitively', async () => {
    await fs.writeFile(path.join(dir, 'UNINSTALL.EXE'), '');
    expect(await findUninstallerInDir(dir, 'nsis')).toBe(path.join(dir, 'UNINSTALL.EXE'));
  });

  it('answers null for custom, for a missing dir and when nothing matches', async () => {
    await fs.writeFile(path.join(dir, 'unins000.exe'), '');
    expect(await findUninstallerInDir(dir, 'custom')).toBeNull();
    expect(await findUninstallerInDir(path.join(dir, 'missing'), 'inno')).toBeNull();
    expect(await findUninstallerInDir(dir, 'nsis')).toBeNull();
  });
});

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
