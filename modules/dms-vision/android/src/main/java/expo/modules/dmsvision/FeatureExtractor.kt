// Port of src/reference/features.ts, irisOffset.ts and record.ts: the whole per-frame feature pass.
// Geometry on the UPRIGHT landmarks in upright pixels; luma in the BUFFER frame (Roi); head pose
// from the matrix (HeadPose). Returns one absolute-form record (index 0 = tMs) with NaN where the
// wire mask says "not computed". JVM only.

package expo.modules.dmsvision

import kotlin.math.hypot

class EyeGeometry(val ear: Double, val widthPx: Double, val ox: Double, val oy: Double, val irisIn: Boolean)

class FrameInput(
  val tMs: Double,
  val bufferW: Int,
  val bufferH: Int,
  val rotationDeg: Int,
  val luma: LumaSource,
  /** MediaPipe's landmarks in the BUFFER frame (478 × 3), or null when no face was found. */
  val landmarks: DoubleArray?,
  /** The facial transformation matrix (16 values as delivered, either layout: HeadPose.normaliseLayout), or null. */
  val matrix: DoubleArray?,
  /** The gaze network's output vector when it ran on this frame. */
  val netGaze: DoubleArray?,
  val latLandmarkMs: Double,
  val latTotalMs: Double
)

object FeatureExtractor {
  const val DEGENERATE_PX = 1e-6

  fun ear6(lm: DoubleArray, p: IntArray, w: Double, h: Double): Double {
    val horizontal = Landmarks.dist(lm, p[0], p[3], w, h)
    return (Landmarks.dist(lm, p[1], p[5], w, h) + Landmarks.dist(lm, p[2], p[4], w, h)) / (2.0 * horizontal)
  }

  /** Even–odd ray casting of (x, y) against the polygon of landmark indices, in pixels. */
  fun insidePolygon(lm: DoubleArray, poly: IntArray, x: Double, y: Double, w: Double, h: Double): Boolean {
    var inside = false
    var j = poly.size - 1
    for (i in poly.indices) {
      val xi = Landmarks.pxX(lm, poly[i], w)
      val yi = Landmarks.pxY(lm, poly[i], h)
      val xj = Landmarks.pxX(lm, poly[j], w)
      val yj = Landmarks.pxY(lm, poly[j], h)
      if ((yi > y) != (yj > y)) {
        val xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi
        if (x < xCross) inside = !inside
      }
      j = i
    }
    return inside
  }

  /** û = s·u (image right for both eyes), v̂ = (û.y, −û.x) (image up); offsets in eye widths. Null when degenerate. */
  fun irisOffset(lm: DoubleArray, right: Boolean, w: Double, h: Double): DoubleArray? {
    val corners = if (right) Landmarks.rightCorners else Landmarks.leftCorners
    val s = if (right) 1.0 else -1.0
    val ax = Landmarks.pxX(lm, corners[0], w)
    val ay = Landmarks.pxY(lm, corners[0], h)
    val bx = Landmarks.pxX(lm, corners[1], w)
    val by = Landmarks.pxY(lm, corners[1], h)
    val c = if (right) 468 else 473
    val cx = Landmarks.pxX(lm, c, w)
    val cy = Landmarks.pxY(lm, c, h)
    val dx = bx - ax
    val dy = by - ay
    val width = hypot(dx, dy)
    if (!(width > 1e-9)) return null
    val ux = s * dx / width
    val uy = s * dy / width
    val vx = uy
    val vy = -ux
    val mx = 0.5 * (ax + bx)
    val my = 0.5 * (ay + by)
    return doubleArrayOf(((cx - mx) * ux + (cy - my) * uy) / width, ((cx - mx) * vx + (cy - my) * vy) / width)
  }

  fun eyeGeometry(lm: DoubleArray, right: Boolean, w: Double, h: Double): EyeGeometry? {
    val contour = if (right) Landmarks.rightEye else Landmarks.leftEye
    val iris = if (right) Landmarks.rightIris else Landmarks.leftIris
    for (k in contour) if (!Landmarks.inFrame(lm, k)) return null
    for (k in iris) if (!Landmarks.inFrame(lm, k)) return null
    val corners = if (right) Landmarks.rightCorners else Landmarks.leftCorners
    val widthPx = Landmarks.dist(lm, corners[0], corners[1], w, h)
    if (!(widthPx >= DEGENERATE_PX)) return null
    val off = irisOffset(lm, right, w, h) ?: return null
    val cx = Landmarks.pxX(lm, iris[0], w)
    val cy = Landmarks.pxY(lm, iris[0], h)
    return EyeGeometry(
      ear6(lm, if (right) Landmarks.earRight else Landmarks.earLeft, w, h),
      widthPx, off[0], off[1],
      insidePolygon(lm, contour, cx, cy, w, h)
    )
  }

  class Geometry(
    val boxCx: Double, val boxCy: Double, val boxW: Double, val boxH: Double, val iod: Double,
    val right: EyeGeometry?, val left: EyeGeometry?,
    val mar: Double?, val mouthW: Double?
  )

  fun geometry(lm: DoubleArray, uw: Int, uh: Int): Geometry {
    val w = uw.toDouble()
    val h = uh.toDouble()
    var minX = Double.POSITIVE_INFINITY
    var minY = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY
    var maxY = Double.NEGATIVE_INFINITY
    for (i in 0 until Landmarks.COUNT) {
      val x = lm[i * 3]
      val y = lm[i * 3 + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    val iodPx = Landmarks.dist(lm, Landmarks.outerCorners[0], Landmarks.outerCorners[1], w, h)
    val mouthKeys = intArrayOf(Landmarks.lipInner[0], Landmarks.lipInner[1], Landmarks.mouthCorners[0], Landmarks.mouthCorners[1])
    val mouthIn = mouthKeys.all { Landmarks.inFrame(lm, it) }
    val mouthWidthPx = Landmarks.dist(lm, Landmarks.mouthCorners[0], Landmarks.mouthCorners[1], w, h)
    var mar: Double? = null
    var mouthW: Double? = null
    if (mouthIn && mouthWidthPx >= DEGENERATE_PX && iodPx >= DEGENERATE_PX) {
      mar = Landmarks.dist(lm, Landmarks.lipInner[0], Landmarks.lipInner[1], w, h) / mouthWidthPx
      mouthW = mouthWidthPx / iodPx
    }
    return Geometry(
      0.5 * (minX + maxX), 0.5 * (minY + maxY), maxX - minX, maxY - minY,
      iodPx / w,
      eyeGeometry(lm, true, w, h), eyeGeometry(lm, false, w, h),
      mar, mouthW
    )
  }

  /** The record native emits for a processed frame with no face. */
  fun faceAbsentRecord(tMs: Double, frameLuma: Double, rotation: Int, latLandmarkMs: Double, latTotalMs: Double): DoubleArray {
    val r = DoubleArray(DmsConstants.FRAME_STRIDE) { Double.NaN }
    for (i in intArrayOf(F.face, F.frameLuma, F.rotationDeg, F.latLandmarkMs, F.latTotalMs, F.flags, F.reserved)) r[i] = 0.0
    r[F.tOffMs] = tMs
    r[F.frameLuma] = frameLuma
    r[F.rotationDeg] = rotation.toDouble()
    r[F.latLandmarkMs] = latLandmarkMs
    r[F.latTotalMs] = latTotalMs
    return r
  }

  fun buildRecord(f: FrameInput): DoubleArray {
    val fl = Roi.frameLuma(f.luma)
    val lmBuffer = f.landmarks ?: return faceAbsentRecord(f.tMs, fl, f.rotationDeg, f.latLandmarkMs, f.latTotalMs)
    val size = Landmarks.uprightSize(f.bufferW, f.bufferH, f.rotationDeg)
    val upright = Landmarks.toUpright(lmBuffer, f.rotationDeg)
    val g = geometry(upright, size[0], size[1])
    val rect = Roi.faceRect(lmBuffer, f.bufferW, f.bufferH)
    val face = Roi.faceLuma(f.luma, rect)

    val r = DoubleArray(DmsConstants.FRAME_STRIDE) { Double.NaN }
    var flags = 0
    r[F.tOffMs] = f.tMs
    r[F.face] = 1.0
    r[F.boxCx] = g.boxCx
    r[F.boxCy] = g.boxCy
    r[F.boxW] = g.boxW
    r[F.boxH] = g.boxH
    r[F.iod] = g.iod
    val pose = f.matrix?.let { HeadPose.fromAnyLayout(it, f.rotationDeg) }
    if (pose != null) {
      r[F.headYaw] = pose[0]
      r[F.headPitch] = pose[1]
      r[F.headRoll] = pose[2]
    } else {
      flags = flags or DmsConstants.FLAG_POSE_MISSING
    }
    val v = f.netGaze
    if (v != null && v.size == 3) {
      val a = HeadPose.gazeAngles(v)
      r[F.netYaw] = a[0]
      r[F.netPitch] = a[1]
      flags = flags or DmsConstants.FLAG_NET_RAN
    }
    for (right in booleanArrayOf(true, false)) {
      val eye = if (right) g.right else g.left
      val irisIn = if (right) F.irisInR else F.irisInL
      if (eye == null) {
        flags = flags or (if (right) DmsConstants.FLAG_EYE_CLIPPED_R else DmsConstants.FLAG_EYE_CLIPPED_L)
        r[irisIn] = 0.0
        continue
      }
      val stats = Roi.eyeLuma(f.luma, lmBuffer, right, face)
      r[if (right) F.earR else F.earL] = eye.ear
      r[if (right) F.eyeWR else F.eyeWL] = eye.widthPx
      r[if (right) F.eyeLumaR else F.eyeLumaL] = stats.eyeLuma
      r[if (right) F.irisContrastR else F.irisContrastL] = stats.irisContrast
      r[if (right) F.eyeSatR else F.eyeSatL] = stats.eyeSat
      r[if (right) F.irisOxR else F.irisOxL] = eye.ox
      r[if (right) F.irisOyR else F.irisOyL] = eye.oy
      r[irisIn] = if (eye.irisIn) 1.0 else 0.0
    }
    r[F.faceLuma] = face
    r[F.blur] = Roi.blurScore(f.luma, rect)
    val mar = g.mar
    val mw = g.mouthW
    if (mar != null && mw != null) {
      r[F.mar] = mar
      r[F.mouthW] = mw
    } else {
      flags = flags or DmsConstants.FLAG_MOUTH_CLIPPED
    }
    r[F.frameLuma] = fl
    r[F.rotationDeg] = f.rotationDeg.toDouble()
    r[F.latLandmarkMs] = f.latLandmarkMs
    r[F.latTotalMs] = f.latTotalMs
    r[F.flags] = flags.toDouble()
    r[F.reserved] = 0.0
    return r
  }
}
