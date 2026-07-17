import { describe, expect, it } from 'vitest';
import {
  resolveInsideWinePrefix,
  winePrefixToManifestPcSavePath,
} from '../src/main/platform/save-path.linux';

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
