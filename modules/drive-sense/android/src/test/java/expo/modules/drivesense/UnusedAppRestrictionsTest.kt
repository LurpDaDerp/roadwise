package expo.modules.drivesense

import androidx.core.content.UnusedAppRestrictionsConstants
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** "Pause app activity if unused" (ruling 15): androidx.core's statuses as the contract's answers. */
class UnusedAppRestrictionsTest {
  @Test
  fun everyStatus_mapsToTheContract() {
    assertEquals("enabled", UnusedAppRestrictions.wire(UnusedAppRestrictionsConstants.API_30_BACKPORT))
    assertEquals("enabled", UnusedAppRestrictions.wire(UnusedAppRestrictionsConstants.API_30))
    assertEquals("enabled", UnusedAppRestrictions.wire(UnusedAppRestrictionsConstants.API_31))
    assertEquals("disabled", UnusedAppRestrictions.wire(UnusedAppRestrictionsConstants.DISABLED))
    assertEquals("unavailable", UnusedAppRestrictions.wire(UnusedAppRestrictionsConstants.FEATURE_NOT_AVAILABLE))
    // ERROR, or a status a later androidx might add: the read failed (JS lists no row).
    assertNull(UnusedAppRestrictions.wire(UnusedAppRestrictionsConstants.ERROR))
    assertNull(UnusedAppRestrictions.wire(99))
  }
}
