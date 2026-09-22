package expo.modules.drivesense

import kotlin.math.abs

/**
 * The vehicle frame, learned in the device frame without a magnetometer — a line-for-line port of
 * `src/extract/alignment.ts` (README §7 steps 5–7). Pure.
 */
object Alignment {
  fun initialState(): AlignmentState = AlignmentState(
    f = null,
    agree = 0,
    aligned = false,
    gravityRing = emptyList(),
    gravityDevS = 0
  )

  data class ResetResult(val state: AlignmentState, val reset: Boolean)

  /** Step 5: did the phone move relative to the car; push this second's gravity onto the ring. */
  fun checkReset(s: AlignmentState, gMean: Vec3, orientationDelta: Double): ResetResult {
    var dev = 0.0
    if (s.gravityRing.isNotEmpty()) {
      var sum = Vec3(0.0, 0.0, 0.0)
      for (v in s.gravityRing) sum = add(sum, v)
      dev = angle(gMean, normalize(sum))
    }
    val gravityDevS = if (dev > RESET_GRAVITY_RAD) s.gravityDevS + 1 else 0
    val reset = orientationDelta > RESET_ORIENT_RAD || gravityDevS >= RESET_GRAVITY_S
    val base = if (reset) initialState() else s.copy(gravityDevS = gravityDevS)
    val ring = (base.gravityRing + gMean).takeLast(GRAVITY_MEAN_S)
    return ResetResult(base.copy(gravityRing = ring), reset)
  }

  /** Step 6: keep `f` horizontal for this second's gravity. A degenerate result drops the frame. */
  fun reproject(s: AlignmentState, gMean: Vec3): AlignmentState {
    val f0 = s.f ?: return s
    val f = normalize(reject(f0, gMean))
    return if (isZero(f)) s.copy(f = null, agree = 0, aligned = false) else s.copy(f = f)
  }

  /** Step 7: one alignment update from the GNSS Δv (`dvG`, signed g) and the mean horizontal accel. */
  fun update(s: AlignmentState, meanH: Vec3, gMean: Vec3, dvG: Double?): AlignmentState {
    if (dvG == null || abs(dvG) < ALIGN_MIN_G) return s
    val h = reject(meanH, gMean)
    if (norm(h) < ALIGN_MIN_H_G) return s
    val u = scale(normalize(h), if (dvG > 0) 1.0 else -1.0)
    val f0 = s.f ?: return s.copy(f = u, agree = 0)
    val agree = if (angle(u, f0) <= ALIGN_TOL_RAD) s.agree + 1 else 0
    val f = normalize(reject(add(scale(f0, 1 - ALIGN_ALPHA), scale(u, ALIGN_ALPHA)), gMean))
    if (isZero(f)) return s.copy(f = null, agree = 0, aligned = false)
    return s.copy(f = f, agree = agree, aligned = s.aligned || agree >= ALIGN_MIN_UPDATES)
  }
}
