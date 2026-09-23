// Synthetic faces and images for the golden vectors. Generator code only: nothing here is ported
// and nothing here reaches the app. Every face is drawn from parameters with a seeded RNG, so the
// vectors contain no person's face.
import { LANDMARK_FLOATS, NUM_LANDMARKS, landmarksToBuffer, uprightSize, type Rotation } from '../src/reference/landmarks';

/** mulberry32: a small seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FaceParams {
  /** upright image size, px */
  w: number;
  h: number;
  /** face centre, px */
  fx: number;
  fy: number;
  /** face half-width, px (half-height is 1.3×) */
  a: number;
  /** lid opening per eye, as a share of the eye width (≈ 0.3 open, 0.05 closed) */
  openR: number;
  openL: number;
  /** iris offset per eye, in eye widths: +x image right, +y image up */
  irisR: [number, number];
  irisL: [number, number];
  /** inner-lip gap as a share of the face half-width */
  mouthOpen: number;
  seed: number;
}

export const DEFAULT_FACE: FaceParams = {
  w: 96,
  h: 120,
  fx: 48.3,
  fy: 58.7,
  a: 29.1,
  openR: 0.32,
  openL: 0.3,
  irisR: [0.04, 0.02],
  irisL: [0.05, 0.01],
  mouthOpen: 0.08,
  seed: 1,
};

interface Eye {
  ex: number;
  ey: number;
  w: number;
  up: number;
  lo: number;
}

function eyes(p: FaceParams): { R: Eye; L: Eye } {
  const b = 1.3 * p.a;
  const w = 0.55 * p.a;
  const ey = p.fy - 0.22 * b;
  return {
    R: { ex: p.fx - 0.42 * p.a, ey, w, up: p.openR * w * 0.62, lo: p.openR * w * 0.38 },
    L: { ex: p.fx + 0.42 * p.a, ey, w, up: p.openL * w * 0.62, lo: p.openL * w * 0.38 },
  };
}

/** Upright landmarks, normalised (x/W, y/H, z/W), for a parametric face. */
export function faceLandmarks(p: FaceParams): Float64Array {
  const r = rng(p.seed);
  const pts = new Float64Array(LANDMARK_FLOATS);
  const b = 1.3 * p.a;
  const set = (k: number, x: number, y: number, z = (r() - 0.5) * 0.1 * p.a) => {
    pts[k * 3] = x / p.w;
    pts[k * 3 + 1] = y / p.h;
    pts[k * 3 + 2] = z / p.w;
  };
  // Everything else: random points well inside the face ellipse.
  for (let k = 0; k < NUM_LANDMARKS; k++) {
    const ang = r() * 2 * Math.PI;
    const rad = Math.sqrt(r()) * 0.8;
    set(k, p.fx + rad * p.a * Math.cos(ang), p.fy + rad * b * Math.sin(ang));
  }
  // The face outline extremes fix the box.
  set(10, p.fx, p.fy - b);
  set(152, p.fx, p.fy + b);
  set(234, p.fx - p.a, p.fy);
  set(454, p.fx + p.a, p.fy);
  const e = eyes(p);
  // Right eye (image left): outer 33 at ex − w/2, lower lid 33 → 133, upper back.
  const lowerR = [33, 7, 163, 144, 145, 153, 154, 155, 133];
  const upperR = [173, 157, 158, 159, 160, 161, 246];
  lowerR.forEach((k, t) => set(k, e.R.ex - e.R.w / 2 + (e.R.w * t) / 8, e.R.ey + e.R.lo * Math.sin((Math.PI * t) / 8)));
  upperR.forEach((k, i) => {
    const t = i + 1;
    set(k, e.R.ex + e.R.w / 2 - (e.R.w * t) / 8, e.R.ey - e.R.up * Math.sin((Math.PI * t) / 8));
  });
  // Left eye (image right): outer 263 at ex + w/2, lower lid 263 → 362, upper back.
  const lowerL = [263, 249, 390, 373, 374, 380, 381, 382, 362];
  const upperL = [398, 384, 385, 386, 387, 388, 466];
  lowerL.forEach((k, t) => set(k, e.L.ex + e.L.w / 2 - (e.L.w * t) / 8, e.L.ey + e.L.lo * Math.sin((Math.PI * t) / 8)));
  upperL.forEach((k, i) => {
    const t = i + 1;
    set(k, e.L.ex - e.L.w / 2 + (e.L.w * t) / 8, e.L.ey - e.L.up * Math.sin((Math.PI * t) / 8));
  });
  // Irises: centre, then the 4 ring points (right, up, left, down) at 0.22 w.
  const iris = (base: number, eye: Eye, off: [number, number]) => {
    const cx = eye.ex + off[0] * eye.w;
    const cy = eye.ey - off[1] * eye.w;
    const rr = 0.22 * eye.w;
    set(base, cx, cy, 0);
    set(base + 1, cx + rr, cy, 0);
    set(base + 2, cx, cy - rr, 0);
    set(base + 3, cx - rr, cy, 0);
    set(base + 4, cx, cy + rr, 0);
  };
  iris(468, e.R, p.irisR);
  iris(473, e.L, p.irisL);
  // Brows.
  set(105, e.R.ex, e.R.ey - 0.9 * e.R.w);
  set(334, e.L.ex, e.L.ey - 0.9 * e.L.w);
  // Mouth.
  const my = p.fy + 0.55 * b;
  const gap = p.mouthOpen * p.a;
  set(61, p.fx - 0.4 * p.a, my);
  set(291, p.fx + 0.4 * p.a, my);
  set(78, p.fx - 0.3 * p.a, my);
  set(308, p.fx + 0.3 * p.a, my);
  set(13, p.fx, my - gap / 2);
  set(14, p.fx, my + gap / 2);
  return pts;
}

export interface ImageOptions {
  sunglasses?: boolean;
  glareR?: boolean;
  /** no face drawn (an empty scene) */
  noFace?: boolean;
  /** scale every channel (low light) */
  gain?: number;
}

/** RGB (0–255) of the upright scene, as three planes. */
function renderUpright(p: FaceParams, opts: ImageOptions): { r: Uint8Array; g: Uint8Array; b: Uint8Array } {
  const noise = rng(p.seed * 7919 + 13);
  const n = p.w * p.h;
  const R = new Uint8Array(n);
  const G = new Uint8Array(n);
  const B = new Uint8Array(n);
  const b = 1.3 * p.a;
  const e = eyes(p);
  const gain = opts.gain ?? 1;
  const put = (i: number, rgb: [number, number, number]) => {
    const jitter = (noise() - 0.5) * 10;
    R[i] = Math.max(0, Math.min(255, Math.round((rgb[0] + jitter) * gain)));
    G[i] = Math.max(0, Math.min(255, Math.round((rgb[1] + jitter) * gain)));
    B[i] = Math.max(0, Math.min(255, Math.round((rgb[2] + jitter) * gain)));
  };
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const i = y * p.w + x;
      const cx = x + 0.5;
      const cy = y + 0.5;
      let rgb: [number, number, number] = [40 + (60 * x) / p.w, 45 + (60 * x) / p.w, 50 + (60 * x) / p.w];
      if (!opts.noFace) {
        const inFace = ((cx - p.fx) / p.a) ** 2 + ((cy - p.fy) / b) ** 2 <= 1;
        if (inFace) rgb = [200, 160, 130];
        for (const [side, eye, off] of [
          ['R', e.R, p.irisR],
          ['L', e.L, p.irisL],
        ] as const) {
          const inEye = ((cx - eye.ex) / (eye.w / 2)) ** 2 + ((cy - eye.ey) / Math.max(eye.up, 0.5)) ** 2 <= 1;
          if (inEye) {
            rgb = [235, 232, 228];
            const ix = eye.ex + off[0] * eye.w;
            const iy = eye.ey - off[1] * eye.w;
            const d = Math.hypot(cx - ix, cy - iy);
            if (d <= 0.22 * eye.w) rgb = [70, 55, 40];
            if (d <= 0.1 * eye.w) rgb = [15, 12, 10];
          }
          if (opts.sunglasses && Math.abs(cx - eye.ex) <= 0.7 * eye.w && Math.abs(cy - eye.ey) <= 0.45 * eye.w) rgb = [22, 22, 25];
          if (opts.glareR && side === 'R' && Math.abs(cx - eye.ex) <= 0.6 * eye.w && Math.abs(cy - eye.ey) <= 0.4 * eye.w) rgb = [255, 255, 255];
        }
        const brow = (eye: Eye) => Math.abs(cx - eye.ex) <= 0.55 * eye.w && Math.abs(cy - (eye.ey - 0.9 * eye.w)) <= 1.2;
        if (brow(e.R) || brow(e.L)) rgb = [60, 45, 35];
        const my = p.fy + 0.55 * b;
        if (Math.abs(cx - p.fx) <= 0.4 * p.a && Math.abs(cy - my) <= Math.max(0.6, (p.mouthOpen * p.a) / 2)) rgb = [120, 50, 55];
      }
      put(i, rgb);
    }
  }
  return { r: R, g: G, b: B };
}

/** The scene as the camera delivers it: rotated into the BUFFER frame, 4 bytes per pixel. */
export function renderBuffer(p: FaceParams, rotation: Rotation, format: 'bgra' | 'rgba', opts: ImageOptions = {}): { w: number; h: number; bytes: Uint8Array } {
  const up = renderUpright(p, opts);
  // Buffer size: the upright size un-rotated.
  const { w: bw, h: bh } = uprightSize(p.w, p.h, rotation);
  const bytes = new Uint8Array(bw * bh * 4);
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) {
      const bx = (i + 0.5) / bw;
      const by = (j + 0.5) / bh;
      let ux = bx;
      let uy = by;
      if (rotation === 90) {
        ux = 1 - by;
        uy = bx;
      } else if (rotation === 180) {
        ux = 1 - bx;
        uy = 1 - by;
      } else if (rotation === 270) {
        ux = by;
        uy = 1 - bx;
      }
      const src = Math.floor(uy * p.h) * p.w + Math.floor(ux * p.w);
      const o = (j * bw + i) * 4;
      const [c0, c2] = format === 'bgra' ? [up.b[src]!, up.r[src]!] : [up.r[src]!, up.b[src]!];
      bytes[o] = c0;
      bytes[o + 1] = up.g[src]!;
      bytes[o + 2] = c2;
      bytes[o + 3] = 255;
    }
  }
  return { w: bw, h: bh, bytes };
}

/** Copy tightly packed rows into rows of `stride` bytes, filling the padding with `fill`. */
export function padRows(bytes: Uint8Array, w: number, h: number, stride: number, fill = 0xff): Uint8Array {
  const out = new Uint8Array(stride * h).fill(fill);
  for (let y = 0; y < h; y++) out.set(bytes.subarray(y * w * 4, (y + 1) * w * 4), y * stride);
  return out;
}

/** The face's landmarks in the BUFFER frame of `rotation` (what MediaPipe returns). */
export function bufferLandmarks(p: FaceParams, rotation: Rotation): Float64Array {
  return landmarksToBuffer(faceLandmarks(p), rotation);
}

/** Round to 6 significant decimals so the JSON carries exact short doubles both sides parse identically. */
export function q6(x: number): number {
  return Number(x.toPrecision(9));
}
