// Registry fallback for finding a game's uninstaller (rare path — a nonstandard NSIS uninstaller name
// that the FS search in the install dir missed). We read the Windows "Uninstall" registry branches via
// the advapi32 Reg* API through koffi, NOT `reg query`: that CLI emits its output in the console OEM
// codepage (CP866 for ru-RU), which mojibakes Cyrillic paths and silently breaks the InstallLocation
// match (I2). The Reg*W (wide) API returns proper UTF-16, so Cyrillic install paths compare correctly.
//
// Everything here is best-effort: ANY failure (FFI error, missing key, unreadable value) degrades to
// `null`, and the caller then falls back to a plain directory removal. The whole lookup is wrapped so a
// runtime FFI hiccup can never crash the main process — the worst case is "registry didn't help".
//
// FFI pattern mirrors game-launcher.ts / gamepad-global.ts: opaque pointer handles, __stdcall, DLLs
// loaded lazily (so dev builds on macOS don't fail at import). Output parameters are passed as Node
// Buffers (koffi forwards the Buffer's memory as the raw pointer; the API writes into it in place),
// which keeps the in/out marshalling explicit and predictable across ia32/x64.
import koffi from 'koffi';
import { log } from './logger';

/** A matched Uninstall registry entry (its InstallLocation equals our install dir). */
export interface UninstallEntry {
  /** `UninstallString` value, if present (may not be silent). */
  readonly uninstallString?: string;
  /** `QuietUninstallString` value, if present (already silent — preferred). */
  readonly quietUninstallString?: string;
  /** True when the entry lives under HKLM (machine-wide) — informs the elevated decision (R-UAC-KIOSK). */
  readonly fromHKLM: boolean;
}

// ── Win32 registry constants ─────────────────────────────────────────────────
const HKEY_CURRENT_USER = 0x80000001n;
const HKEY_LOCAL_MACHINE = 0x80000002n;
const KEY_READ = 0x20019;
const KEY_WOW64_64KEY = 0x0100;
const ERROR_SUCCESS = 0;
const ERROR_NO_MORE_ITEMS = 259;
const REG_EXPAND_SZ = 2;

const UNINSTALL_SUBKEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const UNINSTALL_SUBKEY_WOW = 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

// Registry key names are capped at 255 chars; value strings (paths/commands) are short — a fixed
// 4 KiB buffer covers them without a size-probe round-trip (oversized values just read as absent).
const MAX_NAME_CHARS = 256;
const VALUE_BUF_BYTES = 4096;

// HKEY is an opaque pointer; predefined roots are passed as BigInt values (koffi accepts BigInt for
// opaque pointer args, as game-launcher.ts does for HANDLE).
const HKEY = koffi.pointer('HKEY', koffi.opaque());

type RegOpenKeyExWFn = (
  hKey: bigint,
  lpSubKey: string,
  ulOptions: number,
  samDesired: number,
  phkResult: Buffer,
) => number;
type RegEnumKeyExWFn = (
  hKey: bigint,
  dwIndex: number,
  lpName: Buffer,
  lpcchName: Buffer,
  lpReserved: null,
  lpClass: null,
  lpcchClass: null,
  lpftLastWriteTime: null,
) => number;
type RegQueryValueExWFn = (
  hKey: bigint,
  lpValueName: string,
  lpReserved: null,
  lpType: Buffer,
  lpData: Buffer,
  lpcbData: Buffer,
) => number;
type RegCloseKeyFn = (hKey: bigint) => number;

interface Advapi32 {
  readonly RegOpenKeyExW: RegOpenKeyExWFn;
  readonly RegEnumKeyExW: RegEnumKeyExWFn;
  readonly RegQueryValueExW: RegQueryValueExWFn;
  readonly RegCloseKey: RegCloseKeyFn;
}

let advapi32: Advapi32 | null = null;

function loadAdvapi32(): Advapi32 {
  if (advapi32 !== null) return advapi32;
  const lib = koffi.load('advapi32.dll');
  const RegOpenKeyExW = lib.func(
    'int32 __stdcall RegOpenKeyExW(HKEY hKey, str16 lpSubKey, uint32 ulOptions, uint32 samDesired, void *phkResult)',
  ) as unknown as RegOpenKeyExWFn;
  const RegEnumKeyExW = lib.func(
    'int32 __stdcall RegEnumKeyExW(HKEY hKey, uint32 dwIndex, void *lpName, void *lpcchName, void *lpReserved, void *lpClass, void *lpcchClass, void *lpftLastWriteTime)',
  ) as unknown as RegEnumKeyExWFn;
  const RegQueryValueExW = lib.func(
    'int32 __stdcall RegQueryValueExW(HKEY hKey, str16 lpValueName, void *lpReserved, void *lpType, void *lpData, void *lpcbData)',
  ) as unknown as RegQueryValueExWFn;
  const RegCloseKey = lib.func('int32 __stdcall RegCloseKey(HKEY hKey)') as unknown as RegCloseKeyFn;
  advapi32 = { RegOpenKeyExW, RegEnumKeyExW, RegQueryValueExW, RegCloseKey };
  return advapi32;
}

// ── Path normalization & env expansion (explicit — not path.resolve, I3) ─────

/** Lowercase, forward→back slashes, no trailing backslash — for a stable InstallLocation==installDir match. */
function normalizePath(p: string): string {
  return p.trim().replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Expands `%VAR%` tokens via process.env (Windows env access is case-insensitive in Node). Used for
 * REG_EXPAND_SZ InstallLocation values, which may store e.g. `%ProgramFiles%\...`. Unknown vars are
 * left as-is so a partial expansion still has a chance to match.
 */
function expandEnv(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

// ── Low-level reads (each returns null on any failure) ───────────────────────

/** Reads a string value (REG_SZ / REG_EXPAND_SZ) from an open key; expands env for REG_EXPAND_SZ. */
function readStringValue(api: Advapi32, hKey: bigint, valueName: string): string | null {
  const typeBuf = Buffer.alloc(4);
  const dataBuf = Buffer.alloc(VALUE_BUF_BYTES);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(VALUE_BUF_BYTES, 0);
  const rc = api.RegQueryValueExW(hKey, valueName, null, typeBuf, dataBuf, sizeBuf);
  if (rc !== ERROR_SUCCESS) return null;
  const byteLen = sizeBuf.readUInt32LE(0);
  if (byteLen === 0) return null;
  // The byte length includes the trailing NUL for string types; decode then strip NULs.
  const raw = dataBuf.toString('utf16le', 0, Math.min(byteLen, VALUE_BUF_BYTES)).replace(/\0+$/, '');
  if (raw.length === 0) return null;
  const type = typeBuf.readUInt32LE(0);
  return type === REG_EXPAND_SZ ? expandEnv(raw) : raw;
}

/**
 * Scans one Uninstall branch for a subkey whose (expanded, normalized) InstallLocation equals
 * `installDirNorm`. Returns the matched entry's uninstall strings, or null. Never throws.
 */
function scanBranch(
  api: Advapi32,
  root: bigint,
  subPath: string,
  samDesired: number,
  installDirNorm: string,
  fromHKLM: boolean,
): UninstallEntry | null {
  const rootKeyBuf = Buffer.alloc(8);
  if (api.RegOpenKeyExW(root, subPath, 0, samDesired, rootKeyBuf) !== ERROR_SUCCESS) return null;
  const rootKey = rootKeyBuf.readBigUInt64LE(0);
  try {
    const nameBuf = Buffer.alloc(MAX_NAME_CHARS * 2);
    const nameLenBuf = Buffer.alloc(4);
    for (let index = 0; ; index += 1) {
      nameLenBuf.writeUInt32LE(MAX_NAME_CHARS, 0);
      const rc = api.RegEnumKeyExW(rootKey, index, nameBuf, nameLenBuf, null, null, null, null);
      if (rc === ERROR_NO_MORE_ITEMS) break;
      if (rc !== ERROR_SUCCESS) break; // unexpected — stop scanning this branch
      const nameChars = nameLenBuf.readUInt32LE(0);
      const subName = nameBuf.toString('utf16le', 0, nameChars * 2);

      const subKeyBuf = Buffer.alloc(8);
      if (api.RegOpenKeyExW(rootKey, subName, 0, samDesired, subKeyBuf) !== ERROR_SUCCESS) continue;
      const subKey = subKeyBuf.readBigUInt64LE(0);
      try {
        const installLocation = readStringValue(api, subKey, 'InstallLocation');
        if (installLocation === null) continue;
        if (normalizePath(installLocation) !== installDirNorm) continue;
        // Matched our install dir — pull the uninstall command(s).
        const quiet = readStringValue(api, subKey, 'QuietUninstallString');
        const plain = readStringValue(api, subKey, 'UninstallString');
        return {
          fromHKLM,
          ...(quiet !== null ? { quietUninstallString: quiet } : {}),
          ...(plain !== null ? { uninstallString: plain } : {}),
        };
      } finally {
        api.RegCloseKey(subKey);
      }
    }
    return null;
  } finally {
    api.RegCloseKey(rootKey);
  }
}

/**
 * Finds the Uninstall registry entry whose InstallLocation equals `installDir` (across HKLM 64-bit,
 * HKLM WOW6432Node, and HKCU), or null. Best-effort: returns null on any error or on non-Windows.
 */
export async function findUninstallEntry(installDir: string): Promise<UninstallEntry | null> {
  if (process.platform !== 'win32') return null;
  // Async signature for a uniform call site (mirrors resolveUninstaller); the work itself is sync FFI.
  return Promise.resolve().then(() => {
    try {
      const api = loadAdvapi32();
      const target = normalizePath(installDir);
      const branches: ReadonlyArray<{ root: bigint; sub: string; sam: number; hklm: boolean }> = [
        { root: HKEY_LOCAL_MACHINE, sub: UNINSTALL_SUBKEY, sam: KEY_READ | KEY_WOW64_64KEY, hklm: true },
        { root: HKEY_LOCAL_MACHINE, sub: UNINSTALL_SUBKEY_WOW, sam: KEY_READ, hklm: true },
        { root: HKEY_CURRENT_USER, sub: UNINSTALL_SUBKEY, sam: KEY_READ, hklm: false },
      ];
      for (const branch of branches) {
        const entry = scanBranch(api, branch.root, branch.sub, branch.sam, target, branch.hklm);
        if (entry !== null) return entry;
      }
      return null;
    } catch (cause) {
      log.warn('[registry] uninstall-entry lookup failed:', cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  });
}
