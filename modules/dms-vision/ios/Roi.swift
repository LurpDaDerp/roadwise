// Port of src/reference/roi.ts: luma statistics in the BUFFER frame, read per pixel from the
// camera's 4-byte pixels (BGRA on iOS). No full-frame luma plane is built. Foundation only.

import Foundation

/// Read-only view of 4-byte pixels (BGRA or RGBA) with a row stride.
struct LumaSource {
  let bytes: UnsafePointer<UInt8>
  let width: Int
  let height: Int
  let rowBytes: Int
  let bgra: Bool

  /// Integer BT.601: (77·R + 150·G + 29·B) >> 8.
  @inline(__always) func luma(_ x: Int, _ y: Int) -> Int {
    let p = bytes + y * rowBytes + x * 4
    let r = Int(bgra ? p[2] : p[0])
    let g = Int(p[1])
    let b = Int(bgra ? p[0] : p[2])
    return (77 * r + 150 * g + 29 * b) >> 8
  }
}

struct PixelRect {
  let x0: Int, y0: Int, x1: Int, y1: Int  // x1, y1 exclusive
  var isEmpty: Bool { return x1 <= x0 || y1 <= y0 }

  init(minX: Double, minY: Double, maxX: Double, maxY: Double, w: Int, h: Int) {
    x0 = max(0, Int(floor(minX)))
    y0 = max(0, Int(floor(minY)))
    x1 = min(w, Int(ceil(maxX)))
    y1 = min(h, Int(ceil(maxY)))
  }
}

struct EyeLuma {
  let eyeLuma: Double
  let irisContrast: Double
  let eyeSat: Double
}

enum Roi {
  /// Mean luma of every 8th pixel of every 8th row, from (0, 0).
  static func frameLuma(_ src: LumaSource) -> Double {
    var sum = 0, n = 0
    var y = 0
    while y < src.height {
      var x = 0
      while x < src.width { sum += src.luma(x, y); n += 1; x += 8 }
      y += 8
    }
    return n == 0 ? 0 : Double(sum) / Double(n)
  }

  /// The bounding box of all 478 buffer-frame landmarks, in pixels, clipped.
  static func faceRect(_ lm: [Double], _ w: Int, _ h: Int) -> PixelRect {
    var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
    let fw = Double(w), fh = Double(h)
    for i in 0..<Landmarks.count {
      let x = lm[i * 3] * fw, y = lm[i * 3 + 1] * fh
      if x < minX { minX = x }
      if x > maxX { maxX = x }
      if y < minY { minY = y }
      if y > maxY { maxY = y }
    }
    return PixelRect(minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: w, h: h)
  }

  /// Mean over the face rect, every 2nd pixel of every 2nd row from its origin; 0 when empty.
  static func faceLuma(_ src: LumaSource, _ r: PixelRect) -> Double {
    if r.isEmpty { return 0 }
    var sum = 0, n = 0
    var y = r.y0
    while y < r.y1 {
      var x = r.x0
      while x < r.x1 { sum += src.luma(x, y); n += 1; x += 2 }
      y += 2
    }
    return Double(sum) / Double(n)
  }

  /// 64×64 box average of the face rect, then the population variance of the 3×3 Laplacian.
  static func blurScore(_ src: LumaSource, _ r: PixelRect) -> Double {
    if r.isEmpty { return 0 }
    let n = 64
    let rw = r.x1 - r.x0, rh = r.y1 - r.y0
    var cells = [Double](repeating: 0, count: n * n)
    for j in 0..<n {
      let ya = r.y0 + (j * rh) / n
      let yb = max(r.y0 + ((j + 1) * rh) / n, ya + 1)
      for i in 0..<n {
        let xa = r.x0 + (i * rw) / n
        let xb = max(r.x0 + ((i + 1) * rw) / n, xa + 1)
        var sum = 0
        for y in ya..<yb { for x in xa..<xb { sum += src.luma(x, y) } }
        cells[j * n + i] = Double(sum) / Double((yb - ya) * (xb - xa))
      }
    }
    var mean = 0.0, sq = 0.0
    let count = Double((n - 2) * (n - 2))
    for j in 1..<(n - 1) {
      for i in 1..<(n - 1) {
        let c = cells[j * n + i]
        let l = 4 * c - cells[(j - 1) * n + i] - cells[(j + 1) * n + i] - cells[j * n + i - 1] - cells[j * n + i + 1]
        mean += l
        sq += l * l
      }
    }
    mean /= count
    return max(0, sq / count - mean * mean)
  }

  /// Eye ROI (contour bbox grown 10 % per side), iris disk (≤ r) and sclera ring (1.3r, 1.8r].
  static func eyeLuma(_ src: LumaSource, _ lm: [Double], right: Bool, face: Double) -> EyeLuma {
    let contour = right ? Landmarks.rightEye : Landmarks.leftEye
    let iris = right ? Landmarks.rightIris : Landmarks.leftIris
    let fw = Double(src.width), fh = Double(src.height)
    var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
    for k in contour {
      let x = lm[k * 3] * fw, y = lm[k * 3 + 1] * fh
      if x < minX { minX = x }
      if x > maxX { maxX = x }
      if y < minY { minY = y }
      if y > maxY { maxY = y }
    }
    let gx = 0.1 * (maxX - minX), gy = 0.1 * (maxY - minY)
    let rect = PixelRect(minX: minX - gx, minY: minY - gy, maxX: maxX + gx, maxY: maxY + gy, w: src.width, h: src.height)
    if rect.isEmpty { return EyeLuma(eyeLuma: 0, irisContrast: 0, eyeSat: 0) }
    let cx = lm[iris[0] * 3] * fw, cy = lm[iris[0] * 3 + 1] * fh
    var r = 0.0
    for k in 1...4 { r += hypot(lm[iris[k] * 3] * fw - cx, lm[iris[k] * 3 + 1] * fh - cy) }
    r /= 4
    let r2 = r * r, inner2 = 1.69 * r2, outer2 = 3.24 * r2
    var sum = 0, n = 0, sat = 0, irisSum = 0, irisN = 0, ringSum = 0, ringN = 0
    for y in rect.y0..<rect.y1 {
      for x in rect.x0..<rect.x1 {
        let v = src.luma(x, y)
        sum += v
        n += 1
        if v >= 250 { sat += 1 }
        let dx = Double(x) + 0.5 - cx, dy = Double(y) + 0.5 - cy
        let d2 = dx * dx + dy * dy
        if d2 <= r2 {
          irisSum += v
          irisN += 1
        } else if d2 > inner2 && d2 <= outer2 {
          ringSum += v
          ringN += 1
        }
      }
    }
    let contrast = (irisN > 0 && ringN > 0)
      ? min(255, max(0, Double(ringSum) / Double(ringN) - Double(irisSum) / Double(irisN))) : 0
    let mean = Double(sum) / Double(n)
    return EyeLuma(eyeLuma: face > 0 ? mean / face : 0, irisContrast: contrast, eyeSat: Double(sat) / Double(n))
  }
}
