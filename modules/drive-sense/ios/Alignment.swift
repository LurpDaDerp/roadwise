// The vehicle frame learned in the device frame, and the frame-free features of one second.
//
// Port of `src/extract/alignment.ts` and `handling.ts`, line for line (README §7 steps 4–7).
// Vertical is gravity; the forward axis `f` is the horizontal direction the user acceleration
// takes while GNSS says the speed is changing (sign from Δv). No magnetometer, no compass and no
// GNSS course are read: a magnetic mount cannot bend the frame and a lagging course cannot mix
// braking into cornering.
import Foundation

private typealias K = ExtractConstants

struct AlignmentState {
  /// learned forward axis (unit, horizontal), nil before the first update
  var f: Vec3?
  /// consecutive updates that agreed with `f` within ALIGN_TOL_RAD
  var agree: Int
  /// true once `agree` reached ALIGN_MIN_UPDATES; cleared only by a reset
  var aligned: Bool
  /// the last ≤ GRAVITY_MEAN_S per-second mean gravity directions, oldest first
  var gravityRing: [Vec3]
  /// consecutive seconds the gravity direction deviated from the ring's mean by > RESET_GRAVITY_RAD
  var gravityDevS: Int

  static func initial() -> AlignmentState {
    AlignmentState(f: nil, agree: 0, aligned: false, gravityRing: [], gravityDevS: 0)
  }
}

enum Alignment {
  /// Step 5: did the phone move relative to the car? Pushes this second's gravity onto the ring.
  static func checkReset(_ s: AlignmentState, gMean: Vec3, orientationDelta: Double) -> (state: AlignmentState, reset: Bool) {
    var dev = 0.0
    if !s.gravityRing.isEmpty {
      var sum = Vec3.zero
      for v in s.gravityRing { sum = vAdd(sum, v) }
      dev = vAngle(gMean, vNormalize(sum))
    }
    let gravityDevS = dev > K.RESET_GRAVITY_RAD ? s.gravityDevS + 1 : 0
    let reset = orientationDelta > K.RESET_ORIENT_RAD || gravityDevS >= K.RESET_GRAVITY_S
    var base: AlignmentState
    if reset {
      base = AlignmentState.initial()
    } else {
      base = s
      base.gravityDevS = gravityDevS
    }
    var ring = base.gravityRing
    ring.append(gMean)
    if ring.count > K.GRAVITY_MEAN_S { ring.removeFirst(ring.count - K.GRAVITY_MEAN_S) }
    base.gravityRing = ring
    return (base, reset)
  }

  /// Step 6: keep `f` horizontal for this second's gravity; a degenerate result drops the frame.
  static func reproject(_ s: AlignmentState, gMean: Vec3) -> AlignmentState {
    guard let f0 = s.f else { return s }
    var out = s
    let f = vNormalize(vReject(f0, gMean))
    if vIsZero(f) {
      out.f = nil
      out.agree = 0
      out.aligned = false
    } else {
      out.f = f
    }
    return out
  }

  /// Step 7: one update when |dvG| ≥ ALIGN_MIN_G and the mean horizontal user acceleration is at
  /// least ALIGN_MIN_H_G.
  static func updateAlignment(_ s: AlignmentState, meanH: Vec3, gMean: Vec3, dvG: Double?) -> AlignmentState {
    guard let dvG = dvG else { return s }
    if abs(dvG) < K.ALIGN_MIN_G { return s }
    let h = vReject(meanH, gMean)
    if vNorm(h) < K.ALIGN_MIN_H_G { return s }
    let u = vScale(vNormalize(h), dvG > 0 ? 1 : -1)
    var out = s
    guard let f0 = s.f else {
      out.f = u
      out.agree = 0
      return out
    }
    let agree = vAngle(u, f0) <= K.ALIGN_TOL_RAD ? s.agree + 1 : 0
    let f = vNormalize(vReject(vAdd(vScale(f0, 1 - K.ALIGN_ALPHA), vScale(u, K.ALIGN_ALPHA)), gMean))
    if vIsZero(f) {
      out.f = nil
      out.agree = 0
      out.aligned = false
      return out
    }
    out.f = f
    out.agree = agree
    out.aligned = s.aligned || agree >= K.ALIGN_MIN_UPDATES
    return out
  }
}

/// The frame-free features (`handling.ts`), populated whether or not the frame is aligned.
struct FrameFree {
  var yawRateMax: Double
  var gravityStability: Double
  var orientationDelta: Double
  var handlingScore: Double

  /// - Parameters: `gHat[i]` = normalize(imu[i].g); `gMean` = normalize(Σ gHat); `dt` per sample, s.
  static func compute(_ imu: [ImuSample], gHat: [Vec3], gMean: Vec3, dt: [Double]) -> FrameFree {
    var yawRateMax = 0.0
    var maxAngle = 0.0
    var orientationDelta = 0.0
    var sumSq = 0.0
    for i in 0..<imu.count {
      let s = imu[i]
      let gi = gHat[i]
      let yaw = abs(vDot(s.w, gi))
      if yaw > yawRateMax { yawRateMax = yaw }
      let a = vAngle(gi, gMean)
      if a > maxAngle { maxAngle = a }
      let off = vNorm(vReject(s.w, gi))
      orientationDelta += off * dt[i]
      sumSq += off * off
    }
    let gravityStability = 1 - clampD(maxAngle / K.GRAVITY_STABILITY_RAD, 0, 1)
    let rms = (sumSq / Double(imu.count)).squareRoot()
    let handlingScore = clampD((rms - K.HANDLING_W_FLOOR) / K.HANDLING_W_SPAN, 0, 1)
      * (gravityStability < K.HANDLING_STABLE_GS ? 1 : K.HANDLING_STABLE_FACTOR)
    return FrameFree(
      yawRateMax: yawRateMax,
      gravityStability: gravityStability,
      orientationDelta: orientationDelta,
      handlingScore: handlingScore
    )
  }
}
