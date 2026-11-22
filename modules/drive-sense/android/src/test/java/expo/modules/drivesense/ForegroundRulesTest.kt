package expo.modules.drivesense

import android.content.pm.ServiceInfo
import org.junit.Assert.assertEquals
import org.junit.Test

/** When Android ignored the location service's `startForeground` without throwing. Pure JVM. */
class ForegroundRulesTest {
  private val none = ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE
  private val location = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION

  @Test
  fun `Android 10 and up - Restricted and still no foreground type after the call is ignored, whatever is in front`() {
    for (sdk in listOf(29, 31, 34, 36)) for (visible in listOf(true, false)) {
      assertEquals(true, ForegroundRules.suppressed(sdk, none, restricted = true, visible = visible))
      // In the foreground: the call took.
      assertEquals(false, ForegroundRules.suppressed(sdk, location, restricted = true, visible = visible))
      // Not Restricted: never read as ignored.
      assertEquals(false, ForegroundRules.suppressed(sdk, none, restricted = false, visible = visible))
    }
  }

  @Test
  fun `Android 9 - Restricted with no RoadWise screen open is ignored, a screen open keeps the call's answer`() {
    assertEquals(true, ForegroundRules.suppressed(28, 0, restricted = true, visible = false))
    assertEquals(false, ForegroundRules.suppressed(28, 0, restricted = true, visible = true))
    assertEquals(false, ForegroundRules.suppressed(28, 0, restricted = false, visible = false))
  }

  @Test
  fun `below Android 9 Android never ignores it`() {
    for (sdk in listOf(24, 26, 27)) {
      assertEquals(false, ForegroundRules.suppressed(sdk, 0, restricted = true, visible = false))
    }
  }
}
