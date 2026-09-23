// The geometric gaze (plan §M1a, rev1 R-gaze, rev2 R1-I1), computed in the engine from the head pose
// and the wire's per-eye iris offsets. K_EYE and G_PITCH are engine config, tunable without a native
// build; calibration removes the constant offsets. Camera frame (yaw + image right, pitch + up).
import type { DmsConfig } from './config';
import { nearEye } from './quality';
import type { AnglePair, EngineFrame, EyeFeatures } from './types';

const DEG = 180 / Math.PI;
const clamp1 = (x: number) => Math.min(1, Math.max(-1, x));

/** eyeYaw = asin(clamp(ox / K_EYE)), eyePitch = asin(clamp(oy / K_EYE)) × G_PITCH, degrees. */
export function eyeAngles(e: EyeFeatures, cfg: Pick<DmsConfig, 'geometric'>): AnglePair {
  const { kEye, gPitch } = cfg.geometric;
  return { yaw: Math.asin(clamp1(e.ox / kEye)) * DEG, pitch: Math.asin(clamp1(e.oy / kEye)) * DEG * gPitch };
}

/**
 * head + eye. Reliable eyes are averaged, weighted by corner width; past |head yaw| > nearEyeYawDeg the
 * near eye alone, and only if it is reliable. Null with no usable eye (the caller falls back to the head).
 */
export function geometricGaze(
  head: AnglePair,
  f: Pick<EngineFrame, 'eyeR' | 'eyeL'>,
  reliable: { r: boolean; l: boolean },
  cfg: Pick<DmsConfig, 'geometric'>
): AnglePair | null {
  let eyes: EyeFeatures[];
  if (Math.abs(head.yaw) > cfg.geometric.nearEyeYawDeg) {
    const near = nearEye(f);
    const e = near === 'r' ? f.eyeR : near === 'l' ? f.eyeL : null;
    eyes = e !== null && (near === 'r' ? reliable.r : reliable.l) ? [e] : [];
  } else {
    eyes = [];
    if (reliable.r && f.eyeR !== null) eyes.push(f.eyeR);
    if (reliable.l && f.eyeL !== null) eyes.push(f.eyeL);
  }
  if (eyes.length === 0) return null;
  let wSum = 0;
  let yaw = 0;
  let pitch = 0;
  for (const e of eyes) {
    const a = eyeAngles(e, cfg);
    yaw += a.yaw * e.widthPx;
    pitch += a.pitch * e.widthPx;
    wSum += e.widthPx;
  }
  return { yaw: head.yaw + yaw / wSum, pitch: head.pitch + pitch / wSum };
}
