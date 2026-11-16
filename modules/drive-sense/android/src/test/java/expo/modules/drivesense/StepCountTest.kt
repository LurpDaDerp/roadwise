package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The step counter's arithmetic (PedometerSource, README §4 `steps`). Pure JVM: every total and
 * every clock reading is passed in.
 */
class StepCountTest {
  @Test
  fun `the first total is the baseline, and the steps grow from it`() {
    val c = StepCount(null)
    assertEquals(0, c.onTotal(12_345))
    assertEquals(12_345L, c.baseline)
    assertEquals(1, c.onTotal(12_346))
    assertEquals(21, c.onTotal(12_366))
    assertEquals(12_345L, c.baseline)
  }

  @Test
  fun `a total under the baseline (the counter started again) is a new baseline`() {
    val c = StepCount(500)
    assertEquals(20, c.onTotal(520))
    assertEquals(0, c.onTotal(3))
    assertEquals(3L, c.baseline)
    assertEquals(7, c.onTotal(10))
  }

  @Test
  fun `a resumed capture counts on from the baseline it took`() {
    val c = StepCount(1_000)
    assertEquals(250, c.onTotal(1_250))
  }

  @Test
  fun `the saved baseline resumes only for the same capture, in the same boot`() {
    val saved = DriveSensePrefs.StepBaseline(captureStartedAt = 1_700_000_000_000, baseline = 900, atClockMs = 60_000, boot = 7)
    assertEquals(900L, StepCount.resumable(saved, 1_700_000_000_000, 120_000, 7))
    // the phone gives no boot number: the boot clock alone says it is this boot
    assertEquals(900L, StepCount.resumable(saved, 1_700_000_000_000, 120_000, -1))
    // another capture
    assertNull(StepCount.resumable(saved, 1_700_000_100_000, 120_000, 7))
    // another boot (by its number, or a boot clock behind the stamp)
    assertNull(StepCount.resumable(saved, 1_700_000_000_000, 120_000, 8))
    assertNull(StepCount.resumable(saved, 1_700_000_000_000, 30_000, -1))
    // no stamp
    assertNull(StepCount.resumable(saved.copy(atClockMs = 0), 1_700_000_000_000, 120_000, 7))
  }
}
