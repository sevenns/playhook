import { describe, expect, it } from 'vitest';
import {
  applicationSupportDir,
  darwinSaveBase,
  darwinToManifestPcSavePath,
  resolveDarwinPcSavePath,
} from '../src/main/platform/save-path.darwin';

const bases = { home: '/Users/deck', documents: '/Users/deck/Documents' } as const;

describe('darwin SavePathResolver — forward mapping', () => {
  it('sends every AppData-family prefix to ~/Library/Application Support', () => {
    expect(darwinSaveBase(bases, 'APPDATA')).toBe('/Users/deck/Library/Application Support');
    expect(darwinSaveBase(bases, 'LOCALAPPDATA')).toBe('/Users/deck/Library/Application Support');
    expect(darwinSaveBase(bases, 'LOCALLOW')).toBe('/Users/deck/Library/Application Support');
  });

  it('sends %USERPROFILE% to the home dir and %DOCUMENTS% to Documents', () => {
    expect(darwinSaveBase(bases, 'USERPROFILE')).toBe('/Users/deck');
    expect(darwinSaveBase(bases, 'DOCUMENTS')).toBe('/Users/deck/Documents');
  });

  it('accepts a lower-cased token and refuses an unknown one', () => {
    expect(darwinSaveBase(bases, 'appdata')).toBe(applicationSupportDir(bases.home));
    expect(darwinSaveBase(bases, 'WINDIR')).toBeNull();
  });

  it('appends the tail, accepting both separators a Windows manifest may use', () => {
    expect(resolveDarwinPcSavePath(bases, '%APPDATA%\\IronGate\\Valheim')).toBe(
      '/Users/deck/Library/Application Support/IronGate/Valheim',
    );
    expect(resolveDarwinPcSavePath(bases, '%LOCALLOW%/IronGate/Valheim')).toBe(
      '/Users/deck/Library/Application Support/IronGate/Valheim',
    );
  });

  it('resolves a bare prefix to the base itself', () => {
    expect(resolveDarwinPcSavePath(bases, '%USERPROFILE%')).toBe('/Users/deck');
  });

  it('refuses a traversal in the tail and a value with no prefix at all', () => {
    expect(resolveDarwinPcSavePath(bases, '%APPDATA%/../../etc')).toBeNull();
    expect(resolveDarwinPcSavePath(bases, '/Users/deck/Games')).toBeNull();
  });
});

describe('darwin SavePathResolver — reverse mapping', () => {
  it('expresses a folder under Application Support with the canonical %APPDATA%', () => {
    expect(
      darwinToManifestPcSavePath(bases, '/Users/deck/Library/Application Support/IronGate/Valheim'),
    ).toBe('%APPDATA%/IronGate/Valheim');
  });

  it('expresses a Documents folder with %DOCUMENTS%', () => {
    expect(darwinToManifestPcSavePath(bases, '/Users/deck/Documents/My Games/Hades')).toBe(
      '%DOCUMENTS%/My Games/Hades',
    );
  });

  it('falls back to %USERPROFILE% only when no longer base matches', () => {
    expect(darwinToManifestPcSavePath(bases, '/Users/deck/Games/Hades')).toBe(
      '%USERPROFILE%/Games/Hades',
    );
  });

  it('returns the bare token for the base itself', () => {
    expect(darwinToManifestPcSavePath(bases, '/Users/deck')).toBe('%USERPROFILE%');
    expect(darwinToManifestPcSavePath(bases, '/Users/deck/Library/Application Support')).toBe(
      '%APPDATA%',
    );
  });

  it('refuses a folder outside the home dir', () => {
    expect(darwinToManifestPcSavePath(bases, '/Volumes/CARD/saves')).toBeNull();
  });

  it('does not mistake a same-prefixed sibling directory for the base', () => {
    expect(darwinToManifestPcSavePath(bases, '/Users/deck2/Games')).toBeNull();
  });

  it('round-trips %APPDATA% but deliberately does NOT restore %LOCALLOW%', () => {
    const absolute = resolveDarwinPcSavePath(bases, '%LOCALLOW%/IronGate/Valheim');
    expect(absolute).not.toBeNull();
    expect(darwinToManifestPcSavePath(bases, absolute ?? '')).toBe('%APPDATA%/IronGate/Valheim');
  });
});
