// The vehicle frame, learned in the device frame without a magnetometer (R1).
//
// Vertical is gravity. The forward axis `f` is the horizontal device-frame direction the user
// acceleration takes while GNSS says the speed is changing (sign from Δv), so it needs no compass
// and no course — a magnetic phone mount cannot bend it and a lagging course cannot mix braking
// into cornering. It resets whenever the phone moves relative to the car.
import {
  ALIGN_ALPHA,
  ALIGN_MIN_G,
  ALIGN_MIN_H_G,
  ALIGN_MIN_UPDATES,
  ALIGN_TOL_RAD,
  GRAVITY_MEAN_S,
  RESET_GRAVITY_RAD,
  RESET_GRAVITY_S,
  RESET_ORIENT_RAD,
} from './constants';
import type { AlignmentState } from './types';
import { add, angle, isZero, norm, normalize, reject, scale, type Vec3 } from './vec';

export const initialAlignmentState = (): AlignmentState => ({
  f: null,
  agree: 0,
  aligned: false,
  gravityRing: [],
  gravityDevS: 0,
});

const cleared = (): AlignmentState => initialAlignmentState();

/**
 * Step 1 of a second with IMU: decide whether the phone moved relative to the car, and push this
 * second's gravity direction into the ring. Returns the new state and whether it reset.
 */
export function checkReset(
  s: AlignmentState,
  gMean: Vec3,
  orientationDelta: number
): { state: AlignmentState; reset: boolean } {
  let dev = 0;
  if (s.gravityRing.length > 0) {
    let sum: Vec3 = [0, 0, 0];
    for (const v of s.gravityRing) sum = add(sum, v);
    dev = angle(gMean, normalize(sum));
  }
  const gravityDevS = dev > RESET_GRAVITY_RAD ? s.gravityDevS + 1 : 0;
  const reset = orientationDelta > RESET_ORIENT_RAD || gravityDevS >= RESET_GRAVITY_S;
  const base = reset ? cleared() : { ...s, gravityDevS };
  const ring = [...base.gravityRing, gMean].slice(-GRAVITY_MEAN_S);
  return { state: { ...base, gravityRing: ring }, reset };
}

/** Step 2: keep `f` horizontal for this second's gravity. A degenerate result drops the frame. */
export function reproject(s: AlignmentState, gMean: Vec3): AlignmentState {
  if (s.f === null) return s;
  const f = normalize(reject(s.f, gMean));
  return isZero(f) ? { ...s, f: null, agree: 0, aligned: false } : { ...s, f };
}

/**
 * Step 3: one alignment update, when |ΔvGNSS/Δt| ≥ ALIGN_MIN_G (`dvG` in g, signed; null when
 * there is no consecutive valid pair) and the second's mean horizontal user acceleration `meanH`
 * is at least ALIGN_MIN_H_G.
 */
export function updateAlignment(
  s: AlignmentState,
  meanH: Vec3,
  gMean: Vec3,
  dvG: number | null
): AlignmentState {
  if (dvG === null || Math.abs(dvG) < ALIGN_MIN_G) return s;
  const h = reject(meanH, gMean);
  if (norm(h) < ALIGN_MIN_H_G) return s;
  const u = scale(normalize(h), dvG > 0 ? 1 : -1);
  if (s.f === null) return { ...s, f: u, agree: 0 };
  const agree = angle(u, s.f) <= ALIGN_TOL_RAD ? s.agree + 1 : 0;
  const f = normalize(reject(add(scale(s.f, 1 - ALIGN_ALPHA), scale(u, ALIGN_ALPHA)), gMean));
  if (isZero(f)) return { ...s, f: null, agree: 0, aligned: false };
  return { ...s, f, agree, aligned: s.aligned || agree >= ALIGN_MIN_UPDATES };
}
