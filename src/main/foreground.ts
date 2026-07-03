// Native "force to the true foreground" for the gamepad summon (Windows only). The Start+Back chord is
// detected by polling XInput in main (gamepad-global.ts) — from Windows' point of view that is NOT user
// input to our window, so the foreground LOCK denies a plain SetForegroundWindow: the launcher can be
// raised and focused, but the previous app stays the ACTIVE window (its taskbar shows, our window is
// merely on top). The documented workaround is to briefly AttachThreadInput to the current foreground
// window's thread — which lifts the lock for us — then SetForegroundWindow succeeds and the launcher
// becomes the true active window (taskbar hides, the renderer Gamepad API gets input).
//
// Read through koffi (same FFI pattern as gamepad-global.ts / game-launcher.ts). DLLs load lazily on
// first use so dev builds off Windows don't fail at import. Any failure is swallowed (best-effort): the
// Electron-side show/focus already ran, so the worst case is the pre-existing "on top but not active".
import koffi from 'koffi';
import { log } from './logger';

// HWND is an opaque pointer; window handles are passed as BigInt (koffi accepts BigInt for opaque
// pointer args, as game-launcher.ts does for HANDLE). Registered by name for the prototypes below.
koffi.pointer('HWND', koffi.opaque());

// GetForegroundWindow returns an HWND; we pass it straight back into the other calls, so its exact JS
// representation doesn't matter (koffi round-trips its own pointer value).
type ForeignHwnd = unknown;
type GetForegroundWindowFn = () => ForeignHwnd;
type GetWindowThreadProcessIdFn = (hWnd: ForeignHwnd, lpdwProcessId: null) => number;
type AttachThreadInputFn = (idAttach: number, idAttachTo: number, fAttach: number) => number;
type SetForegroundWindowFn = (hWnd: bigint) => number;
type BringWindowToTopFn = (hWnd: bigint) => number;
type GetCurrentThreadIdFn = () => number;

interface User32 {
  readonly GetForegroundWindow: GetForegroundWindowFn;
  readonly GetWindowThreadProcessId: GetWindowThreadProcessIdFn;
  readonly AttachThreadInput: AttachThreadInputFn;
  readonly SetForegroundWindow: SetForegroundWindowFn;
  readonly BringWindowToTop: BringWindowToTopFn;
}

interface Kernel32 {
  readonly GetCurrentThreadId: GetCurrentThreadIdFn;
}

let user32: User32 | null = null;
let kernel32: Kernel32 | null = null;

function loadUser32(): User32 {
  if (user32 !== null) return user32;
  const lib = koffi.load('user32.dll');
  // All prototypes use __stdcall (needed for ia32, harmless on x64) — like the WinAPI calls elsewhere.
  user32 = {
    GetForegroundWindow: lib.func(
      'HWND __stdcall GetForegroundWindow()',
    ) as unknown as GetForegroundWindowFn,
    GetWindowThreadProcessId: lib.func(
      'uint32 __stdcall GetWindowThreadProcessId(HWND hWnd, void *lpdwProcessId)',
    ) as unknown as GetWindowThreadProcessIdFn,
    AttachThreadInput: lib.func(
      'int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)',
    ) as unknown as AttachThreadInputFn,
    SetForegroundWindow: lib.func(
      'int __stdcall SetForegroundWindow(HWND hWnd)',
    ) as unknown as SetForegroundWindowFn,
    BringWindowToTop: lib.func(
      'int __stdcall BringWindowToTop(HWND hWnd)',
    ) as unknown as BringWindowToTopFn,
  };
  return user32;
}

function loadKernel32(): Kernel32 {
  if (kernel32 !== null) return kernel32;
  const lib = koffi.load('kernel32.dll');
  kernel32 = {
    GetCurrentThreadId: lib.func(
      'uint32 __stdcall GetCurrentThreadId()',
    ) as unknown as GetCurrentThreadIdFn,
  };
  return kernel32;
}

// Electron returns the native window handle as a pointer-sized Buffer (8 bytes on x64, 4 on ia32).
function handleToBigInt(handle: Buffer): bigint {
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

/**
 * Forces the window with the given native handle to the true foreground (Windows only). Attaches to the
 * current foreground window's input thread to lift the foreground lock, then activates our window and
 * detaches again. No-op off Windows; best-effort on any FFI failure.
 */
export function forceForegroundWindow(handle: Buffer): void {
  if (process.platform !== 'win32') return;
  try {
    const u = loadUser32();
    const k = loadKernel32();
    const hwnd = handleToBigInt(handle);
    const foreground = u.GetForegroundWindow();
    const foregroundThread = u.GetWindowThreadProcessId(foreground, null);
    const ourThread = k.GetCurrentThreadId();
    // Attaching to our OWN thread is a no-op that some Windows versions error on — only attach when the
    // foreground window belongs to a different thread (the common case: another app is active).
    const attach = foregroundThread !== 0 && foregroundThread !== ourThread;
    if (attach) u.AttachThreadInput(ourThread, foregroundThread, 1);
    u.BringWindowToTop(hwnd);
    u.SetForegroundWindow(hwnd);
    if (attach) u.AttachThreadInput(ourThread, foregroundThread, 0);
  } catch (cause) {
    log.warn('[foreground] native force-foreground failed:', cause);
  }
}
