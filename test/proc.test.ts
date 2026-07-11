import { describe, expect, it } from 'vitest';
import {
  pathBasename,
  imageNameFromCmdline,
  imageNameMatches,
  buildProcIndex,
  snapshotFromEntries,
  type ProcEntry,
} from '../src/main/platform/proc';

describe('linux /proc process monitor — pure helpers', () => {
  describe('pathBasename (both separators)', () => {
    it('returns the last segment of a forward-slash path', () => {
      expect(pathBasename('/home/deck/games/Game.exe')).toBe('Game.exe');
    });

    it('returns the last segment of a Wine backslash path', () => {
      expect(pathBasename('Z:\\home\\deck\\Game-Win64-Shipping.exe')).toBe('Game-Win64-Shipping.exe');
    });

    it('handles a drive-letter Wine path', () => {
      expect(pathBasename('C:\\Program Files\\My Game\\launcher.exe')).toBe('launcher.exe');
    });

    it('returns a bare name unchanged', () => {
      expect(pathBasename('Game.exe')).toBe('Game.exe');
    });

    it('ignores a trailing separator', () => {
      expect(pathBasename('/home/deck/dir/')).toBe('dir');
    });

    it('handles a mixed-separator path (last of either wins)', () => {
      expect(pathBasename('/mnt/games\\Sub\\game.exe')).toBe('game.exe');
    });
  });

  describe('imageNameFromCmdline (NUL-separated argv → basename of argv[0])', () => {
    it('takes the basename of argv[0], ignoring later args', () => {
      // argv: ["Z:\\game\\Game.exe", "-windowed", "-nolauncher"]
      const cmdline = 'Z:\\game\\Game.exe\0-windowed\0-nolauncher\0';
      expect(imageNameFromCmdline(cmdline)).toBe('Game.exe');
    });

    it('handles a native forward-slash exe path', () => {
      expect(imageNameFromCmdline('/usr/bin/umu-run\0game.exe\0')).toBe('umu-run');
    });

    it('returns null for an empty cmdline (kernel thread / zombie)', () => {
      expect(imageNameFromCmdline('')).toBeNull();
    });

    it('returns null when argv[0] is empty', () => {
      expect(imageNameFromCmdline('\0-foo')).toBeNull();
    });

    it('handles a cmdline with no trailing NUL', () => {
      expect(imageNameFromCmdline('/opt/app/Foo.exe')).toBe('Foo.exe');
    });
  });

  describe('imageNameMatches (case-insensitive, basename of target)', () => {
    it('matches ignoring case', () => {
      expect(imageNameMatches('Game.EXE', 'game.exe')).toBe(true);
    });

    it('matches when the target carries a path (Wine cmdline style)', () => {
      expect(imageNameMatches('C:\\g\\Game.exe', 'game.exe')).toBe(true);
    });

    it('does not match different names', () => {
      expect(imageNameMatches('game.exe', 'pregame.exe')).toBe(false);
    });
  });

  describe('buildProcIndex / snapshotFromEntries', () => {
    const entries: readonly ProcEntry[] = [
      { pid: 10, imageName: 'Game-Win64-Shipping.exe' },
      { pid: 11, imageName: 'umu-run' },
      { pid: 12, imageName: null }, // kernel thread
    ];

    it('indexes pids and lower-cased names', () => {
      const { names, pids } = buildProcIndex(entries);
      expect([...pids].sort((a, b) => a - b)).toEqual([10, 11, 12]);
      expect(names.has('game-win64-shipping.exe')).toBe(true);
      expect(names.has('umu-run')).toBe(true);
    });

    it('snapshot.hasImageName matches by exact basename, case-insensitively', () => {
      const snap = snapshotFromEntries(entries);
      expect(snap.hasImageName('Game-Win64-Shipping.exe')).toBe(true);
      expect(snap.hasImageName('game-win64-shipping.EXE')).toBe(true);
      // exact-basename semantics (unlike win32 substring): a longer name must not match a shorter entry.
      expect(snap.hasImageName('Shipping.exe')).toBe(false);
      expect(snap.hasImageName('notrunning.exe')).toBe(false);
    });

    it('snapshot.hasPid reflects the scanned pids', () => {
      const snap = snapshotFromEntries(entries);
      expect(snap.hasPid(10)).toBe(true);
      expect(snap.hasPid(999)).toBe(false);
    });
  });
});
