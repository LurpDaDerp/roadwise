// MediaPipe face-mesh landmark sets and the buffer → upright landmark transform. Part of the TS
// reference the Swift and Kotlin ports reproduce (README §8); every index list here is ported
// verbatim.
//
// Landmarks are MediaPipe-normalised `(x / W, y / H, z / W)`, flat `[x0, y0, z0, x1, …]`, 478
// points. "Subject-right" is the driver's right eye, which the front camera (not mirrored) shows on
// the image LEFT: its outer corner is 33 and inner 133; the left eye's are 263 and 362.

export const NUM_LANDMARKS = 478;
export const LANDMARK_FLOATS = NUM_LANDMARKS * 3;

/** The right eye's 16-point contour, a closed polygon: lower lid 33 → 133, then upper lid back. */
export const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246] as const;
/** The left eye's 16-point contour: lower lid 263 → 362, then upper lid back. */
export const LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466] as const;
/** Iris centre then its four ring points. */
export const RIGHT_IRIS = [468, 469, 470, 471, 472] as const;
export const LEFT_IRIS = [473, 474, 475, 476, 477] as const;
/** 6-point eye aspect ratio: outer corner, upper ×2, inner corner, lower ×2 (p1…p6). */
export const EAR_RIGHT = [33, 160, 158, 133, 153, 144] as const;
export const EAR_LEFT = [362, 385, 387, 263, 373, 380] as const;
/** Outer → inner corner, per eye. */
export const RIGHT_CORNERS = [33, 133] as const;
export const LEFT_CORNERS = [263, 362] as const;
/** The outer eye corners used for the inter-ocular distance. */
export const OUTER_CORNERS = [33, 263] as const;
/** Inner-lip gap and the mouth corners (DMS spec yawn detector: 13–14 over 61–291). */
export const LIP_INNER = [13, 14] as const;
export const MOUTH_CORNERS = [61, 291] as const;

export type Rotation = 0 | 90 | 180 | 270;

/** Upright size for a buffer of `w × h` rotated clockwise by `rotation`. */
export function uprightSize(w: number, h: number, rotation: Rotation): { w: number; h: number } {
  return rotation === 90 || rotation === 270 ? { w: h, h: w } : { w, h };
}

/**
 * Buffer-frame normalised landmarks → upright-frame normalised landmarks (the V1 transform, measured
 * on MediaPipe 0.10.35: MediaPipe returns landmarks in the unrotated buffer frame). `z` is unchanged.
 */
export function landmarksToUpright(buffer: ArrayLike<number>, rotation: Rotation): Float64Array {
  const out = new Float64Array(LANDMARK_FLOATS);
  for (let i = 0; i < LANDMARK_FLOATS; i += 3) {
    const bx = buffer[i]!;
    const by = buffer[i + 1]!;
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
    out[i] = ux;
    out[i + 1] = uy;
    out[i + 2] = buffer[i + 2]!;
  }
  return out;
}

/** The inverse of `landmarksToUpright` (used by the vector generator to build buffer inputs). */
export function landmarksToBuffer(upright: ArrayLike<number>, rotation: Rotation): Float64Array {
  const out = new Float64Array(LANDMARK_FLOATS);
  for (let i = 0; i < LANDMARK_FLOATS; i += 3) {
    const ux = upright[i]!;
    const uy = upright[i + 1]!;
    let bx = ux;
    let by = uy;
    if (rotation === 90) {
      bx = uy;
      by = 1 - ux;
    } else if (rotation === 180) {
      bx = 1 - ux;
      by = 1 - uy;
    } else if (rotation === 270) {
      bx = 1 - uy;
      by = ux;
    }
    out[i] = bx;
    out[i + 1] = by;
    out[i + 2] = upright[i + 2]!;
  }
  return out;
}

/** Landmark `k` in pixels of a `w × h` frame: `[x·w, y·h]`. */
export function px(lm: ArrayLike<number>, k: number, w: number, h: number): [number, number] {
  return [lm[k * 3]! * w, lm[k * 3 + 1]! * h];
}

export function dist(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Whether normalised landmark `k` lies inside the frame `[0, 1] × [0, 1]`. */
export function inFrame(lm: ArrayLike<number>, k: number): boolean {
  const x = lm[k * 3]!;
  const y = lm[k * 3 + 1]!;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}
