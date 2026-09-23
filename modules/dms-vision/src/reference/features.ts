// Geometric per-frame features from the UPRIGHT landmarks (README §4). Ported verbatim to Swift and
// Kotlin. Distances are taken in upright pixels (x·W, y·H), so ratios are aspect-correct.
//
// Clipping:
// - an eye is clipped when any of its 16 contour points or its 5 iris points lies outside
//   [0, 1]², or its corner width is degenerate (< 1e-6 px);
// - the mouth is clipped when any of 13, 14, 61, 291 lies outside, or 61–291 is degenerate.
// A clipped eye's fields are not computed (NaN on the wire, `EYE_CLIPPED_*`), and its `irisIn` is 0.
import { irisOffset, type IrisOffset } from './irisOffset';
import {
  EAR_LEFT,
  EAR_RIGHT,
  LEFT_CORNERS,
  LEFT_EYE,
  LEFT_IRIS,
  LIP_INNER,
  MOUTH_CORNERS,
  NUM_LANDMARKS,
  OUTER_CORNERS,
  RIGHT_CORNERS,
  RIGHT_EYE,
  RIGHT_IRIS,
  dist,
  inFrame,
  px,
} from './landmarks';
import { probe } from './probe';

const DEGENERATE_PX = 1e-6;

export interface EyeGeometry {
  ear: number;
  /** corner width, upright px */
  widthPx: number;
  iris: IrisOffset;
  /** the iris centre lies inside the eye's contour polygon */
  irisIn: boolean;
}

export interface Geometry {
  boxCx: number;
  boxCy: number;
  boxW: number;
  boxH: number;
  /** inter-ocular distance (33–263), upright-width units */
  iod: number;
  /** null when clipped */
  right: EyeGeometry | null;
  left: EyeGeometry | null;
  /** null when clipped */
  mouth: { mar: number; mouthW: number } | null;
}

function ear6(lm: ArrayLike<number>, p: readonly number[], w: number, h: number): number {
  const g = (i: number) => px(lm, p[i]!, w, h);
  const horizontal = dist(g(0), g(3));
  return (dist(g(1), g(5)) + dist(g(2), g(4))) / (2.0 * horizontal);
}

/** Even–odd ray casting of point (x, y) against the polygon of landmark indices, in pixels. */
export function insidePolygon(lm: ArrayLike<number>, poly: readonly number[], x: number, y: number, w: number, h: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = px(lm, poly[i]!, w, h);
    const [xj, yj] = px(lm, poly[j]!, w, h);
    probe('pipYi', yi, y);
    probe('pipYj', yj, y);
    if (yi > y !== yj > y) {
      const xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      probe('pipX', x, xCross);
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

function eyeGeometry(lm: ArrayLike<number>, eye: 'R' | 'L', w: number, h: number): EyeGeometry | null {
  const contour = eye === 'R' ? RIGHT_EYE : LEFT_EYE;
  const irisSet = eye === 'R' ? RIGHT_IRIS : LEFT_IRIS;
  for (const k of [...contour, ...irisSet]) {
    const x = lm[k * 3]!;
    const y = lm[k * 3 + 1]!;
    probe('clipX0', x, 0);
    probe('clipX1', x, 1);
    probe('clipY0', y, 0);
    probe('clipY1', y, 1);
    if (!inFrame(lm, k)) return null;
  }
  const [outer, inner] = eye === 'R' ? RIGHT_CORNERS : LEFT_CORNERS;
  const widthPx = dist(px(lm, outer, w, h), px(lm, inner, w, h));
  if (!(widthPx >= DEGENERATE_PX)) return null;
  const iris = irisOffset(lm, eye, w, h);
  if (iris === null) return null;
  const [cx, cy] = px(lm, irisSet[0], w, h);
  return {
    ear: ear6(lm, eye === 'R' ? EAR_RIGHT : EAR_LEFT, w, h),
    widthPx,
    iris,
    irisIn: insidePolygon(lm, contour, cx, cy, w, h),
  };
}

export function geometry(upright: ArrayLike<number>, w: number, h: number): Geometry {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const x = upright[i * 3]!;
    const y = upright[i * 3 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const iodPx = dist(px(upright, OUTER_CORNERS[0], w, h), px(upright, OUTER_CORNERS[1], w, h));
  let mouth: Geometry['mouth'] = null;
  const mouthIn = [...LIP_INNER, ...MOUTH_CORNERS].every((k) => {
    probe('clipX0', upright[k * 3]!, 0);
    probe('clipX1', upright[k * 3]!, 1);
    probe('clipY0', upright[k * 3 + 1]!, 0);
    probe('clipY1', upright[k * 3 + 1]!, 1);
    return inFrame(upright, k);
  });
  const mouthWidthPx = dist(px(upright, MOUTH_CORNERS[0], w, h), px(upright, MOUTH_CORNERS[1], w, h));
  if (mouthIn && mouthWidthPx >= DEGENERATE_PX && iodPx >= DEGENERATE_PX) {
    mouth = {
      mar: dist(px(upright, LIP_INNER[0], w, h), px(upright, LIP_INNER[1], w, h)) / mouthWidthPx,
      mouthW: mouthWidthPx / iodPx,
    };
  }
  return {
    boxCx: 0.5 * (minX + maxX),
    boxCy: 0.5 * (minY + maxY),
    boxW: maxX - minX,
    boxH: maxY - minY,
    iod: iodPx / w,
    right: eyeGeometry(upright, 'R', w, h),
    left: eyeGeometry(upright, 'L', w, h),
    mouth,
  };
}
