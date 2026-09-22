package expo.modules.drivesense

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * One FeatureRow per second — a line-for-line port of `src/extract/extract.ts` and
 * `src/extract/handling.ts` (README §7 "Per second"). Same order of operations, doubles
 * throughout, constants by the reference's names. Pure: the capture path ([CaptureService]) and
 * `selfTest` ([SelfTest]) both call [extractSecond], so the golden vectors check the code that runs
 * in the car.
 */
object FeatureExtractor {
  fun initialState(): ExtractState = ExtractState(
    lastFix = null,
    prevValidFix = null,
    lastImuT = null,
    hTail = emptyList(),
    prevLon = null,
    alignment = Alignment.initialState()
  )

  data class Result(val row: FeatureRow, val state: ExtractState)

  private fun known(x: Double): Double = if (x >= 0) x else UNKNOWN.toDouble()

  private class Gnss(
    val lat: Double,
    val lng: Double,
    val alt: Double,
    val hAcc: Double,
    val speed: Double,
    val speedAcc: Double,
    val course: Double,
    val gnssValid: Boolean,
    val lastFix: LastFix?,
    val prevValidFix: PrevValidFix?,
    val dvG: Double?
  )

  private fun gnss(fix: FixSample?, ts: Long, state: ExtractState): Gnss {
    if (fix == null) {
      val p = state.lastFix
      return Gnss(
        lat = p?.lat ?: 0.0,
        lng = p?.lng ?: 0.0,
        alt = p?.alt ?: 0.0,
        hAcc = NO_FIX_HACC_M.toDouble(),
        speed = UNKNOWN.toDouble(),
        speedAcc = UNKNOWN.toDouble(),
        course = UNKNOWN.toDouble(),
        gnssValid = false,
        lastFix = p,
        prevValidFix = null,
        dvG = null
      )
    }
    val hAcc = if (fix.hAcc >= 0) fix.hAcc else NO_FIX_HACC_M.toDouble()
    val gnssValid =
      fix.hAcc >= 0 && fix.hAcc <= GNSS_MAX_HACC_M && (ts.toDouble() - fix.t) / 1000 <= GNSS_MAX_AGE_S
    val speed = known(fix.speed)
    var dvG: Double? = null
    var prevValidFix: PrevValidFix? = null
    if (gnssValid && speed >= 0) {
      val prev = state.prevValidFix
      if (prev != null && fix.t > prev.t) {
        dvG = (speed - prev.speed) / ((fix.t - prev.t) / 1000) / G_MPS2
      }
      prevValidFix = PrevValidFix(fix.t, speed)
    }
    return Gnss(
      lat = fix.lat,
      lng = fix.lng,
      alt = fix.alt,
      hAcc = hAcc,
      speed = speed,
      speedAcc = known(fix.speedAcc),
      course = known(fix.course),
      gnssValid = gnssValid,
      lastFix = LastFix(fix.lat, fix.lng, fix.alt),
      prevValidFix = prevValidFix,
      dvG = dvG
    )
  }

  private class FrameFree(
    val yawRateMax: Double,
    val gravityStability: Double,
    val orientationDelta: Double,
    val handlingScore: Double
  )

  /** `handling.ts` `frameFree`. */
  private fun frameFree(imu: List<ImuSample>, gHat: List<Vec3>, gMean: Vec3, dt: List<Double>): FrameFree {
    var yawRateMax = 0.0
    var maxAngle = 0.0
    var orientationDelta = 0.0
    var sumSq = 0.0
    for (i in imu.indices) {
      val s = imu[i]
      val gi = gHat[i]
      val yaw = abs(dot(s.w, gi))
      if (yaw > yawRateMax) yawRateMax = yaw
      val a = angle(gi, gMean)
      if (a > maxAngle) maxAngle = a
      val off = norm(reject(s.w, gi))
      orientationDelta += off * dt[i]
      sumSq += off * off
    }
    val gravityStability = 1 - clamp(maxAngle / GRAVITY_STABILITY_RAD, 0.0, 1.0)
    val rms = sqrt(sumSq / imu.size)
    val handlingScore =
      clamp((rms - HANDLING_W_FLOOR) / HANDLING_W_SPAN, 0.0, 1.0) *
        (if (gravityStability < HANDLING_STABLE_GS) 1.0 else HANDLING_STABLE_FACTOR)
    return FrameFree(yawRateMax, gravityStability, orientationDelta, handlingScore)
  }

  /**
   * @param imu the window's samples, oldest first
   * @param fix the window's fix (the latest fix timestamp in the window), or null
   * @param tsMs the end of the window, epoch ms (rounded for the row)
   */
  fun extractSecond(
    imu: List<ImuSample>,
    fix: FixSample?,
    phone: PhoneSample,
    tsMs: Double,
    state: ExtractState
  ): Result {
    val ts = Math.round(tsMs)
    val g = gnss(fix, ts, state)

    // ——— IMU absent (R2) ———
    if (imu.size < MIN_IMU_SAMPLES) {
      val last = imu.lastOrNull()
      return Result(
        row = FeatureRow(
          ts = ts,
          lat = g.lat, lng = g.lng, hAcc = g.hAcc, speed = g.speed, speedAcc = g.speedAcc,
          course = g.course, alt = g.alt, gnssValid = g.gnssValid,
          aLonMax = 0.0, aLonMin = 0.0, aLatMax = 0.0, aLatMin = 0.0,
          yawRateMax = 0.0, jerkMax = 0.0, gravityStability = 0.0, orientationDelta = 0.0,
          handlingScore = 0.0,
          locked = phone.locked, screenOn = phone.screenOn, appForeground = phone.appForeground
        ),
        state = ExtractState(
          lastFix = g.lastFix,
          prevValidFix = g.prevValidFix,
          lastImuT = last?.t ?: state.lastImuT,
          hTail = emptyList(),
          prevLon = null,
          alignment = state.alignment
        )
      )
    }

    // ——— per-sample basics ———
    val n = imu.size
    val gHat = ArrayList<Vec3>(n)
    val dt = ArrayList<Double>(n)
    val h = ArrayList<Vec3>(n)
    var gSum = Vec3(0.0, 0.0, 0.0)
    var tPrev = state.lastImuT
    var hSum = Vec3(0.0, 0.0, 0.0)
    for (s in imu) {
      val gi = normalize(s.g)
      gHat.add(gi)
      gSum = add(gSum, gi)
      val p = tPrev
      dt.add(if (p == null) 0.0 else clamp((s.t - p) / 1000, 0.0, IMU_MAX_DT_S))
      tPrev = s.t
      val hi = reject(s.ua, gi)
      h.add(hi)
      hSum = add(hSum, hi)
    }
    val gMean = normalize(gSum)
    val free = frameFree(imu, gHat, gMean, dt)

    // ——— frame: reset → reproject → update ———
    val r = Alignment.checkReset(state.alignment, gMean, free.orientationDelta)
    var alignment = Alignment.reproject(r.state, gMean)
    if (!r.reset) alignment = Alignment.update(alignment, scale(hSum, 1.0 / n), gMean, g.dvG)

    // ——— frame-dependent extremes ———
    val window = ArrayList<Vec3>(state.hTail)
    var aLonMax = 0.0
    var aLonMin = 0.0
    var aLatMax = 0.0
    var aLatMin = 0.0
    var jerkMax = 0.0
    var prevLon: PrevLon? = null
    val f = if (alignment.aligned) alignment.f else null
    if (f != null) {
      val l = normalize(cross(f, gMean)) // left, whatever sign convention ua uses (README §Frames)
      aLonMax = Double.NEGATIVE_INFINITY
      aLonMin = Double.POSITIVE_INFINITY
      aLatMax = Double.NEGATIVE_INFINITY
      aLatMin = Double.POSITIVE_INFINITY
      prevLon = state.prevLon
      for (i in 0 until n) {
        window.add(h[i])
        if (window.size > SMOOTH_SAMPLES) window.removeAt(0)
        var sm = Vec3(0.0, 0.0, 0.0)
        for (v in window) sm = add(sm, v)
        sm = scale(sm, 1.0 / window.size)
        val lon = dot(sm, f)
        val lat = dot(sm, l)
        if (lon > aLonMax) aLonMax = lon
        if (lon < aLonMin) aLonMin = lon
        if (lat > aLatMax) aLatMax = lat
        if (lat < aLatMin) aLatMin = lat
        val di = dt[i]
        val pl = prevLon
        if (pl != null && di > 0) {
          val j = abs(lon - pl.v) / di
          if (j > jerkMax) jerkMax = j
        }
        prevLon = PrevLon(imu[i].t, lon)
      }
    } else {
      for (v in h) {
        window.add(v)
        if (window.size > SMOOTH_SAMPLES) window.removeAt(0)
      }
    }

    return Result(
      row = FeatureRow(
        ts = ts,
        lat = g.lat, lng = g.lng, hAcc = g.hAcc, speed = g.speed, speedAcc = g.speedAcc,
        course = g.course, alt = g.alt, gnssValid = g.gnssValid,
        aLonMax = aLonMax,
        aLonMin = aLonMin,
        aLatMax = aLatMax,
        aLatMin = aLatMin,
        yawRateMax = free.yawRateMax,
        jerkMax = jerkMax,
        gravityStability = free.gravityStability,
        orientationDelta = free.orientationDelta,
        handlingScore = free.handlingScore,
        locked = phone.locked, screenOn = phone.screenOn, appForeground = phone.appForeground
      ),
      state = ExtractState(
        lastFix = g.lastFix,
        prevValidFix = g.prevValidFix,
        lastImuT = imu[n - 1].t,
        hTail = window.takeLast(SMOOTH_SAMPLES - 1),
        prevLon = prevLon,
        alignment = alignment
      )
    )
  }
}
