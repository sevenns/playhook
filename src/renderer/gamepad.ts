// Gamepad polling in the renderer (stage 9, R5).
// HTML5 Gamepad API + requestAnimationFrame loop, standard mapping (A = buttons[0], B = buttons[1]).
// We detect the press EDGE (false→true transition) so one hold = one action.
// Input is gated on the main side (A is only handled in ready; B always hides the window).

export interface GamepadController {
  start(): void;
  stop(): void;
}

export interface GamepadHandlers {
  readonly onA: () => void;
  readonly onB: () => void;
}

const A_BUTTON_INDEX = 0;
const B_BUTTON_INDEX = 1;

export function createGamepadController(handlers: GamepadHandlers): GamepadController {
  let rafId = 0;
  let running = false;
  let previousADown = false;
  let previousBDown = false;

  const isButtonDown = (index: number): boolean => {
    for (const pad of navigator.getGamepads()) {
      if (pad === null) continue;
      const button = pad.buttons[index];
      if (button !== undefined && button.pressed) return true;
    }
    return false;
  };

  const poll = (): void => {
    if (!running) return;
    const aDown = isButtonDown(A_BUTTON_INDEX);
    const bDown = isButtonDown(B_BUTTON_INDEX);
    if (aDown && !previousADown) handlers.onA();
    if (bDown && !previousBDown) handlers.onB();
    previousADown = aDown;
    previousBDown = bDown;
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
