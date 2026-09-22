package expo.modules.drivesense

import kotlin.math.abs

/**
 * Android gravity filter — a line-for-line port of `src/extract/gravityFilter.ts` (README §7
 * "Gravity filter"). Hardware accelerometer (already converted by
 * [SensorSource.androidAccelToReference]) + gyroscope → gravity and user acceleration, the same
 * normalisation CoreMotion hands iOS directly. Pure; the capture path ([SensorSource]) and
 * `selfTest` ([SelfTest]) both use it.
 *
 * Per sample, in order:
 *   dt = (t − t_prev) / 1000
 *   seed (no state, dt ≤ 0, dt > GRAVITY_RESET_GAP_S): g = a, mags = [|a|]
 *   else mags ← last GRAVITY_GATE_SAMPLES of (mags + |a|); m = mean(mags) (summed oldest first)
 *        g_pred = g + (g × w)·dt
 *        if | m − 1 | ≤ GRAVITY_GATE_G: α = τ/(τ + dt); g = α·g_pred + (1 − α)·a
 *        else g = g_pred
 *   ua = a − g
 */
object GravityFilter {
  fun initialState(): GravityState = GravityState(null, null, emptyList())

  data class Result(val imu: List<ImuSample>, val state: GravityState)

  fun filter(samples: List<RawImuSample>, state: GravityState): Result {
    var g = state.g
    var tPrev = state.t
    val mags = ArrayList<Double>(state.mags)
    val imu = ArrayList<ImuSample>(samples.size)
    for (s in samples) {
      val prev = tPrev
      val dt = if (prev == null) 0.0 else (s.t - prev) / 1000
      val mag = norm(s.a)
      val current = g
      val next: Vec3
      if (current == null || dt <= 0 || dt > GRAVITY_RESET_GAP_S) {
        next = s.a
        mags.clear()
        mags.add(mag)
      } else {
        mags.add(mag)
        if (mags.size > GRAVITY_GATE_SAMPLES) mags.removeAt(0)
        var sum = 0.0
        for (m in mags) sum += m // oldest first
        val predicted = add(current, scale(cross(current, s.w), dt))
        next = if (abs(sum / mags.size - 1) <= GRAVITY_GATE_G) {
          val alpha = GRAVITY_TAU_S / (GRAVITY_TAU_S + dt)
          add(scale(predicted, alpha), scale(s.a, 1 - alpha))
        } else {
          predicted
        }
      }
      g = next
      tPrev = s.t
      imu.add(ImuSample(s.t, sub(s.a, next), next, s.w))
    }
    return Result(imu, GravityState(g, tPrev, mags.takeLast(GRAVITY_GATE_SAMPLES - 1)))
  }
}
