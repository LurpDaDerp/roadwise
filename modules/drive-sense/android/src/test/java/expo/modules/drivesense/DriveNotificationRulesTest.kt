package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The drive notification's source and stale-timer rules. Pure JVM. */
class DriveNotificationRulesTest {
  @Test
  fun `the capture's own display wins whatever the start`() {
    for (restart in listOf(true, false)) for (capturing in listOf(true, false)) {
      assertEquals(DriveNotificationRules.Source.DISPLAY, DriveNotificationRules.source(hasDisplay = true, restart = restart, capturing = capturing))
    }
  }

  @Test
  fun `only a sticky restart shows the kept state`() {
    assertEquals(DriveNotificationRules.Source.KEPT, DriveNotificationRules.source(hasDisplay = false, restart = true, capturing = false))
    assertEquals(DriveNotificationRules.Source.KEPT, DriveNotificationRules.source(hasDisplay = false, restart = true, capturing = true))
  }

  @Test
  fun `a new JS-started capture starts empty, never with a previous drive's state`() {
    assertEquals(DriveNotificationRules.Source.EMPTY, DriveNotificationRules.source(hasDisplay = false, restart = false, capturing = false))
  }

  @Test
  fun `a start while recording, before any update, keeps what shows`() {
    assertEquals(DriveNotificationRules.Source.CURRENT, DriveNotificationRules.source(hasDisplay = false, restart = false, capturing = true))
  }

  @Test
  fun `stale exactly 2 min after the last update, not before`() {
    val at = 1_000_000L
    assertEquals(DriveNotificationText.STALE_AFTER_MS, DriveNotificationRules.staleIn(at, at))
    assertEquals(1L, DriveNotificationRules.staleIn(at + DriveNotificationText.STALE_AFTER_MS - 1, at))
    assertEquals(0L, DriveNotificationRules.staleIn(at + DriveNotificationText.STALE_AFTER_MS, at))
    assertTrue(DriveNotificationRules.staleIn(at + 10 * DriveNotificationText.STALE_AFTER_MS, at) < 0)
  }

  @Test
  fun `a timer that fires just after a fresh update finds it not due and waits the full 2 min`() {
    val fresh = 5_000_000L
    // the timer armed for the previous update fires while the fresh one is a few ms old
    assertEquals(DriveNotificationText.STALE_AFTER_MS - 3, DriveNotificationRules.staleIn(fresh + 3, fresh))
  }
}
