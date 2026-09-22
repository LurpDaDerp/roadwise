// Constants, vector helpers and value types of the feature-extraction port.
//
// Port of `src/extract/constants.ts`, `vec.ts` and `types.ts` (README §7). Every constant keeps
// the reference's name and value (`__tests__/native-ios.test.ts` compares them); every helper
// keeps the reference's definition, including `normalize`'s exact-zero case and `angle` via
// atan2, so edge cases agree to the last bit where the platform maths allows.
// The Android gravity filter's constants are not here: iOS gets gravity from CoreMotion.
import Foundation

enum ExtractConstants {
  static let G_MPS2: Double = 9.80665
  static let IMU_RATE_HZ: Double = 25
  static let MIN_IMU_SAMPLES: Int = 10
  static let SMOOTH_SAMPLES: Int = 5
  static let IMU_MAX_DT_S: Double = 0.1

  static let GNSS_MAX_HACC_M: Double = 50
  static let GNSS_MAX_AGE_S: Double = 1.5
  static let NO_FIX_HACC_M: Double = 9999
  static let UNKNOWN: Double = -1

  static let ALIGN_MIN_G: Double = 0.1
  static let ALIGN_ALPHA: Double = 0.1
  static let ALIGN_MIN_UPDATES: Int = 5
  static let ALIGN_TOL_RAD: Double = 0.35
  static let ALIGN_MIN_H_G: Double = 0.05

  static let RESET_ORIENT_RAD: Double = 0.35
  static let RESET_GRAVITY_RAD: Double = 0.2
  static let RESET_GRAVITY_S: Int = 2
  static let GRAVITY_MEAN_S: Int = 10

  static let GRAVITY_STABILITY_RAD: Double = 0.2
  static let HANDLING_W_FLOOR: Double = 0.15
  static let HANDLING_W_SPAN: Double = 0.6
  static let HANDLING_STABLE_GS: Double = 0.95
  static let HANDLING_STABLE_FACTOR: Double = 0.5

  static let EPS: Double = 1e-9
  static let SELF_TEST_TOLERANCE: Double = 1e-6
}

/// A device-frame vector. `x`, `y`, `z` as in the reference's `[0]`, `[1]`, `[2]`.
struct Vec3: Equatable {
  var x: Double
  var y: Double
  var z: Double

  static let zero = Vec3(x: 0, y: 0, z: 0)

  init(x: Double, y: Double, z: Double) {
    self.x = x
    self.y = y
    self.z = z
  }

  /// From a 3-element JSON array; nil for anything else.
  init?(json: Any?) {
    guard let a = json as? [Any], a.count == 3,
          let x = jsonNumber(a[0]), let y = jsonNumber(a[1]), let z = jsonNumber(a[2]) else { return nil }
    self.init(x: x, y: y, z: z)
  }
}

@inline(__always) func vAdd(_ a: Vec3, _ b: Vec3) -> Vec3 { Vec3(x: a.x + b.x, y: a.y + b.y, z: a.z + b.z) }
@inline(__always) func vSub(_ a: Vec3, _ b: Vec3) -> Vec3 { Vec3(x: a.x - b.x, y: a.y - b.y, z: a.z - b.z) }
@inline(__always) func vScale(_ a: Vec3, _ k: Double) -> Vec3 { Vec3(x: a.x * k, y: a.y * k, z: a.z * k) }
@inline(__always) func vDot(_ a: Vec3, _ b: Vec3) -> Double { a.x * b.x + a.y * b.y + a.z * b.z }
@inline(__always) func vCross(_ a: Vec3, _ b: Vec3) -> Vec3 {
  Vec3(x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x)
}
@inline(__always) func vNorm(_ a: Vec3) -> Double { (vDot(a, a)).squareRoot() }

/// Unit vector along `a`, or exactly zero when |a| < EPS (divides, as the reference does).
func vNormalize(_ a: Vec3) -> Vec3 {
  let n = vNorm(a)
  return n < ExtractConstants.EPS ? Vec3.zero : Vec3(x: a.x / n, y: a.y / n, z: a.z / n)
}

/// v − (v·n)n
@inline(__always) func vReject(_ v: Vec3, _ n: Vec3) -> Vec3 { vSub(v, vScale(n, vDot(v, n))) }

/// atan2(|a×b|, a·b); 0 when either is zero.
@inline(__always) func vAngle(_ a: Vec3, _ b: Vec3) -> Double { atan2(vNorm(vCross(a, b)), vDot(a, b)) }

@inline(__always) func vIsZero(_ a: Vec3) -> Bool { a.x == 0 && a.y == 0 && a.z == 0 }

/// min(hi, max(lo, x)), as `Math.min(hi, Math.max(lo, x))`.
@inline(__always) func clampD(_ x: Double, _ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, x)) }

/// JavaScript `Math.round`: halves round toward +∞ (Swift's `.rounded()` rounds them away from zero).
func jsRound(_ x: Double) -> Double {
  let f = x.rounded(.down)
  return x - f >= 0.5 ? f + 1 : f
}

/// Whether a JSONSerialization value is a JSON boolean (both are NSNumbers).
private func isJsonBoolean(_ n: NSNumber) -> Bool {
  #if canImport(Darwin)
  return CFGetTypeID(n) == CFBooleanGetTypeID()
  #else
  return String(describing: type(of: n)) == "__NSCFBoolean" // swift-corelibs (host-side checks only)
  #endif
}

/// A JSON number (NSNumber that is not a boolean) as a Double.
func jsonNumber(_ v: Any?) -> Double? {
  guard let n = v as? NSNumber, !isJsonBoolean(n) else { return nil }
  return n.doubleValue
}

/// A JSON boolean.
func jsonBool(_ v: Any?) -> Bool? {
  guard let n = v as? NSNumber, isJsonBoolean(n) else { return nil }
  return n.boolValue
}

// MARK: - Value types (`types.ts`)

/// One IMU sample: epoch ms (may be fractional), user acceleration and gravity in g (a = g + ua,
/// gravity toward the earth), angular rate in rad/s — CoreMotion's own conventions.
struct ImuSample {
  var t: Double
  var ua: Vec3
  var g: Vec3
  var w: Vec3
}

/// One fix as the platform delivered it; unknowns stay negative (the extractor maps them).
struct FixSample {
  var t: Double
  var lat: Double
  var lng: Double
  var hAcc: Double
  var speed: Double
  var speedAcc: Double
  var course: Double
  var alt: Double
}

struct PhoneSample: Equatable {
  var locked: Bool
  var screenOn: Bool
  var appForeground: Bool
}

/// Structurally M1's `FeatureRow` (and the reference's `ExtractedRow`).
struct ExtractedRow {
  var ts: Int64
  var lat, lng, hAcc, speed, speedAcc, course, alt: Double
  var gnssValid: Bool
  var aLonMax, aLonMin, aLatMax, aLatMin, yawRateMax, jerkMax: Double
  var gravityStability, orientationDelta, handlingScore: Double
  var locked, screenOn, appForeground: Bool

  /// Every number finite (the bridge contract; JSONSerialization would also trap on NaN).
  var firstNonFiniteField: String? {
    let numbers: [(String, Double)] = [
      ("lat", lat), ("lng", lng), ("hAcc", hAcc), ("speed", speed), ("speedAcc", speedAcc),
      ("course", course), ("alt", alt), ("aLonMax", aLonMax), ("aLonMin", aLonMin),
      ("aLatMax", aLatMax), ("aLatMin", aLatMin), ("yawRateMax", yawRateMax), ("jerkMax", jerkMax),
      ("gravityStability", gravityStability), ("orientationDelta", orientationDelta),
      ("handlingScore", handlingScore),
    ]
    return numbers.first { !$0.1.isFinite }?.0
  }

  /// The `row` payload: exactly the 21 `FeatureRow` keys (JS validates strictly).
  var payload: [String: Any] {
    return [
      "ts": NSNumber(value: ts),
      "lat": lat, "lng": lng, "hAcc": hAcc, "speed": speed, "speedAcc": speedAcc,
      "course": course, "alt": alt, "gnssValid": gnssValid,
      "aLonMax": aLonMax, "aLonMin": aLonMin, "aLatMax": aLatMax, "aLatMin": aLatMin,
      "yawRateMax": yawRateMax, "jerkMax": jerkMax, "gravityStability": gravityStability,
      "orientationDelta": orientationDelta, "handlingScore": handlingScore,
      "locked": locked, "screenOn": screenOn, "appForeground": appForeground,
    ]
  }
}
