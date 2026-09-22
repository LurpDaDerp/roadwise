package expo.modules.drivesense

import android.app.NotificationManager
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

/**
 * The location foreground service that records a drive (design §2.4, README §2, §6, §7).
 *
 * While it captures at `full` rate: 1 Hz fused location, 25 Hz accelerometer + gyroscope batched
 * in the sensor hub, and one [FeatureRow] per second computed natively by [FeatureExtractor] and
 * emitted as `row` — raw samples never cross the bridge. At `low` rate (rev1: I5): 10 s balanced
 * location, no IMU, a row per fix. Nothing of this runs unless a capture is open: armed-and-idle
 * costs nothing (design §3.5).
 *
 * Starts: from JS (`startCapture`), from [ActivityTransitionReceiver] on IN_VEHICLE ENTER, and as a
 * `START_STICKY` restart with a null intent after the process was killed mid-capture (rev1: I2),
 * which resumes from the persisted state and starts the headless JS task again. A native start
 * must be claimed by JS within 60 s and a JS `row` listener must exist, or [Watchdog] stops it.
 *
 * Threading: all capture state lives on one [HandlerThread]; the companion's `@Volatile` fields are
 * the read-only view the module's `getState` uses.
 */
class CaptureService : Service() {
  companion object {
    const val ACTION_START_JS = "expo.modules.drivesense.START_JS"
    const val ACTION_START_NATIVE = "expo.modules.drivesense.START_NATIVE"
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

    /** The activity-transition receiver's start. A refusal is silent (SR9) and recorded. */
    fun startNative(context: Context) {
      val intent = Intent(context, CaptureService::class.java).setAction(ACTION_START_NATIVE)
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (_: Exception) {
        DriveSensePrefs.init(context).recordExit("other", whileCapturing = false)
      }
    }

    /** `stopCapture()`: idempotent; clears the capture-open flag even with no service running. */
    fun stopFromJs(context: Context, done: () -> Unit) {
      val inst = instance
      if (inst == null) {
        DriveSensePrefs.init(context).captureOpen = false
        done()
        return
      }
      inst.handler.post {
        inst.endCapture(clearOpen = true)
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

    /** `setNotificationState(...)`: remembered for the capture's notification. */
    fun setNotificationState(stationary: Boolean, startedAt: Long?) {
      val inst = instance ?: return
      inst.handler.post {
        inst.notifStationary = stationary
        inst.notifStartedAt = startedAt
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
  private var wakeLock: PowerManager.WakeLock? = null

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
  private var notifStationary = false
  private var notifStartedAt: Long? = null

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
      if (!prefs.captureOpen) {
        stopSelf(startId)
        return START_NOT_STICKY
      }
      if (goForeground() != null) {
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
        val mode = intent.getStringExtra(EXTRA_MODE) ?: "auto"
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
      ACTION_START_NATIVE -> {
        val refused = goForeground()
        if (refused != null) {
          // Silent (SR9): no notification, no sound. Recorded for getLastExitInfo.
          if (!isCapturing) {
            prefs.recordExit("other", whileCapturing = false)
            stopSelf(startId)
            return START_NOT_STICKY
          }
        } else if (!isCapturing) {
          isCapturing = true
          handler.post { beginCapture("auto", "full", System.currentTimeMillis(), nativeStart = true) }
          startHeadless()
        }
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
    // capture was open, the next process reports captureWasOpen and JS decides (rev1: I2).
    handler.post { stopSources() }
    isCapturing = false
    currentRate = null
    currentMode = null
    captureStartedAt = null
    EventBus.rowListenerChanged = null
    instance = null
    thread.quitSafely()
    super.onDestroy()
  }

  // ——— foreground ———

  /** @return null when the service is in the foreground, else the contract code for the refusal. */
  private fun goForeground(): String? {
    val notification = NotificationFactory.build(this, notifStartedAt, notifStationary)
    return try {
      val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
      ServiceCompat.startForeground(this, NotificationFactory.NOTIFICATION_ID, notification, type)
      null
    } catch (_: SecurityException) {
      // Android 14+: a location service needs location permission, and from the background, Always.
      "E_PERMISSION"
    } catch (_: Exception) {
      "E_FGS_REFUSED"
    }
  }

  private fun refreshNotification() {
    if (!isCapturing) return
    try {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager?
      nm?.notify(NotificationFactory.NOTIFICATION_ID, NotificationFactory.build(this, notifStartedAt, notifStationary))
    } catch (_: Exception) {
      // Notifications blocked: the service keeps running (SR9).
    }
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

  private fun beginCapture(mode: String, rate: String, startedAt: Long, nativeStart: Boolean) {
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
    currentMode = mode
    currentRate = rate
    captureStartedAt = startedAt
    prefs.mode = mode
    prefs.rate = rate
    prefs.captureStartedAt = startedAt
    prefs.captureOpen = true

    location = LocationSource(this, thread.looper, { anchor }, ::onFix)
    sensors = SensorSource(this, handler, { anchor }, ::onImu)
    phone.register()
    startRate(rate)
    watchdog.start(nativeStart, EventBus.rowListenerAttached)
    handler.removeCallbacks(minute)
    handler.postDelayed(minute, MINUTE_MS)
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
   * the drive (review N2N3 I4).
   */
  private fun endCapture(clearOpen: Boolean, headlessNow: Boolean = false) {
    stopSources()
    scheduleHeadlessStop(this, if (headlessNow) 0L else HEADLESS_GRACE_MS)
    isCapturing = false
    currentRate = null
    currentMode = null
    captureStartedAt = null
    notifStationary = false
    notifStartedAt = null
    if (clearOpen) prefs.captureOpen = false
    main.post {
      try {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      } catch (_: Exception) {
        // not in the foreground
      }
      // Only if no newer start arrived since (a quick stop-then-start must not kill the new capture).
      stopSelf(lastStartId)
    }
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
    refreshNotification()
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

  private fun acquireWakeLock() {
    val lock = wakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager?)
      ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RoadWise:DriveCapture")
      ?.also {
        it.setReferenceCounted(false)
        wakeLock = it
      }
    try {
      lock?.acquire(WAKE_LOCK_TIMEOUT_MS)
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
        emitRow(out.row)
      }
    } else {
      fixes.add(fix)
      if (fixes.size > MAX_FIXES_BUFFERED) fixes.removeAt(0)
      if (fix.t > latestFixT) latestFixT = fix.t
      if (pendingTs.isNotEmpty()) closeReady()
    }
    watchdog.check()
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
    emitRow(out.row)
  }

  private fun emitRow(row: FeatureRow) {
    if (!row.isFinite()) return // never hand JS a NaN (README §1); parseRow would drop it anyway
    lastRowTs = row.ts
    EventBus.emit("row", row.toMap())
  }
}
