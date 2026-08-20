// The focus indicator: a soft body lying UNDER the selected cover, breathing where it stands and
// flowing to the next one when the selection moves. It replaces the pulsing ring the carousel and the
// Library grid used to draw around the selected card — a ring has to blink out on one card and in on the
// next, while one body per surface simply travels.
//
// The maths that decides WHERE it is stays pure and testable (outlinePoint / pinchScale / jellyBoxOf);
// only createFocusJelly touches a canvas. Design pixels go in, real pixels come out: every caller works
// in the 1920x1080 mockup grid and passes its `--px` along (see screen-scroller.pxUnit).

/** A box the jelly wraps, in REAL px — the coordinate system of the canvas it is drawn on. */
export interface JellyBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Corner radius, so the body keeps the cover's own shape rather than a generic blob's. */
  readonly r: number;
}

/**
 * How the body behaves. Every number here was settled by eye in a standalone sandbox — the values are
 * the ones that read as "jelly" rather than as a box being tweened, and they are collected in one place
 * because tuning them means tuning them TOGETHER.
 */
export const JELLY = {
  /** How long a move takes, ms. The springs below lag behind it on purpose; this is the target's pace. */
  moveMs: 60,
  /** How far the body squeezes at the half-way point, as a fraction of its box. 1 = no squeeze. */
  pinch: 0.83,
  /** Spring constant pulling each point to its place on the target. */
  stiffness: 8,
  /** How much of a point's speed survives each frame's damping — higher damps harder. */
  damping: 0.35,
  /** Amplitude of the idle breathing, design px. */
  wobble: 4.5,
  /** How far the body stands out past the cover on every side, design px. */
  inset: 8,
  /** Points around the contour. Enough that the four corners each get their own, see outlinePoint. */
  points: 36,
  /** Slack around the drawn body the canvas must keep, design px (breathing and the glow reach out). */
  margin: 26,
} as const;

/** The box for a measured card: its own rectangle, pushed out by the stand-off on every side. */
export function jellyBoxOf(
  left: number,
  top: number,
  width: number,
  height: number,
  radius: number,
  unit: number,
): JellyBox {
  const pad = JELLY.inset * unit;
  return {
    x: left - pad,
    y: top - pad,
    w: width + pad * 2,
    h: height + pad * 2,
    // The equidistant curve of a rounded rectangle is a rounded rectangle whose radius grew by the same
    // distance — which is what makes the body echo the cover instead of merely alluding to it.
    r: radius + pad,
  };
}

/**
 * A point on the contour at `t` ∈ [0, 1), walked by ARC LENGTH rather than by angle.
 *
 * The distinction is the whole reason this is a function and not a formula inline: spread by angle, all
 * four corners would share barely one point between them and the spline through them would round the
 * cover's shape away — the exact thing the body is supposed to keep.
 */
export function outlinePoint(box: JellyBox, t: number): readonly [number, number] {
  const r = Math.min(box.r, box.w / 2, box.h / 2);
  const sx = box.w - 2 * r;
  const sy = box.h - 2 * r;
  const arc = (Math.PI / 2) * r;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const wrapped = ((t % 1) + 1) % 1;
  let d = wrapped * (2 * sx + 2 * sy + 4 * arc);

  // Clockwise from the top-left corner's end: top edge, then each corner as a quarter turn about its
  // own centre, then the edge that follows it. `r === 0` cannot divide by zero here — a zero radius
  // makes `arc` zero too, so every corner branch is skipped.
  if (d < sx) return [box.x + r + d, box.y];
  d -= sx;
  if (d < arc) {
    const a = d / r;
    return [right - r + Math.sin(a) * r, box.y + r - Math.cos(a) * r];
  }
  d -= arc;
  if (d < sy) return [right, box.y + r + d];
  d -= sy;
  if (d < arc) {
    const a = d / r;
    return [right - r + Math.cos(a) * r, bottom - r + Math.sin(a) * r];
  }
  d -= arc;
  if (d < sx) return [right - r - d, bottom];
  d -= sx;
  if (d < arc) {
    const a = d / r;
    return [box.x + r - Math.sin(a) * r, bottom - r + Math.cos(a) * r];
  }
  d -= arc;
  if (d < sy) return [box.x, bottom - r - d];
  d -= sy;
  const a = d / r;
  return [box.x + r - Math.cos(a) * r, box.y + r - Math.sin(a) * r];
}

/**
 * How much the body is squeezed `progress` of the way through a move: 1 at both ends, `floor` at the
 * half-way point. A bell rather than a shrink-then-grow pair of ramps — split into phases the movement
 * reads as three glued steps instead of one gesture.
 */
export function pinchScale(progress: number, floor = JELLY.pinch): number {
  const p = Math.min(1, Math.max(0, progress));
  return 1 - (1 - floor) * Math.sin(Math.PI * p);
}

/** What the body is painted with before a palette arrives — the same seed :root carries for --d2. */
export const FALLBACK_COLOUR = '#836e95';

export interface FocusJellyDeps {
  /**
   * Where the body belongs right now, asked once per frame — so it keeps hugging a cover that is still
   * growing, and follows a grid that is still scrolling. `null` means "stay where you are": the caller
   * fades the canvas out instead, which leaves the body in place for the way back.
   */
  target(): JellyBox | null;
  /** The fill, normally the computed `--d2`. Read per frame, so the palette crossfade carries the body. */
  colour(): string;
  /** One design pixel in real px — the breathing and the glow are specified in design px. */
  unit(): number;
}

export interface FocusJelly {
  /** The selection moved: squeeze through the trip. `instant` puts the body there with no travel at all. */
  bump(instant?: boolean): void;
  /** Whether frames are drawn at all. A hidden surface must not keep a canvas animating on a handheld. */
  setActive(active: boolean): void;
  /** The canvas' size in CSS px (the backing store is scaled by the device ratio). */
  resize(width: number, height: number): void;
}

interface Point {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function createFocusJelly(canvas: HTMLCanvasElement, deps: FocusJellyDeps): FocusJelly {
  const ctx = canvas.getContext('2d');
  const pts: Point[] = Array.from({ length: JELLY.points }, () => ({ x: 0, y: 0, vx: 0, vy: 0 }));

  let active = false;
  let frame = 0;
  let seeded = false;
  let box: JellyBox | null = null;
  let moveStart = -1;
  let cssW = 0;
  let cssH = 0;

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

  /** One frame of the springs. Each point is pulled to its own place on the target, not to the centre. */
  function step(dt: number, now: number, to: JellyBox): void {
    const unit = deps.unit();
    const stiff = JELLY.stiffness / 1000;
    const keep = 1 - JELLY.damping;
    const amp = JELLY.wobble * unit;
    const cx = to.x + to.w / 2;
    const cy = to.y + to.h / 2;

    // Which way the body is heading, from where its points sit against where they are wanted.
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
      // Idle breathing: two sines out of step, pushed along the outward normal so the body swells and
      // sags rather than sliding about.
      const wob = amp * (Math.sin(now * 0.0011 + i * 1.7) + 0.6 * Math.sin(now * 0.0017 + i * 0.9));
      const nx = (bx - cx) / (to.w / 2);
      const ny = (by - cy) / (to.h / 2);
      const nl = Math.hypot(nx, ny);
      const ox = nl === 0 ? 0 : nx / nl;
      const oy = nl === 0 ? 0 : ny / nl;
      const tx = bx + ox * wob;
      const ty = by + oy * wob;

      // The edge FACING the move is stiffer, so it arrives first and the trailing edge is left to catch
      // up — which is what stretches the body along its travel instead of sliding it as one piece.
      const lead = ox * dirx + oy * diry;
      const k = stiff * (1 + 0.75 * lead) * (1000 / Math.max(JELLY.moveMs, 120)) * 60;

      p.vx = (p.vx + (tx - p.x) * k * dt) * Math.pow(keep, dt * 60);
      p.vy = (p.vy + (ty - p.y) * k * dt) * Math.pow(keep, dt * 60);
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
    }
  }

  function draw(now: number, to: JellyBox): void {
    if (ctx === null) return;
    const unit = deps.unit();
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const squeeze =
      moveStart < 0 ? 1 : pinchScale((now - moveStart) / Math.max(JELLY.moveMs, 60));
    if (moveStart >= 0 && now - moveStart >= Math.max(JELLY.moveMs, 60)) moveStart = -1;

    const cx = to.x + to.w / 2;
    const cy = to.y + to.h / 2;
    const at = (i: number): readonly [number, number] => {
      const p = pts[((i % pts.length) + pts.length) % pts.length];
      if (p === undefined) return [cx, cy];
      return squeeze === 1
        ? [p.x, p.y]
        : [cx + (p.x - cx) * squeeze, cy + (p.y - cy) * squeeze];
    };

    // Catmull-Rom as cubic Béziers: the curve passes THROUGH the points. Quadratics through the
    // midpoints would clip every corner, shrinking the body inside the cover it is meant to sit under.
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

    const colour = deps.colour();
    ctx.fillStyle = colour;
    ctx.shadowColor = colour;
    ctx.shadowBlur = 24 * unit;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function tick(now: number): void {
    frame = 0;
    if (!active) return;
    frame = window.requestAnimationFrame(tick);
    // Nothing is drawn while the surface is hidden — a detail screen over the row, the Library veil on
    // top of it. The check costs a style resolve; a frame of canvas work costs a great deal more, and
    // on a handheld the difference is battery. The loop keeps ticking so the body is already in place
    // the moment the surface comes back.
    if (!canvas.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
    const to = deps.target() ?? box;
    if (to !== null) {
      box = to;
      if (!seeded) seed(to);
      step(1 / 60, now, to);
      draw(now, to);
    }
  }

  return {
    bump(instant = false): void {
      const to = deps.target();
      if (instant) {
        moveStart = -1;
        if (to !== null) {
          box = to;
          seed(to);
        } else {
          seeded = false;
        }
        return;
      }
      moveStart = performance.now();
    },
    setActive(next: boolean): void {
      if (active === next) return;
      active = next;
      if (active) {
        if (frame === 0) frame = window.requestAnimationFrame(tick);
        return;
      }
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    },
    resize(width: number, height: number): void {
      if (cssW === width && cssH === height) return; // called from layout paths; most calls change nothing
      cssW = width;
      cssH = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    },
  };
}
