package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
  fun `a capture already in the cache stays where it is`() {
    val dir = cache()
    val ext = tmp.newFolder("external")
    val png = File(dir, "ReactNative-snapshot-image1.png").apply { writeText("card") }
    assertEquals(png.canonicalFile, ShareIntent.intoCache(dir, ext, png.toURI().toString()))
    assertTrue(png.exists())
  }

  @Test
  fun `a capture view-shot put in the external cache moves into the cache under its name`() {
    val dir = cache()
    val ext = tmp.newFolder("external")
    val png = File(ext, "ReactNative-snapshot-image2.png").apply { writeText("card") }
    val moved = ShareIntent.intoCache(dir, ext, png.toURI().toString())
    assertEquals(File(dir, "ReactNative-snapshot-image2.png").canonicalFile, moved)
    assertEquals("card", moved!!.readText())
    assertFalse(png.exists())
  }

  @Test
  fun `a name already taken in the cache gets a fresh capture name, and the other file is left alone`() {
    val dir = cache()
    val ext = tmp.newFolder("external")
    val taken = File(dir, "ReactNative-snapshot-image3.png").apply { writeText("older") }
    val png = File(ext, "ReactNative-snapshot-image3.png").apply { writeText("card") }
    val moved = ShareIntent.intoCache(dir, ext, png.absolutePath)!!
    assertNotEquals(taken.canonicalFile, moved)
    assertEquals(dir.canonicalFile, moved.parentFile)
    assertTrue(moved.name.startsWith("ReactNative-snapshot-image") && moved.name.endsWith(".png"))
    assertEquals("card", moved.readText())
    assertEquals("older", taken.readText())
    assertFalse(png.exists())
  }

  @Test
  fun `nothing outside both caches, no external cache, or not an image is moved`() {
    val dir = cache()
    val ext = tmp.newFolder("external")
    val outside = tmp.newFile("outside.png").apply { writeText("x") }
    assertNull(ShareIntent.intoCache(dir, ext, outside.absolutePath))
    assertTrue(outside.exists())
    val inExt = File(ext, "ReactNative-snapshot-image4.png").apply { writeText("x") }
    assertNull(ShareIntent.intoCache(dir, null, inExt.absolutePath))
    assertTrue(inExt.exists())
    val db = File(ext, "data.db").apply { writeText("x") }
    assertNull(ShareIntent.intoCache(dir, ext, db.absolutePath))
    assertTrue(db.exists())
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
