// Gamepad polling in the renderer (stage 9, R5).
// HTML5 Gamepad API + requestAnimationFrame loop, standard mapping.
// A = buttons[0] (Play), B = buttons[1] (Back / close Info popup), Y = buttons[3] (open Info).
// We detect the press EDGE (false→true transition) so one hold = one action.
// Gating (only act in the right state) is done by the caller / main.

export interface GamepadController {
  start(): void;
  stop(): void;
}

export interface GamepadHandlers {
  readonly onA: () => void;
  readonly onB: () => void;
  readonly onY: () => void;
}

const BUTTONS = { a: 0, b: 1, y: 3 } as const;

export function createGamepadController(handlers: GamepadHandlers): GamepadController {
  let rafId = 0;
  let running = false;
  const previous = { a: false, b: false, y: false };

  const isDown = (index: number): boolean => {
    for (const pad of navigator.getGamepads()) {
      if (pad === null) continue;
      const button = pad.buttons[index];
      if (button !== undefined && button.pressed) return true;
    }
    return false;
  };

  const poll = (): void => {
    if (!running) return;
    const a = isDown(BUTTONS.a);
    const b = isDown(BUTTONS.b);
    const y = isDown(BUTTONS.y);
    if (a && !previous.a) handlers.onA();
    if (b && !previous.b) handlers.onB();
    if (y && !previous.y) handlers.onY();
    previous.a = a;
    previous.b = b;
    previous.y = y;
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
