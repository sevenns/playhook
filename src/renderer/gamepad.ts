// Gamepad polling in the renderer (stage 9, R5).
// HTML5 Gamepad API + requestAnimationFrame loop, standard mapping (A = buttons[0]).
// We detect the press EDGE (false→true transition) so one hold = one action.
// Input is ignored while the game is running on the main side (the request is only handled in ready).

export interface GamepadController {
  start(): void;
  stop(): void;
}

const A_BUTTON_INDEX = 0;

export function createGamepadController(onPressA: () => void): GamepadController {
  let rafId = 0;
  let running = false;
  let previousADown = false;

  const isADown = (): boolean => {
    for (const pad of navigator.getGamepads()) {
      if (pad === null) continue;
      const button = pad.buttons[A_BUTTON_INDEX];
      if (button !== undefined && button.pressed) return true;
    }
    return false;
  };

  const poll = (): void => {
    if (!running) return;
    const aDown = isADown();
    if (aDown && !previousADown) onPressA();
    previousADown = aDown;
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
