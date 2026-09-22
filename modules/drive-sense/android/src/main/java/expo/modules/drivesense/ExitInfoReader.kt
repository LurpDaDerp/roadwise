package expo.modules.drivesense

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build

/**
 * `getLastExitInfo()` (README §2): the more recent of the platform's last process exit
 * (`ActivityManager.getHistoricalProcessExitReasons(pkg, 0, 1)`, API 30+) and the record drive-sense
 * persisted itself (a watchdog stop, or a refused foreground-service start). Lets JS recover a trip
 * whose process was killed or whose notification was swiped away.
 */
object ExitInfoReader {
  /** The platform's reason → the contract's (README §2). */
  fun mapReason(reason: Int): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "unknown"
    return when (reason) {
      ApplicationExitInfo.REASON_USER_REQUESTED, ApplicationExitInfo.REASON_USER_STOPPED -> "user_stopped"
      ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
      ApplicationExitInfo.REASON_CRASH, ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash"
      ApplicationExitInfo.REASON_ANR -> "anr"
      ApplicationExitInfo.REASON_UNKNOWN -> "unknown"
      else -> "other"
    }
  }

  fun read(context: Context): Map<String, Any>? {
    val prefs = DriveSensePrefs.init(context)
    var best: DriveSensePrefs.ExitRecord? = prefs.lastExit
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      try {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager?
        val info = am?.getHistoricalProcessExitReasons(context.packageName, 0, 1)?.firstOrNull()
        if (info != null && info.timestamp > 0 && (best == null || info.timestamp > best.ts)) {
          // The last exit of any process of this package is the previous process's end, so the
          // capture-open flag this process found at start is the flag at that time.
          best = DriveSensePrefs.ExitRecord(
            info.timestamp,
            mapReason(info.reason),
            DriveSensePrefs.captureWasOpenAtProcessStart
          )
        }
      } catch (_: Exception) {
        // unavailable on this device: fall back to our own record
      }
    }
    val b = best ?: return null
    return linkedMapOf("ts" to b.ts, "reason" to b.reason, "whileCapturing" to b.whileCapturing)
  }
}
