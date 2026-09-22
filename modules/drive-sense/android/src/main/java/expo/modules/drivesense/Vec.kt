package expo.modules.drivesense

import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Three-vector arithmetic, a line-for-line port of `src/extract/vec.ts`. The edge cases (normalize's
 * exact zero, angle via atan2) must agree with the reference for the golden vectors to pass.
 */
data class Vec3(val x: Double, val y: Double, val z: Double) {
  companion object {
    val ZERO = Vec3(0.0, 0.0, 0.0)
  }
}

fun add(a: Vec3, b: Vec3): Vec3 = Vec3(a.x + b.x, a.y + b.y, a.z + b.z)

fun sub(a: Vec3, b: Vec3): Vec3 = Vec3(a.x - b.x, a.y - b.y, a.z - b.z)

fun scale(a: Vec3, k: Double): Vec3 = Vec3(a.x * k, a.y * k, a.z * k)

fun dot(a: Vec3, b: Vec3): Double = a.x * b.x + a.y * b.y + a.z * b.z

fun cross(a: Vec3, b: Vec3): Vec3 = Vec3(
  a.y * b.z - a.z * b.y,
  a.z * b.x - a.x * b.z,
  a.x * b.y - a.y * b.x
)

fun norm(a: Vec3): Double = sqrt(dot(a, a))

/** Unit vector along [a], or exactly [0, 0, 0] when |a| < EPS. */
fun normalize(a: Vec3): Vec3 {
  val n = norm(a)
  return if (n < EPS) Vec3.ZERO else Vec3(a.x / n, a.y / n, a.z / n)
}

/** v − (v·n)n */
fun reject(v: Vec3, n: Vec3): Vec3 = sub(v, scale(n, dot(v, n)))

/** atan2(|a×b|, a·b); 0 when either is zero. */
fun angle(a: Vec3, b: Vec3): Double = atan2(norm(cross(a, b)), dot(a, b))

fun isZero(a: Vec3): Boolean = a.x == 0.0 && a.y == 0.0 && a.z == 0.0

/** JS `Math.min(hi, Math.max(lo, x))`. */
fun clamp(x: Double, lo: Double, hi: Double): Double = min(hi, max(lo, x))

