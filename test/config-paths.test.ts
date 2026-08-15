// The path rules the in-launcher file picker leans on. They used to be the native dialog's job (its
// filters decided what could be picked at all), so they were never expressible as a test; now that a
// renderer names the path, they are the gate — see the plan, Р5.1/Р5.2.
//
// The paths here are HOST paths (a card root is `E:\` on Windows and `/run/media/deck/…` on the Deck), so
// expectations are built with `path.join` from the platform root rather than written as posix literals —
// the same shape test/pc-library.test.ts already uses for the library's own absolute paths. The one thing
// asserted as a literal is what lands in the MANIFEST, which is forward-slashed on both.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptsExtensions,
  checkPickedType,
  picksDirectory,
  startDirFor,
  toCardRelative,
  type PickedStat,
} from '../src/main/config-paths';

const file: PickedStat = { isSymbolicLink: false, isDirectory: false, isFile: true };
const dir: PickedStat = { isSymbolicLink: false, isDirectory: true, isFile: false };
const link: PickedStat = { isSymbolicLink: true, isDirectory: false, isFile: false };

const root = path.join(path.resolve(path.sep), 'card');
const home = path.join(path.resolve(path.sep), 'home', 'deck');
const appData = path.join(path.resolve(path.sep), 'home', 'deck', 'AppData', 'Roaming');

describe('acceptsExtensions', () => {
  it('holds a CARD field to .exe on both platforms (a card is a Windows dictionary)', () => {
    expect(acceptsExtensions('executable', 'win32')).toEqual(['exe']);
    expect(acceptsExtensions('executable', 'linux')).toEqual(['exe']);
    expect(acceptsExtensions('installer', 'linux')).toEqual(['exe']);
  });

  it('only nudges for a LOCAL executable on Windows, and allows anything on Linux', () => {
    expect(acceptsExtensions('pc-executable', 'win32')).toEqual(['exe', 'bat', 'cmd', 'lnk']);
    expect(acceptsExtensions('pc-executable', 'linux')).toBeNull();
  });

  it('leaves the asset kinds to the caller (the AssetReader owns those lists)', () => {
    expect(acceptsExtensions('image', 'linux')).toBeNull();
    expect(acceptsExtensions('audio', 'linux')).toBeNull();
  });
});

describe('picksDirectory', () => {
  it('is true exactly for the folder-shaped fields', () => {
    expect(picksDirectory('directory')).toBe(true);
    expect(picksDirectory('pc-save')).toBe(true);
    expect(picksDirectory('pc-save-local')).toBe(true);
    expect(picksDirectory('image')).toBe(false);
    expect(picksDirectory('executable')).toBe(false);
  });
});

describe('checkPickedType', () => {
  const images = ['jpg', 'png'];

  it('accepts a file whose extension matches the kind', () => {
    expect(checkPickedType('/x/hero.png', 'image', file, images)).toBeNull();
  });

  it('refuses a private key offered as a hero image (the attack Р5.1 names)', () => {
    expect(checkPickedType('/home/deck/.ssh/id_rsa', 'image', file, images)).toBe('wrong-type');
  });

  it('refuses a symlink rather than following it', () => {
    expect(checkPickedType('/x/hero.png', 'image', link, images)).toBe('symlink');
  });

  it('refuses a path that is not there', () => {
    expect(checkPickedType('/x/hero.png', 'image', null, images)).toBe('missing');
  });

  it('requires a folder for a folder field, and a file for a file field', () => {
    expect(checkPickedType('/x/saves', 'directory', dir, null)).toBeNull();
    expect(checkPickedType('/x/saves', 'directory', file, null)).toBe('needs-folder');
    expect(checkPickedType('/x/game.exe', 'executable', dir, ['exe'])).toBe('needs-file');
  });

  it('compares the extension case-insensitively', () => {
    expect(checkPickedType('/x/GAME.EXE', 'executable', file, ['exe'])).toBeNull();
  });

  it('accepts any extension when the kind has no list', () => {
    expect(checkPickedType('/x/hades', 'pc-executable', file, null)).toBeNull();
  });
});

describe('toCardRelative', () => {
  it('makes a card-relative, forward-slashed manifest path', () => {
    expect(toCardRelative(root, path.join(root, 'Hades', 'Hades.exe'))).toBe('Hades/Hades.exe');
  });

  it('refuses a path outside the card instead of emitting a `..` escape', () => {
    expect(
      toCardRelative(root, path.join(path.resolve(path.sep), 'elsewhere', 'x.exe')),
    ).toBeNull();
  });

  it('refuses the card root itself (an empty relative the schema would reject)', () => {
    expect(toCardRelative(root, root)).toBeNull();
  });
});

describe('startDirFor', () => {
  const downloads = path.join(home, 'Downloads');
  const env = {
    homeDir: home,
    appDataDir: appData,
    downloadsDir: downloads,
    rootIsCard: true,
  };

  it('reopens where a filled card-relative value points', () => {
    expect(startDirFor({ root, kind: 'executable', current: 'Hades/Hades.exe' }, env)).toBe(
      path.join(root, 'Hades'),
    );
  });

  it('reopens where a filled ABSOLUTE value points', () => {
    const exe = path.join(home, 'Games', 'Hades', 'Hades.exe');
    expect(startDirFor({ kind: 'pc-executable', current: exe }, env)).toBe(path.dirname(exe));
  });

  it('ignores a %PREFIX% value — it names no host directory', () => {
    expect(startDirFor({ kind: 'pc-save', current: '%APPDATA%/Hades' }, env)).toBe(appData);
  });

  it('starts a card field at the card root', () => {
    expect(startDirFor({ root, kind: 'image' }, env)).toBe(root);
  });

  // Artwork and music for a LOCAL game were downloaded a minute ago far more often than they were
  // authored in place, and the library root itself holds only what we already copied into it.
  it('starts a local library artwork field in Downloads, not at the library root', () => {
    expect(startDirFor({ root, kind: 'image' }, { ...env, rootIsCard: false })).toBe(downloads);
    expect(startDirFor({ root, kind: 'audio' }, { ...env, rootIsCard: false })).toBe(downloads);
  });

  // The game writes its saves on the PC whatever it was launched from, so a CARD game's save path has no
  // business opening on the card.
  it('starts a save path at %APPDATA% even for a card game', () => {
    expect(startDirFor({ root, kind: 'pc-save' }, env)).toBe(appData);
  });

  it('starts a local executable at the home folder and a save path at %APPDATA%', () => {
    expect(startDirFor({ root, kind: 'pc-executable' }, env)).toBe(home);
    expect(startDirFor({ root, kind: 'pc-save-local' }, env)).toBe(appData);
  });
});
