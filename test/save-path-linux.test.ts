import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLinuxSavePathResolver,
  resolveInsideWinePrefix,
  winePrefixToManifestPcSavePath,
} from '../src/main/platform/save-path.linux';
import type { GameManifest, ResolvedManifest } from '../src/shared/types';

const PFX = '/home/deck/.config/playhook/prefixes/mygame';
const HOME = `${PFX}/drive_c/users/steamuser`;

describe('resolveInsideWinePrefix — %PREFIX% → Wine prefix mapping (Р5)', () => {
  it('maps %APPDATA% to AppData/Roaming', () => {
    expect(resolveInsideWinePrefix(PFX, '%APPDATA%\\My Game\\Saves')).toBe(
      `${HOME}/AppData/Roaming/My Game/Saves`,
    );
  });

  it('maps %LOCALAPPDATA% to AppData/Local', () => {
    expect(resolveInsideWinePrefix(PFX, '%LOCALAPPDATA%\\Foo')).toBe(`${HOME}/AppData/Local/Foo`);
  });

  it('maps %LOCALLOW% to AppData/LocalLow', () => {
    expect(resolveInsideWinePrefix(PFX, '%LOCALLOW%\\Unity\\Game')).toBe(
      `${HOME}/AppData/LocalLow/Unity/Game`,
    );
  });

  it('maps %USERPROFILE% to the steamuser home itself', () => {
    expect(resolveInsideWinePrefix(PFX, '%USERPROFILE%\\Saved Games')).toBe(`${HOME}/Saved Games`);
    // Bare prefix (no tail) → the home root.
    expect(resolveInsideWinePrefix(PFX, '%USERPROFILE%')).toBe(HOME);
  });

  it('maps %DOCUMENTS% to Documents', () => {
    expect(resolveInsideWinePrefix(PFX, '%DOCUMENTS%\\My Game')).toBe(`${HOME}/Documents/My Game`);
  });

  it('accepts both separators in the tail (a Windows manifest may use / or \\)', () => {
    expect(resolveInsideWinePrefix(PFX, '%APPDATA%/Foo/Bar')).toBe(`${HOME}/AppData/Roaming/Foo/Bar`);
    expect(resolveInsideWinePrefix(PFX, '%APPDATA%\\Foo\\Bar')).toBe(`${HOME}/AppData/Roaming/Foo/Bar`);
  });

  it('works with a Steam compatdata prefix root (same steamuser layout)', () => {
    const compat = '/home/deck/.local/share/Steam/steamapps/compatdata/814380/pfx';
    expect(resolveInsideWinePrefix(compat, '%LOCALLOW%\\Elden')).toBe(
      `${compat}/drive_c/users/steamuser/AppData/LocalLow/Elden`,
    );
  });

  it('rejects an unknown prefix token', () => {
    expect(resolveInsideWinePrefix(PFX, '%WINDIR%\\System32')).toBeNull();
  });

  it('rejects a non-prefixed (absolute) path', () => {
    expect(resolveInsideWinePrefix(PFX, 'C:\\Users\\me\\Saves')).toBeNull();
  });

  it('rejects a traversal in the tail', () => {
    expect(resolveInsideWinePrefix(PFX, '%APPDATA%\\..\\..\\Windows')).toBeNull();
  });
});

describe('winePrefixToManifestPcSavePath — Configure Browse reverse mapping (Р5)', () => {
  it('maps a picked folder inside the prefix back to its %PREFIX% token', () => {
    expect(winePrefixToManifestPcSavePath(`${HOME}/AppData/Local/Saves`)).toBe('%LOCALAPPDATA%/Saves');
    expect(winePrefixToManifestPcSavePath(`${HOME}/AppData/Roaming/My Game/Saves`)).toBe(
      '%APPDATA%/My Game/Saves',
    );
    expect(winePrefixToManifestPcSavePath(`${HOME}/Documents/My Game`)).toBe('%DOCUMENTS%/My Game');
  });

  it('never mistakes AppData/LocalLow for AppData/Local (segment-wise match)', () => {
    expect(winePrefixToManifestPcSavePath(`${HOME}/AppData/LocalLow/Unity/Game`)).toBe(
      '%LOCALLOW%/Unity/Game',
    );
  });

  it('falls back to %USERPROFILE% only for a folder outside the known bases', () => {
    expect(winePrefixToManifestPcSavePath(`${HOME}/Saved Games/Game`)).toBe('%USERPROFILE%/Saved Games/Game');
    // The steamuser home itself → the bare token.
    expect(winePrefixToManifestPcSavePath(HOME)).toBe('%USERPROFILE%');
  });

  it('works for a Steam compatdata prefix too (any prefix — only the part below drive_c matters)', () => {
    const compat = '/home/deck/.local/share/Steam/steamapps/compatdata/814380/pfx';
    expect(winePrefixToManifestPcSavePath(`${compat}/drive_c/users/steamuser/AppData/LocalLow/Elden`)).toBe(
      '%LOCALLOW%/Elden',
    );
  });

  it('rejects a folder that lives in no Wine prefix (not a Windows save location)', () => {
    expect(winePrefixToManifestPcSavePath('/home/deck/Documents/MyGame')).toBeNull();
    expect(winePrefixToManifestPcSavePath('/run/media/deck/CARD/saves')).toBeNull();
  });

  it('round-trips with resolveInsideWinePrefix (forward → reverse → same string)', () => {
    for (const manifestPath of ['%APPDATA%/My Game/Saves', '%LOCALLOW%/Unity/Game', '%USERPROFILE%']) {
      const forward = resolveInsideWinePrefix(PFX, manifestPath);
      expect(forward).not.toBeNull();
      expect(winePrefixToManifestPcSavePath(forward as string)).toBe(manifestPath);
    }
  });
});

// The two ways a LOCAL game (source: 'pc') can name its saves, and why the resolver must keep them apart:
// an ordinary local game browses to a host folder and gets an absolute path, a local STEAM game's saves
// live inside Steam's compatdata prefix and can only be named with a %PREFIX% token.
describe('createLinuxSavePathResolver — a local game vs a local Steam game', () => {
  const appid = 1145360;
  let base: string;
  let steamPath: string;
  let compat: string;

  const deps = (): Parameters<typeof createLinuxSavePathResolver>[0] => ({
    userData: path.join(base, 'userData'),
    steamLocator: {
      locateSteam: async (): Promise<string | null> => steamPath,
      steamExecutable: async (): Promise<string | null> => null,
    },
  });

  const raw: GameManifest = { schemaVersion: 1, id: 'hades', title: 'Hades' };
  const manifest = (over: Partial<ResolvedManifest>): ResolvedManifest => ({
    raw,
    root: path.join(base, 'pc-games'),
    source: 'pc',
    executablePath: '',
    cwd: '',
    ...over,
  });

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'playhook-savepath-'));
    steamPath = path.join(base, 'Steam');
    compat = path.join(steamPath, 'steamapps', 'compatdata', String(appid), 'pfx');
    await fs.mkdir(compat, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('resolves a local STEAM game into compatdata — not the host fs, not our own prefix', async () => {
    const resolver = createLinuxSavePathResolver(deps());
    const location = await resolver.resolvePcSavePath(
      manifest({ steam: { appid } }),
      '%APPDATA%\\Hades\\Saves',
    );
    expect(location).not.toBeNull();
    // Asserted as "under compatdata + the Windows-profile tail" rather than one literal, because the
    // compatdata root is a real temp dir whose separators follow the OS the suite runs on (CI runs it on
    // Windows too) — the tail below drive_c is the part this mapping owns.
    expect(location?.path.startsWith(compat)).toBe(true);
    expect(location?.path.endsWith('drive_c/users/steamuser/AppData/Roaming/Hades/Saves')).toBe(true);
    expect(location?.containerExists).toBe(true);
  });

  it('keeps an ordinary local game`s absolute path verbatim (the host fs IS its container)', async () => {
    const resolver = createLinuxSavePathResolver(deps());
    const location = await resolver.resolvePcSavePath(manifest({}), '/home/deck/Games/Hades/Saves');
    expect(location).toEqual({ path: '/home/deck/Games/Hades/Saves', containerExists: true });
  });

  it('is a no-op while Steam has made no compatdata for the game yet', async () => {
    await fs.rm(path.join(steamPath, 'steamapps'), { recursive: true, force: true });
    const resolver = createLinuxSavePathResolver(deps());
    const location = await resolver.resolvePcSavePath(manifest({ steam: { appid } }), '%APPDATA%\\Hades');
    expect(location).toBeNull();
  });
});
