package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android time base across a wall-clock step (review N2N3 I2; README §7 "Time base"). Pure JVM:
 * nothing here touches `SystemClock` — every instant is passed in on the boot clock.
 */
class TimeBaseTest {
  // The capture starts: wall 1_700_000_000_000, boot clock 50 000 ms.
  private val anchor = ClockAnchor(epochMs = 1_700_000_000_000.0, clockMs = 50_000.0)

  /** What the old code used as arrival: the wall clock, stepped forward by an hour mid-drive. */
  private fun steppedWallClock(clockMs: Double): Double = anchor.epochMs + (clockMs - anchor.clockMs) + 3_600_000.0

  @Test
  fun `a wall-clock step cannot trip the fallback when arrival is on the anchored boot clock`() {
    // a sensor sample stamped at boot 60 000 ms, delivered in a batch 900 ms later
    val stampMs = 60_000.0
    val arrival = TimeBase.anchoredNow(anchor, stampMs + 900.0)
    val c = TimeBase.toEpochMs(stampMs, anchor, arrival)
    assertFalse(c.fellBack)
    assertEquals(1_700_000_010_000.0, c.t, 0.0)

    // the same sample against the stepped wall clock: the old behaviour, pushed an hour off
    val old = TimeBase.toEpochMs(stampMs, anchor, steppedWallClock(stampMs + 900.0))
    assertTrue(old.fellBack)
    assertEquals(1_700_000_010_900.0 + 3_600_000.0, old.t, 0.0)
  }

  @Test
  fun `after the step the sample and the fix still land in their row's window`() {
    // Row ts comes from the same anchored boot clock (CaptureService.nowEpochMs).
    val ts = Math.round(TimeBase.anchoredNow(anchor, 61_000.0))
    val prevTs = Math.round(TimeBase.anchoredNow(anchor, 60_000.0))
    val start = TimeBase.windowStart(prevTs, ts)
    val sampleT = TimeBase.toEpochMs(60_500.0, anchor, TimeBase.anchoredNow(anchor, 61_300.0)).t
    val fix = FixSample(
      t = TimeBase.toEpochMs(60_800.0, anchor, TimeBase.anchoredNow(anchor, 61_200.0)).t,
      lat = 47.6, lng = -122.3, hAcc = 5.0, speed = 10.0, speedAcc = 0.5, course = 90.0, alt = 10.0
    )
    val w = TimeBase.takeWindow(listOf(sampleT), start, ts) { it }
    assertEquals(listOf(sampleT), w.inWindow)
    assertEquals(0, w.dropped)
    assertEquals(fix, TimeBase.pickFix(listOf(fix), start, ts))
  }

  @Test
  fun `a sensor stamping on another clock still falls back to its arrival`() {
    // stamps on uptime instead of elapsedRealtime: 20 000 ms behind
    val arrival = TimeBase.anchoredNow(anchor, 60_900.0)
    val c = TimeBase.toEpochMs(40_000.0, anchor, arrival)
    assertTrue(c.fellBack)
    assertEquals(arrival, c.t, 0.0)
  }

  @Test
  fun `windows follow the previous ts, except after a gap over MAX_ROW_GAP_MS`() {
    assertEquals(1_000L, TimeBase.windowStart(1_000L, 2_000L))
    assertEquals(4_000L, TimeBase.windowStart(1_000L, 5_000L))
    assertEquals(4_000L, TimeBase.windowStart(null, 5_000L))
    assertNull(TimeBase.pickFix(emptyList(), 0L, 1L))
  }
}
