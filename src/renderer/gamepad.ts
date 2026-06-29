// Gamepad polling in the renderer (stage 9, R5).
// HTML5 Gamepad API + requestAnimationFrame loop, standard mapping.
// Navigation: D-pad Left/Right (buttons[14]/[15]) or left-stick X (axes[0]).
// A = buttons[0] (activate focused control), B = buttons[1] (back / close popup).
// We fire on the press EDGE (false→true) so one press / one stick tilt = one action.

export interface GamepadController {
  start(): void;
  stop(): void;
}

export interface GamepadHandlers {
  readonly onLeft: () => void;
  readonly onRight: () => void;
  readonly onA: () => void;
  readonly onB: () => void;
}

const BTN = { a: 0, b: 1, dpadLeft: 14, dpadRight: 15 } as const;
const STICK_X_AXIS = 0;
const STICK_DEADZONE = 0.5;

export function createGamepadController(handlers: GamepadHandlers): GamepadController {
  let rafId = 0;
  let running = false;
  const prev = { left: false, right: false, a: false, b: false };

  const isDown = (index: number): boolean => {
    for (const pad of navigator.getGamepads()) {
      if (pad === null) continue;
      const button = pad.buttons[index];
      if (button !== undefined && button.pressed) return true;
    }
    return false;
  };

  const stickX = (): number => {
    for (const pad of navigator.getGamepads()) {
      if (pad === null) continue;
      const value = pad.axes[STICK_X_AXIS];
      if (typeof value === 'number' && Math.abs(value) > STICK_DEADZONE) return value;
    }
    return 0;
  };

  const poll = (): void => {
    if (!running) return;
    const x = stickX();
    const left = isDown(BTN.dpadLeft) || x < -STICK_DEADZONE;
    const right = isDown(BTN.dpadRight) || x > STICK_DEADZONE;
    const a = isDown(BTN.a);
    const b = isDown(BTN.b);

    if (left && !prev.left) handlers.onLeft();
    if (right && !prev.right) handlers.onRight();
    if (a && !prev.a) handlers.onA();
    if (b && !prev.b) handlers.onB();

    prev.left = left;
    prev.right = right;
    prev.a = a;
    prev.b = b;
    rafId = requestAnimationFrame(poll);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      rafId = requestAnimationFrame(poll);
    },
    stop(): void {
      running = false;
      cancelAnimationFrame(rafId);
    },
  };
}
