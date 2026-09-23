// Frames of reference and angle helpers (plan §M1). Pure.
//
// - Camera frame: upright image, yaw + toward image right, pitch + up. As a unit vector:
//   x = cos(pitch)·sin(yaw) (image right), y = sin(pitch) (up), z = cos(pitch)·cos(yaw).
// - Roll correction: the direction vector is rotated about the optical axis (z) by −rollOffsetDeg,
//   where a rotation by α takes image-up (0, 1) to (sin α, cos α): the same sense as head roll.
// - Driver frame: LHD yawDrv = −yawCam, RHD yawDrv = +yawCam; pitch unchanged. Positive driver-frame
//   yaw is toward the passenger (the DMS spec's zone convention).
// - Relative angles: rel = drv − centre, with yaw wrapped into (−180, 180].
import type { AnglePair, Direction, DriverSide } from './types';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Wraps degrees into (−180, 180]. */
export function wrapDeg180(deg: number): number {
  const r = deg - 360 * Math.floor((deg + 180) / 360);
  return r === -180 ? 180 : r;
}

export function toDirection(a: AnglePair): Direction {
  const cp = Math.cos(a.pitch * RAD);
  return [cp * Math.sin(a.yaw * RAD), Math.sin(a.pitch * RAD), cp * Math.cos(a.yaw * RAD)];
}

export function fromDirection(d: Direction): AnglePair {
  const [x, y, z] = d;
  return { yaw: Math.atan2(x, z) * DEG, pitch: Math.atan2(y, Math.hypot(x, z)) * DEG };
}

/** Rotates the direction about the optical axis by −rollOffsetDeg (plan §M1). */
export function rollCorrect(a: AnglePair, rollOffsetDeg: number): AnglePair {
  if (rollOffsetDeg === 0) return { yaw: a.yaw, pitch: a.pitch };
  const [x, y, z] = toDirection(a);
  const t = -rollOffsetDeg * RAD;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return fromDirection([x * c + y * s, -x * s + y * c, z]);
}

export function toDriverFrame(cam: AnglePair, side: DriverSide): AnglePair {
  return { yaw: side === 'left' ? -cam.yaw : cam.yaw, pitch: cam.pitch };
}

/** `a − centre`, yaw wrapped. */
export function relative(a: AnglePair, centre: AnglePair): AnglePair {
  return { yaw: wrapDeg180(a.yaw - centre.yaw), pitch: a.pitch - centre.pitch };
}

/** The great-circle angle between two directions, degrees. */
export function angularDistanceDeg(a: AnglePair, b: AnglePair): number {
  const [ax, ay, az] = toDirection(a);
  const [bx, by, bz] = toDirection(b);
  // atan2 of |a×b| and a·b is accurate at small angles, where acos is not.
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.atan2(Math.hypot(cx, cy, cz), ax * bx + ay * by + az * bz) * DEG;
}

/**
 * The GNSS course rate, °/s (+ = right turn: course is clockwise from north), between two consecutive
 * valid rows (plan §M1, rev1 I5). Null when either course is not finite or the time step is not positive.
 */
export function courseRateDegS(prevCourseDeg: number, prevTMs: number, courseDeg: number, tMs: number): number | null {
  const dt = (tMs - prevTMs) / 1000;
  if (!Number.isFinite(prevCourseDeg) || !Number.isFinite(courseDeg) || !(dt > 0) || !Number.isFinite(dt)) return null;
  return wrapDeg180(courseDeg - prevCourseDeg) / dt;
}
