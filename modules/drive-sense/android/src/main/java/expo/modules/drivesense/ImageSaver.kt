package expo.modules.drivesense

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.widget.Toast
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import java.io.IOException
import java.util.concurrent.Executors

/**
 * Save image from the share sheet (WP09, ruling 10; [ShareIntent]): the share image copied into
 * Pictures/RoadWise through MediaStore, the Android counterpart of iPhone's "Save Image" to Photos.
 * Android 10+ only: MediaStore takes a new image from its own app without any storage permission
 * there, and RoadWise asks for none. A short toast says it is saved, or that it could not be.
 *
 * The copy runs on one background thread of this object; the entry is written pending and made
 * visible only once complete, and a failed copy leaves no half-written image behind.
 */
internal object ImageSaver {
  private const val SAVED = "Image saved"
  private const val FAILED = "Couldn't save the image. Try again."

  /** Pictures/RoadWise, as the gallery and Files show it. */
  private val FOLDER = Environment.DIRECTORY_PICTURES + "/RoadWise"

  private val worker by lazy {
    Executors.newSingleThreadExecutor { r -> Thread(r, "DriveSenseImageSaver").apply { isDaemon = true } }
  }

  /** Saves the share image at `path` off the main thread, says how it went, then calls `finished`. */
  fun saveInBackground(context: Context, path: String, finished: () -> Unit) {
    val ctx = context.applicationContext
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      finished()
      return
    }
    try {
      worker.execute {
        val ok = try {
          save(ctx, path)
        } catch (_: Exception) {
          false
        }
        tell(ctx, if (ok) SAVED else FAILED)
        finished()
      }
    } catch (_: Exception) {
      finished()
    }
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun save(ctx: Context, path: String): Boolean {
    val file = ShareIntent.shareableImage(ctx.cacheDir, path) ?: return false
    val mime = ShareIntent.mimeOf(file) ?: return false
    val resolver = ctx.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, "RoadWise-${System.currentTimeMillis()}.${file.extension.lowercase()}")
      put(MediaStore.Images.Media.MIME_TYPE, mime)
      put(MediaStore.Images.Media.RELATIVE_PATH, FOLDER)
      put(MediaStore.Images.Media.IS_PENDING, 1)
    }
    val item = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values) ?: return false
    return try {
      val out = resolver.openOutputStream(item) ?: throw IOException("no output stream")
      out.use { o -> file.inputStream().use { it.copyTo(o) } }
      resolver.update(item, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
      true
    } catch (_: Exception) {
      try {
        resolver.delete(item, null, null)
      } catch (_: Exception) {
        // the pending entry is MediaStore's to expire
      }
      false
    }
  }

  private fun tell(ctx: Context, text: String) {
    Handler(Looper.getMainLooper()).post {
      try {
        Toast.makeText(ctx, text, Toast.LENGTH_SHORT).show()
      } catch (_: Exception) {
        // no toast: the save itself stands
      }
    }
  }
}

/**
 * Android 14+: the share sheet's Save image action ([ShareIntent]). Unexported, reached only
 * through RoadWise's own explicit, immutable PendingIntent; it saves under goAsync.
 */
class SaveImageReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val path = intent.getStringExtra(ShareIntent.EXTRA_PATH) ?: return
    val pending = goAsync()
    ImageSaver.saveInBackground(context, path) { pending.finish() }
  }
}

/**
 * Android 10 to 13: the share sheet's Save image row ([ShareIntent]). Unexported (the chooser
 * starts it as RoadWise), translucent and gone at once: it hands the save to [ImageSaver].
 */
class SaveImageActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val path = if (savedInstanceState == null) intent?.getStringExtra(ShareIntent.EXTRA_PATH) else null
    if (path != null) ImageSaver.saveInBackground(this, path) {}
    finish()
  }
}

/** The content URIs a share image goes out as (`res/xml/drivesense_share_paths.xml`: the cache only). */
class ShareFileProvider : FileProvider()
