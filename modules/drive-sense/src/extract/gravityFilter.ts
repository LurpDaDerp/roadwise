// Android gravity filter (R1): hardware accelerometer + gyroscope → gravity and user acceleration,
// the same normalisation CoreMotion's `.xArbitraryZVertical` device motion hands iOS directly.
//
// Complementary filter, per sample, in the reference sign (a = g + ua; face-up a ≈ [0, 0, −1]):
//   dt    = (t − t_prev) / 1000
//   seed  (first sample, dt ≤ 0, or dt > GRAVITY_RESET_GAP_S):  g = a, mags = [|a|]
//   else  mags ← last GRAVITY_GATE_SAMPLES of (mags + |a|);  m = mean(mags) (summed oldest first)
//         g_pred = g + (g × w)·dt            (gravity is fixed in the world, so in the device frame
//                                             it turns opposite to the device: dg/dt = −w × g)
//         if | m − 1 | ≤ GRAVITY_GATE_G:       (the accelerometer reads ~1 g: no dynamic acceleration)
//             α = GRAVITY_TAU_S / (GRAVITY_TAU_S + dt)
//             g = α·g_pred + (1 − α)·a
//         else:                                (braking, cornering, a bump: trust the gyro alone)
//             g = g_pred
//   ua = a − g
// Pure; the Kotlin port (`GravityFilter.kt`) follows these lines in this order.
import {
  G_MPS2,
  GRAVITY_GATE_G,
  GRAVITY_GATE_SAMPLES,
  GRAVITY_RESET_GAP_S,
  GRAVITY_TAU_S,
} from './constants';
import { probe } from './probe';
import type { GravityState, ImuSample, RawImuSample } from './types';
import { add, cross, norm, scale, sub, type Vec3 } from './vec';

export const initialGravityState = (): GravityState => ({ g: null, t: null, mags: [] });

/** Android `TYPE_ACCELEROMETER` values (m/s², face-up ≈ [0, 0, +9.81]) → the reference sign, in g. */
export const androidAccelToReference = (v: Vec3): Vec3 => [
  (0 - v[0]) / G_MPS2,
  (0 - v[1]) / G_MPS2,
  (0 - v[2]) / G_MPS2,
];

export function gravityFilter(
  samples: readonly RawImuSample[],
  state: GravityState
): { imu: ImuSample[]; state: GravityState } {
  let g = state.g;
  let tPrev = state.t;
  let mags = [...state.mags];
  const imu: ImuSample[] = [];
  for (const s of samples) {
    const dt = tPrev === null ? 0 : (s.t - tPrev) / 1000;
    if (tPrev !== null) probe('GRAVITY_RESET_GAP_S', dt, GRAVITY_RESET_GAP_S);
    const mag = norm(s.a);
    if (g === null || dt <= 0 || dt > GRAVITY_RESET_GAP_S) {
      g = s.a;
      mags = [mag];
    } else {
      mags.push(mag);
      if (mags.length > GRAVITY_GATE_SAMPLES) mags.shift();
      let sum = 0;
      for (const m of mags) sum += m; // oldest first
      const predicted = add(g, scale(cross(g, s.w), dt));
      const off = Math.abs(sum / mags.length - 1);
      probe('GRAVITY_GATE_G', off, GRAVITY_GATE_G);
      if (off <= GRAVITY_GATE_G) {
        const alpha = GRAVITY_TAU_S / (GRAVITY_TAU_S + dt);
        g = add(scale(predicted, alpha), scale(s.a, 1 - alpha));
      } else {
        g = predicted;
      }
    }
    tPrev = s.t;
    imu.push({ t: s.t, ua: sub(s.a, g), g, w: s.w });
  }
  return { imu, state: { g, t: tPrev, mags: mags.slice(-(GRAVITY_GATE_SAMPLES - 1)) } };
}
