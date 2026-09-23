// Port of src/reference/features.ts, irisOffset.ts and record.ts: the whole per-frame feature pass.
// Geometry on the UPRIGHT landmarks in upright pixels; luma in the BUFFER frame (Roi); head pose
// from the matrix (HeadPose). Returns one absolute-form record (index 0 = tMs) with NaN where the
// wire mask says "not computed". Foundation only.

import Foundation

struct EyeGeometry {
  let ear: Double
  let widthPx: Double
  let ox: Double
  let oy: Double
  let irisIn: Bool
}

struct FrameInput {
  let tMs: Double
  let bufferW: Int
  let bufferH: Int
  let rotationDeg: Int
  let luma: LumaSource
  /// MediaPipe's landmarks in the BUFFER frame (478 × 3), or nil when no face was found.
  let landmarks: [Double]?
  /// The facial transformation matrix (4×4, buffer frame, either layout: HeadPose.normaliseLayout), or nil.
  let matrix: [Double]?
  /// The gaze network's output vector when it ran on this frame.
  let netGaze: [Double]?
  let latLandmarkMs: Double
  let latTotalMs: Double
}

enum FeatureExtractor {
  static let degeneratePx = 1e-6

  static func ear6(_ lm: [Double], _ p: [Int], _ w: Double, _ h: Double) -> Double {
    let g = { (i: Int) in Landmarks.px(lm, p[i], w, h) }
    let horizontal = Landmarks.dist(g(0), g(3))
    return (Landmarks.dist(g(1), g(5)) + Landmarks.dist(g(2), g(4))) / (2.0 * horizontal)
  }

  /// Even–odd ray casting of (x, y) against the polygon of landmark indices, in pixels.
  static func insidePolygon(_ lm: [Double], _ poly: [Int], _ x: Double, _ y: Double, _ w: Double, _ h: Double) -> Bool {
    var inside = false
    var j = poly.count - 1
    for i in 0..<poly.count {
      let (xi, yi) = Landmarks.px(lm, poly[i], w, h)
      let (xj, yj) = Landmarks.px(lm, poly[j], w, h)
      if (yi > y) != (yj > y) {
        let xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi
        if x < xCross { inside = !inside }
      }
      j = i
    }
    return inside
  }

  /// û = s·u (image right for both eyes), v̂ = (û.y, −û.x) (image up); offsets in eye widths.
  static func irisOffset(_ lm: [Double], right: Bool, _ w: Double, _ h: Double) -> (ox: Double, oy: Double)? {
    let (outer, inner) = right ? Landmarks.rightCorners : Landmarks.leftCorners
    let s: Double = right ? 1 : -1
    let a = Landmarks.px(lm, outer, w, h)
    let b = Landmarks.px(lm, inner, w, h)
    let c = Landmarks.px(lm, right ? 468 : 473, w, h)
    let dx = b.0 - a.0, dy = b.1 - a.1
    let width = hypot(dx, dy)
    if !(width > 1e-9) { return nil }
    let ux = s * dx / width, uy = s * dy / width
    let vx = uy, vy = -ux
    let mx = 0.5 * (a.0 + b.0), my = 0.5 * (a.1 + b.1)
    return (((c.0 - mx) * ux + (c.1 - my) * uy) / width, ((c.0 - mx) * vx + (c.1 - my) * vy) / width)
  }

  static func eyeGeometry(_ lm: [Double], right: Bool, _ w: Double, _ h: Double) -> EyeGeometry? {
    let contour = right ? Landmarks.rightEye : Landmarks.leftEye
    let iris = right ? Landmarks.rightIris : Landmarks.leftIris
    for k in contour + iris where !Landmarks.inFrame(lm, k) { return nil }
    let (outer, inner) = right ? Landmarks.rightCorners : Landmarks.leftCorners
    let widthPx = Landmarks.dist(Landmarks.px(lm, outer, w, h), Landmarks.px(lm, inner, w, h))
    if !(widthPx >= degeneratePx) { return nil }
    guard let off = irisOffset(lm, right: right, w, h) else { return nil }
    let (cx, cy) = Landmarks.px(lm, iris[0], w, h)
    return EyeGeometry(
      ear: ear6(lm, right ? Landmarks.earRight : Landmarks.earLeft, w, h),
      widthPx: widthPx, ox: off.ox, oy: off.oy,
      irisIn: insidePolygon(lm, contour, cx, cy, w, h))
  }

  struct Geometry {
    let boxCx: Double, boxCy: Double, boxW: Double, boxH: Double, iod: Double
    let right: EyeGeometry?, left: EyeGeometry?
    let mar: Double?, mouthW: Double?
  }

  static func geometry(_ lm: [Double], _ uw: Int, _ uh: Int) -> Geometry {
    let w = Double(uw), h = Double(uh)
    var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
    for i in 0..<Landmarks.count {
      let x = lm[i * 3], y = lm[i * 3 + 1]
      if x < minX { minX = x }
      if x > maxX { maxX = x }
      if y < minY { minY = y }
      if y > maxY { maxY = y }
    }
    let iodPx = Landmarks.dist(Landmarks.px(lm, Landmarks.outerCorners.0, w, h), Landmarks.px(lm, Landmarks.outerCorners.1, w, h))
    let mouthKeys = [Landmarks.lipInner.0, Landmarks.lipInner.1, Landmarks.mouthCorners.0, Landmarks.mouthCorners.1]
    let mouthIn = mouthKeys.allSatisfy { Landmarks.inFrame(lm, $0) }
    let mouthWidthPx = Landmarks.dist(Landmarks.px(lm, Landmarks.mouthCorners.0, w, h), Landmarks.px(lm, Landmarks.mouthCorners.1, w, h))
    var mar: Double? = nil, mouthW: Double? = nil
    if mouthIn && mouthWidthPx >= degeneratePx && iodPx >= degeneratePx {
      mar = Landmarks.dist(Landmarks.px(lm, Landmarks.lipInner.0, w, h), Landmarks.px(lm, Landmarks.lipInner.1, w, h)) / mouthWidthPx
      mouthW = mouthWidthPx / iodPx
    }
    return Geometry(
      boxCx: 0.5 * (minX + maxX), boxCy: 0.5 * (minY + maxY), boxW: maxX - minX, boxH: maxY - minY,
      iod: iodPx / w,
      right: eyeGeometry(lm, right: true, w, h), left: eyeGeometry(lm, right: false, w, h),
      mar: mar, mouthW: mouthW)
  }

  /// The record native emits for a processed frame with no face.
  static func faceAbsentRecord(_ tMs: Double, _ frameLuma: Double, _ rotation: Int, _ latLandmarkMs: Double, _ latTotalMs: Double) -> [Double] {
    var r = [Double](repeating: .nan, count: DmsConstants.FRAME_STRIDE)
    for i in [F.face, F.frameLuma, F.rotationDeg, F.latLandmarkMs, F.latTotalMs, F.flags, F.reserved] { r[i] = 0 }
    r[F.tOffMs] = tMs
    r[F.frameLuma] = frameLuma
    r[F.rotationDeg] = Double(rotation)
    r[F.latLandmarkMs] = latLandmarkMs
    r[F.latTotalMs] = latTotalMs
    return r
  }

  static func buildRecord(_ f: FrameInput) -> [Double] {
    let fl = Roi.frameLuma(f.luma)
    guard let lmBuffer = f.landmarks else {
      return faceAbsentRecord(f.tMs, fl, f.rotationDeg, f.latLandmarkMs, f.latTotalMs)
    }
    let (uw, uh) = Landmarks.uprightSize(f.bufferW, f.bufferH, f.rotationDeg)
    let upright = Landmarks.toUpright(lmBuffer, f.rotationDeg)
    let g = geometry(upright, uw, uh)
    let rect = Roi.faceRect(lmBuffer, f.bufferW, f.bufferH)
    let face = Roi.faceLuma(f.luma, rect)

    var r = [Double](repeating: .nan, count: DmsConstants.FRAME_STRIDE)
    var flags = 0
    r[F.tOffMs] = f.tMs
    r[F.face] = 1
    r[F.boxCx] = g.boxCx
    r[F.boxCy] = g.boxCy
    r[F.boxW] = g.boxW
    r[F.boxH] = g.boxH
    r[F.iod] = g.iod
    if let m = f.matrix, let pose = HeadPose.fromAnyLayout(m, f.rotationDeg) {
      r[F.headYaw] = pose.yaw
      r[F.headPitch] = pose.pitch
      r[F.headRoll] = pose.roll
    } else {
      flags |= DmsConstants.FLAG_POSE_MISSING
    }
    if let v = f.netGaze, v.count == 3 {
      let a = HeadPose.gazeAngles(v)
      r[F.netYaw] = a.yaw
      r[F.netPitch] = a.pitch
      flags |= DmsConstants.FLAG_NET_RAN
    }
    let eyes: [(Bool, EyeGeometry?)] = [(true, g.right), (false, g.left)]
    for (right, eye) in eyes {
      let ear = right ? F.earR : F.earL, eyeW = right ? F.eyeWR : F.eyeWL
      let luma = right ? F.eyeLumaR : F.eyeLumaL, contrast = right ? F.irisContrastR : F.irisContrastL
      let sat = right ? F.eyeSatR : F.eyeSatL, ox = right ? F.irisOxR : F.irisOxL
      let oy = right ? F.irisOyR : F.irisOyL, irisIn = right ? F.irisInR : F.irisInL
      guard let e = eye else {
        flags |= right ? DmsConstants.FLAG_EYE_CLIPPED_R : DmsConstants.FLAG_EYE_CLIPPED_L
        r[irisIn] = 0
        continue
      }
      let stats = Roi.eyeLuma(f.luma, lmBuffer, right: right, face: face)
      r[ear] = e.ear
      r[eyeW] = e.widthPx
      r[luma] = stats.eyeLuma
      r[contrast] = stats.irisContrast
      r[sat] = stats.eyeSat
      r[ox] = e.ox
      r[oy] = e.oy
      r[irisIn] = e.irisIn ? 1 : 0
    }
    r[F.faceLuma] = face
    r[F.blur] = Roi.blurScore(f.luma, rect)
    if let mar = g.mar, let mw = g.mouthW {
      r[F.mar] = mar
      r[F.mouthW] = mw
    } else {
      flags |= DmsConstants.FLAG_MOUTH_CLIPPED
    }
    r[F.frameLuma] = fl
    r[F.rotationDeg] = Double(f.rotationDeg)
    r[F.latLandmarkMs] = f.latLandmarkMs
    r[F.latTotalMs] = f.latTotalMs
    r[F.flags] = Double(flags)
    r[F.reserved] = 0
    return r
  }
}
