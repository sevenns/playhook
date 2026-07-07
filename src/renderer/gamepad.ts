// Gamepad polling in the renderer.
// HTML5 Gamepad API + requestAnimationFrame loop, standard mapping.
// Navigation: D-pad Left/Right (buttons[14]/[15]) or left-stick X (axes[0]) for the bar; D-pad
// Up/Down (buttons[12]/[13]) or left-stick Y (axes[1]) for the vertical popup stacks.
// A = buttons[0] (activate focused control), B = buttons[1] (back / close popup).
// We fire on the press EDGE (false→true) so one press / one stick tilt = one action.

export interface GamepadController {
  start(): void;
  stop(): void;
}

export interface GamepadHandlers {
  readonly onLeft: () => void;
  readonly onRight: () => void;
  readonly onUp: () => void;
  readonly onDown: () => void;
  readonly onA: () => void;
  readonly onB: () => void;
}

const BTN = { a: 0, b: 1, dpadUp: 12, dpadDown: 13, dpadLeft: 14, dpadRight: 15 } as const;
const STICK_X_AXIS = 0;
const STICK_Y_AXIS = 1;
const STICK_DEADZONE = 0.5;

export function createGamepadController(handlers: GamepadHandlers): GamepadController {
  let rafId = 0;
  let running = false;
  const prev = { left: false, right: false, up: false, down: false, a: false, b: false };

  const isDown = (index: number): boolean => {
    for (const pad of navigator.getGamepads()) {
      if (pad === null) continue;
      const button = pad.buttons[index];
      if (button !== undefined && button.pressed) return true;
    }
    return false;
  };

  const axis = (index: number): number => {
    for (const pad of navigator.getGamepads()) {
      if (pad === null) continue;
      const value = pad.axes[index];
      if (typeof value === 'number' && Math.abs(value) > STICK_DEADZONE) return value;
    }
    return 0;
  };

  const poll = (): void => {
    if (!running) return;
    const x = axis(STICK_X_AXIS);
    const y = axis(STICK_Y_AXIS);
    const left = isDown(BTN.dpadLeft) || x < -STICK_DEADZONE;
    const right = isDown(BTN.dpadRight) || x > STICK_DEADZONE;
    // Standard mapping: stick Y is +down / -up.
    const up = isDown(BTN.dpadUp) || y < -STICK_DEADZONE;
    const down = isDown(BTN.dpadDown) || y > STICK_DEADZONE;
    const a = isDown(BTN.a);
    const b = isDown(BTN.b);

    if (left && !prev.left) handlers.onLeft();
    if (right && !prev.right) handlers.onRight();
    if (up && !prev.up) handlers.onUp();
    if (down && !prev.down) handlers.onDown();
    if (a && !prev.a) handlers.onA();
    if (b && !prev.b) handlers.onB();

    prev.left = left;
    prev.right = right;
    prev.up = up;
    prev.down = down;
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
