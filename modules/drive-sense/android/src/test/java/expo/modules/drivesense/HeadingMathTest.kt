package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

/**
 * The phone heading's arithmetic (HeadingSource, README §12). Pure JVM: the rotation vectors are
 * built here from known poses, as the sensor would report them.
 */
class HeadingMathTest {
  /** A unit quaternion (x, y, z, w) rotating by [deg] about the axis (ax, ay, az). */
  private fun quat(ax: Double, ay: Double, az: Double, deg: Double): DoubleArray {
    val h = Math.toRadians(deg) / 2
    return doubleArrayOf(ax * sin(h), ay * sin(h), az * sin(h), cos(h))
  }

  /** q1 then q2 (the rotation q2 · q1). */
  private fun then(q1: DoubleArray, q2: DoubleArray): DoubleArray {
    val (x1, y1, z1, w1) = q1.toList()
    val (x2, y2, z2, w2) = q2.toList()
    return doubleArrayOf(
      w2 * x1 + x2 * w1 + y2 * z1 - z2 * y1,
      w2 * y1 - x2 * z1 + y2 * w1 + z2 * x1,
      w2 * z1 + x2 * y1 - y2 * x1 + z2 * w1,
      w2 * w1 - x2 * x1 - y2 * y1 - z2 * z1
    )
  }

  private fun headingOf(q: DoubleArray, withW: Boolean = true, rotation: Int = 0): Double? =
    HeadingMath.heading(HeadingMath.rotationMatrix(q[0], q[1], q[2], if (withW) q[3] else null), rotation)

  /**
   * A phone facing [facing] degrees (clockwise from north), tilted back from upright by [tiltBack]
   * degrees: 0 is upright in portrait (its back to the road ahead), 90 lying flat screen up (its top
   * ahead).
   */
  private fun pose(facing: Double, tiltBack: Double): DoubleArray {
    // Upright facing north: the screen faces south, the top up. From flat (identity), that is +90°
    // about the east axis; tilting back by t is (90 − t) about east. Facing is −facing about up.
    val tilt = quat(1.0, 0.0, 0.0, 90.0 - tiltBack)
    val turn = quat(0.0, 0.0, 1.0, -facing)
    return then(tilt, turn)
  }

  @Test
  fun `lying flat, the heading is where the top points`() {
    assertEquals(0.0, headingOf(pose(0.0, 90.0))!!, 1e-6)
    assertEquals(90.0, headingOf(pose(90.0, 90.0))!!, 1e-6)
    assertEquals(225.0, headingOf(pose(225.0, 90.0))!!, 1e-6)
  }

  @Test
  fun `upright in portrait, the heading is where the back faces (the road ahead)`() {
    assertEquals(0.0, headingOf(pose(0.0, 0.0))!!, 1e-6)
    assertEquals(90.0, headingOf(pose(90.0, 0.0))!!, 1e-6)
    assertEquals(300.0, headingOf(pose(300.0, 0.0))!!, 1e-6)
  }

  @Test
  fun `tilted back in a mount, the heading does not move with the tilt`() {
    for (tilt in listOf(10.0, 30.0, 45.0, 60.0, 80.0)) {
      assertEquals(270.0, headingOf(pose(270.0, tilt))!!, 1e-6)
      assertEquals(45.0, headingOf(pose(45.0, tilt))!!, 1e-6)
    }
  }

  /** Headings equal within 1e-6 degrees, across north (359.9999999 is 0). */
  private fun assertHeading(expected: Double, actual: Double?) {
    assertNotNull(actual)
    assertEquals(0.0, ((actual!! - expected + 540.0) % 360.0) - 180.0, 1e-6)
  }

  /**
   * [pose] for the screen, on a device whose own axes sit a quarter turn [rotation] times from the
   * screen's: at `Surface.ROTATION_90` the device's +X is the top of the screen (its +Y points to the
   * screen's left), as for a landscape-natural tablet standing in portrait.
   */
  private fun devicePose(facing: Double, tiltBack: Double, rotation: Int): DoubleArray =
    then(quat(0.0, 0.0, 1.0, 90.0 * rotation), pose(facing, tiltBack))

  @Test
  fun `at every display rotation the heading is where the top of the screen and the back point`() {
    for (rotation in 0..3) {
      for (tilt in listOf(0.0, 30.0, 90.0)) {
        assertHeading(0.0, headingOf(devicePose(0.0, tilt, rotation), rotation = rotation))
        assertHeading(135.0, headingOf(devicePose(135.0, tilt, rotation), rotation = rotation))
        assertHeading(290.0, headingOf(devicePose(290.0, tilt, rotation), rotation = rotation))
      }
    }
  }

  @Test
  fun `a landscape-natural tablet in portrait at rotation 90 would read off if its own top were taken`() {
    // Lying flat facing north: the device's +Y points west, so its own top reads 270.
    assertHeading(270.0, headingOf(devicePose(0.0, 90.0, 1)))
    assertHeading(0.0, headingOf(devicePose(0.0, 90.0, 1), rotation = 1))
    // Upright in a mount facing north: 45 degrees off by the device's own top, right by the screen's.
    assertHeading(315.0, headingOf(devicePose(0.0, 0.0, 1)))
    assertHeading(0.0, headingOf(devicePose(0.0, 0.0, 1), rotation = 1))
    assertHeading(90.0, headingOf(devicePose(90.0, 0.0, 3), rotation = 3))
  }

  @Test
  fun `a rotation vector without its w component reads the same`() {
    // The sensor's scalar part is non-negative when it omits it: take the quaternion with w >= 0.
    val q = pose(120.0, 20.0).let { if (it[3] < 0) it.map { v -> -v }.toDoubleArray() else it }
    assertEquals(120.0, headingOf(q, withW = false)!!, 1e-4)
  }

  @Test
  fun `tipped 45 degrees face down there is no forward direction`() {
    assertNull(headingOf(pose(0.0, -45.0)))
    assertNotNull(headingOf(pose(0.0, -20.0)))
  }

  @Test
  fun `on the accuracy scale unreliable is none and the estimate lowers the status`() {
    assertEquals(0, HeadingMath.accuracyLevel(0, null))
    assertEquals(0, HeadingMath.accuracyLevel(-1, null))
    assertEquals(1, HeadingMath.accuracyLevel(1, null))
    assertEquals(3, HeadingMath.accuracyLevel(3, null))
    assertEquals(3, HeadingMath.accuracyLevel(3, Math.toRadians(10.0)))
    assertEquals(2, HeadingMath.accuracyLevel(3, Math.toRadians(30.0)))
    assertEquals(1, HeadingMath.accuracyLevel(3, Math.toRadians(40.0)))
    assertEquals(0, HeadingMath.accuracyLevel(3, Math.toRadians(60.0)))
    assertEquals(1, HeadingMath.accuracyLevel(1, Math.toRadians(5.0)))
    // a negative estimate is none given
    assertEquals(3, HeadingMath.accuracyLevel(3, -1.0))
  }

  @Test
  fun `norm keeps degrees in 0 to 360`() {
    assertEquals(350.0, HeadingMath.norm(-10.0), 1e-9)
    assertEquals(0.0, HeadingMath.norm(360.0), 1e-9)
    assertEquals(10.0, HeadingMath.norm(370.0), 1e-9)
  }
}
