// Native "put the PC to sleep" for the power menu (Windows only). Read through koffi (same FFI pattern
// as foreground.ts / gamepad-global.ts): the DLL loads lazily on first use so dev builds off Windows
// don't fail at import. This module is deliberately SEPARATE from power.ts — the service stays
// koffi/electron-free so it is importable in vitest (see test/power.test.ts); main.ts wires this
// implementation in as the injected `suspend` dependency.
//
// We call powrprof!SetSuspendState(FALSE, FALSE, FALSE) rather than the common
// `rundll32 …,SetSuspendState 0,1,0`: rundll32 does NOT forward those arguments, so with hibernation
// enabled (frequently the case on gaming PCs) the machine hibernates instead of sleeping. Calling the
// API directly passes bHibernate=FALSE reliably.
import koffi from 'koffi';
import { log } from './logger';

// BOOLEAN SetSuspendState(BOOLEAN bHibernate, BOOLEAN bForce, BOOLEAN bWakeupEventsDisabled)
type SetSuspendStateFn = (
  bHibernate: number,
  bForce: number,
  bWakeupEventsDisabled: number,
) => number;

let setSuspendState: SetSuspendStateFn | null = null;

function loadPowrprof(): SetSuspendStateFn {
  if (setSuspendState !== null) return setSuspendState;
  const lib = koffi.load('powrprof.dll');
  // __stdcall (needed for ia32, harmless on x64) — like the other WinAPI calls in this codebase.
  // koffi's KoffiFunction call signature is assignable to our typed prototype, so no cast is needed.
  setSuspendState = lib.func(
    'uint8 __stdcall SetSuspendState(uint8 bHibernate, uint8 bForce, uint8 bWakeupEventsDisabled)',
  );
  return setSuspendState;
}

/**
 * Puts the PC to sleep (suspend, NOT hibernate) via powrprof!SetSuspendState. Windows only — the caller
 * (PowerService) already platform-guards, so this is a hard fault path: any FFI failure throws so the
 * service can surface it in the error popup (unlike foreground.ts, whose failure is benign).
 */
export function suspendToSleep(): void {
  const fn = loadPowrprof();
  const result = fn(0, 0, 0);
  // SetSuspendState returns nonzero on success; zero → the request failed (GetLastError has the detail,
  // which we don't surface — a plain failure is enough for the user-facing popup).
  if (result === 0) {
    log.warn('[power] SetSuspendState returned 0 (sleep request failed)');
    throw new Error('SetSuspendState failed');
  }
}
