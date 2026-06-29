// Global gamepad hotkey (Windows): hold Start+Back to bring the launcher window back.
// Unlike the renderer's HTML5 Gamepad API (which only works while our window is focused),
// this reads the controller natively via XInput in main — so it works GLOBALLY, even while a
// game is running in the foreground and our window is hidden in the tray.
//
// XInput is read through koffi (FFI): koffi ships prebuilt binaries in the package, so there's
// no node-gyp/native-compile step (unlike drivelist). We use the documented XInputGetState
// (Start/Back are normal buttons — no XInputGetStateEx hack, no Game Bar conflict).
import koffi from 'koffi';
import { log } from './logger';

const START_BUTTON = 0x0010; // XINPUT_GAMEPAD_START (the right central "Menu ☰" button)
const BACK_BUTTON = 0x0020; // XINPUT_GAMEPAD_BACK (the left central "View ⧉" button)
const CHORD_MASK = START_BUTTON | BACK_BUTTON;

const HOLD_MS = 600; // how long the chord must be held to trigger
const POLL_INTERVAL_MS = 50;
const MAX_CONTROLLERS = 4; // XInput supports user indices 0..3
const ERROR_SUCCESS = 0; // XInputGetState return code for a connected controller

// XInput structs (do not require the DLL — safe to define at import time on any OS).
koffi.struct('XINPUT_GAMEPAD', {
  wButtons: 'uint16',
  bLeftTrigger: 'uint8',
  bRightTrigger: 'uint8',
  sThumbLX: 'int16',
  sThumbLY: 'int16',
  sThumbRX: 'int16',
  sThumbRY: 'int16',
});
koffi.struct('XINPUT_STATE', {
  dwPacketNumber: 'uint32',
  Gamepad: 'XINPUT_GAMEPAD',
});

interface XInputStateObject {
  dwPacketNumber: number;
  Gamepad: { wButtons: number };
}
type XInputGetStateFn = (userIndex: number, state: XInputStateObject) => number;

/** Loads XInput and binds XInputGetState. Returns null if unavailable (e.g. non-Windows). */
function loadXInput(): XInputGetStateFn | null {
  // Different Windows versions ship different XInput DLL names.
  const candidates = ['XInput1_4.dll', 'xinput1_4.dll', 'XInput1_3.dll', 'XInput9_1_0.dll'];
  for (const dllName of candidates) {
    try {
      const lib = koffi.load(dllName);
      const fn = lib.func(
        'uint32 __stdcall XInputGetState(uint32 dwUserIndex, _Out_ XINPUT_STATE *pState)',
      );
      return fn as unknown as XInputGetStateFn;
    } catch {
      // try the next DLL name
    }
  }
  log.warn('[gamepad-global] XInput not available — Start+Back hotkey disabled');
  return null;
}

export class GlobalGamepad {
  private readonly getState: XInputGetStateFn | null;
  private timer: NodeJS.Timeout | null = null;
  private holdSince: number | null = null;
  private fired = false;
  private chordHandler: (() => void) | null = null;

  constructor() {
    this.getState = loadXInput();
  }

  /** true if XInput is available on this system (otherwise start() is a no-op). */
  get isAvailable(): boolean {
    return this.getState !== null;
  }

  onChord(handler: () => void): void {
    this.chordHandler = handler;
  }

  start(): void {
    if (this.getState === null || this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    if (!this.isChordPressed()) {
      this.holdSince = null;
      this.fired = false;
      return;
    }
    const now = Date.now();
    if (this.holdSince === null) this.holdSince = now;
    // Fire once per hold, only after the required duration; reset on release above.
    if (!this.fired && now - this.holdSince >= HOLD_MS) {
      this.fired = true;
      this.chordHandler?.();
    }
  }

  private isChordPressed(): boolean {
    const getState = this.getState;
    if (getState === null) return false;
    for (let index = 0; index < MAX_CONTROLLERS; index += 1) {
      const state: XInputStateObject = { dwPacketNumber: 0, Gamepad: { wButtons: 0 } };
      let result: number;
      try {
        result = getState(index, state);
      } catch {
        continue;
      }
      if (result !== ERROR_SUCCESS) continue; // controller not connected on this slot
      if ((state.Gamepad.wButtons & CHORD_MASK) === CHORD_MASK) return true;
    }
    return false;
  }
}
