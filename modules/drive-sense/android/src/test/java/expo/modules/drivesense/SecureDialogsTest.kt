package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bookkeeping that keeps FLAG_SECURE on React Native's Modal dialogs while the DashPal aiming
 * picture shows (SecureDialogs), on stand-in windows. Pure JVM.
 */
class SecureDialogsTest {
  private class Win(val name: String)

  /** The stand-in windows stay reachable for the whole test: SecureDialogs keeps them weakly. */
  private val kept = mutableListOf<Win>()

  private fun win(name: String): Win = Win(name).also { kept.add(it) }

  private val log = mutableListOf<String>()
  private val dialogs = SecureDialogs<Win>(secure = { log.add("secure:${it.name}") }, clear = { log.add("clear:${it.name}") })

  @Test
  fun `with nothing held a dialog opens as it is`() {
    val sheet = win("sheet")
    dialogs.opened(sheet)
    dialogs.closed(sheet)
    assertFalse(dialogs.isSecure)
    assertEquals(emptyList<String>(), log)
  }

  @Test
  fun `the first hold secures the dialog already on screen, the setup sheet opened steps before the picture`() {
    val sheet = win("sheet")
    dialogs.opened(sheet)
    dialogs.hold("dashpal-aim-1")
    assertTrue(dialogs.isSecure)
    assertEquals(listOf("secure:sheet"), log)
  }

  @Test
  fun `a dialog opened while the picture is held is secured at once, as the re-aim sheet is`() {
    dialogs.hold("dashpal-reaim-1")
    val sheet = win("sheet")
    dialogs.opened(sheet)
    dialogs.opened(sheet)
    assertEquals(listOf("secure:sheet"), log)
  }

  @Test
  fun `the last hold let go clears the flag from every dialog on screen, not before`() {
    val a = win("a")
    val b = win("b")
    dialogs.opened(a)
    dialogs.opened(b)
    dialogs.hold("dashpal-aim-1")
    dialogs.hold("dashpal-aim-2")
    log.clear()
    dialogs.release("dashpal-aim-1")
    assertTrue(dialogs.isSecure)
    assertEquals(emptyList<String>(), log)
    dialogs.release("dashpal-aim-2")
    assertFalse(dialogs.isSecure)
    assertEquals(listOf("clear:a", "clear:b"), log.sorted())
  }

  @Test
  fun `a late release of a key not held, or one let go already, changes nothing`() {
    val sheet = win("sheet")
    dialogs.opened(sheet)
    dialogs.release("dashpal-aim-1")
    assertEquals(emptyList<String>(), log)
    dialogs.hold("dashpal-aim-2")
    dialogs.release("dashpal-aim-1")
    assertTrue(dialogs.isSecure)
    assertEquals(listOf("secure:sheet"), log)
  }

  @Test
  fun `a key held twice is one hold`() {
    val sheet = win("sheet")
    dialogs.opened(sheet)
    dialogs.hold("dashpal-aim-1")
    dialogs.hold("dashpal-aim-1")
    dialogs.release("dashpal-aim-1")
    assertFalse(dialogs.isSecure)
    assertEquals(listOf("secure:sheet", "clear:sheet"), log)
  }

  @Test
  fun `a dialog that left the screen is never touched again`() {
    val sheet = win("sheet")
    dialogs.opened(sheet)
    dialogs.closed(sheet)
    dialogs.hold("dashpal-aim-1")
    dialogs.release("dashpal-aim-1")
    assertEquals(emptyList<String>(), log)
  }
}
