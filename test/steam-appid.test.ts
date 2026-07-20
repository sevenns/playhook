// appid arithmetic for non-Steam shortcuts. The three representations of one number are where this
// feature silently breaks (a duplicate record per click, a rungameid that lost precision), so each one is
// pinned here.
import { describe, it, expect } from 'vitest';
import {
  computeAppIdU32,
  gridFileNames,
  quoteExePath,
  toRunGameId,
  toSignedAppId,
  toUnsignedAppId,
} from '../src/main/platform/steam-appid';

describe('computeAppIdU32', () => {
  it('always sets the top bit (the non-Steam-shortcut marker)', () => {
    const cases = [
      ['/home/deck/.local/share/playhook/Playhook.AppImage', 'Playhook'],
      ['/usr/bin/konsole', 'konsole'],
      ['', ''],
    ] as const;
    for (const [exe, name] of cases) {
      const id = computeAppIdU32(exe, name);
      expect(id).toBeGreaterThanOrEqual(0x80000000);
      expect(id).toBeLessThan(0x100000000);
      expect(Number.isInteger(id)).toBe(true);
    }
  });

  it('is deterministic and sensitive to both inputs', () => {
    const exe = '/home/deck/.local/share/playhook/Playhook.AppImage';
    expect(computeAppIdU32(exe, 'Playhook')).toBe(computeAppIdU32(exe, 'Playhook'));
    expect(computeAppIdU32(exe, 'Playhook')).not.toBe(computeAppIdU32(exe, 'Playhook2'));
    expect(computeAppIdU32(exe, 'Playhook')).not.toBe(computeAppIdU32(`${exe}.bak`, 'Playhook'));
  });

  it('hashes the quoted exe — the same string that goes into the Exe field', () => {
    // Regression on the one thing that would make Steam and us disagree about the id: the quotes.
    const exe = '/opt/Playhook.AppImage';
    expect(quoteExePath(exe)).toBe('"/opt/Playhook.AppImage"');
    expect(computeAppIdU32(exe, 'Playhook')).not.toBe(
      computeAppIdU32(quoteExePath(exe), 'Playhook'),
    );
  });
});

describe('signed / unsigned conversion', () => {
  it('round-trips through the negative int32 Steam stores on disk', () => {
    const id = computeAppIdU32('/opt/Playhook.AppImage', 'Playhook');
    const signed = toSignedAppId(id);
    expect(signed).toBeLessThan(0); // top bit is set → always negative as int32
    expect(toUnsignedAppId(signed)).toBe(id);
  });
});

describe('toRunGameId', () => {
  it('matches the real Deck pair (appid 2789208654 → SteamGameId)', () => {
    // Both numbers were read off a live Steam Deck: the shortcut's appid and the SteamGameId Steam
    // stamped into the launched process's environ.
    expect(toRunGameId(2789208654)).toBe(11979559950683734016n);
  });

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    const id = toRunGameId(2789208654);
    expect(id).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(toRunGameId(0xffffffff)).toBe((0xffffffffn << 32n) | 0x02000000n);
  });

  it('is BigInt because both `number` routes produce a wrong URL', () => {
    // Two traps, both real. A plain `<<` is a 32-bit operation and returns garbage…
    expect((2789208654 << 32) | 0x02000000).not.toBe(Number(toRunGameId(2789208654)));
    // …and while the value happens to survive a double (its low 25 bits are zero), PRINTING it as a
    // number does not: `.toString()` emits the shortest round-tripping form, ending in 000.
    expect(Number(toRunGameId(2789208654)).toString()).toBe('11979559950683734000');
    expect(toRunGameId(2789208654).toString()).toBe('11979559950683734016');
  });
});

describe('gridFileNames', () => {
  it("uses the unsigned id, with Steam's suffixes", () => {
    expect(gridFileNames(2789208654)).toEqual({
      wide: '2789208654.png',
      portrait: '2789208654p.png',
      hero: '2789208654_hero.png',
      logo: '2789208654_logo.png',
    });
  });
});
