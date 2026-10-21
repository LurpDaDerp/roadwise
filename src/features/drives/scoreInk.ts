/**
 * The drive score's colour: red for a poor drive through amber to green for a clean one, read off
 * the theme's own signal inks and kept at 4.5:1 on the card it sits on. Pure (no React).
 */
import { ensureContrast, mix } from '@/ui';
import { opaque, parseColor } from '@/ui/sky/color';
import type { SignalColors } from '@/ui/tokens';

/**
 * Where the ramp's stops sit on the 0–100 score, on the Analytics coaching bands: red at 60 and
 * under (below Fair), amber at 80 (where Good starts), green at 100 (a clean drive).
 */
export const SCORE_INK_STOPS = [60, 80, 100] as const;

/** The minimum contrast of the score on its card: the AA floor for text. */
export const SCORE_INK_MIN_CONTRAST = 4.5;

type Inks = { signal: Record<'clean' | 'minor' | 'moderate' | 'severe', Pick<SignalColors, 'text'>> };

// ── OKLCH ───────────────────────────────────────────────────────────────────────────────

type Lch = { l: number; c: number; h: number };

const toLinear = (v: number) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

function lchOf(hex: string): Lch {
  const { r, g, b } = parseColor(hex);
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, Bb), h: Math.atan2(Bb, A) };
}

function hexOf({ l: L, c, h }: Lch): string {
  const A = c * Math.cos(h);
  const B = c * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb.map((x) => Math.round(Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, x)))))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** `a` → `b` by `t` in OKLCH, the hue taking the short way round (red to amber to green, never through blue). */
function lerpLch(a: string, b: string, t: number): string {
  const x = lchOf(a);
  const y = lchOf(b);
  let dh = y.h - x.h;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  return hexOf({ l: x.l + (y.l - x.l) * t, c: x.c + (y.c - x.c) * t, h: x.h + dh * t });
}

/**
 * The score's ink: the theme's severe red at 60 and under, amber (halfway between its minor and
 * moderate inks) at 80, its clean green at 100, blended between them in OKLCH so the colours on
 * the way stay clear (no muddy brown or grey); then darkened or lightened only as far as it takes
 * to read at 4.5:1 on `surface`.
 */
export function scoreInk(score: number, colors: Inks, surface: string): string {
  const s = Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;
  const { clean, minor, moderate, severe } = colors.signal;
  const red = opaque(severe.text);
  const amber = mix(opaque(minor.text), opaque(moderate.text), 0.5);
  const green = opaque(clean.text);
  const [lo, mid, hi] = SCORE_INK_STOPS;
  const raw = s <= lo ? red : s <= mid ? lerpLch(red, amber, (s - lo) / (mid - lo)) : lerpLch(amber, green, (s - mid) / (hi - mid));
  return ensureContrast(raw, [opaque(surface)], SCORE_INK_MIN_CONTRAST);
}
