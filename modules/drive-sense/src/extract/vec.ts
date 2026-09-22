// Three-vector arithmetic for the extraction reference. The ports implement exactly these
// definitions (notably `normalize`'s zero case and `angle` via atan2), so edge cases agree.
import { EPS } from './constants';

export type Vec3 = readonly [number, number, number];

export const ZERO: Vec3 = [0, 0, 0];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.sqrt(dot(a, a));

/** Unit vector along `a`, or exactly `[0, 0, 0]` when |a| < EPS. */
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n < EPS ? ZERO : [a[0] / n, a[1] / n, a[2] / n];
}

/** The component of `v` perpendicular to the unit vector `n`: v − (v·n)n. */
export const reject = (v: Vec3, n: Vec3): Vec3 => sub(v, scale(n, dot(v, n)));

/** Angle between `a` and `b` in [0, π], as atan2(|a×b|, a·b); 0 when either is zero. */
export const angle = (a: Vec3, b: Vec3): number => Math.atan2(norm(cross(a, b)), dot(a, b));

export const isZero = (a: Vec3): boolean => a[0] === 0 && a[1] === 0 && a[2] === 0;

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
