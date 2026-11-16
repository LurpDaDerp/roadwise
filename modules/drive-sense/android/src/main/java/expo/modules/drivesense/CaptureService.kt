package expo.modules.drivesense

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import expo.modules.drivesense.detect.DriveDetector
import expo.modules.drivesense.detect.onRow

/**
 * The location foreground service that records a drive (design §2.4, README §2, §6, §7).
 *
 * While it captures at `full` rate: 1 Hz fused location, 25 Hz accelerometer + gyroscope batched
 * in the sensor hub, and one [FeatureRow] per second computed natively by [FeatureExtractor] and
 * emitted as `row` — raw samples never cross the bridge. At `low` rate (rev1: I5): 10 s balanced
 * location, no IMU, a row per fix. Nothing of this runs unless a capture is open: idle
 * costs nothing (design §3.5).
 *
 * Two owners. A plain capture starts from JS (`startCapture`, a user's tap in the foreground —
 * plan §1 decision 4; tests, dev tools and the Start fallback) and as a `START_STICKY` restart with
 * a null intent after the process was killed mid-capture (rev1: I2), which resumes the capture the
 * user had started from the persisted state and starts the headless JS task again. That restart
 * must be claimed by JS within 60 s and a JS `row` listener must exist, or [Watchdog] stops it; its
 * rows go straight to JS. A detector capture is the drive detector's ([DriveDetector]: the Start
 * card's drive, and a drive resumed in a new process): its rows go to the detector, which journals
 * them and hands them to JS with their `seq`; no watchdog (the detector's safety stop and 12 h cap
 * bound it), and its end keeps RoadWise running 25 s more for JS to store the drive. It starts only
 * from RoadWise in front, a process start or the sticky restart, and a refusal never loses the
 * drive (the detector leaves it for its resume or orphan rule).
 *
 * Threading: all capture state lives on one [HandlerThread]; the companion's `@Volatile` fields are
 * the read-only view the module's `getState` uses.
 */
class CaptureService : Service() {
  companion object {
    const val ACTION_START_JS = "expo.modules.drivesense.START_JS"
    /** The drive detector's capture (its drive's start or resume). */
    const val ACTION_DETECT = "expo.modules.drivesense.DETECT"
    private const val EXTRA_STARTED_AT = "startedAt"
    private const val EXTRA_RESTART = "restart"
    const val ACTION_END_DRIVE = "expo.modules.drivesense.END_DRIVE"
    const val EXTRA_MODE = "mode"

    /**
     * When a row closes (README §7, both platforms; review N2N3 I1): an IMU sample stamped after ts
     * has arrived (or no IMU), AND a fix stamped after ts has arrived or FIX_SETTLE_MS has passed —
     * capped at ROW_MAX_WAIT_MS after ts. The same constants as ios/RowPipeline.swift.
     */
    const val FIX_SETTLE_MS = 300L
    const val ROW_MAX_WAIT_MS = 1_500L

    /**
     * After a drive ends, the headless JS task gets this long to finalize and upload before native
     * stops its service (and so its wake lock) itself (review N2N3 I4). Timed on the main looper,
     * which runs while that wake lock holds the CPU awake.
     */
    const val HEADLESS_GRACE_MS = 2 * 60_000L
    private const val TICK_MS = 1_000L
    private const val MINUTE_MS = 60_000L
    private const val START_RESULT_TIMEOUT_MS = 10_000L

    /** Safety net on the capture wake lock: renewed every minute while capturing at full rate. */
    private const val WAKE_LOCK_TIMEOUT_MS = 5 * 60_000L

    /** Ten seconds of 25 Hz samples, and of 1 Hz fixes, is the most that ever waits for a row. */
    private const val MAX_IMU_BUFFERED = 250
    private const val MAX_FIXES_BUFFERED = 30

    @Volatile
    var instance: CaptureService? = null
      private set

    @Volatile
    var isCapturing = false
      private set

    @Volatile
    var currentRate: String? = null
      private set

    @Volatile
    var currentMode: String? = null
      private set

    @Volatile
    var captureStartedAt: Long? = null
      private set

    @Volatile
    var lastRowTs: Long? = null
      private set

    /** The capture running is the drive detector's (its rows go to the detector, no watchdog). */
    @Volatile
    var detectorCapture = false
      private set

    /** A plain capture runs (a JS `startCapture`): the detector's Start card answers busy. */
    fun plainCapturing(): Boolean = isCapturing && !detectorCapture

    private val main = Handler(Looper.getMainLooper())

    /** The pending post-drive stop of the headless task (review N2N3 I4); cancelled by a new capture. */
    private var headlessStop: Runnable? = null

    private fun cancelHeadlessStop() {
      headlessStop?.let { main.removeCallbacks(it) }
      headlessStop = null
    }

    /** Stop the headless JS service after [delayMs] — its onDestroy releases the headless wake lock. */
    private fun scheduleHeadlessStop(context: Context, delayMs: Long) {
      val app = context.applicationContext
      main.post {
        cancelHeadlessStop()
        val r = Runnable {
          headlessStop = null
          if (isCapturing) return@Runnable // a new drive started meanwhile
          try {
            app.stopService(Intent(app, DriveSenseHeadlessService::class.java))
          } catch (_: Exception) {
            // not running
          }
        }
        headlessStop = r
        main.postDelayed(r, delayMs)
      }
    }

    /** One JS startCapture waiting for the service's foreground result. */
    private class PendingStart(val onResult: (String?) -> Unit)

    private val pendingStarts = ArrayList<PendingStart>()

    /** The detector's starts waiting for the service's foreground result (never a JS start's). */
    private val pendingDetect = ArrayList<PendingStart>()

    private fun resolveDetect(code: String?) {
      val waiting = synchronized(pendingDetect) { pendingDetect.toList().also { pendingDetect.clear() } }
      for (p in waiting) p.onResult(code)
    }

    private fun resolveDetectOne(p: PendingStart, code: String?) {
      val waiting = synchronized(pendingDetect) { pendingDetect.remove(p) }
      if (waiting) p.onResult(code)
    }

    /**
     * The drive detector's capture, from [startedAt] (the drive's start: its step count and its
     * notification's kept state are keyed on it). [restart]: a drive resumed in a new process (its
     * notification shows the kept state; with no RoadWise screen open the headless JS host starts).
     * [onResult] gets null once the service is in the foreground and sensing, else `E_PERMISSION`
     * (Android 14+: no location permission for a location service started behind) or
     * `E_FGS_REFUSED` (Android 12+: not allowed to start a foreground service behind). A service
     * already in the foreground (the sticky restart's) takes it directly: no new start to refuse.
     */
    fun startDetector(context: Context, startedAt: Long, mode: String, restart: Boolean, onResult: (String?) -> Unit) {
      val inst = instance
      if (inst != null && inst.inForeground) {
        inst.handler.post { inst.beginDetector(startedAt, mode, restart) }
        onResult(null)
        return
      }
      val pending = PendingStart(onResult)
      synchronized(pendingDetect) { pendingDetect.add(pending) }
      val intent = Intent(context, CaptureService::class.java)
        .setAction(ACTION_DETECT)
        .putExtra(EXTRA_MODE, mode)
        .putExtra(EXTRA_STARTED_AT, startedAt)
        .putExtra(EXTRA_RESTART, restart)
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (_: SecurityException) {
        resolveDetectOne(pending, "E_PERMISSION")
        return
      } catch (_: Exception) {
        // ForegroundServiceStartNotAllowedException (API 31+) and any other refusal.
        resolveDetectOne(pending, "E_FGS_REFUSED")
        return
      }
      main.postDelayed({ resolveDetectOne(pending, "E_FGS_REFUSED") }, START_RESULT_TIMEOUT_MS)
    }

    /**
     * The detector's drive ended (or was cancelled, or wiped): sensing stops at once and the
     * notification goes, then the service keeps RoadWise running [holdMs] more (its wake lock held)
     * so JS can store the drive and post its recap, as iOS's end task does. With no service running
     * only the capture-open flags go.
     */
    fun stopDetector(context: Context, holdMs: Long) {
      val inst = instance
      if (inst == null) {
        val prefs = DriveSensePrefs.init(context)
        if (prefs.detectorOwned) {
          prefs.detectorOwned = false
          prefs.captureOpen = false
        }
        return
      }
      inst.handler.post {
        if (isCapturing && detectorCapture) {
          inst.endDetector(holdMs)
        } else if (!isCapturing) {
          // Not sensing yet (a sticky restart in the foreground for a drive that ended as an orphan).
          inst.prefs.detectorOwned = false
          inst.prefs.captureOpen = false
          releaseIfIdle()
        }
      }
    }

    /**
     * A service the system restarted for a detector drive that turned out to need none: it stops.
     * Never one that captures, holds RoadWise after a drive, or has had no start delivered yet.
     */
    fun releaseIfIdle() {
      val inst = instance ?: return
      main.post { if (!isCapturing && !inst.holding && inst.lastStartId > 0) inst.stopIdle() }
    }

    /** The service runs in the foreground in this process (a detector start then needs no new start). */
    fun foregroundRunning(): Boolean = instance?.inForeground == true

    private fun resolveStarts(code: String?) {
      val waiting = synchronized(pendingStarts) { pendingStarts.toList().also { pendingStarts.clear() } }
      for (p in waiting) p.onResult(code)
    }

    /** Resolve [p] alone, if it is still waiting (its own timeout; never a later call's). */
    private fun resolveStart(p: PendingStart, code: String?) {
      val waiting = synchronized(pendingStarts) { pendingStarts.remove(p) }
      if (waiting) p.onResult(code)
    }

    /**
     * `startCapture(mode)` from JS. [onResult] gets null once capture runs, else the contract code:
     * `E_PERMISSION` (the OS refused the location service for lack of permission) or
     * `E_FGS_REFUSED` (refused for another reason — background-start restrictions).
     */
    fun startFromJs(context: Context, mode: String, onResult: (String?) -> Unit) {
      val inst = instance
      if (inst != null && isCapturing) {
        inst.handler.post { inst.updateModeAndClaim(mode) }
        onResult(null)
        return
      }
      val pending = PendingStart(onResult)
      synchronized(pendingStarts) { pendingStarts.add(pending) }
      val intent = Intent(context, CaptureService::class.java).setAction(ACTION_START_JS).putExtra(EXTRA_MODE, mode)
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (_: SecurityException) {
        resolveStart(pending, "E_PERMISSION")
        return
      } catch (_: Exception) {
        // ForegroundServiceStartNotAllowedException (API 31+) and any other refusal.
        resolveStart(pending, "E_FGS_REFUSED")
        return
      }
      main.postDelayed({ resolveStart(pending, "E_FGS_REFUSED") }, START_RESULT_TIMEOUT_MS)
    }

    /** `stopCapture(end)`: idempotent; clears the capture-open flag even with no service running. */
    fun stopFromJs(context: Context, end: CaptureEnd?, done: () -> Unit) {
      val inst = instance
      if (inst == null) {
        DriveSensePrefs.init(context).captureOpen = false
        done()
        return
      }
      inst.handler.post {
        // A detector drive's end holds RoadWise 25 s for JS: JS's own stop afterwards never cuts it short.
        if (!isCapturing && inst.holding) {
          done()
          return@post
        }
        inst.endCapture(clearOpen = true, end = end)
        done()
      }
    }

    /** `setCaptureRate(rate)`: ignored while not capturing. */
    fun setRate(rate: String, done: () -> Unit) {
      val inst = instance
      if (inst == null || !isCapturing) {
        done()
        return
      }
      inst.handler.post {
        inst.applyRate(rate)
        done()
      }
    }

    /**
     * `setDriveDisplay(...)` (plan §6): what the capture's notification shows, posted by
     * [DriveNotificationController] (only when it changed; each update re-arms the 2-min stale timer).
     * Ignored while not capturing.
     */
    fun setDriveDisplay(display: DriveDisplay) {
      val inst = instance ?: return
      inst.handler.post {
        inst.display = display
        inst.refreshNotification()
      }
    }
  }

  private lateinit var thread: HandlerThread
  private lateinit var handler: Handler
  private lateinit var prefs: DriveSensePrefs
  private lateinit var watchdog: Watchdog
  private lateinit var phone: PhoneStateReceiver
  private var location: LocationSource? = null
  private var sensors: SensorSource? = null
  private var pedometer: PedometerSource? = null
  private var wakeLock: PowerManager.WakeLock? = null

  /** The service is in the foreground (main thread writes; any thread reads). */
  @Volatile
  private var inForeground = false

  /** The detector's drive ended and the service holds RoadWise a little longer (main thread writes). */
  @Volatile
  private var holding = false
  private val endHold = Runnable { finishHold() }

  // ——— capture state (capture thread only) ———
  private var anchor = ClockAnchor.now()
  private var extractState = FeatureExtractor.initialState()
  private val imu = ArrayList<ImuSample>()
  private val fixes = ArrayList<FixSample>()
  private val pendingTs = ArrayList<Long>()
  private var prevRowTs: Long? = null
  private var latestImuT = Double.NEGATIVE_INFINITY
  private var latestFixT = Double.NEGATIVE_INFINITY
  private var imuRunning = false
  private var nextTickAt = 0L
  private var droppedSamples = 0
  /** The last `setDriveDisplay` of this capture (null before any: "— mph · limit —"). */
  private var display: DriveDisplay? = null

  /** The latest start command delivered (main thread). */
  private var lastStartId = 0

  private val tick = Runnable { onTick() }
  private val closeLate = Runnable { closeReady() }
  private val minute = Runnable { onMinute() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    prefs = DriveSensePrefs.init(this)
    thread = HandlerThread("drive-sense-capture").also { it.start() }
    handler = Handler(thread.looper)
    phone = PhoneStateReceiver(applicationContext, handler)
    watchdog = Watchdog(handler) { onWatchdog() }
    EventBus.rowListenerChanged = { attached -> watchdog.onRowListener(attached) }
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    lastStartId = startId
    // A START_STICKY restart after the process died mid-capture (rev1: I2).
    if (intent == null) {
      // A detector drive: in the foreground first (Android may refuse that behind; the drive stays
      // journaled and the detector's next process start or foreground resumes or ends it), then the
      // detector decides from its journal: resume (it starts sensing here) or orphan (this stops).
      if (prefs.detectorOwned) {
        if (goForeground(restart = true) != null) {
          stopSelf(startId)
          return START_NOT_STICKY
        }
        DriveDetector.get(this).resumeAtLaunch()
        return START_STICKY
      }
      if (!prefs.captureOpen) {
        stopSelf(startId)
        return START_NOT_STICKY
      }
      if (goForeground(restart = true) != null) {
        prefs.recordExit("other", whileCapturing = true)
        stopSelf(startId)
        return START_NOT_STICKY
      }
      if (!isCapturing) {
        isCapturing = true
        val startedAt = prefs.captureStartedAt.takeIf { it > 0 } ?: System.currentTimeMillis()
        handler.post { beginCapture(prefs.mode, prefs.rate, startedAt, nativeStart = true) }
        startHeadless()
      }
      return START_STICKY
    }

    when (intent.action) {
      ACTION_START_JS -> {
        val mode = intent.getStringExtra(EXTRA_MODE) ?: "mounted"
        val refused = goForeground()
        if (refused != null) {
          resolveStarts(refused)
          if (!isCapturing) stopSelf(startId)
          return if (isCapturing) START_STICKY else START_NOT_STICKY
        }
        if (isCapturing) {
          handler.post { updateModeAndClaim(mode) }
        } else {
          isCapturing = true
          handler.post { beginCapture(mode, "full", System.currentTimeMillis(), nativeStart = false) }
        }
        resolveStarts(null)
      }
      ACTION_DETECT -> {
        val restart = intent.getBooleanExtra(EXTRA_RESTART, false)
        val refused = goForeground(restart = restart)
        if (refused != null) {
          resolveDetect(refused)
          if (!isCapturing) stopSelf(startId)
          return if (isCapturing) START_STICKY else START_NOT_STICKY
        }
        val startedAt = intent.getLongExtra(EXTRA_STARTED_AT, System.currentTimeMillis())
        val mode = intent.getStringExtra(EXTRA_MODE) ?: "mounted"
        handler.post { beginDetector(startedAt, mode, restart) }
        resolveDetect(null)
      }
      ACTION_END_DRIVE -> {
        if (!isCapturing) {
          stopSelf(startId)
          return START_NOT_STICKY
        }
        EventBus.emit("notificationAction", linkedMapOf("action" to "endDrive", "ts" to System.currentTimeMillis()))
      }
      else -> if (!isCapturing) {
        stopSelf(startId)
        return START_NOT_STICKY
      }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    // The system or a stopSelf ended the service. The capture-open flag is left as it is: if a
    // capture was open, the next process reports captureWasOpen and JS decides (rev1: I2); a
    // detector drive is resumed or ended from its journal.
    handler.post { stopSources() }
    main.removeCallbacks(endHold)
    releaseWakeLock()
    isCapturing = false
    detectorCapture = false
    inForeground = false
    holding = false
    // C12 round 1 (review-C12 m1): a capture that ends here (the system, a kill, a refused sticky restart)
    // never ran endCapture: its walking feed goes too.
    ActivityTransitions.sync(this)
    currentRate = null
    currentMode = null
    captureStartedAt = null
    EventBus.rowListenerChanged = null
    instance = null
    thread.quitSafely()
    super.onDestroy()
  }

  // ——— foreground ———

  /**
   * @return null when the service is in the foreground, else the contract code for the refusal. The
   * drive notification it posts shows the capture's newest display, or on a [restart] (the
   * `START_STICKY` one only) the one kept for it; a new capture's starts empty
   * (DriveNotificationController).
   */
  private fun goForeground(restart: Boolean = false): String? {
    val notification = DriveNotificationController.foreground(this, display, restart)
    return try {
      val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
      ServiceCompat.startForeground(this, NotificationFactory.NOTIFICATION_ID, notification, type)
      inForeground = true
      null
    } catch (_: SecurityException) {
      // Android 14+: a location service needs location permission.
      "E_PERMISSION"
    } catch (_: Exception) {
      "E_FGS_REFUSED"
    }
  }

  private fun refreshNotification() {
    if (!isCapturing) return
    // Notifications blocked: the controller swallows it and the service keeps running (SR9).
    display?.let { DriveNotificationController.update(this, it) }
  }

  /** The headless JS task that runs the drive host while the app is not open (rev1: I15). */
  private fun startHeadless() {
    cancelHeadlessStop()
    try {
      startService(Intent(this, DriveSenseHeadlessService::class.java))
      HeadlessJsTaskService.acquireWakeLockNow(this)
    } catch (_: Exception) {
      // JS cannot boot: nobody will claim this capture, and the watchdog stops it within 60 s.
    }
  }

  // ——— lifecycle (capture thread) ———

  /**
   * The detector's capture (capture thread): a new one, or the running one taken over when it is
   * the same drive's. A plain capture is never taken over (the Start card answered busy). A drive
   * resumed with no RoadWise screen open starts the headless JS host.
   */
  private fun beginDetector(startedAt: Long, mode: String, restart: Boolean) {
    main.post {
      main.removeCallbacks(endHold)
      holding = false
    }
    if (isCapturing && !detectorCapture) return
    if (!isCapturing || captureStartedAt != startedAt) {
      if (isCapturing) stopSources()
      isCapturing = true
      beginCapture(mode, "full", startedAt, nativeStart = false, detector = true)
    } else {
      updateModeAndClaim(mode)
    }
    if (restart) main.post { if (!AppVisibility.visible()) startHeadless() }
  }

  private fun beginCapture(mode: String, rate: String, startedAt: Long, nativeStart: Boolean, detector: Boolean = false) {
    anchor = ClockAnchor.now()
    extractState = FeatureExtractor.initialState()
    imu.clear()
    fixes.clear()
    pendingTs.clear()
    prevRowTs = null
    latestFixT = Double.NEGATIVE_INFINITY
    main.post { cancelHeadlessStop() }
    latestImuT = Double.NEGATIVE_INFINITY
    droppedSamples = 0

    isCapturing = true
    detectorCapture = detector
    currentMode = mode
    currentRate = rate
    captureStartedAt = startedAt
    display = null
    prefs.mode = mode
    prefs.rate = rate
    prefs.captureStartedAt = startedAt
    prefs.detectorOwned = detector
    prefs.captureOpen = true

    location = LocationSource(this, thread.looper, { anchor }, ::onFix)
    sensors = SensorSource(this, handler, { anchor }, ::onImu)
    phone.register()
    // The step count for the rows' `steps`, at both rates, from this capture's baseline (a sticky
    // restart's capture goes on from the one it took before its process died).
    pedometer = PedometerSource(this, handler).also { it.start(startedAt) }
    startRate(rate)
    // The watchdog guards plain captures only: a detector drive records whether JS listens or not.
    if (!detector) watchdog.start(nativeStart, EventBus.rowListenerAttached)
    handler.removeCallbacks(minute)
    handler.postDelayed(minute, MINUTE_MS)
    // The forgot-to-start reminder learns a drive is open (one direction only): this trip is
    // recorded, and a notification it showed comes down. Best effort: it can never hold a capture.
    try {
      TripReminder.onCaptureStarted(this)
    } catch (_: Exception) {
      // the reminder's state stays as it was; the capture runs on
    }
    // WK-m1: the walking feed during every capture (JS start, sticky restart), best
    // effort: a failure is logged and swallowed and the capture runs on.
    ActivityTransitions.sync(this)
  }

  private fun updateModeAndClaim(mode: String) {
    if (!isCapturing) return
    currentMode = mode
    prefs.mode = mode
    watchdog.claim()
  }

  private fun startRate(rate: String) {
    location?.start(rate)
    if (rate == "full") {
      imuRunning = sensors?.start() ?: false
      latestImuT = Double.NEGATIVE_INFINITY
      acquireWakeLock()
      nextTickAt = SystemClock.elapsedRealtime() + TICK_MS
      handler.removeCallbacks(tick)
      handler.postDelayed(tick, TICK_MS)
    } else {
      sensors?.stop()
      imuRunning = false
      handler.removeCallbacks(tick)
      releaseWakeLock()
    }
  }

  private fun applyRate(rate: String) {
    if (!isCapturing || rate == currentRate || (rate != "full" && rate != "low")) return
    if (rate == "low") {
      // Close what the IMU already covered, then stop it.
      imuRunning = false
      closeReady(force = true)
      imu.clear()
    }
    currentRate = rate
    prefs.rate = rate
    startRate(rate)
  }

  /**
   * Stop GNSS, IMU, timers and rows; with [clearOpen] (JS stop, watchdog) also the flag and the
   * service. The headless JS task is stopped too — at once when [headlessNow] (the watchdog: JS is
   * not there), else after HEADLESS_GRACE_MS for it to finalize — so its wake lock never outlives
   * the drive (review N2N3 I4). [end]: what JS said about the drive's end, for the reminder.
   */
  private fun endCapture(clearOpen: Boolean, headlessNow: Boolean = false, end: CaptureEnd? = null) {
    stopSources()
    scheduleHeadlessStop(this, if (headlessNow) 0L else HEADLESS_GRACE_MS)
    isCapturing = false
    detectorCapture = false
    currentRate = null
    currentMode = null
    captureStartedAt = null
    display = null
    if (clearOpen) prefs.captureOpen = false
    // The reminder's session takes the drive's end. Best effort: the service still stops below.
    try {
      TripReminder.onCaptureEnded(this, end)
    } catch (_: Exception) {
      // the reminder's state stays as it was
    }
    // The capture's walking feed ends with it (the reminder's takes over when it is on).
    ActivityTransitions.sync(this)
    main.post {
      try {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      } catch (_: Exception) {
        // not in the foreground
      }
      inForeground = false
      // Only if no newer start arrived since (a quick stop-then-start must not kill the new capture).
      stopSelf(lastStartId)
    }
  }

  /**
   * The detector's drive is over (capture thread): GPS, IMU and rows stop now and the notification
   * goes (as the Live Activity does), then RoadWise is held [holdMs] (the service started, its wake
   * lock held) so JS can store the drive and post its recap; the headless task stops after its grace.
   */
  private fun endDetector(holdMs: Long) {
    stopSources()
    scheduleHeadlessStop(this, HEADLESS_GRACE_MS)
    isCapturing = false
    detectorCapture = false
    currentRate = null
    currentMode = null
    captureStartedAt = null
    display = null
    prefs.detectorOwned = false
    prefs.captureOpen = false
    try {
      TripReminder.onCaptureEnded(this, null)
    } catch (_: Exception) {
      // the reminder's state stays as it was
    }
    ActivityTransitions.sync(this)
    // Set here, before JS can hear of the end, so its stopCapture never cuts the hold short.
    holding = holdMs > 0
    main.post {
      try {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      } catch (_: Exception) {
        // not in the foreground
      }
      inForeground = false
      main.removeCallbacks(endHold)
      if (holdMs > 0 && !isCapturing) {
        acquireWakeLock(holdMs)
        main.postDelayed(endHold, holdMs)
      } else {
        finishHold()
      }
    }
  }

  /** The hold after a detector drive is over (main thread): the service stops, unless a new capture runs. */
  private fun finishHold() {
    holding = false
    if (isCapturing) return
    releaseWakeLock()
    stopSelf(lastStartId)
  }

  /** A sticky restart that needed nothing (main thread). */
  private fun stopIdle() {
    try {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    } catch (_: Exception) {
      // not in the foreground
    }
    inForeground = false
    stopSelf(lastStartId)
  }

  private fun stopSources() {
    watchdog.stop()
    handler.removeCallbacks(tick)
    handler.removeCallbacks(closeLate)
    handler.removeCallbacks(minute)
    reportFallbacks()
    location?.stop()
    sensors?.stop()
    location = null
    sensors = null
    pedometer?.stop()
    pedometer = null
    imuRunning = false
    phone.unregister()
    releaseWakeLock()
    pendingTs.clear()
    imu.clear()
    fixes.clear()
  }

  private fun onWatchdog() {
    if (!isCapturing) return
    prefs.recordExit("watchdog", whileCapturing = true)
    endCapture(clearOpen = true, headlessNow = true)
  }

  private fun onMinute() {
    if (!isCapturing) return
    if (currentRate == "full") acquireWakeLock()
    reportFallbacks()
    handler.postDelayed(minute, MINUTE_MS)
  }

  private fun reportFallbacks() {
    val n = (location?.takeFallbacks() ?: 0) + (sensors?.takeFallbacks() ?: 0)
    if (n > 0) prefs.addTimebaseFallbacks(n)
    prefs.addImuUnpaired(sensors?.takeUnpaired() ?: 0)
  }

  // ——— wake lock: the 1 Hz row timer must keep running with the screen off ———

  private fun acquireWakeLock(timeoutMs: Long = WAKE_LOCK_TIMEOUT_MS) {
    val lock = wakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager?)
      ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RoadWise:DriveCapture")
      ?.also {
        it.setReferenceCounted(false)
        wakeLock = it
      }
    try {
      lock?.acquire(timeoutMs)
    } catch (_: Exception) {
      // WAKE_LOCK missing: rows may stall in deep sleep; the row windows absorb the gap.
    }
  }

  private fun releaseWakeLock() {
    try {
      wakeLock?.let { if (it.isHeld) it.release() }
    } catch (_: Exception) {
      // already released
    }
  }

  // ——— rows (capture thread) ———

  /** The boot clock through this capture's anchor: monotonic, so row timestamps only increase. */
  private fun nowEpochMs(): Double = TimeBase.anchoredNow(anchor)

  private fun onTick() {
    if (!isCapturing || currentRate != "full") return
    val ts = Math.round(nowEpochMs())
    val last = pendingTs.lastOrNull() ?: prevRowTs
    if (last == null || ts > last) {
      pendingTs.add(ts)
      handler.postDelayed(closeLate, FIX_SETTLE_MS)
      handler.postDelayed(closeLate, ROW_MAX_WAIT_MS)
    }
    // Next tick on a 1 s grid; after a stall (> 2 s behind) start the grid again.
    val now = SystemClock.elapsedRealtime()
    nextTickAt += TICK_MS
    if (nextTickAt < now - 2 * TICK_MS) nextTickAt = now + TICK_MS
    handler.postDelayed(tick, (nextTickAt - now).coerceAtLeast(0L))
    closeReady()
    watchdog.check()
  }

  private fun onImu(sample: ImuSample) {
    if (!isCapturing || !imuRunning) return
    imu.add(sample)
    if (imu.size > MAX_IMU_BUFFERED) {
      imu.removeAt(0)
      droppedSamples++
    }
    if (sample.t > latestImuT) latestImuT = sample.t
    if (pendingTs.isNotEmpty()) closeReady()
  }

  private fun onFix(fix: FixSample) {
    if (!isCapturing) return
    if (currentRate == "low") {
      // rev1: I5 — a row per fix, IMU absent, ts = the fix's own time.
      val ts = Math.round(fix.t)
      val prev = prevRowTs
      if (prev == null || ts > prev) {
        val out = FeatureExtractor.extractSecond(emptyList(), fix, phone.snapshot(), ts.toDouble(), extractState)
        extractState = out.state
        prevRowTs = ts
        emitRow(out.row, fix.mock)
      }
    } else {
      emitSpeed(fix)
      fixes.add(fix)
      if (fixes.size > MAX_FIXES_BUFFERED) fixes.removeAt(0)
      if (fix.t > latestFixT) latestFixT = fix.t
      if (pendingTs.isNotEmpty()) closeReady()
    }
    watchdog.check()
  }

  /**
   * The `speed` event (README §3): this fix's speed the moment it lands, with how old it already is
   * (both on the capture's anchored boot clock), for the driving screen. Live only: dropped while no
   * JS listener is attached.
   */
  private fun emitSpeed(fix: FixSample) {
    val age = (TimeBase.anchoredNow(anchor) - fix.t).coerceAtLeast(0.0)
    EventBus.emitLive(
      "speed",
      linkedMapOf(
        "ts" to Math.round(fix.t),
        "speed" to (if (fix.speed >= 0) fix.speed else -1.0),
        "speedAcc" to (if (fix.speedAcc >= 0) fix.speedAcc else -1.0),
        "hAcc" to (if (fix.hAcc >= 0) fix.hAcc else -1.0),
        "ageMs" to Math.round(age)
      )
    )
  }

  /**
   * Close every pending row whose window can be complete (README §7 "When a row closes"): the IMU
   * has passed ts (or is not running) AND a fix stamped after ts has arrived or FIX_SETTLE_MS has
   * passed — capped at ROW_MAX_WAIT_MS. [force] closes everything pending (switching to low rate).
   */
  private fun closeReady(force: Boolean = false) {
    if (!isCapturing) return
    val now = nowEpochMs()
    while (pendingTs.isNotEmpty()) {
      val ts = pendingTs[0]
      val imuReady = !imuRunning || latestImuT > ts
      val fixReady = latestFixT > ts || now >= ts + FIX_SETTLE_MS
      val ready = force || (imuReady && fixReady) || now >= ts + ROW_MAX_WAIT_MS
      if (!ready) break
      pendingTs.removeAt(0)
      closeRow(ts)
    }
  }

  private fun closeRow(ts: Long) {
    val prev = prevRowTs
    if (prev != null && ts <= prev) return
    val start = TimeBase.windowStart(prev, ts)
    val window = TimeBase.takeWindow(imu, start, ts) { it.t }
    imu.clear()
    imu.addAll(window.rest)
    droppedSamples += window.dropped
    val fix = TimeBase.pickFix(fixes, start, ts)
    fixes.removeAll { it.t <= ts } // no fix is used by two rows
    val out = FeatureExtractor.extractSecond(window.inWindow, fix, phone.snapshot(), ts.toDouble(), extractState)
    extractState = out.state
    prevRowTs = ts
    emitRow(out.row, fix?.mock ?: false)
  }

  /**
   * The `row` payload: the FeatureRow keys plus the bridge-only `mock` (v3, plan §6: the window's
   * fix was mocked), `call` (`ring` | `live`, absent with no call: README §1) and `steps` (the
   * pedometer's count since the drive's baseline, absent before its first count or without one).
   * Below API 31 (no audio-mode listener) the row tick is also when a call starting or ending is
   * noticed, so its `call` event goes out before the row.
   */
  private fun emitRow(row: FeatureRow, mock: Boolean) {
    if (!row.isFinite()) return // never hand JS a NaN (README §1); parseRow would drop it anyway
    lastRowTs = row.ts
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) phone.checkCall()
    val body = LinkedHashMap<String, Any?>(row.toMap())
    body["mock"] = mock
    PhoneStateReceiver.callState(applicationContext)?.let { body["call"] = it }
    pedometer?.steps?.let { body["steps"] = it }
    // A detector drive's row goes to the detector, which journals it and emits it with its `seq`.
    val detector = if (detectorCapture) DriveDetector.peek() else null
    if (detector != null) detector.onRow(row, body) else EventBus.emit("row", body)
    // Split screen is a configuration change, not a lifecycle callback: the next row reads a fresh sample.
    main.post { AppVisibility.sample() }
  }
}
