package expo.modules.drivesense

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * The watch's notification (ruling 3): Android shows a notification for every foreground service,
 * and a watch for a drive is one (its GPS runs in the location service). iOS watches invisibly, so
 * this one says as little as it can: "Checking for a drive", on its own minimum-importance channel
 * ("Checking for a drive"): no sound, no vibration, no badge, no heads-up, no status-bar icon and
 * nothing on the lock screen (minimum importance shows only in the shade, collapsed). It goes the
 * moment the watch ends. A tap opens RoadWise. When the watch confirms a drive, the drive
 * notification ([NotificationFactory]) takes its place under the same id.
 *
 * Also retires the forgot-to-start reminder's channel ("trip_reminder"), which RoadWise no longer has.
 */
object WatchNotification {
  const val CHANNEL_ID = "drive_check"
  /** The retired forgot-to-start reminder's channel: deleted. */
  private const val RETIRED_CHANNEL_ID = "trip_reminder"
  const val TITLE = "Checking for a drive"
  private const val REQUEST_OPEN = 7306

  @Volatile
  private var channelReady = false

  fun ensureChannel(context: Context) {
    if (channelReady || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager? ?: return
    if (nm.getNotificationChannel(CHANNEL_ID) == null) {
      val channel = NotificationChannel(CHANNEL_ID, TITLE, NotificationManager.IMPORTANCE_MIN).apply {
        description = "Shows for a few minutes while RoadWise checks whether a drive has started"
        setSound(null, null)
        enableVibration(false)
        enableLights(false)
        setShowBadge(false)
        lockscreenVisibility = Notification.VISIBILITY_SECRET
      }
      nm.createNotificationChannel(channel)
    }
    channelReady = true
  }

  /** The forgot-to-start reminder's channel goes (best effort; off the main thread: the detector's). */
  fun retireReminderChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    try {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager? ?: return
      if (nm.getNotificationChannel(RETIRED_CHANNEL_ID) != null) nm.deleteNotificationChannel(RETIRED_CHANNEL_ID)
    } catch (_: Exception) {
      // a later process tries again
    }
  }

  fun build(context: Context): Notification {
    ensureChannel(context)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(NotificationFactory.smallIcon(context))
      .setContentTitle(TITLE)
      .setOngoing(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setVisibility(NotificationCompat.VISIBILITY_SECRET)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      // Android 12+ may hold a service's notification back 10 s: a watch that ends sooner never shows.
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFAULT)
    openIntent(context)?.let { builder.setContentIntent(it) }
    return builder.build()
  }

  /** RoadWise as the launcher opens it; immutable. */
  private fun openIntent(context: Context): PendingIntent? {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    return PendingIntent.getActivity(context, REQUEST_OPEN, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}
