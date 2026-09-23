// Port of src/reference/headPose.ts: the matrix layout rule, head pose from the facial transformation
// matrix, and the gaze network's vector → angles. JVM only.

package expo.modules.dmsvision

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

object HeadPose {
  const val MATRIX_TZ_MIN = 5.0
  const val MATRIX_ZERO_MAX = 1.0

  /**
   * Column-major if |m14| ≥ 5 and |m11| < 1; transposed if |m11| ≥ 5 and |m14| < 1; otherwise null
   * (POSE_MISSING). Every head-pose path goes through this (Task 2 review I2): MediaPipe's float[16]
   * is copied as delivered, and this rule decides its layout at runtime.
   */
  fun normaliseLayout(m: DoubleArray): DoubleArray? {
    if (m.size != 16) return null
    for (v in m) if (!v.isFinite()) return null
    val a14 = abs(m[14])
    val a11 = abs(m[11])
    if (a14 >= MATRIX_TZ_MIN && a11 < MATRIX_ZERO_MAX) return m
    if (a11 >= MATRIX_TZ_MIN && a14 < MATRIX_ZERO_MAX) {
      val t = DoubleArray(16)
      for (r in 0 until 4) for (c in 0 until 4) t[c * 4 + r] = m[r * 4 + c]
      return t
    }
    return null
  }

  /** [yaw, pitch, roll] in degrees from a matrix in either layout, or null when the layout is ambiguous. */
  fun fromAnyLayout(m: DoubleArray, rotation: Int): DoubleArray? {
    val n = normaliseLayout(m) ?: return null
    return fromMatrix(n, rotation)
  }

  /** Column-major 4×4 in the buffer frame → degrees in the upright camera frame (R_up = Rz(−θ)·R_buf). */
  fun fromMatrix(m: DoubleArray, rotation: Int): DoubleArray {
    val th = (-rotation.toDouble() * Math.PI) / 180
    val c = cos(th)
    val s = sin(th)
    fun at(row: Int, col: Int): Double = m[col * 4 + row]
    fun r(row: Int, col: Int): Double {
      val a = at(0, col)
      val b = at(1, col)
      if (row == 0) return c * a - s * b
      if (row == 1) return s * a + c * b
      return at(2, col)
    }
    val fx = r(0, 2)
    val fy = r(1, 2)
    val fz = r(2, 2)
    val yaw = atan2(fx, fz)
    val pitch = atan2(fy, hypot(fx, fz))
    val ux = r(0, 1)
    val uy = r(1, 1)
    val uz = r(2, 1)
    val cy = cos(-yaw)
    val sy = sin(-yaw)
    val x1 = cy * ux + sy * uz
    val y1 = uy
    val z1 = -sy * ux + cy * uz
    val cp = cos(pitch)
    val sp = sin(pitch)
    val x2 = x1
    val y2 = cp * y1 - sp * z1
    val roll = atan2(x2, y2)
    val deg = 180 / Math.PI
    return doubleArrayOf(yaw * deg, pitch * deg, roll * deg)
  }

  /** The model stores s = diag(1, 1, −1) × the OpenCV direction: yaw = atan2(x, z), pitch = atan2(−y, hypot(x, z)). */
  fun gazeAngles(v: DoubleArray): DoubleArray {
    val deg = 180 / Math.PI
    return doubleArrayOf(atan2(v[0], v[2]) * deg, atan2(-v[1], hypot(v[0], v[2])) * deg)
  }
}
