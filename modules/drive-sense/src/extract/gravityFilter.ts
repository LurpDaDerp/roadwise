// Android gravity filter (R1): hardware accelerometer + gyroscope → gravity and user acceleration,
// the same normalisation CoreMotion's `.xArbitraryZVertical` device motion hands iOS directly.
//
// Complementary filter, per sample, in the reference sign (a = g + ua; face-up a ≈ [0, 0, −1]):
//   dt    = (t − t_prev) / 1000
//   seed  (first sample, dt ≤ 0, or dt > GRAVITY_RESET_GAP_S):  g = a
//   else  g_pred = g + (g × w)·dt            (gravity is fixed in the world, so in the device frame
//                                             it turns opposite to the device: dg/dt = −w × g)
//         if | |a| − 1 | ≤ GRAVITY_GATE_G:     (the accelerometer reads ~1 g: no dynamic acceleration)
//             α = GRAVITY_TAU_S / (GRAVITY_TAU_S + dt)
//             g = α·g_pred + (1 − α)·a
//         else:                                (braking, cornering, a bump: trust the gyro alone)
//             g = g_pred
//   ua = a − g
// Pure; the Kotlin port (`GravityFilter.kt`) follows these lines in this order.
import { G_MPS2, GRAVITY_GATE_G, GRAVITY_RESET_GAP_S, GRAVITY_TAU_S } from './constants';
import type { GravityState, ImuSample, RawImuSample } from './types';
import { add, cross, norm, scale, sub, type Vec3 } from './vec';

export const initialGravityState = (): GravityState => ({ g: null, t: null });

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
  const imu: ImuSample[] = [];
  for (const s of samples) {
    const dt = tPrev === null ? 0 : (s.t - tPrev) / 1000;
    if (g === null || dt <= 0 || dt > GRAVITY_RESET_GAP_S) {
      g = s.a;
    } else {
      const predicted = add(g, scale(cross(g, s.w), dt));
      if (Math.abs(norm(s.a) - 1) <= GRAVITY_GATE_G) {
        const alpha = GRAVITY_TAU_S / (GRAVITY_TAU_S + dt);
        g = add(scale(predicted, alpha), scale(s.a, 1 - alpha));
      } else {
        g = predicted;
      }
    }
    tPrev = s.t;
    imu.push({ t: s.t, ua: sub(s.a, g), g, w: s.w });
  }
  return { imu, state: { g, t: tPrev } };
}
