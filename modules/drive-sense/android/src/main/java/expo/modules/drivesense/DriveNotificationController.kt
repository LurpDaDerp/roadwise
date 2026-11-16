package expo.modules.drivesense

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * When the drive notification ([NotificationFactory]) is posted, and with what: the Live
 * Activity's rules (`LiveDriveController.swift` and the widget) the Android way.
 *
 * - **Updates.** JS paces them as it paces the Live Activity's (src/drive/display.ts) and re-sends an
 *   unchanged state every minute. One whose content equals what is posted ([DriveNotificationText.key])
 *   is not posted again: it only re-arms the stale timer.
 * - **Stale.** With no update for [DriveNotificationText.STALE_AFTER_MS] (2 min: the app is gone) it
 *   shows the stale form ([DriveDisplay.stale]: "-" for the speed, no tint, hint or weather; the
 *   limit and the sky stay), as the widget does past its stale date. One timer, re-armed by each
 *   update; it never runs without a capture.
 * - **Swiped away.** Android 14+ lets the driver dismiss a foreground service's notification. Like a
 *   dismissed Live Activity it stays away (no update re-posts it) until RoadWise comes to the front
 *   during the drive ([onAppFront]) or the next capture starts.
 * - **A restart.** The newest state and when it came are kept on disk (its own small preferences
 *   file) with the capture's start, so a capture Android restarts after killing the process
 *   (`START_STICKY`) shows it at once: as it was when under 2 min old, else its stale form. Never a
 *   previous drive's: it must be the open capture's, and only that restart restores it (a new
 *   capture starts empty and forgets it).
 * - **The end.** JS's final `ended` state forgets the drive's state and posts nothing more: the
 *   capture's stop takes the notification down.
 * - **A watch.** While the capture is the detector's watch it shows "Checking for a drive"
 *   ([WatchNotification]) and this posts nothing. A confirmed watch's drive starts empty
 *   ([startDrive]); the linger after an automatic end takes the drive's down at once ([endDrive]).
 *
 * Called from the capture thread (updates), the main thread (the foreground post, the stale timer,
 * RoadWise coming to the front, the dismissal); every entry point holds the object's lock.
 */
object DriveNotificationController {
  private const val PREFS = "expo.modules.drivesense.driveNotification"
  private const val KEY_DISPLAY = "display"
  private const val KEY_AT = "at"
  private const val KEY_DRIVE = "captureStartedAt"

  /** The driver swiped the notification away (its delete intent, to this process only). */
  private const val ACTION_DISMISSED = "expo.modules.drivesense.DRIVE_NOTIFICATION_DISMISSED"
  private const val REQUEST_DISMISS = 7304

  private val main = Handler(Looper.getMainLooper())

  private var app: Context? = null

  /** The newest state JS sent for the capture (null before any) and when (the boot clock). */
  private var latest: DriveDisplay? = null
  private var latestAt = 0L
  private var stale = false
  private var dismissed = false
  private var ended = false

  /** The content posted last ([DriveNotificationText.key]); null: post the next one whatever it is. */
  private var postedKey: String? = null

  private var receiverRegistered = false

  private val staleTask = Runnable { onStale() }

  private val dismissReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action == ACTION_DISMISSED) onDismissed()
    }
  }

  /**
   * The notification a foreground start posts (`goForeground`, main thread), from
   * [DriveNotificationRules.source]: [display] when the capture already has one (a start while
   * recording); on a `START_STICKY` [restart] the open capture's kept state; on a start while
   * recording before any update what already shows; else (a new capture) the empty one, forgetting
   * any kept state. A new capture never restores: its capture-open flag and start are written only
   * after this post, so the kept state of a drive killed mid-drive would still match them. A new
   * foreground post shows whatever was swiped away again.
   */
  @Synchronized
  fun foreground(context: Context, display: DriveDisplay?, restart: Boolean): Notification {
    val ctx = context.applicationContext
    app = ctx
    ensureReceiver(ctx)
    dismissed = false
    ended = false
    val now = SystemClock.elapsedRealtime()
    when (DriveNotificationRules.source(display != null, restart, CaptureService.isCapturing)) {
      DriveNotificationRules.Source.DISPLAY -> if (display !== latest) {
        latest = display
        latestAt = now
      }
      DriveNotificationRules.Source.KEPT -> {
        val kept = restore(ctx)
        latest = kept?.first
        latestAt = now - (kept?.second ?: 0L)
      }
      DriveNotificationRules.Source.CURRENT -> Unit
      DriveNotificationRules.Source.EMPTY -> {
        latest = null
        latestAt = now
        forget(ctx)
      }
    }
    val left = DriveNotificationRules.staleIn(now, latestAt)
    stale = latest != null && left <= 0
    armStale(if (latest == null || stale) DriveNotificationText.STALE_AFTER_MS else left)
    val promoted = LiveUpdates.allowed(ctx)
    val shown = shown()
    postedKey = DriveNotificationText.key(shown, promoted)
    return NotificationFactory.build(ctx, shown, promoted, dismissIntent(ctx))
  }

  /**
   * A watch became a drive (main thread): its notification, from the empty state as a new
   * capture's (any kept state forgotten), to replace "Checking for a drive" under the same id.
   */
  @Synchronized
  fun startDrive(context: Context): Notification {
    val ctx = context.applicationContext
    app = ctx
    ensureReceiver(ctx)
    dismissed = false
    ended = false
    latest = null
    latestAt = SystemClock.elapsedRealtime()
    stale = false
    forget(ctx)
    armStale(DriveNotificationText.STALE_AFTER_MS)
    val promoted = LiveUpdates.allowed(ctx)
    val shown = shown()
    postedKey = DriveNotificationText.key(shown, promoted)
    return NotificationFactory.build(ctx, shown, promoted, dismissIntent(ctx))
  }

  /** The drive is over and its service runs on as the linger's watch (main thread): nothing more is posted for it. */
  @Synchronized
  fun endDrive(context: Context) {
    ended = true
    latest = null
    postedKey = null
    main.removeCallbacks(staleTask)
    forget(context.applicationContext)
  }

  /** `setDriveDisplay` while capturing (the capture thread). */
  @Synchronized
  fun update(context: Context, display: DriveDisplay) {
    val ctx = context.applicationContext
    app = ctx
    if (display.ended) {
      ended = true
      latest = null
      main.removeCallbacks(staleTask)
      forget(ctx)
      return
    }
    ended = false
    latest = display
    latestAt = SystemClock.elapsedRealtime()
    stale = false
    armStale(DriveNotificationText.STALE_AFTER_MS)
    keep(ctx, display)
    post(ctx)
  }

  /** RoadWise came to the front (AppVisibility, main thread): a swiped-away notification comes back during a drive. */
  @Synchronized
  fun onAppFront() {
    if (!dismissed) return
    dismissed = false
    postedKey = null
    app?.let { post(it) }
  }

  @Synchronized
  private fun onDismissed() {
    if (!CaptureService.recording()) return
    dismissed = true
    postedKey = null
  }

  /**
   * The stale timer. An update may have come while it waited for the lock (removeCallbacks cannot
   * stop a run already under way), so it goes by the newest state's age, not by having fired: not
   * due yet, it waits out what is left.
   */
  @Synchronized
  private fun onStale() {
    if (latest == null || stale) return
    val left = DriveNotificationRules.staleIn(SystemClock.elapsedRealtime(), latestAt)
    if (left > 0) {
      armStale(left)
      return
    }
    stale = true
    app?.let { post(it) }
  }

  private fun armStale(delayMs: Long) {
    main.removeCallbacks(staleTask)
    main.postDelayed(staleTask, delayMs.coerceAtLeast(0L))
  }

  private fun shown(): DriveDisplay {
    val d = latest ?: DriveDisplay.EMPTY
    return if (stale) d.stale() else d
  }

  /** Post what shows now, unless no drive records (a watch's notification is its own), the drive ended, the driver swiped it away, or it is posted already. */
  private fun post(ctx: Context) {
    if (!CaptureService.recording() || ended || dismissed) return
    val promoted = LiveUpdates.allowed(ctx)
    val shown = shown()
    val key = DriveNotificationText.key(shown, promoted)
    if (key == postedKey) return
    try {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager? ?: return
      nm.notify(NotificationFactory.NOTIFICATION_ID, NotificationFactory.build(ctx, shown, promoted, dismissIntent(ctx)))
      postedKey = key
    } catch (_: Exception) {
      // Notifications blocked or the system refused: the capture runs on (SR9); the next update tries again.
    }
  }

  // ——— the delete intent ———

  private fun ensureReceiver(ctx: Context) {
    if (receiverRegistered) return
    try {
      ContextCompat.registerReceiver(ctx, dismissReceiver, IntentFilter(ACTION_DISMISSED), ContextCompat.RECEIVER_NOT_EXPORTED)
      receiverRegistered = true
    } catch (_: Exception) {
      // no receiver: a swiped-away notification comes back with the next update, as before
    }
  }

  /** Explicit to RoadWise's own package and immutable; heard only by this process's unexported receiver. */
  private fun dismissIntent(ctx: Context): PendingIntent? {
    if (!receiverRegistered) return null
    return try {
      PendingIntent.getBroadcast(
        ctx,
        REQUEST_DISMISS,
        Intent(ACTION_DISMISSED).setPackage(ctx.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    } catch (_: Exception) {
      null
    }
  }

  // ——— the kept state (a restart) ———

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun keep(ctx: Context, d: DriveDisplay) {
    try {
      val json = JSONObject()
        .put("speed", d.speed ?: JSONObject.NULL)
        .put("limit", d.limit ?: JSONObject.NULL)
        .put("unit", d.unit)
        .put("speedTint", d.speedTint ?: JSONObject.NULL)
        .put("speeding", d.speeding)
        .put("notDrivingAvailable", d.notDrivingAvailable)
        .put("weatherKind", d.weatherKind ?: JSONObject.NULL)
        .put("weatherText", d.weatherText ?: JSONObject.NULL)
        .put("skyTop", d.skyTop ?: JSONObject.NULL)
        .put("skyMid", d.skyMid ?: JSONObject.NULL)
        .put("skyLow", d.skyLow ?: JSONObject.NULL)
        .put("accent", d.accent ?: JSONObject.NULL)
      prefs(ctx).edit()
        .putString(KEY_DISPLAY, json.toString())
        .putLong(KEY_AT, System.currentTimeMillis())
        .putLong(KEY_DRIVE, DriveSensePrefs.init(ctx).captureStartedAt)
        .apply()
    } catch (_: Exception) {
      // not kept: a restart shows the empty state
    }
  }

  private fun forget(ctx: Context) {
    try {
      prefs(ctx).edit().clear().apply()
    } catch (_: Exception) {
      // nothing kept
    }
  }

  /** The open capture's kept state and its age (ms), or null (none, another drive's, or no capture open). */
  private fun restore(ctx: Context): Pair<DriveDisplay, Long>? {
    return try {
      val drive = DriveSensePrefs.init(ctx)
      val p = prefs(ctx)
      if (!drive.captureOpen || p.getLong(KEY_DRIVE, -1L) != drive.captureStartedAt) {
        forget(ctx)
        return null
      }
      val raw = p.getString(KEY_DISPLAY, null) ?: return null
      val json = JSONObject(raw)
      val map = HashMap<String, Any?>()
      for (k in json.keys()) map[k] = if (json.isNull(k)) null else json.get(k)
      val age = (System.currentTimeMillis() - p.getLong(KEY_AT, 0L)).coerceAtLeast(0L)
      DriveDisplay.from(map) to age
    } catch (_: Exception) {
      null
    }
  }
}
