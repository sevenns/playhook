// Bring an external process window to the foreground (Windows), by pid, via Win32 (koffi/user32).
// Used by "resume": after the Start+Back hotkey summons the launcher over a running game, pressing
// Play/A must hand control BACK to the game — i.e. activate the game's own window so gamepad input
// goes to the game again. Just hiding our window doesn't reliably re-activate the game.
//
// This works because at the moment of resume OUR process is the foreground process, so Windows lets
// us hand the foreground to another window (SetForegroundWindow's restriction doesn't bite).
// koffi is already a dependency (XInput); it ships prebuilt, so there's no native-compile step.
import koffi from 'koffi';
import { log } from './logger';

const GW_OWNER = 4; // GetWindow: the window's owner (we skip owned tool/dialog windows)
const SW_RESTORE = 9; // ShowWindow: un-minimize if the game was minimized

// Opaque Win32 handle. koffi hands these back as external pointers; we only pass them around.
type Handle = unknown;

type EnumCallback = (hwnd: Handle, lParam: number) => boolean;

interface User32 {
  readonly enumWindows: (lpEnumFunc: unknown, lParam: number) => boolean;
  readonly getWindowThreadProcessId: (hwnd: Handle, pidOut: number[]) => number;
  readonly isWindowVisible: (hwnd: Handle) => boolean;
  readonly getWindow: (hwnd: Handle, uCmd: number) => Handle;
  readonly showWindow: (hwnd: Handle, nCmdShow: number) => boolean;
  readonly bringWindowToTop: (hwnd: Handle) => boolean;
  readonly setForegroundWindow: (hwnd: Handle) => boolean;
}

// undefined = not loaded yet, null = unavailable (non-Windows / load failed).
let cached: User32 | null | undefined;

function loadUser32(): User32 | null {
  if (cached !== undefined) return cached;
  try {
    const lib = koffi.load('user32.dll');
    // Named callback prototype so EnumWindows can reference it by name as a pointer parameter.
    koffi.proto('bool __stdcall WNDENUMPROC(void *hwnd, intptr_t lParam)');
    cached = {
      enumWindows: lib.func(
        'bool __stdcall EnumWindows(WNDENUMPROC *lpEnumFunc, intptr_t lParam)',
      ) as User32['enumWindows'],
      getWindowThreadProcessId: lib.func(
        'uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *lpdwProcessId)',
      ) as User32['getWindowThreadProcessId'],
      isWindowVisible: lib.func(
        'bool __stdcall IsWindowVisible(void *hwnd)',
      ) as User32['isWindowVisible'],
      getWindow: lib.func('void* __stdcall GetWindow(void *hwnd, uint32 uCmd)') as User32['getWindow'],
      showWindow: lib.func(
        'bool __stdcall ShowWindow(void *hwnd, int nCmdShow)',
      ) as User32['showWindow'],
      bringWindowToTop: lib.func(
        'bool __stdcall BringWindowToTop(void *hwnd)',
      ) as User32['bringWindowToTop'],
      setForegroundWindow: lib.func(
        'bool __stdcall SetForegroundWindow(void *hwnd)',
      ) as User32['setForegroundWindow'],
    };
  } catch (cause) {
    log.warn('[foreground] user32 unavailable — resume will fall back to hiding the window:', cause);
    cached = null;
  }
  return cached;
}

/** Finds the first visible, non-owned top-level window belonging to `pid`. null if none. */
function findWindow(u: User32, pid: number): Handle {
  let found: Handle = null;
  const callback: EnumCallback = (hwnd, _lParam) => {
    const pidOut: number[] = [0];
    u.getWindowThreadProcessId(hwnd, pidOut);
    if (pidOut[0] !== pid) return true; // not our process — keep enumerating
    if (!u.isWindowVisible(hwnd)) return true; // skip hidden helper windows
    if (u.getWindow(hwnd, GW_OWNER) !== null) return true; // skip owned tool/dialog windows
    found = hwnd;
    return false; // stop enumeration
  };
  const pointer = koffi.register(callback, koffi.pointer('WNDENUMPROC'));
  try {
    u.enumWindows(pointer, 0);
  } finally {
    koffi.unregister(pointer);
  }
  return found;
}

/**
 * Activates the main window of the process `pid` and returns whether it succeeded.
 * false → no window found or the API is unavailable (caller should fall back, e.g. hide our window).
 */
export function focusWindowByPid(pid: number): boolean {
  const u = loadUser32();
  if (u === null) return false;
  let hwnd: Handle = null;
  try {
    hwnd = findWindow(u, pid);
  } catch (cause) {
    log.error(`[foreground] enum failed for pid ${pid}:`, cause);
    return false;
  }
  if (hwnd === null) {
    log.warn(`[foreground] no top-level window found for pid ${pid}`);
    return false;
  }
  u.showWindow(hwnd, SW_RESTORE);
  u.bringWindowToTop(hwnd);
  const ok = u.setForegroundWindow(hwnd);
  log.info(`[foreground] focus pid ${pid}: setForegroundWindow=${ok}`);
  return ok;
}
