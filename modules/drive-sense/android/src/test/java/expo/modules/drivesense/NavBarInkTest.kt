package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The navigation bar's ink (SystemBarsModule): the names JS sends, and the scrim painted under the
 * buttons only where the system draws none (API 26–28). Pure JVM.
 */
class NavBarInkTest {
  @Test
  fun `the ink names are the status bar's, anything else is none`() {
    assertEquals(true, NavBarInk.parse("light"))
    assertEquals(false, NavBarInk.parse("dark"))
    assertNull(NavBarInk.parse("auto"))
    assertNull(NavBarInk.parse(""))
  }

  @Test
  fun `API 26 to 28 get a scrim that matches the ink, never white buttons on a white bar`() {
    for (sdk in 26..28) {
      assertEquals(NavBarInk.DARK_SCRIM, NavBarInk.scrimFor(sdk, lightInk = true))
      assertEquals(NavBarInk.LIGHT_SCRIM, NavBarInk.scrimFor(sdk, lightInk = false))
    }
  }

  @Test
  fun `API 29 and up stay transparent (the system scrim), below 26 nothing changes`() {
    for (sdk in listOf(23, 24, 25, 29, 30, 34, 35, 36)) {
      assertNull(NavBarInk.scrimFor(sdk, lightInk = true))
      assertNull(NavBarInk.scrimFor(sdk, lightInk = false))
    }
  }

  @Test
  fun `the scrims are React Native's own colours`() {
    assertEquals(0xE6FFFFFF.toInt(), NavBarInk.LIGHT_SCRIM)
    assertEquals(0x801B1B1B.toInt(), NavBarInk.DARK_SCRIM)
  }
}
