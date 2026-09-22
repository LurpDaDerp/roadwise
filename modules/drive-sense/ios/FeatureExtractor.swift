// One FeatureRow per second from the second's IMU samples, its fix and the phone state.
//
// Port of `src/extract/extract.ts`, line for line (README §7 "Per second"): same order of
// operations, doubles throughout, the reference's constants by name. The capture path and
// `selfTest` both call `FeatureExtractor.extractSecond`, so the golden vectors check the code that
// runs in the car. Not thread-safe: the capture path uses one instance on its work queue.
import Foundation

private typealias K = ExtractConstants

struct ExtractState {
  /// position of the most recent fix of any quality, for the no-fix rows
  var lastFix: (lat: Double, lng: Double, alt: Double)?
  /// the previous second's fix when it was valid with a known speed
  var prevValidFix: (t: Double, speed: Double)?
  /// epoch ms of the last IMU sample consumed
  var lastImuT: Double?
  /// the last ≤ SMOOTH_SAMPLES − 1 horizontal user-acceleration vectors, oldest first
  var hTail: [Vec3]
  /// the last smoothed longitudinal value and its time, for jerk across the second boundary
  var prevLon: (t: Double, v: Double)?
  var alignment: AlignmentState

  static func initial() -> ExtractState {
    ExtractState(lastFix: nil, prevValidFix: nil, lastImuT: nil, hTail: [], prevLon: nil, alignment: .initial())
  }
}

private struct Gnss {
  var lat, lng, alt, hAcc, speed, speedAcc, course: Double
  var gnssValid: Bool
  var lastFix: (lat: Double, lng: Double, alt: Double)?
  var prevValidFix: (t: Double, speed: Double)?
  /// signed ΔvGNSS/Δt in g between this and the previous valid fix
  var dvG: Double?
}

final class FeatureExtractor {
  private(set) var state = ExtractState.initial()

  @inline(__always) private static func known(_ x: Double) -> Double { x >= 0 ? x : K.UNKNOWN }

  private static func gnss(_ fix: FixSample?, ts: Double, state: ExtractState) -> Gnss {
    guard let fix = fix else {
      let p = state.lastFix
      return Gnss(
        lat: p?.lat ?? 0, lng: p?.lng ?? 0, alt: p?.alt ?? 0,
        hAcc: K.NO_FIX_HACC_M, speed: K.UNKNOWN, speedAcc: K.UNKNOWN, course: K.UNKNOWN,
        gnssValid: false, lastFix: p, prevValidFix: nil, dvG: nil
      )
    }
    let hAcc = fix.hAcc >= 0 ? fix.hAcc : K.NO_FIX_HACC_M
    let age = (ts - fix.t) / 1000
    let gnssValid = fix.hAcc >= 0 && fix.hAcc <= K.GNSS_MAX_HACC_M && age <= K.GNSS_MAX_AGE_S
    let speed = known(fix.speed)
    var dvG: Double?
    var prevValidFix: (t: Double, speed: Double)?
    if gnssValid && speed >= 0 {
      if let prev = state.prevValidFix, fix.t > prev.t {
        dvG = (speed - prev.speed) / ((fix.t - prev.t) / 1000) / K.G_MPS2
      }
      prevValidFix = (fix.t, speed)
    }
    return Gnss(
      lat: fix.lat, lng: fix.lng, alt: fix.alt, hAcc: hAcc, speed: speed,
      speedAcc: known(fix.speedAcc), course: known(fix.course), gnssValid: gnssValid,
      lastFix: (fix.lat, fix.lng, fix.alt), prevValidFix: prevValidFix, dvG: dvG
    )
  }

  /// - Parameters:
  ///   - imu: the window's samples, oldest first
  ///   - fix: the window's fix (latest fix timestamp in the window), or nil
  ///   - tsMs: the end of the window, epoch ms (rounded like `Math.round` for the row)
  func extractSecond(imu: [ImuSample], fix: FixSample?, phone: PhoneSample, tsMs: Double) -> ExtractedRow {
    let prior = state
    let tsD = jsRound(tsMs)
    let g = Self.gnss(fix, ts: tsD, state: prior)
    var row = ExtractedRow(
      ts: Int64(tsD),
      lat: g.lat, lng: g.lng, hAcc: g.hAcc, speed: g.speed, speedAcc: g.speedAcc,
      course: g.course, alt: g.alt, gnssValid: g.gnssValid,
      aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0, jerkMax: 0,
      gravityStability: 0, orientationDelta: 0, handlingScore: 0,
      locked: phone.locked, screenOn: phone.screenOn, appForeground: phone.appForeground
    )

    // ——— IMU absent (R2): IMU fields stay 0; alignment unchanged ———
    if imu.count < K.MIN_IMU_SAMPLES {
      state = ExtractState(
        lastFix: g.lastFix, prevValidFix: g.prevValidFix,
        lastImuT: imu.last?.t ?? prior.lastImuT,
        hTail: [], prevLon: nil, alignment: prior.alignment
      )
      return row
    }

    // ——— per-sample basics ———
    let n = imu.count
    var gHat: [Vec3] = []
    var dt: [Double] = []
    var h: [Vec3] = []
    gHat.reserveCapacity(n)
    dt.reserveCapacity(n)
    h.reserveCapacity(n)
    var gSum = Vec3.zero
    var tPrev = prior.lastImuT
    var hSum = Vec3.zero
    for s in imu {
      let gi = vNormalize(s.g)
      gHat.append(gi)
      gSum = vAdd(gSum, gi)
      if let tp = tPrev {
        dt.append(clampD((s.t - tp) / 1000, 0, K.IMU_MAX_DT_S))
      } else {
        dt.append(0)
      }
      tPrev = s.t
      let hi = vReject(s.ua, gi)
      h.append(hi)
      hSum = vAdd(hSum, hi)
    }
    let gMean = vNormalize(gSum)
    let free = FrameFree.compute(imu, gHat: gHat, gMean: gMean, dt: dt)

    // ——— frame: reset → reproject → update ———
    let r = Alignment.checkReset(prior.alignment, gMean: gMean, orientationDelta: free.orientationDelta)
    var alignment = Alignment.reproject(r.state, gMean: gMean)
    if !r.reset {
      alignment = Alignment.updateAlignment(alignment, meanH: vScale(hSum, 1 / Double(n)), gMean: gMean, dvG: g.dvG)
    }

    // ——— frame-dependent extremes ———
    var window: [Vec3] = prior.hTail
    var aLonMax = 0.0
    var aLonMin = 0.0
    var aLatMax = 0.0
    var aLatMin = 0.0
    var jerkMax = 0.0
    var prevLon: (t: Double, v: Double)?
    if alignment.aligned, let f = alignment.f {
      let l = vNormalize(vCross(f, gMean)) // left, whatever sign convention ua uses (README §Frames)
      aLonMax = -Double.infinity
      aLonMin = Double.infinity
      aLatMax = -Double.infinity
      aLatMin = Double.infinity
      prevLon = prior.prevLon
      for i in 0..<n {
        window.append(h[i])
        if window.count > K.SMOOTH_SAMPLES { window.removeFirst() }
        var sm = Vec3.zero
        for v in window { sm = vAdd(sm, v) }
        sm = vScale(sm, 1 / Double(window.count))
        let lon = vDot(sm, f)
        let lat = vDot(sm, l)
        if lon > aLonMax { aLonMax = lon }
        if lon < aLonMin { aLonMin = lon }
        if lat > aLatMax { aLatMax = lat }
        if lat < aLatMin { aLatMin = lat }
        let di = dt[i]
        if let p = prevLon, di > 0 {
          let j = abs(lon - p.v) / di
          if j > jerkMax { jerkMax = j }
        }
        prevLon = (imu[i].t, lon)
      }
    } else {
      for v in h {
        window.append(v)
        if window.count > K.SMOOTH_SAMPLES { window.removeFirst() }
      }
    }

    row.aLonMax = aLonMax
    row.aLonMin = aLonMin
    row.aLatMax = aLatMax
    row.aLatMin = aLatMin
    row.yawRateMax = free.yawRateMax
    row.jerkMax = jerkMax
    row.gravityStability = free.gravityStability
    row.orientationDelta = free.orientationDelta
    row.handlingScore = free.handlingScore

    state = ExtractState(
      lastFix: g.lastFix, prevValidFix: g.prevValidFix, lastImuT: imu[n - 1].t,
      hTail: Array(window.suffix(K.SMOOTH_SAMPLES - 1)), prevLon: prevLon, alignment: alignment
    )
    return row
  }
}
