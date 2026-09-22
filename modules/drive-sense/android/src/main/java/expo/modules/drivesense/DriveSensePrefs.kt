package expo.modules.drivesense

import android.content.Context
import android.content.SharedPreferences

/**
 * The state drive-sense persists across processes: the armed flag (for [BootReceiver]), the
 * capture-open flag and the capture's parameters (for the `START_STICKY` restart and
 * `captureWasOpen`), the motion "requested once" flag, and the last native exit record
 * ([ExitInfoReader]). Every entry point — the module, both receivers, both services — calls
 * [init] first, so [captureWasOpenAtProcessStart] is read before anything in this process writes
 * the flag.
 */
object DriveSensePrefs {
  private const val FILE = "expo.modules.drivesense"
  private const val ARMED = "armed"
  private const val CAPTURE_OPEN = "captureOpen"
  private const val MODE = "mode"
  private const val RATE = "rate"
  private const val STARTED_AT = "captureStartedAt"
  private const val MOTION_REQUESTED = "motionRequested"
  private const val EXIT_TS = "exitTs"
  private const val EXIT_REASON = "exitReason"
  private const val EXIT_WHILE_CAPTURING = "exitWhileCapturing"
  private const val FALLBACK_COUNT = "timebaseFallbacks"

  @Volatile
  private var prefs: SharedPreferences? = null

  /** The persisted capture-open flag as this process found it (README §2 `captureWasOpen`). */
  @Volatile
  var captureWasOpenAtProcessStart: Boolean = false
    private set

  fun init(context: Context): DriveSensePrefs {
    if (prefs == null) {
      synchronized(this) {
        if (prefs == null) {
          val p = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
          captureWasOpenAtProcessStart = p.getBoolean(CAPTURE_OPEN, false)
          prefs = p
        }
      }
    }
    return this
  }

  private val p: SharedPreferences
    get() = checkNotNull(prefs) { "DriveSensePrefs.init was not called" }

  var armed: Boolean
    get() = p.getBoolean(ARMED, false)
    set(v) = p.edit().putBoolean(ARMED, v).apply()

  var captureOpen: Boolean
    get() = p.getBoolean(CAPTURE_OPEN, false)
    // commit, not apply: a process killed right after startCapture must still find the flag.
    set(v) {
      p.edit().putBoolean(CAPTURE_OPEN, v).commit()
    }

  var mode: String
    get() = p.getString(MODE, "auto") ?: "auto"
    set(v) = p.edit().putString(MODE, v).apply()

  var rate: String
    get() = p.getString(RATE, "full") ?: "full"
    set(v) = p.edit().putString(RATE, v).apply()

  var captureStartedAt: Long
    get() = p.getLong(STARTED_AT, 0L)
    set(v) = p.edit().putLong(STARTED_AT, v).apply()

  var motionRequested: Boolean
    get() = p.getBoolean(MOTION_REQUESTED, false)
    set(v) = p.edit().putBoolean(MOTION_REQUESTED, v).apply()

  /** Converted timestamps that fell back to their arrival time (README §7), for diagnostics. */
  fun addTimebaseFallbacks(n: Int) {
    if (n > 0) p.edit().putLong(FALLBACK_COUNT, p.getLong(FALLBACK_COUNT, 0L) + n).apply()
  }

  data class ExitRecord(val ts: Long, val reason: String, val whileCapturing: Boolean)

  /** Record a native stop (`watchdog`) or a refused foreground-service start (`other`). */
  fun recordExit(reason: String, whileCapturing: Boolean) {
    p.edit()
      .putLong(EXIT_TS, System.currentTimeMillis())
      .putString(EXIT_REASON, reason)
      .putBoolean(EXIT_WHILE_CAPTURING, whileCapturing)
      .commit()
  }

  val lastExit: ExitRecord?
    get() {
      val reason = p.getString(EXIT_REASON, null) ?: return null
      return ExitRecord(p.getLong(EXIT_TS, 0L), reason, p.getBoolean(EXIT_WHILE_CAPTURING, false))
    }
}
