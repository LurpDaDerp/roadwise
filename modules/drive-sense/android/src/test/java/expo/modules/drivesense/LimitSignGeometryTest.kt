package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The speed-limit sign's layout: the Live Activity's `LimitSign` proportions in pixels. Pure JVM. */
class LimitSignGeometryTest {
  private val eps = 1e-3f

  @Test
  fun `the US plate at 64 dp on a 3x screen`() {
    val h = 192f
    val g = LimitSignGeometry.plate(h, 3f)
    assertEquals(153.6f, g.width, eps) // 0.8 of the height
    assertEquals(9.216f, g.corner, eps) // 0.06 of the width
    assertEquals(4.5f, g.line, eps) // max(1.5 dp, 0.025 of the width)
    assertEquals(6f, g.inset, eps) // 2 dp
    assertEquals(32.064f, g.legendSize, eps) // 0.167
    assertEquals(88.32f, g.numeralSize, eps) // 0.46
    assertTrue(g.showsLegend) // 30 dp or taller
    // Even room: top gap, gap above the number and bottom gap are equal.
    val edge = 6f + 4.5f
    val capL = g.legendSize * LimitSignGeometry.CAP
    val capN = g.numeralSize * LimitSignGeometry.CAP
    val top = g.speedY - capL / 2f - edge
    val middle = (g.numeralY - capN / 2f) - (g.limitY + capL / 2f)
    val bottom = h - edge - (g.numeralY + capN / 2f)
    assertEquals(top, middle, eps)
    assertEquals(top, bottom, eps)
    assertEquals(1.4f * capL, g.limitY - g.speedY, eps)
    assertEquals(153.6f - 2f * (edge + 7.5f), g.textWidth, eps)
  }

  @Test
  fun `a plate under 30 dp drops the legend and splits its room in two`() {
    val g = LimitSignGeometry.plate(28f, 1f)
    assertFalse(g.showsLegend)
    assertEquals(1.5f, g.line, eps) // the 1.5 dp floor
    val edge = 2f + 1.5f
    val capN = g.numeralSize * LimitSignGeometry.CAP
    assertEquals(28f - edge - (28f - 2f * edge - capN) / 2f - capN / 2f, g.numeralY, eps)
  }

  @Test
  fun `the round sign - a ring 0_09 of the height, the number 0_42 held to 0_8 of the inside`() {
    val g = LimitSignGeometry.round(192f, 3f)
    assertEquals(17.28f, g.ring, eps)
    assertEquals(80.64f, g.numeralSize, eps)
    assertEquals((192f - 2f * 17.28f) * 0.8f, g.textWidth, eps)
    assertEquals(6f, LimitSignGeometry.round(20f, 3f).ring, eps) // the 2 dp floor
    assertEquals(0xFFD7263D.toInt(), LimitSignGeometry.SIGN_RED)
  }

  @Test
  fun `a line shrinks to fit, never below its floor`() {
    assertEquals(10f, LimitSignGeometry.fitted(10f, 50f, 60f, 0.5f), eps)
    assertEquals(8f, LimitSignGeometry.fitted(10f, 75f, 60f, 0.5f), eps)
    assertEquals(5f, LimitSignGeometry.fitted(10f, 400f, 60f, 0.5f), eps)
    assertEquals(6f, LimitSignGeometry.fitted(10f, 400f, 60f, 0.6f), eps)
  }
}
