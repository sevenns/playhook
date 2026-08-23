import { describe, expect, it } from 'vitest';
import {
  descendantPids,
  normalizeImageName,
  parsePsCommand,
  parsePsParents,
  snapshotFromEntries,
} from '../src/main/platform/process-monitor.darwin';

describe('darwin ProcessMonitor — ps output parsing', () => {
  it('reads pid and the full command path from `ps -axwwo pid=,comm=`', () => {
    const stdout = [
      '    1 /sbin/launchd',
      '  742 /Applications/Steam.app/Contents/MacOS/steam_osx',
      '',
    ].join('\n');
    expect(parsePsCommand(stdout)).toEqual([
      { pid: 1, imageName: 'launchd' },
      { pid: 742, imageName: 'steam_osx' },
    ]);
  });

  it('keeps spaces in a bundle path (only the pid field is split off)', () => {
    const stdout = ' 1234 /Applications/My Game.app/Contents/MacOS/My Game';
    expect(parsePsCommand(stdout)).toEqual([{ pid: 1234, imageName: 'My Game' }]);
  });

  it('returns nothing for empty output', () => {
    expect(parsePsCommand('')).toEqual([]);
  });

  it('skips lines that carry no pid', () => {
    expect(parsePsCommand('ps: illegal option\n  5 /bin/zsh')).toEqual([
      { pid: 5, imageName: 'zsh' },
    ]);
  });

  it('records a pid with no command as present but nameless', () => {
    expect(parsePsCommand('  99 ')).toEqual([{ pid: 99, imageName: null }]);
  });

  it('reads pid/ppid pairs and ignores anything else', () => {
    const stdout = ['    1     0', '  742     1', 'garbage', '  900   742'].join('\n');
    expect(parsePsParents(stdout)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 742, ppid: 1 },
      { pid: 900, ppid: 742 },
    ]);
  });
});

describe('darwin ProcessMonitor — image-name matching', () => {
  it('normalizes to a lower-cased basename without the .exe suffix', () => {
    expect(normalizeImageName('Valheim.exe')).toBe('valheim');
    expect(normalizeImageName('valheim')).toBe('valheim');
    expect(normalizeImageName('/Applications/Valheim.app/Contents/MacOS/Valheim')).toBe('valheim');
    expect(normalizeImageName('C:\\Games\\Valheim\\valheim.exe')).toBe('valheim');
  });

  it('matches a watched name with OR without .exe against the running mac binary', () => {
    const snapshot = snapshotFromEntries([{ pid: 10, imageName: 'valheim' }]);
    expect(snapshot.hasImageName('valheim.exe')).toBe(true);
    expect(snapshot.hasImageName('valheim')).toBe(true);
    expect(snapshot.hasImageName('VALHEIM.EXE')).toBe(true);
  });

  it('does not match a different game (exact basename, not substring)', () => {
    const snapshot = snapshotFromEntries([{ pid: 10, imageName: 'valheim_server' }]);
    expect(snapshot.hasImageName('valheim.exe')).toBe(false);
  });

  it('tracks pids and ignores nameless entries for name matching', () => {
    const snapshot = snapshotFromEntries([
      { pid: 10, imageName: null },
      { pid: 11, imageName: 'hades' },
    ]);
    expect(snapshot.hasPid(10)).toBe(true);
    expect(snapshot.hasPid(12)).toBe(false);
    expect(snapshot.hasImageName('hades')).toBe(true);
  });
});

describe('darwin ProcessMonitor — process tree', () => {
  const links = [
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 200, ppid: 100 },
    { pid: 201, ppid: 100 },
    { pid: 300, ppid: 200 },
    { pid: 400, ppid: 1 },
  ];

  it('collects the root plus every descendant', () => {
    expect([...descendantPids(100, links)].sort((a, b) => a - b)).toEqual([100, 200, 201, 300]);
  });

  it('returns just the pid when it has no children', () => {
    expect(descendantPids(400, links)).toEqual([400]);
  });

  it('returns the pid itself when it is not in the table at all', () => {
    expect(descendantPids(999, links)).toEqual([999]);
  });

  it('terminates on a cyclic parent chain', () => {
    const cyclic = [
      { pid: 10, ppid: 11 },
      { pid: 11, ppid: 10 },
    ];
    expect([...descendantPids(10, cyclic)].sort((a, b) => a - b)).toEqual([10, 11]);
  });
});
