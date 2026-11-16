package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Where RoadWise's window starts on the screen (SystemBarsModule.windowTopOnScreen), in the points
 * the keyboard lift compares with the keyboard's screen top. Pure JVM.
 */
class WindowTopTest {
  @Test
  fun `full screen the window starts at the top of the screen`() {
    assertEquals(0.0, WindowTop.dp(0, 0, 2.75f), 0.0)
  }

  @Test
  fun `the bottom pane of split screen starts that far down, in points`() {
    assertEquals(400.0, WindowTop.dp(1100, 0, 2.75f), 1e-9)
    assertEquals(300.0, WindowTop.dp(900, 0, 3f), 1e-9)
  }

  @Test
  fun `a view's own place in the window is taken off`() {
    assertEquals(300.0, WindowTop.dp(960, 60, 3f), 1e-9)
  }

  @Test
  fun `a missing or broken density reads as full screen`() {
    assertEquals(0.0, WindowTop.dp(900, 0, 0f), 0.0)
    assertEquals(0.0, WindowTop.dp(900, 0, -1f), 0.0)
    assertEquals(0.0, WindowTop.dp(900, 0, Float.NaN), 0.0)
    assertEquals(0.0, WindowTop.dp(900, 0, Float.POSITIVE_INFINITY), 0.0)
  }
}
