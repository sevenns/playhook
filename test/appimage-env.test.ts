// Stripping the AppImage's environment before spawning a system program.
//
// The fixture below is a VERBATIM dump of a real daemon's /proc/<pid>/environ on a Steam Deck, taken while
// the bug was live: `steam steam://rungameid/…` answered "steam-runtime-steam-remote: Steam is not
// running" although Steam was running, because it inherited LD_LIBRARY_PATH pointing inside the AppImage.
// Keeping the real dump means this test fails if the cleanup ever stops covering what AppRun actually sets.
import { describe, it, expect } from 'vitest';
import { systemEnv } from '../src/main/appimage-env';

const MOUNT = '/tmp/.mount_PlayhoJH8cfQ';

/** The real environment of the daemon on a Deck (sorted, trimmed of journald bookkeeping). */
const DECK_ENV: NodeJS.ProcessEnv = {
  APPDIR: MOUNT,
  APPIMAGE: '/home/deck/Downloads/Playhook.AppImage',
  ARGV0: '/home/deck/Downloads/Playhook.AppImage',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  DESKTOP_SESSION: 'gamescope-wayland',
  ELECTRON_RUN_AS_NODE: '1',
  GSETTINGS_SCHEMA_DIR: `${MOUNT}/usr/share/glib-2.0/schemas`,
  HOME: '/home/deck',
  LANG: 'en_US.UTF-8',
  LD_LIBRARY_PATH: `${MOUNT}/usr/lib`,
  LOGNAME: 'deck',
  OWD: '/home/deck',
  PATH: `${MOUNT}:${MOUNT}/usr/sbin:/usr/local/bin:/usr/bin`,
  PWD: '/home/deck',
  SHELL: '/bin/bash',
  USER: 'deck',
  XDG_CURRENT_DESKTOP: 'gamescope',
  XDG_DATA_DIRS: `${MOUNT}/usr/share/:/home/deck/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share:/usr/local/share:/usr/share`,
  XDG_RUNTIME_DIR: '/run/user/1000',
  XDG_SESSION_TYPE: 'x11',
};

describe('systemEnv — on the real Deck environment', () => {
  const cleaned = systemEnv(DECK_ENV);

  it('leaves nothing pointing inside the AppImage mount', () => {
    // The single assertion that matters: any surviving reference re-creates the bug.
    for (const [name, value] of Object.entries(cleaned)) {
      expect(value ?? '', `${name} still references the mount`).not.toContain(MOUNT);
    }
  });

  it('drops LD_LIBRARY_PATH entirely — it was nothing but the AppImage', () => {
    expect(cleaned['LD_LIBRARY_PATH']).toBeUndefined();
    expect('LD_LIBRARY_PATH' in cleaned).toBe(false); // absent, not empty
  });

  it('keeps the system part of PATH so `steam` is still found', () => {
    expect(cleaned['PATH']).toBe('/usr/local/bin:/usr/bin');
  });

  it('keeps the system part of XDG_DATA_DIRS', () => {
    expect(cleaned['XDG_DATA_DIRS']).toBe(
      '/home/deck/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share:/usr/local/share:/usr/share',
    );
  });

  it('drops the single-path variables that live in the mount', () => {
    expect(cleaned['GSETTINGS_SCHEMA_DIR']).toBeUndefined();
  });

  it("drops AppRun's own variables", () => {
    for (const name of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) {
      expect(cleaned[name], name).toBeUndefined();
    }
  });

  it('drops ELECTRON_RUN_AS_NODE so a child Electron app is not turned into bare Node', () => {
    expect(cleaned['ELECTRON_RUN_AS_NODE']).toBeUndefined();
  });

  it('KEEPS what `steam` needs to find the running client', () => {
    // Dropping these was my first (wrong) suspicion for the bug — they must survive untouched.
    expect(cleaned['XDG_RUNTIME_DIR']).toBe('/run/user/1000');
    expect(cleaned['DBUS_SESSION_BUS_ADDRESS']).toBe('unix:path=/run/user/1000/bus');
    expect(cleaned['HOME']).toBe('/home/deck');
    expect(cleaned['USER']).toBe('deck');
    expect(cleaned['XDG_CURRENT_DESKTOP']).toBe('gamescope');
    expect(cleaned['LANG']).toBe('en_US.UTF-8');
  });

  it('does not mutate the input', () => {
    expect(DECK_ENV['LD_LIBRARY_PATH']).toBe(`${MOUNT}/usr/lib`);
  });
});

describe('systemEnv — outside an AppImage', () => {
  it('changes nothing but the non-inheritable vars (dev run, Windows build)', () => {
    const plain: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/opt/lib',
      HOME: '/home/deck',
      ELECTRON_RUN_AS_NODE: '1',
    };
    expect(systemEnv(plain)).toEqual({
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/opt/lib', // NOT ours to touch when there is no AppImage
      HOME: '/home/deck',
    });
  });
});

describe('systemEnv — edge cases', () => {
  it('handles a PATH that is entirely inside the mount', () => {
    const cleaned = systemEnv({ APPDIR: MOUNT, PATH: `${MOUNT}:${MOUNT}/usr/sbin` });
    expect('PATH' in cleaned).toBe(false);
  });

  it('does not mistake a path that merely starts with the same characters', () => {
    // `/tmp/.mount_PlayhoJH8cfQ-other` is NOT inside `/tmp/.mount_PlayhoJH8cfQ`.
    const cleaned = systemEnv({ APPDIR: MOUNT, PATH: `${MOUNT}-other/bin:/usr/bin` });
    expect(cleaned['PATH']).toBe(`${MOUNT}-other/bin:/usr/bin`);
  });

  it('tolerates an empty APPDIR', () => {
    const cleaned = systemEnv({ APPDIR: '', PATH: '/usr/bin' });
    expect(cleaned['PATH']).toBe('/usr/bin');
  });
});
