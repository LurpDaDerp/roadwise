package expo.modules.drivesense

import android.app.Activity
import android.app.PendingIntent
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.LabeledIntent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.chooser.ChooserAction
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import java.io.File
import java.net.URI

/**
 * The system share sheet with a share image (WP09, ruling 10): a drive's share card or a Wrapped
 * card, with the Wrapped's line and link as text beside it. React Native's `Share` drops the image
 * on Android (it carries text only) and expo-sharing carries no text, so neither can hand over what
 * iPhone's sheet gets.
 *
 * - The image goes as a content URI of [ShareFileProvider] (`<cache-path>` only, never exported),
 *   in EXTRA_STREAM and in the intent's ClipData with a read grant, which the chooser passes on to
 *   the app picked. EXTRA_TEXT carries the text when there is one.
 * - **Save image** (Android 10+): a chooser custom action on Android 14+ (a broadcast to the
 *   unexported [SaveImageReceiver] through an explicit, immutable PendingIntent), an initial intent
 *   to the unexported [SaveImageActivity] on 10 to 13 (the chooser starts it as RoadWise). Either
 *   copies the image into Pictures/RoadWise through MediaStore ([ImageSaver]): no storage
 *   permission on 10+. Below 10 a save would need WRITE_EXTERNAL_STORAGE, which RoadWise never asks
 *   for, so the action is left out there.
 * - Only an image file inside RoadWise's own cache directory is ever shared or saved
 *   ([shareableImage]): the path comes from JS (and back from the PendingIntent's fixed extras), so
 *   it is checked every time.
 *
 * The chooser answers nothing about what was picked, and the app picked may still be reading the
 * file after RoadWise is back in front, so the file is not deleted here: JS sweeps share images
 * about 10 minutes old at launch and on each return to the front (`sweepStaleShareImages`).
 */
internal object ShareIntent {
  /** [ShareFileProvider]'s authority after the package name (the manifest's `${applicationId}.drivesense.share`). */
  private const val AUTHORITY_SUFFIX = ".drivesense.share"

  /** The image's absolute path, on the save action's intent. */
  const val EXTRA_PATH = "expo.modules.drivesense.SHARE_IMAGE_PATH"

  /** The save action's name in the share sheet. */
  const val SAVE_LABEL = "Save image"

  /** One PendingIntent for the save action: the latest share's extras replace an older one's. */
  private const val REQUEST_SAVE = 0x5A7E

  /** Whether the sheet offers Save image on this phone (Android 10+, MediaStore without a permission). */
  val saveOffered: Boolean
    get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

  /**
   * Opens the share sheet for the image at `uriOrPath` (a `file://` URI or a bare path), with
   * `text` beside it when given and `title` over the sheet. False when the file is not a share
   * image in RoadWise's cache or the sheet could not open. Main thread (it starts an activity).
   */
  fun shareImage(activity: Activity, uriOrPath: String, text: String?, title: String?): Boolean {
    val ctx = activity.applicationContext
    val file = shareableImage(ctx.cacheDir, uriOrPath) ?: return false
    val mime = mimeOf(file) ?: return false
    val uri = FileProvider.getUriForFile(ctx, ctx.packageName + AUTHORITY_SUFFIX, file)
    val send = Intent(Intent.ACTION_SEND).apply {
      type = mime
      putExtra(Intent.EXTRA_STREAM, uri)
      if (!text.isNullOrBlank()) putExtra(Intent.EXTRA_TEXT, text)
      // The ClipData carries the grant (and the sheet's preview); createChooser moves both onto the chooser.
      clipData = ClipData.newUri(ctx.contentResolver, "RoadWise", uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(send, title?.takeIf { it.isNotBlank() })
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      chooser.putExtra(Intent.EXTRA_CHOOSER_CUSTOM_ACTIONS, arrayOf(saveAction(ctx, file)))
    } else if (saveOffered) {
      chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(saveIntent(ctx, file)))
    }
    activity.startActivity(chooser)
    return true
  }

  /** Android 14+: Save image as a chooser action, a broadcast to the unexported receiver. */
  @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  private fun saveAction(ctx: Context, file: File): ChooserAction {
    val intent = Intent(ctx, SaveImageReceiver::class.java)
      .setPackage(ctx.packageName)
      .putExtra(EXTRA_PATH, file.absolutePath)
    // Explicit and immutable: nobody can retarget it or change the path it carries.
    val pending = PendingIntent.getBroadcast(ctx, REQUEST_SAVE, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return ChooserAction.Builder(Icon.createWithResource(ctx, R.drawable.drivesense_save_image), SAVE_LABEL, pending).build()
  }

  /** Android 10 to 13: Save image as the sheet's first row, an explicit intent to the unexported activity. */
  private fun saveIntent(ctx: Context, file: File): Intent {
    val intent = Intent(ctx, SaveImageActivity::class.java).putExtra(EXTRA_PATH, file.absolutePath)
    return LabeledIntent(intent, ctx.packageName, SAVE_LABEL, R.drawable.drivesense_save_image)
  }

  /**
   * The file at `uriOrPath` when it is an image (`.png`, `.jpg`, `.jpeg`) directly or deeper inside
   * `cacheDir`, after resolving `..` and links; null for anything else. Pure (ShareIntentTest).
   */
  fun shareableImage(cacheDir: File, uriOrPath: String): File? = try {
    val given = when {
      uriOrPath.startsWith("file:") -> File(URI(uriOrPath))
      File(uriOrPath).isAbsolute -> File(uriOrPath)
      else -> null
    }
    val file = given?.canonicalFile
    val root = cacheDir.canonicalFile.path + File.separator
    if (file == null || !file.path.startsWith(root) || mimeOf(file) == null || !file.isFile) null else file
  } catch (_: Exception) {
    null
  }

  /** The image type a share image's name says; null for anything that is not one. */
  fun mimeOf(file: File): String? = when (file.extension.lowercase()) {
    "png" -> "image/png"
    "jpg", "jpeg" -> "image/jpeg"
    else -> null
  }
}
