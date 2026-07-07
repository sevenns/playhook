// Return-to-game: find the main window of a running game (by process image name) and bring it to the
// foreground. Used when the launcher is summoned over a running game and the user presses Play again —
// instead of relaunching, we raise the game's own window.
//
// Windows only, koffi FFI (same pattern as foreground.ts / game-launcher.ts), DLLs loaded lazily so dev
// builds off Windows don't fail at import. Deliberately NO koffi callbacks: we walk the top-level windows
// by Z-order via GetTopWindow + GetWindow(GW_HWNDNEXT) rather than EnumWindows (which needs a callback),
// which keeps the FFI surface small and low-risk. For each visible root-owner window we resolve its
// process image path with QueryFullProcessImageNameW (works across the integrity-level boundary with
// PROCESS_QUERY_LIMITED_INFORMATION, so it covers elevated games too) and match its basename.
//
// HWND/HANDLE are passed as `uintptr_t` (an integer) rather than an opaque pointer, so returns come back
// as a plain number/bigint we can reliably compare for NULL and window identity (GA_ROOTOWNER === self).
// Every handle is coerced with BigInt() so the checks hold on both x64 (8-byte → bigint) and ia32 (4-byte
// → number). foreground.activateHwnd accepts a bigint HWND (koffi takes bigint for the opaque HWND param).
import koffi from 'koffi';
import { activateHwnd } from './foreground';
import { imageMatches } from './image-names';
import { log } from './logger';

const GW_HWNDNEXT = 2; // GetWindow: the next window below in Z-order
const GA_ROOTOWNER = 3; // GetAncestor: the root of the owner chain (skip child/owned popups)
const SW_RESTORE = 9; // ShowWindow: restore a minimized window before activating it
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000; // enough for QueryFullProcessImageNameW across ILs
// Safety cap so a pathological Z-order chain can never spin forever.
const MAX_WINDOWS = 5000;
// QueryFullProcessImageNameW buffer capacity, in wide chars (well above a normal Win32 path).
const IMAGE_PATH_CAP = 1024;

// koffi returns uintptr_t as bigint (8-byte) or number (4-byte); we normalize with BigInt() at call sites.
type Handle = number | bigint;

type GetTopWindowFn = (hWnd: bigint) => Handle;
type GetWindowFn = (hWnd: bigint, uCmd: number) => Handle;
type GetWindowThreadProcessIdFn = (hWnd: bigint, lpdwProcessId: number[]) => number;
type IsWindowVisibleFn = (hWnd: bigint) => number;
type GetAncestorFn = (hwnd: bigint, gaFlags: number) => Handle;
type GetWindowTextLengthWFn = (hWnd: bigint) => number;
type ShowWindowFn = (hWnd: bigint, nCmdShow: number) => number;

type OpenProcessFn = (dwDesiredAccess: number, bInheritHandle: number, dwProcessId: number) => Handle;
type QueryFullProcessImageNameWFn = (
  hProcess: bigint,
  dwFlags: number,
  lpExeName: Uint16Array,
  lpdwSize: number[],
) => number;
type CloseHandleFn = (hObject: bigint) => number;

interface User32 {
  readonly GetTopWindow: GetTopWindowFn;
  readonly GetWindow: GetWindowFn;
  readonly GetWindowThreadProcessId: GetWindowThreadProcessIdFn;
  readonly IsWindowVisible: IsWindowVisibleFn;
  readonly GetAncestor: GetAncestorFn;
  readonly GetWindowTextLengthW: GetWindowTextLengthWFn;
  readonly ShowWindow: ShowWindowFn;
}

interface Kernel32 {
  readonly OpenProcess: OpenProcessFn;
  readonly QueryFullProcessImageNameW: QueryFullProcessImageNameWFn;
  readonly CloseHandle: CloseHandleFn;
}

let user32: User32 | null = null;
let kernel32: Kernel32 | null = null;

function loadUser32(): User32 {
  if (user32 !== null) return user32;
  const lib = koffi.load('user32.dll');
  // All prototypes use __stdcall (needed for ia32, harmless on x64) — like the WinAPI calls elsewhere.
  user32 = {
    GetTopWindow: lib.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)') as unknown as GetTopWindowFn,
    GetWindow: lib.func(
      'uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)',
    ) as unknown as GetWindowFn,
    GetWindowThreadProcessId: lib.func(
      'uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *lpdwProcessId)',
    ) as unknown as GetWindowThreadProcessIdFn,
    IsWindowVisible: lib.func(
      'int __stdcall IsWindowVisible(uintptr_t hWnd)',
    ) as unknown as IsWindowVisibleFn,
    GetAncestor: lib.func(
      'uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32 gaFlags)',
    ) as unknown as GetAncestorFn,
    GetWindowTextLengthW: lib.func(
      'int __stdcall GetWindowTextLengthW(uintptr_t hWnd)',
    ) as unknown as GetWindowTextLengthWFn,
    ShowWindow: lib.func(
      'int __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)',
    ) as unknown as ShowWindowFn,
  };
  return user32;
}

function loadKernel32(): Kernel32 {
  if (kernel32 !== null) return kernel32;
  const lib = koffi.load('kernel32.dll');
  kernel32 = {
    OpenProcess: lib.func(
      'uintptr_t __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)',
    ) as unknown as OpenProcessFn,
    QueryFullProcessImageNameW: lib.func(
      'int __stdcall QueryFullProcessImageNameW(uintptr_t hProcess, uint32 dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32 *lpdwSize)',
    ) as unknown as QueryFullProcessImageNameWFn,
    CloseHandle: lib.func('int __stdcall CloseHandle(uintptr_t hObject)') as unknown as CloseHandleFn,
  };
  return kernel32;
}

/** Resolves the full process image path for an open process handle, or null on failure. */
function queryImagePath(k: Kernel32, handle: bigint): string | null {
  const nameBuf = new Uint16Array(IMAGE_PATH_CAP);
  const sizeBox = [IMAGE_PATH_CAP];
  const ok = k.QueryFullProcessImageNameW(handle, 0, nameBuf, sizeBox);
  if (ok === 0) return null;
  const len = sizeBox[0] ?? 0;
  if (len <= 0) return null;
  return Buffer.from(nameBuf.buffer, 0, len * 2).toString('utf16le');
}

/**
 * Finds the first visible, titled, root-owner top-level window whose process image name is one of
 * `imageNames` (already normalized lower-case basenames) and brings it to the foreground (restoring it
 * first, in case a fullscreen game minimized when it lost focus). Returns true if a window was activated.
 * No-op (false) off Windows; best-effort — any FFI error is logged and swallowed.
 */
export function focusGameWindow(imageNames: readonly string[]): boolean {
  if (process.platform !== 'win32') return false;
  if (imageNames.length === 0) return false;
  try {
    const u = loadUser32();
    const k = loadKernel32();
    let hwnd = BigInt(u.GetTopWindow(0n)); // 0n = NULL → the desktop, i.e. the topmost window in Z-order
    let visited = 0;
    while (hwnd !== 0n && visited < MAX_WINDOWS) {
      visited += 1;
      const current = hwnd;
      // Advance to the next window FIRST, so every `continue` below still makes progress.
      hwnd = BigInt(u.GetWindow(current, GW_HWNDNEXT));
      if (u.IsWindowVisible(current) === 0) continue;
      // Only a root-owner window (its own owner chain root) — skips child/owned popups of the game.
      if (BigInt(u.GetAncestor(current, GA_ROOTOWNER)) !== current) continue;
      const pidBox = [0];
      u.GetWindowThreadProcessId(current, pidBox);
      const pid = pidBox[0] ?? 0;
      if (pid === 0) continue;
      const handle = BigInt(k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
      if (handle === 0n) continue;
      try {
        const imagePath = queryImagePath(k, handle);
        if (imagePath === null || !imageMatches(imagePath, imageNames)) continue;
        // Prefer a real, titled window over the process's invisible helper windows.
        if (u.GetWindowTextLengthW(current) === 0) continue;
        u.ShowWindow(current, SW_RESTORE);
        activateHwnd(current);
        return true;
      } finally {
        k.CloseHandle(handle);
      }
    }
    return false;
  } catch (cause) {
    log.warn('[window-finder] focusGameWindow failed:', cause);
    return false;
  }
}
