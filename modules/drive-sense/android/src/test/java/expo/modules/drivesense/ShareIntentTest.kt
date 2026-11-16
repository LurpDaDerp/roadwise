package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Only an image inside RoadWise's own cache directory is ever shared or saved (ShareIntent.kt,
 * WP09): the path comes from JS and back from the save action's extras. Pure JVM.
 */
class ShareIntentTest {
  @get:Rule
  val tmp = TemporaryFolder()

  private fun cache(): File = tmp.newFolder("cache")

  @Test
  fun `a capture in the cache is shareable, as a file URI or a bare path`() {
    val dir = cache()
    val png = File(dir, "ReactNative-snapshot-image123.png").apply { writeText("x") }
    assertEquals(png.canonicalFile, ShareIntent.shareableImage(dir, png.absolutePath))
    assertEquals(png.canonicalFile, ShareIntent.shareableImage(dir, png.toURI().toString()))
    val jpg = File(File(dir, "sub").apply { mkdirs() }, "card.JPG").apply { writeText("x") }
    assertEquals(jpg.canonicalFile, ShareIntent.shareableImage(dir, jpg.absolutePath))
  }

  @Test
  fun `anything outside the cache, missing, a folder or not an image is refused`() {
    val dir = cache()
    val outside = tmp.newFile("outside.png").apply { writeText("x") }
    assertNull(ShareIntent.shareableImage(dir, outside.absolutePath))
    // `..` out of the cache resolves before the check
    assertNull(ShareIntent.shareableImage(dir, File(dir, "../outside.png").path))
    assertNull(ShareIntent.shareableImage(dir, File(dir, "missing.png").absolutePath))
    val folder = File(dir, "folder.png").apply { mkdirs() }
    assertNull(ShareIntent.shareableImage(dir, folder.absolutePath))
    val db = File(dir, "roadwise.db").apply { writeText("x") }
    assertNull(ShareIntent.shareableImage(dir, db.absolutePath))
    assertNull(ShareIntent.shareableImage(dir, "content://elsewhere/x.png"))
    assertNull(ShareIntent.shareableImage(dir, "relative/x.png"))
    assertNull(ShareIntent.shareableImage(dir, ""))
  }

  @Test
  fun `the type comes from the name`() {
    assertEquals("image/png", ShareIntent.mimeOf(File("a.PNG")))
    assertEquals("image/jpeg", ShareIntent.mimeOf(File("a.jpeg")))
    assertEquals("image/jpeg", ShareIntent.mimeOf(File("a.jpg")))
    assertNull(ShareIntent.mimeOf(File("a.pdf")))
    assertNull(ShareIntent.mimeOf(File("png")))
  }
}
