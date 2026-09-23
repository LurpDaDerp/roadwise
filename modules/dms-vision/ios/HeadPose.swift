// Port of src/reference/headPose.ts: the matrix layout rule, head pose from the facial transformation
// matrix, and the gaze network's vector → angles. Foundation only.

import Foundation

enum HeadPose {
  static let MATRIX_TZ_MIN = 5.0
  static let MATRIX_ZERO_MAX = 1.0

  /// Column-major if |m14| ≥ 5 and |m11| < 1; transposed if |m11| ≥ 5 and |m14| < 1; otherwise nil
  /// (POSE_MISSING). Every head-pose path goes through this (Task 2 review I2).
  static func normaliseLayout(_ m: [Double]) -> [Double]? {
    if m.count != 16 { return nil }
    for v in m where !v.isFinite { return nil }
    let a14 = abs(m[14]), a11 = abs(m[11])
    if a14 >= MATRIX_TZ_MIN && a11 < MATRIX_ZERO_MAX { return m }
    if a11 >= MATRIX_TZ_MIN && a14 < MATRIX_ZERO_MAX {
      var t = [Double](repeating: 0, count: 16)
      for r in 0..<4 { for c in 0..<4 { t[c * 4 + r] = m[r * 4 + c] } }
      return t
    }
    return nil
  }

  /// Head pose from a matrix in either layout, or nil when the layout is ambiguous.
  static func fromAnyLayout(_ m: [Double], _ rotation: Int) -> (yaw: Double, pitch: Double, roll: Double)? {
    guard let n = normaliseLayout(m) else { return nil }
    return fromMatrix(n, rotation)
  }

  /// Column-major 4×4 in the buffer frame → degrees in the upright camera frame (R_up = Rz(−θ)·R_buf).
  static func fromMatrix(_ m: [Double], _ rotation: Int) -> (yaw: Double, pitch: Double, roll: Double) {
    let th = (-Double(rotation) * Double.pi) / 180
    let c = cos(th), s = sin(th)
    func at(_ row: Int, _ col: Int) -> Double { return m[col * 4 + row] }
    func r(_ row: Int, _ col: Int) -> Double {
      let a = at(0, col), b = at(1, col)
      if row == 0 { return c * a - s * b }
      if row == 1 { return s * a + c * b }
      return at(2, col)
    }
    let fx = r(0, 2), fy = r(1, 2), fz = r(2, 2)
    let yaw = atan2(fx, fz)
    let pitch = atan2(fy, hypot(fx, fz))
    let ux = r(0, 1), uy = r(1, 1), uz = r(2, 1)
    let cy = cos(-yaw), sy = sin(-yaw)
    let x1 = cy * ux + sy * uz
    let y1 = uy
    let z1 = -sy * ux + cy * uz
    let cp = cos(pitch), sp = sin(pitch)
    let x2 = x1
    let y2 = cp * y1 - sp * z1
    let roll = atan2(x2, y2)
    let deg = 180 / Double.pi
    return (yaw * deg, pitch * deg, roll * deg)
  }

  /// The model stores s = diag(1, 1, −1) × the OpenCV direction: yaw = atan2(x, z), pitch = atan2(−y, hypot(x, z)).
  static func gazeAngles(_ v: [Double]) -> (yaw: Double, pitch: Double) {
    let deg = 180 / Double.pi
    return (atan2(v[0], v[2]) * deg, atan2(-v[1], hypot(v[0], v[2])) * deg)
  }
}
