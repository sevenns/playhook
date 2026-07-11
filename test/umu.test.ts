import { describe, expect, it } from 'vitest';
import {
  prefixDir,
  installDirs,
  prefixForInstall,
  pendingWinetricks,
  INSTALL_BASELINE_WINETRICKS,
  buildUmuEnv,
  buildUmuArgs,
  DEFAULT_PROTON,
  UMU_GAMEID,
} from '../src/main/platform/umu';

describe('umu launch helpers (Proton exe mode)', () => {
  describe('prefixDir', () => {
    it('is <userData>/prefixes/<id>', () => {
      expect(prefixDir('/home/deck/.config/playhook', 'hollow-knight')).toBe(
        '/home/deck/.config/playhook/prefixes/hollow-knight',
      );
    });
  });

  describe('installDirs (install mode — Р7)', () => {
    it('host view is <pfx>/drive_c/playhook/games/<id>, installer view is C:\\playhook\\games\\<id>', () => {
      const { hostDir, installerDir } = installDirs('/home/deck/.config/playhook', 'my-game');
      expect(hostDir).toBe(
        '/home/deck/.config/playhook/prefixes/my-game/drive_c/playhook/games/my-game',
      );
      expect(installerDir).toBe('C:\\playhook\\games\\my-game');
    });

    it('host view sits inside the game prefix (prefixDir)', () => {
      const userData = '/home/deck/.config/playhook';
      const { hostDir } = installDirs(userData, 'zork');
      expect(hostDir.startsWith(`${prefixDir(userData, 'zork')}/`)).toBe(true);
    });
  });

  describe('prefixForInstall (inverse of installDirs)', () => {
    it('recovers the prefix from a host-view install dir', () => {
      const userData = '/home/deck/.config/playhook';
      const { hostDir } = installDirs(userData, 'my-game');
      expect(prefixForInstall(hostDir)).toBe(prefixDir(userData, 'my-game'));
    });

    it('falls back to the input when there is no drive_c marker', () => {
      expect(prefixForInstall('/some/plain/path')).toBe('/some/plain/path');
    });
  });

  describe('pendingWinetricks (prefix provisioning — Р7b)', () => {
    it('returns the full baseline when nothing is done and no extras', () => {
      expect(pendingWinetricks([], [])).toEqual([...INSTALL_BASELINE_WINETRICKS]);
    });

    it('appends card extras after the baseline', () => {
      expect(pendingWinetricks(['dotnet48', 'd3dcompiler_47'], [])).toEqual([
        ...INSTALL_BASELINE_WINETRICKS,
        'dotnet48',
        'd3dcompiler_47',
      ]);
    });

    it('skips verbs already recorded as done', () => {
      const done = ['mfc42', 'gdiplus'];
      expect(pendingWinetricks([], done)).toEqual(
        INSTALL_BASELINE_WINETRICKS.filter((v) => !done.includes(v)),
      );
    });

    it('is empty when baseline + extras are all done (idempotent skip)', () => {
      expect(pendingWinetricks(['dotnet48'], [...INSTALL_BASELINE_WINETRICKS, 'dotnet48'])).toEqual([]);
    });

    it('de-duplicates a verb an extra repeats from the baseline', () => {
      // 'mfc42' is in the baseline; repeating it as an extra must not double it.
      expect(pendingWinetricks(['mfc42', 'dotnet48'], [])).toEqual([
        ...INSTALL_BASELINE_WINETRICKS,
        'dotnet48',
      ]);
    });
  });

  describe('buildUmuEnv', () => {
    it('sets WINEPREFIX / GAMEID / PROTONPATH and preserves the base env', () => {
      const env = buildUmuEnv(
        { PATH: '/usr/bin', HOME: '/home/deck' },
        { prefix: '/pfx/x', proton: DEFAULT_PROTON },
      );
      expect(env.WINEPREFIX).toBe('/pfx/x');
      expect(env.GAMEID).toBe(UMU_GAMEID);
      expect(env.PROTONPATH).toBe('GE-Proton');
      // Base env survives (system PATH → python3, session vars).
      expect(env.PATH).toBe('/usr/bin');
      expect(env.HOME).toBe('/home/deck');
    });

    it('accepts an absolute Proton path override', () => {
      const env = buildUmuEnv({}, { prefix: '/pfx/y', proton: '/steam/common/Proton 9.0' });
      expect(env.PROTONPATH).toBe('/steam/common/Proton 9.0');
    });

    it('strips the AppImage linker vars so system python3/Proton use clean libs (§5.1)', () => {
      const env = buildUmuEnv(
        {
          PATH: '/usr/bin',
          LD_LIBRARY_PATH: '/tmp/.mount_Playhook/usr/lib',
          LD_PRELOAD: '/tmp/.mount_Playhook/preload.so',
        },
        { prefix: '/pfx/z', proton: DEFAULT_PROTON },
      );
      expect(env.LD_LIBRARY_PATH).toBeUndefined();
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.PATH).toBe('/usr/bin'); // unrelated vars survive
    });
  });

  describe('buildUmuArgs', () => {
    it('is [umu-run, exe, ...gameArgs] in order', () => {
      expect(
        buildUmuArgs('/res/umu/umu-run', '/run/media/deck/CARD/game.exe', ['-windowed', '-nolauncher']),
      ).toEqual(['/res/umu/umu-run', '/run/media/deck/CARD/game.exe', '-windowed', '-nolauncher']);
    });

    it('handles no game args', () => {
      expect(buildUmuArgs('/res/umu/umu-run', '/card/g.exe', [])).toEqual([
        '/res/umu/umu-run',
        '/card/g.exe',
      ]);
    });
  });
});
