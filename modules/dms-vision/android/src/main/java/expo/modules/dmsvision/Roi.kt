// Port of src/reference/roi.ts: luma statistics in the BUFFER frame, read per pixel from the
// camera's 4-byte pixels (RGBA on Android). No full-frame luma plane is built. JVM only.

package expo.modules.dmsvision

import java.nio.ByteBuffer
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Read-only view of 4-byte pixels (RGBA or BGRA). Pixel (x, y) starts at y·rowStride + x·pixelStride
 * from the buffer's start: CameraX `planes[0].rowStride` / `pixelStride`, never width × 4 (camera rows
 * are padded; Task 2 review I1). Reads are absolute, so the buffer's position is never touched.
 */
class LumaSource(
  private val bytes: ByteBuffer,
  val width: Int,
  val height: Int,
  private val rowStride: Int,
  private val pixelStride: Int,
  private val bgra: Boolean
) {
  /** Integer BT.601: (77·R + 150·G + 29·B) >> 8. */
  fun luma(x: Int, y: Int): Int {
    val p = y * rowStride + x * pixelStride
    val r = bytes.get(if (bgra) p + 2 else p).toInt() and 0xFF
    val g = bytes.get(p + 1).toInt() and 0xFF
    val b = bytes.get(if (bgra) p else p + 2).toInt() and 0xFF
    return (77 * r + 150 * g + 29 * b) shr 8
  }
}

/** x1, y1 exclusive. */
class PixelRect(minX: Double, minY: Double, maxX: Double, maxY: Double, w: Int, h: Int) {
  val x0: Int = max(0, floor(minX).toInt())
  val y0: Int = max(0, floor(minY).toInt())
  val x1: Int = min(w, ceil(maxX).toInt())
  val y1: Int = min(h, ceil(maxY).toInt())
  val isEmpty: Boolean get() = x1 <= x0 || y1 <= y0
}

class EyeLuma(val eyeLuma: Double, val irisContrast: Double, val eyeSat: Double)

object Roi {
  /** Mean luma of every 8th pixel of every 8th row, from (0, 0). */
  fun frameLuma(src: LumaSource): Double {
    var sum = 0L
    var n = 0
    var y = 0
    while (y < src.height) {
      var x = 0
      while (x < src.width) { sum += src.luma(x, y); n += 1; x += 8 }
      y += 8
    }
    return if (n == 0) 0.0 else sum.toDouble() / n
  }

  /** The bounding box of all 478 buffer-frame landmarks, in pixels, clipped. */
  fun faceRect(lm: DoubleArray, w: Int, h: Int): PixelRect {
    var minX = Double.POSITIVE_INFINITY
    var minY = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY
    var maxY = Double.NEGATIVE_INFINITY
    val fw = w.toDouble()
    val fh = h.toDouble()
    for (i in 0 until Landmarks.COUNT) {
      val x = lm[i * 3] * fw
      val y = lm[i * 3 + 1] * fh
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    return PixelRect(minX, minY, maxX, maxY, w, h)
  }

  /** Mean over the face rect, every 2nd pixel of every 2nd row from its origin; 0 when empty. */
  fun faceLuma(src: LumaSource, r: PixelRect): Double {
    if (r.isEmpty) return 0.0
    var sum = 0L
    var n = 0
    var y = r.y0
    while (y < r.y1) {
      var x = r.x0
      while (x < r.x1) { sum += src.luma(x, y); n += 1; x += 2 }
      y += 2
    }
    return sum.toDouble() / n
  }

  /** 64×64 box average of the face rect, then the population variance of the 3×3 Laplacian. */
  fun blurScore(src: LumaSource, r: PixelRect): Double {
    if (r.isEmpty) return 0.0
    val n = 64
    val rw = r.x1 - r.x0
    val rh = r.y1 - r.y0
    val cells = DoubleArray(n * n)
    for (j in 0 until n) {
      val ya = r.y0 + (j * rh) / n
      val yb = max(r.y0 + ((j + 1) * rh) / n, ya + 1)
      for (i in 0 until n) {
        val xa = r.x0 + (i * rw) / n
        val xb = max(r.x0 + ((i + 1) * rw) / n, xa + 1)
        var sum = 0L
        for (y in ya until yb) for (x in xa until xb) sum += src.luma(x, y)
        cells[j * n + i] = sum.toDouble() / ((yb - ya) * (xb - xa)).toDouble()
      }
    }
    var mean = 0.0
    var sq = 0.0
    val count = ((n - 2) * (n - 2)).toDouble()
    for (j in 1 until n - 1) {
      for (i in 1 until n - 1) {
        val c = cells[j * n + i]
        val l = 4 * c - cells[(j - 1) * n + i] - cells[(j + 1) * n + i] - cells[j * n + i - 1] - cells[j * n + i + 1]
        mean += l
        sq += l * l
      }
    }
    mean /= count
    return max(0.0, sq / count - mean * mean)
  }

  /** Eye ROI (contour bbox grown 10 % per side), iris disk (≤ r) and sclera ring (1.3r, 1.8r]. */
  fun eyeLuma(src: LumaSource, lm: DoubleArray, right: Boolean, face: Double): EyeLuma {
    val contour = if (right) Landmarks.rightEye else Landmarks.leftEye
    val iris = if (right) Landmarks.rightIris else Landmarks.leftIris
    val fw = src.width.toDouble()
    val fh = src.height.toDouble()
    var minX = Double.POSITIVE_INFINITY
    var minY = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY
    var maxY = Double.NEGATIVE_INFINITY
    for (k in contour) {
      val x = lm[k * 3] * fw
      val y = lm[k * 3 + 1] * fh
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    val gx = 0.1 * (maxX - minX)
    val gy = 0.1 * (maxY - minY)
    val rect = PixelRect(minX - gx, minY - gy, maxX + gx, maxY + gy, src.width, src.height)
    if (rect.isEmpty) return EyeLuma(0.0, 0.0, 0.0)
    val cx = lm[iris[0] * 3] * fw
    val cy = lm[iris[0] * 3 + 1] * fh
    var r = 0.0
    for (k in 1..4) r += hypot(lm[iris[k] * 3] * fw - cx, lm[iris[k] * 3 + 1] * fh - cy)
    r /= 4
    val r2 = r * r
    val inner2 = 1.69 * r2
    val outer2 = 3.24 * r2
    var sum = 0L
    var n = 0
    var sat = 0
    var irisSum = 0L
    var irisN = 0
    var ringSum = 0L
    var ringN = 0
    for (y in rect.y0 until rect.y1) {
      for (x in rect.x0 until rect.x1) {
        val v = src.luma(x, y)
        sum += v
        n += 1
        if (v >= 250) sat += 1
        val dx = x + 0.5 - cx
        val dy = y + 0.5 - cy
        val d2 = dx * dx + dy * dy
        if (d2 <= r2) {
          irisSum += v
          irisN += 1
        } else if (d2 > inner2 && d2 <= outer2) {
          ringSum += v
          ringN += 1
        }
      }
    }
    val contrast = if (irisN > 0 && ringN > 0) {
      min(255.0, max(0.0, ringSum.toDouble() / ringN - irisSum.toDouble() / irisN))
    } else 0.0
    val mean = sum.toDouble() / n
    return EyeLuma(if (face > 0) mean / face else 0.0, contrast, sat.toDouble() / n)
  }
}
