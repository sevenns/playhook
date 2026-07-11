import { describe, expect, it } from 'vitest';
import { buildInstallerArgs, buildParameters, quoteArg } from '../src/main/launch-args';

describe('quoteArg (CommandLineToArgvW rules)', () => {
  it('leaves a simple token unquoted', () => {
    expect(quoteArg('simple')).toBe('simple');
  });

  it('quotes an argument containing whitespace', () => {
    expect(quoteArg('with space')).toBe('"with space"');
  });

  it('quotes and escapes an embedded quote', () => {
    expect(quoteArg('a"b')).toBe('"a\\"b"');
  });

  it('doubles trailing backslashes before the closing quote', () => {
    expect(quoteArg('path with space\\')).toBe('"path with space\\\\"');
  });

  it('quotes an empty argument as ""', () => {
    expect(quoteArg('')).toBe('""');
  });

  it('escapes backslashes that precede a quote (doubled) but keeps others literal', () => {
    expect(quoteArg('a\\\\"b')).toBe('"a\\\\\\\\\\"b"');
  });
});

describe('buildParameters', () => {
  it('joins quoted args with a single space', () => {
    expect(buildParameters(['a', 'b c', 'd'])).toBe('a "b c" d');
  });

  it('returns an empty string for no args', () => {
    expect(buildParameters([])).toBe('');
  });
});

describe('buildInstallerArgs', () => {
  it('nsis silent: /S first, unquoted /D= last (even with spaces in dir) — unaffected by quoteDir', () => {
    const expected = ['/S', '/D=C:\\Program Files\\Game'];
    expect(buildInstallerArgs('nsis', 'C:\\Program Files\\Game', [], true, true)).toEqual(expected);
    expect(buildInstallerArgs('nsis', 'C:\\Program Files\\Game', [], false, true)).toEqual(expected);
  });

  it('nsis silent: custom args go between /S and the trailing /D=', () => {
    expect(buildInstallerArgs('nsis', 'C:\\Game', ['/EXTRA'], true, true)).toEqual([
      '/S',
      '/EXTRA',
      '/D=C:\\Game',
    ]);
  });

  it('nsis interactive (silent=false): drops /S but keeps the trailing /D= dir hint', () => {
    expect(buildInstallerArgs('nsis', 'C:\\Game', ['/EXTRA'], true, false)).toEqual([
      '/EXTRA',
      '/D=C:\\Game',
    ]);
  });

  it('inno win32 silent (quoteDir=true): silent flags with a QUOTED /DIR= (verbatim passthrough)', () => {
    expect(buildInstallerArgs('inno', 'C:\\Program Files\\Game', [], true, true)).toEqual([
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/DIR="C:\\Program Files\\Game"',
    ]);
  });

  it('inno linux silent (quoteDir=false): silent flags with an UNQUOTED /DIR= (Р7 — argv passthrough)', () => {
    expect(buildInstallerArgs('inno', 'C:\\playhook\\games\\my-game', [], false, true)).toEqual([
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/DIR=C:\\playhook\\games\\my-game',
    ]);
  });

  it('inno interactive (silent=false): drops the silent flags but keeps /DIR= to steer the wizard', () => {
    expect(buildInstallerArgs('inno', 'C:\\playhook\\games\\my-game', [], false, false)).toEqual([
      '/DIR=C:\\playhook\\games\\my-game',
    ]);
  });

  it('custom: substitutes every {dir} token — unaffected by quoteDir/silent', () => {
    expect(
      buildInstallerArgs('custom', 'C:\\Game', ['--target={dir}', '--also={dir}'], false, true),
    ).toEqual(['--target=C:\\Game', '--also=C:\\Game']);
    expect(
      buildInstallerArgs('custom', 'C:\\Game', ['--target={dir}'], false, false),
    ).toEqual(['--target=C:\\Game']);
  });
});
