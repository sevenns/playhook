// Liquid UI: ONE soft body for the whole launcher. Whatever holds the focus right now — a cover on the
// row, the Play button, a row in Settings, a key on the on-screen keyboard — the same body is under it,
// and moving the focus makes it flow there rather than making one highlight blink out and another in.
//
// The body lives in SCREEN coordinates, and that is what lets it be one body. Its canvases are only
// windows onto it: each layer of the UI owns one, sized to that layer and drawn with that layer's own
// offset, so a body halfway between the bar and a popup is painted by both and reads as continuous. A
// single canvas could not do this — .settings-column and friends carry opacity/transform, so they build
// stacking contexts of their own and nothing outside them can be layered underneath their contents.
//
// The geometry is shared with focus-jelly.ts (the contour, the squeeze, the box around a target); this
// module owns the springs, the windows and the question of WHAT has the focus.
import {
  JELLY,
  JELLY_UI,
  jellyBoxOf,
  outlinePoint,
  pinchScale,
  type JellyBox,
  type JellyTuning,
} from './focus-jelly.js';

/**
 * What the body may sit under: everything the launcher highlights carries `.is-focused`, which is the one
 * focus visual across every surface (see styles.css).
 *
 * The two CARD surfaces are deliberately not here. The row and the grid keep their own bodies
 * (focus-jelly.ts), because the carousel breaks the assumption this module is built on: there the
 * selection stands still and the strip slides under it, so a screen rectangle is mid-flight for the
 * length of every step and the springs chase a target that never settles. Their own canvases live inside
 * the moving strip, where the selected card simply does not move.
 */
const FOCUS_SELECTOR = '.is-focused';

/**
 * A layer that can show the body. `priority` settles who owns the focus when more than one surface has
 * a marked element: a popup over a screen leaves the screen's row marked, and without an order the body
 * would drop back down to it. Higher wins.
 */
interface LiquidWindow {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D | null;
  readonly root: HTMLElement;
  readonly priority: number;
}

export interface LiquidDeps {
  /** One design pixel in real px (--px is a vh unit, so it moves with the window). */
  unit(): number;
  /** The fill, normally the computed `--d2` — read per frame, so the palette crossfade carries it. */
  colour(): string;
}

export interface LiquidFocus {
  /**
   * Registers a layer: `root` is both the subtree searched for the focused element and the box the
   * window is fitted to. The canvas is created here rather than shipped in index.html — a window is an
   * implementation detail of this module, and eight hand-written canvases would be eight chances to
   * forget one. `priority` breaks ties when several surfaces hold a marked element at once.
   */
  mount(root: HTMLElement, priority: number, before?: Element | null): void;
  /** Puts the body where the focus is with no travel — for a screen change, which is a cut, not a move. */
  snap(): void;
  start(): void;
}

interface Point {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Which tuning the body runs on right now. A cover and a button are the same shape to this module and
 * nothing alike to the eye: covers are big, far apart and slow, so softness reads as weight, while the
 * bar's buttons are small and a few px from each other, where that same softness smears across them.
 * The body carries its tuning with the thing it is under, so crossing from the row to the bar
 * changes how it behaves as well as where it is.
 */
function tuningFor(el: Element): JellyTuning {
  return el.classList.contains('card') ? JELLY : JELLY_UI;
}

/** The focused element's box in SCREEN coordinates, plus the corner radius the body should copy. */
function targetOf(el: Element, unit: number, tuning: JellyTuning): JellyBox {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const parsed = Number.parseFloat(style.borderTopLeftRadius);
  const radius = Number.isFinite(parsed) ? parsed : 0;
  return jellyBoxOf(rect.left, rect.top, rect.width, rect.height, radius, unit, tuning);
}

export function createLiquidFocus(deps: LiquidDeps): LiquidFocus {
  const windows: LiquidWindow[] = [];
  // The contour is allocated once and kept across tunings — the point COUNT is shared (both sets carry
  // the same one), so switching tuning mid-flight changes how the body moves, never how it is built.
  const pts: Point[] = Array.from({ length: JELLY.points }, () => ({ x: 0, y: 0, vx: 0, vy: 0 }));

  let running = false;
  let seeded = false;
  let owner: Element | null = null;
  let moveStart = -1;
  let pendingSnap = false;

  /** The focused element of the topmost surface that has one, or null when nothing is highlighted. */
  function findFocused(): Element | null {
    let best: Element | null = null;
    let bestPriority = -Infinity;
    for (const win of windows) {
      if (win.priority <= bestPriority) continue;
      if (!win.root.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      for (const el of win.root.querySelectorAll(FOCUS_SELECTOR)) {
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        best = el;
        bestPriority = win.priority;
        break;
      }
    }
    return best;
  }

  function seed(to: JellyBox): void {
    for (let i = 0; i < pts.length; i += 1) {
      const [x, y] = outlinePoint(to, i / pts.length);
      const p = pts[i];
      if (p === undefined) continue;
      p.x = x;
      p.y = y;
      p.vx = 0;
      p.vy = 0;
    }
    seeded = true;
  }

  /** One frame of the springs — the same soft body the row carried, now in screen space. */
  function step(dt: number, now: number, to: JellyBox, tuning: JellyTuning): void {
    const unit = deps.unit();
    const stiff = tuning.stiffness / 1000;
    const keep = 1 - tuning.damping;
    const amp = tuning.wobble * unit;
    const cx = to.x + to.w / 2;
    const cy = to.y + to.h / 2;

    let mx = 0;
    let my = 0;
    for (const p of pts) {
      mx += p.x;
      my += p.y;
    }
    mx = cx - mx / pts.length;
    my = cy - my / pts.length;
    const mlen = Math.hypot(mx, my);
    const dirx = mlen === 0 ? 0 : mx / mlen;
    const diry = mlen === 0 ? 0 : my / mlen;

    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      if (p === undefined) continue;
      const [bx, by] = outlinePoint(to, i / pts.length);
      const turn = (i / pts.length) * Math.PI * 2;
      const wob =
        amp *
        (Math.sin(2 * turn + now * 0.00055) +
          0.62 * Math.sin(3 * turn - now * 0.00041 + 1.7) +
          0.44 * Math.sin(5 * turn + now * 0.00068 + 4.1));
      const nx = (bx - cx) / (to.w / 2);
      const ny = (by - cy) / (to.h / 2);
      const nl = Math.hypot(nx, ny);
      const ox = nl === 0 ? 0 : nx / nl;
      const oy = nl === 0 ? 0 : ny / nl;
      const tx = bx + ox * wob;
      const ty = by + oy * wob;

      const lead = ox * dirx + oy * diry;
      const k = stiff * (1 + 0.75 * lead) * (1000 / Math.max(tuning.moveMs, 120)) * 60;

      p.vx = (p.vx + (tx - p.x) * k * dt) * Math.pow(keep, dt * 60);
      p.vy = (p.vy + (ty - p.y) * k * dt) * Math.pow(keep, dt * 60);
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
    }
  }

  /** The body's own bounds in screen space, so a window that cannot see it does no work. */
  function bounds(squeeze: number, to: JellyBox): DOMRect {
    const cx = to.x + to.w / 2;
    const cy = to.y + to.h / 2;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      const x = cx + (p.x - cx) * squeeze;
      const y = cy + (p.y - cy) * squeeze;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return new DOMRect(minX, minY, maxX - minX, maxY - minY);
  }

  function paint(win: LiquidWindow, squeeze: number, to: JellyBox, colour: string): void {
    const { ctx, canvas } = win;
    if (ctx === null) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // The body is in SCREEN space; this window is a hole in the page at `rect`, so drawing it means
    // shifting by the window's own origin. Every window does the same, which is why one body spanning
    // two of them looks like one body.
    ctx.translate(-rect.left, -rect.top);

    const cx = to.x + to.w / 2;
    const cy = to.y + to.h / 2;
    const at = (i: number): readonly [number, number] => {
      const p = pts[((i % pts.length) + pts.length) % pts.length];
      if (p === undefined) return [cx, cy];
      return squeeze === 1 ? [p.x, p.y] : [cx + (p.x - cx) * squeeze, cy + (p.y - cy) * squeeze];
    };

    ctx.beginPath();
    const [sx, sy] = at(0);
    ctx.moveTo(sx, sy);
    for (let i = 0; i < pts.length; i += 1) {
      const [x0, y0] = at(i - 1);
      const [x1, y1] = at(i);
      const [x2, y2] = at(i + 1);
      const [x3, y3] = at(i + 2);
      ctx.bezierCurveTo(
        x1 + (x2 - x0) / 6,
        y1 + (y2 - y0) / 6,
        x2 - (x3 - x1) / 6,
        y2 - (y3 - y1) / 6,
        x2,
        y2,
      );
    }
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
  }

  function clear(win: LiquidWindow): void {
    if (win.ctx === null || win.canvas.width === 0) return;
    win.ctx.setTransform(1, 0, 0, 1, 0, 0);
    win.ctx.clearRect(0, 0, win.canvas.width, win.canvas.height);
  }

  function frame(now: number): void {
    window.requestAnimationFrame(frame);

    const focused = findFocused();
    if (focused === null) {
      for (const win of windows) clear(win);
      owner = null;
      seeded = false;
      return;
    }

    const tuning = tuningFor(focused);
    const to = targetOf(focused, deps.unit(), tuning);
    if (!seeded || pendingSnap) {
      seed(to);
      pendingSnap = false;
      moveStart = -1;
    } else if (focused !== owner) {
      moveStart = now; // a new element has it: squeeze through the trip
    }
    owner = focused;

    step(1 / 60, now, to, tuning);

    const span = Math.max(tuning.moveMs, 60);
    const squeeze = moveStart < 0 ? 1 : pinchScale((now - moveStart) / span, tuning.pinch);
    if (moveStart >= 0 && now - moveStart >= span) moveStart = -1;

    const reach = bounds(squeeze, to);
    const colour = deps.colour();
    for (const win of windows) {
      const rect = win.canvas.getBoundingClientRect();
      const hidden =
        rect.width === 0 ||
        rect.height === 0 ||
        !win.canvas.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      const misses =
        reach.right < rect.left ||
        reach.left > rect.right ||
        reach.bottom < rect.top ||
        reach.top > rect.bottom;
      if (hidden || misses) {
        clear(win);
        continue;
      }
      paint(win, squeeze, to, colour);
    }
  }

  return {
    mount(root: HTMLElement, priority: number, before?: Element | null): void {
      const canvas = document.createElement('canvas');
      canvas.className = 'liquid-window';
      canvas.setAttribute('aria-hidden', 'true');
      // First child by default — but a layer that opens with a veil and a blur of its own needs the
      // window AFTER those, or the body is painted underneath and comes out dimmed by the very gradient
      // that is supposed to sit behind it.
      if (before === undefined || before === null) root.prepend(canvas);
      else root.insertBefore(canvas, before);
      windows.push({ canvas, ctx: canvas.getContext('2d'), root, priority });
    },
    snap(): void {
      pendingSnap = true;
    },
    start(): void {
      if (running) return;
      running = true;
      window.requestAnimationFrame(frame);
    },
  };
}

/** Exposed for the tests: what the body considers a focus target. */
export const LIQUID_FOCUS_SELECTOR = FOCUS_SELECTOR;
