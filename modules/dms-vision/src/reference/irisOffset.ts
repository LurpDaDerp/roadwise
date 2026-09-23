// Per-eye iris offsets (plan rev2: R1-I1; README §4). Computed in UPRIGHT PIXEL coordinates, so x
// and y share one unit (aspect-corrected):
// - u = the unit vector from the eye's outer corner to its inner corner (right 33 → 133, left
//   263 → 362);
// - s = +1 for the right eye and −1 for the left, so û = s·u points toward image right for both;
// - v̂ = û rotated 90° toward image-up; in (x, y-down) pixels v̂ = (û.y, −û.x);
// - w = the corner distance, m = the corner midpoint, c = the iris centre (468 / 473);
// - ox = ((c − m)·û)/w and oy = ((c − m)·v̂)/w; + means image right and image up, for BOTH eyes.
import { LEFT_CORNERS, RIGHT_CORNERS, px } from './landmarks';

export interface IrisOffset {
  ox: number;
  oy: number;
}

export function irisOffset(upright: ArrayLike<number>, eye: 'R' | 'L', w: number, h: number): IrisOffset | null {
  const [outer, inner] = eye === 'R' ? RIGHT_CORNERS : LEFT_CORNERS;
  const s = eye === 'R' ? 1 : -1;
  const iris = eye === 'R' ? 468 : 473;
  const a = px(upright, outer, w, h);
  const b = px(upright, inner, w, h);
  const c = px(upright, iris, w, h);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const width = Math.hypot(dx, dy);
  if (!(width > 1e-9)) return null;
  const ux = (s * dx) / width;
  const uy = (s * dy) / width;
  const vx = uy;
  const vy = -ux;
  const mx = 0.5 * (a[0] + b[0]);
  const my = 0.5 * (a[1] + b[1]);
  const ox = ((c[0] - mx) * ux + (c[1] - my) * uy) / width;
  const oy = ((c[0] - mx) * vx + (c[1] - my) * vy) / width;
  return { ox, oy };
}
