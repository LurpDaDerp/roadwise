// Port of src/reference/landmarks.ts: index sets and the buffer → upright landmark transform.
// JVM only. Landmarks are flat [x0, y0, z0, x1, …] (478 × 3), normalised (x/W, y/H, z/W).

package expo.modules.dmsvision

import kotlin.math.hypot

object Landmarks {
  const val COUNT = 478
  const val FLOATS = 478 * 3

  val rightEye = intArrayOf(33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246)
  val leftEye = intArrayOf(263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466)
  val rightIris = intArrayOf(468, 469, 470, 471, 472)
  val leftIris = intArrayOf(473, 474, 475, 476, 477)
  val earRight = intArrayOf(33, 160, 158, 133, 153, 144)
  val earLeft = intArrayOf(362, 385, 387, 263, 373, 380)
  val rightCorners = intArrayOf(33, 133)
  val leftCorners = intArrayOf(263, 362)
  val outerCorners = intArrayOf(33, 263)
  val lipInner = intArrayOf(13, 14)
  val mouthCorners = intArrayOf(61, 291)

  /** (w, h) of the upright frame. */
  fun uprightSize(w: Int, h: Int, rotation: Int): IntArray =
    if (rotation == 90 || rotation == 270) intArrayOf(h, w) else intArrayOf(w, h)

  /** Buffer-frame → upright-frame normalised landmarks (MediaPipe returns the buffer frame). z unchanged. */
  fun toUpright(buffer: DoubleArray, rotation: Int): DoubleArray {
    val out = DoubleArray(FLOATS)
    var i = 0
    while (i < FLOATS) {
      val bx = buffer[i]
      val by = buffer[i + 1]
      var ux = bx
      var uy = by
      when (rotation) {
        90 -> { ux = 1 - by; uy = bx }
        180 -> { ux = 1 - bx; uy = 1 - by }
        270 -> { ux = by; uy = 1 - bx }
      }
      out[i] = ux
      out[i + 1] = uy
      out[i + 2] = buffer[i + 2]
      i += 3
    }
    return out
  }

  fun pxX(lm: DoubleArray, k: Int, w: Double): Double = lm[k * 3] * w
  fun pxY(lm: DoubleArray, k: Int, h: Double): Double = lm[k * 3 + 1] * h

  /** Distance between landmarks a and b, in pixels. */
  fun dist(lm: DoubleArray, a: Int, b: Int, w: Double, h: Double): Double =
    hypot(pxX(lm, a, w) - pxX(lm, b, w), pxY(lm, a, h) - pxY(lm, b, h))

  fun inFrame(lm: DoubleArray, k: Int): Boolean {
    val x = lm[k * 3]
    val y = lm[k * 3 + 1]
    return x >= 0 && x <= 1 && y >= 0 && y <= 1
  }
}
