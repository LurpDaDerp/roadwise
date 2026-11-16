package expo.modules.drivesense

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.core.content.IntentCompat
import androidx.core.content.PackageManagerCompat
import androidx.core.content.UnusedAppRestrictionsConstants
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android's "Pause app activity if unused" for RoadWise (Android 11: "Remove permissions if app isn't
 * used"), ruling 15: a few months unopened, Android takes RoadWise's permissions back (and on 12 and
 * later stops its background work), so automatic drives would stop. Settings › Permissions lists it
 * as a tip (src/core/permissions/driveSensePort.ts reads it, `getUnusedAppRestrictions`).
 *
 * [read] answers the contract's `enabled` / `disabled` / `unavailable` from androidx.core's
 * `PackageManagerCompat.getUnusedAppRestrictionsStatus`, a ListenableFuture: on Android 11 and later
 * it is answered at once from the PackageManager; the backport below 11 binds Play's verifier
 * service and answers on the main thread when it connects. Its listener runs on whichever thread
 * completes it (nothing waits on `get`, which is only called once the future is done), and an
 * answer that has not come in [TIMEOUT_MS] is an `ERROR`, so the JS call always settles and no
 * thread is ever held. [open] shows the page with the switch: `IntentCompat
 * .createManageUnusedAppRestrictionsIntent` (Android 12+: the app's info page; Android 11: its
 * permissions page with "Remove permissions if app isn't used"); false where the phone has no such
 * page, and JS opens the app's settings page instead.
 */
object UnusedAppRestrictions {
  const val TIMEOUT_MS = 5_000L

  /** Runs the listener on the thread that completed the future (it only reads a finished result). */
  private val direct = Executor { it.run() }

  /** The contract's answer for a status; null for `ERROR` (or anything unknown): the read failed. */
  fun wire(status: Int): String? = when (status) {
    UnusedAppRestrictionsConstants.API_30_BACKPORT,
    UnusedAppRestrictionsConstants.API_30,
    UnusedAppRestrictionsConstants.API_31 -> "enabled"
    UnusedAppRestrictionsConstants.DISABLED -> "disabled"
    UnusedAppRestrictionsConstants.FEATURE_NOT_AVAILABLE -> "unavailable"
    else -> null
  }

  /** Answers once: the wire value, or null when the phone could not answer (the JS call rejects). */
  fun read(context: Context, done: (String?) -> Unit) {
    val once = AtomicBoolean(false)
    val settle = { answer: String? -> if (once.compareAndSet(false, true)) done(answer) }
    val future = try {
      PackageManagerCompat.getUnusedAppRestrictionsStatus(context.applicationContext)
    } catch (_: Exception) {
      settle(null)
      return
    }
    Handler(Looper.getMainLooper()).postDelayed({ settle(null) }, TIMEOUT_MS)
    future.addListener({
      val status = try {
        future.get()
      } catch (_: Exception) {
        UnusedAppRestrictionsConstants.ERROR
      }
      settle(wire(status))
    }, direct)
  }

  /** Opens the page with the switch; false when the phone has none or it could not be started. */
  fun open(context: Context, activity: Activity?): Boolean =
    try {
      val intent = IntentCompat.createManageUnusedAppRestrictionsIntent(context, context.packageName)
      if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      (activity ?: context).startActivity(intent)
      true
    } catch (_: Exception) {
      // UnsupportedOperationException: no such feature on this phone; ActivityNotFoundException: an
      // OEM build without the page.
      false
    }
}
