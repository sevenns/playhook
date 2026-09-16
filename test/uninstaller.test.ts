// The pure parts of uninstaller.win32.ts: the silent flags per installer family, the CommandLineToArgvW
// parser behind the registry fallback, the in-dir uninstaller search and the two resolveUninstaller
// outcomes that never reach the registry. The registry path itself (advapi32 through koffi) is not
// driven here; the backed-off sweep has its own suite (test/remove-with-retry.test.ts).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findUninstallerInDir,
  parseCommandLine,
  resolveUninstaller,
  silentUninstallArgs,
} from '../src/main/uninstaller.win32';
import type { ResolvedInstallerRun } from '../src/main/manifest-types';

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

  it('keeps an empty quoted token, and a quote inside a token only toggles quoting', () => {
    expect(parseCommandLine('a "" b')).toEqual(['a', '', 'b']);
    expect(parseCommandLine('/DIR="C:\\x" /S')).toEqual(['/DIR=C:\\x', '/S']);
  });

  it('runs an unclosed quote to the end of the line, like CommandLineToArgvW', () => {
    expect(parseCommandLine('"C:\\x\\a b')).toEqual(['C:\\x\\a b']);
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

describe('resolveUninstaller (the outcomes that never reach the registry)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-resolve-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function install(type: ResolvedInstallerRun['type'], runAsAdmin = false): ResolvedInstallerRun {
    return {
      type,
      installerPath: path.join(dir, 'setup.exe'),
      runAsAdmin,
      args: [],
      winetricks: [],
      dir,
      installerDir: dir,
    };
  }

  it('an uninstaller found in the install dir runs from there with the family silent flags', async () => {
    await fs.writeFile(path.join(dir, 'unins000.exe'), '');
    expect(await resolveUninstaller(install('inno', true))).toEqual({
      file: path.join(dir, 'unins000.exe'),
      args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'],
      cwd: dir,
      runAsAdmin: true,
    });
  });

  it('custom resolves to nothing — no FS convention and no registry fallback — so the sweep alone runs', async () => {
    await fs.writeFile(path.join(dir, 'unins000.exe'), '');
    expect(await resolveUninstaller(install('custom'))).toBeNull();
  });
});
