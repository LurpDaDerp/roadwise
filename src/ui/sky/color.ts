import { contrastRatio } from '../contrast';

/**
 * Colour arithmetic for the sky theme: parsing, mixing, contrast repair and whole-palette
 * interpolation. Everything works on `#rrggbb` and `rgba(r, g, b, a)` strings, the two forms the
 * tokens use, so a blended palette is still a plain palette every primitive already understands.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

const HEX = /^#([0-9a-f]{6})$/i;
const RGBA = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

export function isColor(v: unknown): v is string {
  return typeof v === 'string' && (HEX.test(v) || RGBA.test(v));
}

export function parseColor(c: string): Rgba {
  const h = HEX.exec(c);
  if (h) {
    const n = parseInt(h[1] ?? '0', 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = RGBA.exec(c);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
  throw new Error(`not a colour: ${c}`);
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const hex2 = (v: number) => clamp255(v).toString(16).padStart(2, '0').toUpperCase();

export function formatColor({ r, g, b, a }: Rgba): string {
  if (a >= 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return `rgba(${clamp255(r)}, ${clamp255(g)}, ${clamp255(b)}, ${Math.round(Math.max(0, a) * 1000) / 1000})`;
}

/** `a` → `b` by `t` (0..1). Opaque in, opaque out; either side translucent gives an `rgba()`. */
export function mix(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const x = parseColor(a);
  const y = parseColor(b);
  return formatColor({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
    a: x.a + (y.a - x.a) * t,
  });
}

/** A colour at an opacity, for washes and glows drawn over another layer. */
export function withAlpha(c: string, alpha: number): string {
  const x = parseColor(c);
  return formatColor({ ...x, a: alpha });
}

/** Opaque `#rrggbb` (drops alpha) so a contrast check can read it. */
export function opaque(c: string): string {
  return formatColor({ ...parseColor(c), a: 1 });
}

/**
 * The nearest colour to `fg` that reads at `min`:1 on every ground in `on`, moved toward black or
 * white (whichever side of the grounds it already sits on, or the side that can reach the target).
 * Hue survives; only lightness gives way. Used so a mixed accent can never fall under AA.
 */
export function ensureContrast(fg: string, on: readonly string[], min: number): string {
  const ok = (c: string) => on.every((g) => contrastRatio(c, g) >= min);
  if (ok(fg)) return fg;
  const lightGround = on.reduce((s, g) => s + contrastRatio(g, '#000000'), 0) / on.length > 10.5;
  const toward = lightGround ? '#000000' : '#FFFFFF';
  // Binary search on the mix amount: the first step that clears every ground.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const midT = (lo + hi) / 2;
    if (ok(mix(fg, toward, midT))) hi = midT;
    else lo = midT;
  }
  return mix(fg, toward, hi);
}

/**
 * A ground (`bg`) pulled toward `toward` until `fg` reads on it at `min`:1: the reverse of
 * `ensureContrast`, for tinted backgrounds that text sits on.
 */
export function ensureGround(ground: string, inks: readonly string[], min: number, toward: string): string {
  const ok = (g: string) => inks.every((i) => contrastRatio(i, g) >= min);
  if (ok(ground)) return ground;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const midT = (lo + hi) / 2;
    if (ok(mix(ground, toward, midT))) hi = midT;
    else lo = midT;
  }
  return mix(ground, toward, hi);
}

/**
 * Interpolate any palette-shaped value: colour strings blend, numbers lerp, arrays and objects
 * recurse, and anything else (scheme names, shadow strings, flags) switches at the halfway point.
 * Shapes are taken from `to`; a key missing on one side takes the other side's value.
 */
export function lerpDeep<T>(from: T, to: T, t: number): T {
  if (t <= 0) return from;
  if (t >= 1) return to;
  return lerpAny(from, to, t) as T;
}

function lerpAny(a: unknown, b: unknown, t: number): unknown {
  if (a === b) return b;
  if (isColor(a) && isColor(b)) return mix(a, b, t);
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return b.map((v, i) => lerpAny(a[i], v, t));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = {};
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of Object.keys(bo)) out[k] = k in ao ? lerpAny(ao[k], bo[k], t) : bo[k];
    return out;
  }
  return t < 0.5 ? a : b;
}
