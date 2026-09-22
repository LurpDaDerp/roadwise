// The frame-free features of one second (R2: populated whether or not the frame is aligned).
import {
  GRAVITY_STABILITY_RAD,
  HANDLING_STABLE_FACTOR,
  HANDLING_STABLE_GS,
  HANDLING_W_FLOOR,
  HANDLING_W_SPAN,
} from './constants';
import type { ImuSample } from './types';
import { angle, clamp, dot, norm, reject, type Vec3 } from './vec';

export interface FrameFree {
  yawRateMax: number;
  gravityStability: number;
  orientationDelta: number;
  handlingScore: number;
}

/**
 * @param imu the second's samples (at least MIN_IMU_SAMPLES)
 * @param gHat per-sample unit gravity, normalize(imu[i].g)
 * @param gMean the second's mean gravity direction, normalize(Σ gHat)
 * @param dt per-sample interval in seconds (see `extract.ts`)
 */
export function frameFree(
  imu: readonly ImuSample[],
  gHat: readonly Vec3[],
  gMean: Vec3,
  dt: readonly number[]
): FrameFree {
  let yawRateMax = 0;
  let maxAngle = 0;
  let orientationDelta = 0;
  let sumSq = 0;
  for (let i = 0; i < imu.length; i++) {
    const s = imu[i]!;
    const gi = gHat[i]!;
    const yaw = Math.abs(dot(s.w, gi));
    if (yaw > yawRateMax) yawRateMax = yaw;
    const a = angle(gi, gMean);
    if (a > maxAngle) maxAngle = a;
    const off = norm(reject(s.w, gi));
    orientationDelta += off * dt[i]!;
    sumSq += off * off;
  }
  const gravityStability = 1 - clamp(maxAngle / GRAVITY_STABILITY_RAD, 0, 1);
  const rms = Math.sqrt(sumSq / imu.length);
  const handlingScore =
    clamp((rms - HANDLING_W_FLOOR) / HANDLING_W_SPAN, 0, 1) *
    (gravityStability < HANDLING_STABLE_GS ? 1 : HANDLING_STABLE_FACTOR);
  return { yawRateMax, gravityStability, orientationDelta, handlingScore };
}
