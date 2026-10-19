package expo.modules.drivesense

import android.Manifest
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * The DashPal link service (README §2 `setDashpalLink`): a `connectedDevice` foreground service that
 * runs while a DashPal is paired, so the RoadWise process is never cached and frozen in the
 * background and the dashcam's Bluetooth frames reach JS in time for the phone to answer and play
 * its alerts (Android 15 also grants audio focus to an app running a foreground service). JS asks
 * for `waiting` (paired, not connected), `connected` or `off`.
 *
 * - A running instance takes every new state through its own handler ([apply]): its notification
 *   and the reconnect tick. That path never calls `startForegroundService` or `startForeground`,
 *   so it works from the background (a second start request can be refused there).
 * - A stopped service starts only after its prerequisites are checked (RoadWise visible or the
 *   process in front, and Nearby devices granted on Android 14+), so `onStartCommand` reaches
 *   `startForeground` and the app never crashes for a service that stopped before it.
 * - While `waiting`, a 30-s handler tick emits `dashpalLinkTick` (only to a listener, never
 *   buffered): JS pumps its timers, so a reconnect back-off fires with JS timers paused.
 * - `START_NOT_STICKY`: if Android ends the process, nothing restarts it until RoadWise is opened.
 * - It touches neither the capture service nor any wake lock ([AlertWakeLock] is separate).
 */
class DashpalLinkService : Service() {
  companion object {
    const val CHANNEL_ID = "dashpal_link"
    const val NOTIFICATION_ID = 7310
    private const val REQUEST_OPEN = 7311
    const val TITLE = "DashPal"
    const val TEXT_CONNECTED = "Connected. DashPal alerts play on this phone."
    const val TEXT_WAITING = "Not connected. DashPal plays its alerts itself."
    const val TICK_MS = 30_000L
    private const val START_RESULT_TIMEOUT_MS = 10_000L
    private val STATES = setOf("off", "waiting", "connected")

    @Volatile
    var instance: DashpalLinkService? = null
      private set

    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()

    /** The state a start in flight will apply once it is in the foreground (main thread reads it). */
    @Volatile
    private var startState: String? = null

    /** JS calls waiting for a start's result. */
    private val pending = ArrayList<(String) -> Unit>()

    /** Counts start attempts, so a timeout answers only the attempt that armed it. */
    private var attempt = 0

    /** `dashpalLinkRunning()`: the service is running now. */
    fun running(): Boolean = instance != null

    /**
     * `setDashpalLink(state)`. [onResult] gets `running`, `stopped` or `refused` (never throws).
     */
    fun set(context: Context, state: String, onResult: (String) -> Unit) {
      val next = if (state in STATES) state else "off"
      val inst = instance
      if (next == "off") {
        synchronized(lock) { startState = "off" }
        if (inst != null) inst.handler.post { inst.shutDown() }
        onResult("stopped")
        return
      }
      if (inst != null) {
        // The update path: through the live instance only. No start call of any kind here.
        inst.handler.post { inst.apply(next) }
        onResult("running")
        return
      }
      var mine = 0
      val inFlight = synchronized(lock) {
        val waiting = pending.isNotEmpty()
        startState = next
        pending.add(onResult)
        if (!waiting) {
          attempt += 1
          mine = attempt
        }
        waiting
      }
      // A start already asked for: it applies the newest state and answers every caller.
      if (inFlight) return
      val ctx = context.applicationContext
      if (!mayStart(ctx)) {
        resolve("refused")
        return
      }
      try {
        ContextCompat.startForegroundService(ctx, Intent(ctx, DashpalLinkService::class.java))
      } catch (_: IllegalStateException) {
        // ForegroundServiceStartNotAllowedException (API 31+) is an IllegalStateException.
        resolve("refused")
        return
      } catch (_: SecurityException) {
        resolve("refused")
        return
      } catch (_: Exception) {
        resolve("refused")
        return
      }
      main.postDelayed({ if (synchronized(lock) { attempt == mine }) resolve("refused") }, START_RESULT_TIMEOUT_MS)
    }

    /**
     * A foreground-service start is allowed from here: a RoadWise activity is visible (a paused one
     * under a dialog during a drive included) or the process is in front, and on Android 14+ the
     * `connectedDevice` type's Nearby devices permission is granted.
     */
    private fun mayStart(context: Context): Boolean {
      val visible = AppVisibility.visible() || try {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
      } catch (_: Exception) {
        false
      }
      if (!visible) return false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
      ) {
        return false
      }
      return true
    }

    private fun resolve(result: String) {
      val waiting = synchronized(lock) { pending.toList().also { pending.clear() } }
      for (fn in waiting) fn(result)
    }

    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      try {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager? ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(CHANNEL_ID, "DashPal link", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while RoadWise is ready to play your DashPal's alerts"
          setSound(null, null)
          enableVibration(false)
          setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
      } catch (_: Exception) {
        // No channel: the notification fails quietly too; the service still runs.
      }
    }

    fun text(state: String): String = if (state == "connected") TEXT_CONNECTED else TEXT_WAITING
  }

  val handler = Handler(Looper.getMainLooper())
  private var state = "waiting"
  private var foreground = false
  private val tick = object : Runnable {
    override fun run() {
      if (instance !== this@DashpalLinkService || state != "waiting") return
      EventBus.emitLive("dashpalLinkTick", emptyMap())
      handler.postDelayed(this, TICK_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val wanted = synchronized(lock) { startState } ?: "waiting"
    if (!foreground) {
      try {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, build(if (wanted == "off") "waiting" else wanted), type)
        foreground = true
      } catch (_: SecurityException) {
        resolve("refused")
        stopSelf()
        return START_NOT_STICKY
      } catch (_: IllegalStateException) {
        resolve("refused")
        stopSelf()
        return START_NOT_STICKY
      } catch (_: Exception) {
        resolve("refused")
        stopSelf()
        return START_NOT_STICKY
      }
    }
    instance = this
    if (wanted == "off") {
      // Forgotten while the start was in flight: in the foreground first (as Android requires), then gone.
      resolve("stopped")
      shutDown()
      return START_NOT_STICKY
    }
    apply(wanted)
    resolve("running")
    return START_NOT_STICKY
  }

  /** Main thread. The new state: the notification text, and the reconnect tick while waiting. */
  fun apply(next: String) {
    if (instance !== this) return
    state = next
    handler.removeCallbacks(tick)
    if (next == "waiting") handler.postDelayed(tick, TICK_MS)
    try {
      if (NotificationManagerCompat.from(this).areNotificationsEnabled()) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager?
        nm?.notify(NOTIFICATION_ID, build(next))
      }
    } catch (_: Exception) {
      // Notifications blocked: the service keeps running.
    }
  }

  /** Main thread. Stops the service and takes its notification down. */
  fun shutDown() {
    handler.removeCallbacks(tick)
    if (instance === this) instance = null
    try {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    } catch (_: Exception) {
      // not in the foreground
    }
    stopSelf()
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun build(state: String): Notification {
    ensureChannel(this)
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_drive_notification)
      .setContentTitle(TITLE)
      .setContentText(text(state))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    openApp()?.let { builder.setContentIntent(it) }
    return builder.build()
  }

  private fun openApp(): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
    return PendingIntent.getActivity(this, REQUEST_OPEN, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}
