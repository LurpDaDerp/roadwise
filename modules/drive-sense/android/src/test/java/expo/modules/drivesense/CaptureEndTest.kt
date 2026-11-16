package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * `stopCapture`'s end, as JS sends it (README §2; `captureEndArgs` in src/index.ts) and as iOS's
 * `CaptureEnd.of` reads it: "auto" is an "at" end with its cut, marked automatic.
 */
class CaptureEndTest {
  @Test
  fun `dropped keeps no driving end`() {
    assertEquals(CaptureEnd(null, true), CaptureEnd.of("dropped", 123.0, true))
    assertEquals(CaptureEnd(null, false), CaptureEnd.of("dropped", Double.NaN, false))
  }

  @Test
  fun `at carries the cut, not automatic`() {
    assertEquals(CaptureEnd(1_700_000_000_000L, false, automatic = false), CaptureEnd.of("at", 1_700_000_000_000.0, false))
  }

  @Test
  fun `auto carries the cut and is automatic`() {
    assertEquals(CaptureEnd(1_700_000_000_000L, true, automatic = true), CaptureEnd.of("auto", 1_700_000_000_000.0, true))
  }

  @Test
  fun `an at or auto end with no valid time is now`() {
    for (kind in listOf("at", "auto")) {
      assertNull(CaptureEnd.of(kind, -1.0, false))
      assertNull(CaptureEnd.of(kind, Double.NaN, false))
      assertNull(CaptureEnd.of(kind, Double.POSITIVE_INFINITY, false))
    }
  }

  @Test
  fun `now and any unknown kind are null`() {
    assertNull(CaptureEnd.of("now", 1_700_000_000_000.0, true))
    assertNull(CaptureEnd.of("later", 1_700_000_000_000.0, true))
  }
}
