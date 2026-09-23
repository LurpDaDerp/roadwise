// Port of src/reference/landmarks.ts: index sets and the buffer → upright landmark transform.
// Foundation only. Landmarks are flat [x0, y0, z0, x1, …] (478 × 3), normalised (x/W, y/H, z/W).

import Foundation

enum Landmarks {
  static let count = 478
  static let floats = 478 * 3

  static let rightEye: [Int] = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
  static let leftEye: [Int] = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]
  static let rightIris: [Int] = [468, 469, 470, 471, 472]
  static let leftIris: [Int] = [473, 474, 475, 476, 477]
  static let earRight: [Int] = [33, 160, 158, 133, 153, 144]
  static let earLeft: [Int] = [362, 385, 387, 263, 373, 380]
  static let rightCorners: (Int, Int) = (33, 133)
  static let leftCorners: (Int, Int) = (263, 362)
  static let outerCorners: (Int, Int) = (33, 263)
  static let lipInner: (Int, Int) = (13, 14)
  static let mouthCorners: (Int, Int) = (61, 291)

  static func uprightSize(_ w: Int, _ h: Int, _ rotation: Int) -> (w: Int, h: Int) {
    return (rotation == 90 || rotation == 270) ? (h, w) : (w, h)
  }

  /// Buffer-frame → upright-frame normalised landmarks (MediaPipe returns the buffer frame). z unchanged.
  static func toUpright(_ buffer: [Double], _ rotation: Int) -> [Double] {
    var out = [Double](repeating: 0, count: floats)
    var i = 0
    while i < floats {
      let bx = buffer[i], by = buffer[i + 1]
      var ux = bx, uy = by
      switch rotation {
      case 90: ux = 1 - by; uy = bx
      case 180: ux = 1 - bx; uy = 1 - by
      case 270: ux = by; uy = 1 - bx
      default: break
      }
      out[i] = ux
      out[i + 1] = uy
      out[i + 2] = buffer[i + 2]
      i += 3
    }
    return out
  }

  @inline(__always) static func px(_ lm: [Double], _ k: Int, _ w: Double, _ h: Double) -> (Double, Double) {
    return (lm[k * 3] * w, lm[k * 3 + 1] * h)
  }

  @inline(__always) static func dist(_ a: (Double, Double), _ b: (Double, Double)) -> Double {
    return hypot(a.0 - b.0, a.1 - b.1)
  }

  @inline(__always) static func inFrame(_ lm: [Double], _ k: Int) -> Bool {
    let x = lm[k * 3], y = lm[k * 3 + 1]
    return x >= 0 && x <= 1 && y >= 0 && y <= 1
  }
}
