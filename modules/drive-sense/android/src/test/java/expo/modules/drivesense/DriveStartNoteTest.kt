package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Test

/** When an automatic drive's start posts the "drive started" note. Pure JVM. */
class DriveStartNoteTest {
  @Test
  fun `an automatic drive with the switch on and RoadWise not showing posts it`() {
    assertEquals(true, DriveStartNote.due("auto", switchOff = false, appVisible = false))
  }

  @Test
  fun `a Start drive never posts it`() {
    for (off in listOf(true, false)) for (visible in listOf(true, false)) {
      assertEquals(false, DriveStartNote.due("manual", switchOff = off, appVisible = visible))
    }
  }

  @Test
  fun `the switch off or RoadWise showing keeps it down`() {
    assertEquals(false, DriveStartNote.due("auto", switchOff = true, appVisible = false))
    assertEquals(false, DriveStartNote.due("auto", switchOff = false, appVisible = true))
    assertEquals(false, DriveStartNote.due("auto", switchOff = true, appVisible = true))
  }

  @Test
  fun `the words match the iPhone's note`() {
    assertEquals("Recording your drive. Stay safe.", DriveStartNote.TITLE)
    assertEquals("Select to open your drive. Not driving? Open it to stop recording.", DriveStartNote.BODY)
  }
}
