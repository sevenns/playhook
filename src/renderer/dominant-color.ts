// Computes a button accent color from the hero background (renderer-only, no native deps).
// Draws the image onto a small offscreen canvas, builds a quantized color histogram, and picks
// the dominant bucket — weighted toward saturated pixels so the accent pops rather than landing
// on a muddy average. Returns null on any failure (no image, decode error, tainted canvas), and
// the caller then keeps the default button color.

export interface ButtonColors {
  readonly bg: string;
  readonly fg: string;
}

const SAMPLE_SIZE = 64;

export function computeButtonColors(dataUrl: string): Promise<ButtonColors | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = (): void => resolve(extractColors(image));
    image.onerror = (): void => resolve(null);
    image.src = dataUrl;
  });
}

interface ColorBucket {
  count: number;
  r: number;
  g: number;
  b: number;
  score: number;
}

function extractColors(image: HTMLImageElement): ButtonColors | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return null; // tainted canvas (shouldn't happen for data: URLs)
  }

  const buckets = new Map<number, ColorBucket>();
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] ?? 0;
    if (alpha < 128) continue;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 32) continue; // near-black (typically background)
    if (min > 224) continue; // near-white
    const saturation = max === 0 ? 0 : (max - min) / max;
    // Quantize to 5 bits per channel; weight colorful pixels higher so the accent stands out.
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const weight = 1 + saturation * 2;
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, { count: 1, r, g, b, score: weight });
    } else {
      existing.count += 1;
      existing.r += r;
      existing.g += g;
      existing.b += b;
      existing.score += weight;
    }
  }

  let best: ColorBucket | null = null;
  for (const bucket of buckets.values()) {
    if (best === null || bucket.score > best.score) best = bucket;
  }
  if (best === null) return null;

  let r = Math.round(best.r / best.count);
  let g = Math.round(best.g / best.count);
  let b = Math.round(best.b / best.count);

  // Keep the button visible: lift a very dark dominant color toward a usable brightness.
  const peak = Math.max(r, g, b);
  if (peak > 0 && peak < 96) {
    const factor = 96 / peak;
    r = Math.min(255, Math.round(r * factor));
    g = Math.min(255, Math.round(g * factor));
    b = Math.min(255, Math.round(b * factor));
  }

  // Pick readable text color for the chosen background by perceived luminance.
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const fg = luminance > 0.55 ? '#0c0c0f' : '#ffffff';
  return { bg: `rgb(${r}, ${g}, ${b})`, fg };
}
