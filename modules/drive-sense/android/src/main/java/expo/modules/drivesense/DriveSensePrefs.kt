package expo.modules.drivesense

import android.content.Context
import android.content.SharedPreferences

/**
 * The state drive-sense persists across processes: the capture-open flag and the capture's
 * parameters (for the `START_STICKY` restart and `captureWasOpen`), the motion "requested once"
 * flag, the last native exit record ([ExitInfoReader]), the forgot-to-start reminder's state
 * ([TripReminder]), the activity-transition request on file ([ActivityTransitions]) and the step
 * counter's baseline for the open capture ([PedometerSource]). Every entry
 * point — the module, the receivers, both services — calls [init] first, so
 * [captureWasOpenAtProcessStart] is read before anything in this process writes the flag.
 */
object DriveSensePrefs {
  private const val FILE = "expo.modules.drivesense"
  private const val CAPTURE_OPEN = "captureOpen"
  private const val MODE = "mode"
  private const val RATE = "rate"
  private const val STARTED_AT = "captureStartedAt"
  private const val MOTION_REQUESTED = "motionRequested"
  private const val EXIT_TS = "exitTs"
  private const val EXIT_REASON = "exitReason"
  private const val EXIT_WHILE_CAPTURING = "exitWhileCapturing"
  private const val FALLBACK_COUNT = "timebaseFallbacks"
  private const val UNPAIRED_COUNT = "imuUnpaired"
  private const val TRIP_REMINDER = "tripReminder"
  private const val TRANSITIONS_TIER = "transitionsTier"
  private const val TRANSITIONS_AT_NANOS = "transitionsAtNanos"
  private const val TRANSITIONS_BOOT = "transitionsBoot"
  private const val STEPS_CAPTURE = "stepsCaptureStartedAt"
  private const val STEPS_BASELINE = "stepsBaseline"
  private const val STEPS_AT_CLOCK = "stepsAtClockMs"
  private const val STEPS_BOOT = "stepsBoot"

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

  /** The forgot-to-start reminder's state as JSON ([TripReminderState]); null until it is first written. */
  var tripReminderJson: String?
    get() = p.getString(TRIP_REMINDER, null)
    // commit: the next broadcast may run in a new process.
    set(v) {
      p.edit().putString(TRIP_REMINDER, v).commit()
    }

  /** The activity-transition tier last requested from Play services, or null for none on file. */
  var transitionsTier: String?
    get() = p.getString(TRANSITIONS_TIER, null)
    set(v) {
      p.edit().putString(TRANSITIONS_TIER, v).commit()
    }

  /** The boot clock (elapsedRealtimeNanos) when that request was made; 0 for none. */
  var transitionsAtNanos: Long
    get() = p.getLong(TRANSITIONS_AT_NANOS, 0L)
    set(v) {
      p.edit().putLong(TRANSITIONS_AT_NANOS, v).commit()
    }

  /** The boot (Settings.Global.BOOT_COUNT) that request was made in; -1 for none or unknown. */
  var transitionsBoot: Int
    get() = p.getInt(TRANSITIONS_BOOT, -1)
    set(v) {
      p.edit().putInt(TRANSITIONS_BOOT, v).commit()
    }

  /** Converted timestamps that fell back to their arrival time (README §7), for diagnostics. */
  fun addTimebaseFallbacks(n: Int) {
    if (n > 0) p.edit().putLong(FALLBACK_COUNT, p.getLong(FALLBACK_COUNT, 0L) + n).apply()
  }

  /** Accelerometer samples that found no gyroscope partner (review N2N3 I3), for diagnostics. */
  fun addImuUnpaired(n: Int) {
    if (n > 0) p.edit().putLong(UNPAIRED_COUNT, p.getLong(UNPAIRED_COUNT, 0L) + n).apply()
  }

  /**
   * The step counter's baseline for a capture ([PedometerSource]): the capture it is for (its
   * `captureStartedAt`), the counter total it counts from, and when it was taken (the boot clock, ms,
   * and the boot number, -1 unknown), so a capture the system restarts goes on counting from it.
   */
  data class StepBaseline(val captureStartedAt: Long, val baseline: Long, val atClockMs: Long, val boot: Int)

  var stepBaseline: StepBaseline?
    get() {
      val baseline = p.getLong(STEPS_BASELINE, -1L)
      if (baseline < 0) return null
      return StepBaseline(p.getLong(STEPS_CAPTURE, 0L), baseline, p.getLong(STEPS_AT_CLOCK, 0L), p.getInt(STEPS_BOOT, -1))
    }
    set(v) {
      val e = p.edit()
      if (v == null) {
        e.remove(STEPS_CAPTURE).remove(STEPS_BASELINE).remove(STEPS_AT_CLOCK).remove(STEPS_BOOT)
      } else {
        e.putLong(STEPS_CAPTURE, v.captureStartedAt).putLong(STEPS_BASELINE, v.baseline).putLong(STEPS_AT_CLOCK, v.atClockMs).putInt(STEPS_BOOT, v.boot)
      }
      e.apply()
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
