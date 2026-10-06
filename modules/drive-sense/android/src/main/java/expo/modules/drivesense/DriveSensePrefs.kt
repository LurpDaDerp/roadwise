package expo.modules.drivesense

import android.content.Context
import android.content.SharedPreferences

/**
 * The state drive-sense persists across processes: the capture-open flag and the capture's
 * parameters (for the `START_STICKY` restart and `captureWasOpen`), the motion "requested once"
 * flag, the forgot-to-start reminder's setting and bookkeeping ([ForgotToStartReminder]), and the
 * last native exit record ([ExitInfoReader]). Every entry point — the module, the receiver, both
 * services — calls [init] first, so [captureWasOpenAtProcessStart] is read before anything in this
 * process writes the flag.
 */
object DriveSensePrefs {
  private const val FILE = "expo.modules.drivesense"
  private const val CAPTURE_OPEN = "captureOpen"
  private const val MODE = "mode"
  private const val RATE = "rate"
  private const val STARTED_AT = "captureStartedAt"
  private const val MOTION_REQUESTED = "motionRequested"
  private const val REMINDER_ENABLED = "reminderEnabled"
  private const val VEHICLE_ENTERED_AT = "vehicleEnteredAt"
  private const val CAPTURE_RAN_IN_VEHICLE = "captureRanInVehicle"
  private const val LAST_REMINDER_AT = "lastReminderAt"
  private const val EXIT_TS = "exitTs"
  private const val EXIT_REASON = "exitReason"
  private const val EXIT_WHILE_CAPTURING = "exitWhileCapturing"
  private const val FALLBACK_COUNT = "timebaseFallbacks"
  private const val UNPAIRED_COUNT = "imuUnpaired"

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

  var captureOpen: Boolean
    get() = p.getBoolean(CAPTURE_OPEN, false)
    // commit, not apply: a process killed right after startCapture must still find the flag.
    set(v) {
      p.edit().putBoolean(CAPTURE_OPEN, v).commit()
    }

  var mode: String
    get() = p.getString(MODE, "mounted") ?: "mounted"
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

  // ——— forgot-to-start reminder ———

  var reminderEnabled: Boolean
    get() = p.getBoolean(REMINDER_ENABLED, false)
    set(v) = p.edit().putBoolean(REMINDER_ENABLED, v).apply()

  /** Epoch ms of the open IN_VEHICLE period's ENTER; 0 when not in a vehicle. */
  var vehicleEnteredAt: Long
    get() = p.getLong(VEHICLE_ENTERED_AT, 0L)
    set(v) = p.edit().putLong(VEHICLE_ENTERED_AT, v).apply()

  var captureRanInVehicle: Boolean
    get() = p.getBoolean(CAPTURE_RAN_IN_VEHICLE, false)
    set(v) = p.edit().putBoolean(CAPTURE_RAN_IN_VEHICLE, v).apply()

  var lastReminderAt: Long
    get() = p.getLong(LAST_REMINDER_AT, 0L)
    set(v) = p.edit().putLong(LAST_REMINDER_AT, v).apply()

  /** Converted timestamps that fell back to their arrival time (README §7), for diagnostics. */
  fun addTimebaseFallbacks(n: Int) {
    if (n > 0) p.edit().putLong(FALLBACK_COUNT, p.getLong(FALLBACK_COUNT, 0L) + n).apply()
  }

  /** Accelerometer samples that found no gyroscope partner (review N2N3 I3), for diagnostics. */
  fun addImuUnpaired(n: Int) {
    if (n > 0) p.edit().putLong(UNPAIRED_COUNT, p.getLong(UNPAIRED_COUNT, 0L) + n).apply()
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
