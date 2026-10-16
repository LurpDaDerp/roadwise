package expo.modules.drivesense

import android.content.Context
import android.os.PowerManager

/**
 * `holdAwake(ms)` (README §2): keeps the CPU up while a DashPal alert is answered and played with
 * the screen off. One partial wake lock, not reference counted, so each call only re-arms its
 * timeout ([ms] clamped to 1-10 s) and it always lapses by itself: nothing ever has to release it.
 * Independent of the DashPal link service and of the capture's own wake lock.
 */
object AlertWakeLock {
  const val TAG = "RoadWise:DashPalAlert"
  const val MIN_MS = 1_000
  const val MAX_MS = 10_000

  private val lock = Any()
  private var wakeLock: PowerManager.WakeLock? = null

  /** True when the wake lock is held for the next [ms] (clamped); false on any failure. */
  fun hold(context: Context, ms: Int): Boolean {
    return try {
      synchronized(lock) {
        val wl = wakeLock ?: run {
          val pm = context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager? ?: return false
          pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG).also {
            it.setReferenceCounted(false)
            wakeLock = it
          }
        }
        wl.acquire(ms.coerceIn(MIN_MS, MAX_MS).toLong())
        true
      }
    } catch (_: Exception) {
      false
    }
  }
}
