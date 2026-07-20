// Steam non-Steam-shortcut appid arithmetic. Pure and electron-free (unit-tested in
// test/steam-appid.test.ts) — the whole Steam-shortcut feature keys on getting these three
// representations of ONE number right.
//
// The root value is an unsigned 32-bit CRC32 over `"<exe>"<appName>` (the exe EXACTLY as it is written
// into the shortcut's `Exe` field — Steam stores it quoted, so the quotes are part of the hash), with the
// top bit forced on. Four independent implementations agree on this (steamgrid/Go,
// Steam-Shortcut-Manager/Python, steam_shortcuts_util/Rust, steam-rom-manager/TS).
//
// It is derived — never read back from Steam: an appid Steam itself assigns to a shortcut added through
// its UI comes from a random range (ValveSoftware/steam-for-linux#9463). The formula holds only for the
// records WE write, which is exactly why Playhook writes shortcuts.vdf itself.
import zlib from 'node:zlib';

/**
 * The exact string Steam stores in a shortcut's `Exe` field: the path in double quotes. Also the prefix of
 * the CRC input — the single source for both, so the hash can never drift from the field it describes.
 */
export function quoteExePath(exePath: string): string {
  return `"${exePath}"`;
}

/**
 * The root appid as an UNSIGNED 32-bit number (always >= 2^31 — the top bit is forced on, which is what
 * marks an id as a non-Steam shortcut). Fits a JS `number` losslessly (< 2^32); this is the ONE value
 * persisted in settings.json, everything else below is derived from it on the spot.
 */
export function computeAppIdU32(exePath: string, appName: string): number {
  const crcInput = `${quoteExePath(exePath)}${appName}`;
  const crc = zlib.crc32(Buffer.from(crcInput, 'utf8')) >>> 0;
  return (crc | 0x80000000) >>> 0;
}

/**
 * The same number as a SIGNED int32 (i.e. negative) — the representation that goes into the `appid` field
 * inside shortcuts.vdf. Comparing an id read from the file against a stored unsigned one without funnelling
 * both through one representation is how you end up appending a duplicate record on every click.
 */
export function toSignedAppId(appIdU32: number): number {
  return appIdU32 | 0;
}

/** Back from the on-disk signed int32 to the unsigned form used everywhere else. */
export function toUnsignedAppId(signed: number): number {
  return signed >>> 0;
}

/**
 * The 64-bit id for `steam://rungameid/<n>`. ~1.5·10^19 — far past Number.MAX_SAFE_INTEGER, so it is a
 * BigInt and must never be routed through a `number` on its way to the URL.
 */
export function toRunGameId(appIdU32: number): bigint {
  return (BigInt(appIdU32) << 32n) | 0x02000000n;
}

/** Names Steam expects for a shortcut's artwork in `userdata/<id>/config/grid/` (unsigned id). */
export function gridFileNames(appIdU32: number): {
  readonly wide: string;
  readonly portrait: string;
  readonly hero: string;
  readonly logo: string;
} {
  return {
    wide: `${appIdU32}.png`,
    portrait: `${appIdU32}p.png`,
    hero: `${appIdU32}_hero.png`,
    logo: `${appIdU32}_logo.png`,
  };
}
