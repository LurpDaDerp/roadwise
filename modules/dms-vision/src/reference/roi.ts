// Luma statistics for quality classification (README §4 fields 16–21, 28, 29, 32). Computed in the
// BUFFER frame, from MediaPipe's buffer-frame landmarks and the unrotated pixels, so no pixel is
// ever rotated. A rotation by a multiple of 90° maps pixels one-to-one, so every statistic is
// equivalent to its upright value up to the sampling grid. Whole-rect means, the eye masks and
// `eyeSat` are exactly equal. `faceLuma` (every 2nd pixel from the rect origin), `frameLuma` (every
// 8th) and the 64×64 blur cells sample a slightly different grid per orientation. Native always
// computes in the buffer frame, so this is consistent (Task 2 review m1). Ported verbatim to Swift
// and Kotlin.
//
// Pixels are read at `y·stride + x·4`. Camera rows are padded, so `stride` (bytes per row) is often
// more than `width·4`, and native readers ALWAYS use the buffer's stride (Task 2 review I1).
//
// Luma is BT.601 in integers: `(77·R + 150·G + 29·B) >> 8`. iOS receives BGRA, Android RGBA.
// Natively it is read per pixel inside each region; no full-frame luma plane is built.
// Pixel (i, j) is "at" its centre (i + 0.5, j + 0.5).
import { LEFT_EYE, LEFT_IRIS, NUM_LANDMARKS, RIGHT_EYE, RIGHT_IRIS } from './landmarks';
import { probe } from './probe';

export type PixelFormat = 'bgra' | 'rgba';

/** Integer BT.601 luma of one pixel. */
export function luma601(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b) >> 8;
}

/**
 * A `w × h` luma plane from 4-byte pixels with `stride` bytes per row (≥ `w·4`; the padding after
 * each row's `w·4` bytes is never read). `bytes` holds `stride·h` bytes.
 */
export function lumaPlane(bytes: Uint8Array, w: number, h: number, format: PixelFormat, stride: number = w * 4): Uint8Array {
  if (stride < w * 4) throw new Error(`stride ${stride} is less than w·4 = ${w * 4}`);
  if (bytes.length !== stride * h) throw new Error(`expected ${stride * h} bytes, got ${bytes.length}`);
  const out = new Uint8Array(w * h);
  const [ri, gi, bi] = format === 'bgra' ? [2, 1, 0] : [0, 1, 2];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + x * 4;
      out[y * w + x] = luma601(bytes[o + ri]!, bytes[o + gi]!, bytes[o + bi]!);
    }
  }
  return out;
}

/** Mean luma of every 8th pixel of every 8th row, from (0, 0). */
export function frameLuma(luma: Uint8Array, w: number, h: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) {
    sum += luma[y * w + x]!;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
}

/** Integer pixel rect covering [minX, maxX] × [minY, maxY] (pixels), clipped to the frame. */
function pixelRect(minX: number, minY: number, maxX: number, maxY: number, w: number, h: number): Rect {
  return {
    x0: Math.max(0, Math.floor(minX)),
    y0: Math.max(0, Math.floor(minY)),
    x1: Math.min(w, Math.ceil(maxX)),
    y1: Math.min(h, Math.ceil(maxY)),
  };
}

function empty(r: Rect): boolean {
  return r.x1 <= r.x0 || r.y1 <= r.y0;
}

/** The face rect: the bounding box of all 478 buffer-frame landmarks, in pixels, clipped. */
export function faceRect(lm: ArrayLike<number>, w: number, h: number): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const x = lm[i * 3]! * w;
    const y = lm[i * 3 + 1]! * h;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return pixelRect(minX, minY, maxX, maxY, w, h);
}

/** Mean luma over the face rect, sampling every 2nd pixel of every 2nd row from its origin; 0 if empty. */
export function faceLuma(luma: Uint8Array, w: number, rect: Rect): number {
  if (empty(rect)) return 0;
  let sum = 0;
  let n = 0;
  for (let y = rect.y0; y < rect.y1; y += 2) for (let x = rect.x0; x < rect.x1; x += 2) {
    sum += luma[y * w + x]!;
    n++;
  }
  return sum / n;
}

/**
 * 3×3 Laplacian variance of the face rect box-averaged down to 64×64. Cell (i, j) averages the pixels
 * with x in [x0 + ⌊i·W/64⌋, max(x0 + ⌊(i+1)·W/64⌋, that + 1)), and the same for y. The Laplacian
 * `4c − n − s − e − w` runs on the 62×62 interior; the population variance is returned. 0 when empty.
 */
export function blurScore(luma: Uint8Array, w: number, rect: Rect): number {
  if (empty(rect)) return 0;
  const N = 64;
  const rw = rect.x1 - rect.x0;
  const rh = rect.y1 - rect.y0;
  const cells = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    const ya = rect.y0 + Math.floor((j * rh) / N);
    const yb = Math.max(rect.y0 + Math.floor(((j + 1) * rh) / N), ya + 1);
    for (let i = 0; i < N; i++) {
      const xa = rect.x0 + Math.floor((i * rw) / N);
      const xb = Math.max(rect.x0 + Math.floor(((i + 1) * rw) / N), xa + 1);
      let sum = 0;
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) sum += luma[y * w + x]!;
      cells[j * N + i] = sum / ((yb - ya) * (xb - xa));
    }
  }
  let mean = 0;
  let sq = 0;
  const count = (N - 2) * (N - 2);
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
    const c = cells[j * N + i]!;
    const l = 4 * c - cells[(j - 1) * N + i]! - cells[(j + 1) * N + i]! - cells[j * N + i - 1]! - cells[j * N + i + 1]!;
    mean += l;
    sq += l * l;
  }
  mean /= count;
  return Math.max(0, sq / count - mean * mean);
}

export interface EyeLuma {
  /** eye ROI mean luma ÷ face luma (0 when the face luma is 0) */
  eyeLuma: number;
  /** sclera-ring mean − iris-disk mean, clamped to [0, 255]; 0 when either region is empty */
  irisContrast: number;
  /** share of eye-ROI pixels with luma ≥ 250 */
  eyeSat: number;
}

/**
 * The eye ROI is the contour's pixel bounding box, grown by 10 % of its width on the left and right
 * and 10 % of its height at the top and bottom, then clipped. The iris disk holds the ROI pixels whose
 * centre lies within r of the iris centre, where r is the mean distance from the centre (468/473) to
 * its 4 ring points. The sclera ring holds those with 1.3 r < d ≤ 1.8 r.
 */
export function eyeLuma(luma: Uint8Array, w: number, h: number, lm: ArrayLike<number>, eye: 'R' | 'L', face: number): EyeLuma {
  const contour = eye === 'R' ? RIGHT_EYE : LEFT_EYE;
  const iris = eye === 'R' ? RIGHT_IRIS : LEFT_IRIS;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const k of contour) {
    const x = lm[k * 3]! * w;
    const y = lm[k * 3 + 1]! * h;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const gx = 0.1 * (maxX - minX);
  const gy = 0.1 * (maxY - minY);
  const rect = pixelRect(minX - gx, minY - gy, maxX + gx, maxY + gy, w, h);
  if (empty(rect)) return { eyeLuma: 0, irisContrast: 0, eyeSat: 0 };
  const cx = lm[iris[0] * 3]! * w;
  const cy = lm[iris[0] * 3 + 1]! * h;
  let r = 0;
  for (let k = 1; k <= 4; k++) r += Math.hypot(lm[iris[k]! * 3]! * w - cx, lm[iris[k]! * 3 + 1]! * h - cy);
  r /= 4;
  const r2 = r * r;
  const inner2 = 1.69 * r2; // (1.3 r)²
  const outer2 = 3.24 * r2; // (1.8 r)²
  let sum = 0;
  let n = 0;
  let sat = 0;
  let irisSum = 0;
  let irisN = 0;
  let ringSum = 0;
  let ringN = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const v = luma[y * w + x]!;
      sum += v;
      n++;
      if (v >= 250) sat++;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      probe('irisDisk', d2, r2);
      probe('ringInner', d2, inner2);
      probe('ringOuter', d2, outer2);
      if (d2 <= r2) {
        irisSum += v;
        irisN++;
      } else if (d2 > inner2 && d2 <= outer2) {
        ringSum += v;
        ringN++;
      }
    }
  }
  const contrast = irisN > 0 && ringN > 0 ? Math.min(255, Math.max(0, ringSum / ringN - irisSum / irisN)) : 0;
  return { eyeLuma: face > 0 ? sum / n / face : 0, irisContrast: contrast, eyeSat: sat / n };
}
