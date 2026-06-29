// Extracts a two-color palette from the hero background (renderer-only, no native deps).
// d1 — the dominant/background color (most frequent area color).
// d2 — an accent: a frequent, saturated color that contrasts with d1. If the image has no
// distinct second color, d2 is derived from d1 (hue-rotated + saturated) so accents still pop.
// Returns null on failure (no image, decode error, tainted canvas); caller keeps CSS fallbacks.

export interface Palette {
  readonly d1: string; // rgb(...) background
  readonly d2: string; // rgb(...) accent
}

const SAMPLE_SIZE = 64;

export function computePalette(dataUrl: string): Promise<Palette | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = (): void => resolve(extractPalette(image));
    image.onerror = (): void => resolve(null);
    image.src = dataUrl;
  });
}

interface Bucket {
  count: number;
  r: number;
  g: number;
  b: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function saturationOf({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function distance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2) / 441;
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

const rgbCss = ({ r, g, b }: Rgb): string => `rgb(${r}, ${g}, ${b})`;

/** Derives an accent from d1 when the image lacks a distinct second color. */
function deriveAccent(d1: Rgb): Rgb {
  const [h, , l] = rgbToHsl(d1);
  return hslToRgb((h + 0.5) % 1, 0.6, Math.min(0.7, Math.max(0.45, 1 - l)));
}

function extractPalette(image: HTMLImageElement): Palette | null {
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
    return null;
  }

  const buckets = new Map<number, Bucket>();
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i + 3] ?? 0) < 128) continue;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 24) continue; // near-black (letterbox)
    if (min > 232) continue; // near-white
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const existing = buckets.get(key);
    if (existing === undefined) buckets.set(key, { count: 1, r, g, b });
    else {
      existing.count += 1;
      existing.r += r;
      existing.g += g;
      existing.b += b;
    }
  }
  if (buckets.size === 0) return null;

  const colors = [...buckets.values()].map((bucket) => ({
    count: bucket.count,
    color: {
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
    } satisfies Rgb,
  }));

  // d1: the most frequent color (the dominant background area).
  let d1Entry = colors[0];
  if (d1Entry === undefined) return null;
  for (const entry of colors) if (entry.count > d1Entry.count) d1Entry = entry;
  const d1 = d1Entry.color;

  // d2: maximize frequency × saturation × contrast-from-d1 to find the accent.
  const maxCount = Math.max(...colors.map((c) => c.count));
  let bestAccent: Rgb | null = null;
  let bestScore = 0;
  for (const entry of colors) {
    const dist = distance(entry.color, d1);
    const score = (entry.count / maxCount) * (0.25 + saturationOf(entry.color)) * (0.15 + dist);
    if (dist > 0.18 && score > bestScore) {
      bestScore = score;
      bestAccent = entry.color;
    }
  }
  const d2 = bestAccent ?? deriveAccent(d1);

  return { d1: rgbCss(d1), d2: rgbCss(d2) };
}
