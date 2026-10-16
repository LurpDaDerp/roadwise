package expo.modules.drivesense

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * The forgot-to-start reminder's note on Android: "Forgot to start drive?" / "Tap here to start", on
 * a silent channel (no sound, no vibration: Android usually reports the stop as the car parks, and
 * the note may still be up while the car moves on), with no buttons. Tapping it opens RoadWise with
 * the note's one-use token ([EXTRA_TAP]); the module hands the token to JS once and JS claims it
 * before it starts the drive. Nothing here starts or records a drive.
 *
 * Every post and every refresh sets a positive system timeout (the session's end, or 3 h after the
 * latest report while the phone is in the vehicle); a timeout that is not ahead cancels instead. No
 * notify goes out without one, so an earlier timeout can never be left armed by an update.
 */
object TripReminderNotifier {
  const val CHANNEL_ID = "trip_reminder"
  const val NOTIFICATION_ID = 7305
  private const val REQUEST_OPEN = 7306
  /** The intent extra that carries the note's token. Read and removed only by the module. */
  const val EXTRA_TAP = "expo.modules.drivesense.REMINDER_TAP"
  const val TITLE = "Forgot to start drive?"
  const val TEXT = "Tap here to start"

  private fun manager(context: Context): NotificationManager? =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager?

  /** Created when the reminder is turned on (and before a post), so Settings names it from the start. */
  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    try {
      val nm = manager(context) ?: return
      if (nm.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(CHANNEL_ID, "Drive reminder", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "A silent note when you're driving with no drive recording"
        setSound(null, null)
        enableVibration(false)
        setShowBadge(false)
      }
      nm.createNotificationChannel(channel)
    } catch (_: Exception) {
      // No channel: the post below fails quietly too.
    }
  }

  /** Notifications allowed for the app, and this channel (once it exists) not switched off. */
  fun enabled(context: Context): Boolean {
    return try {
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = manager(context)?.getNotificationChannel(CHANNEL_ID)
        if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) return false
      }
      true
    } catch (_: Exception) {
      false
    }
  }

  /** @return whether the note went up. A timeout that is not ahead posts nothing. */
  fun post(context: Context, token: String, postedAt: Long, timeoutMs: Long): Boolean {
    return try {
      if (timeoutMs <= 0L) {
        cancel(context)
        return false
      }
      ensureChannel(context)
      val nm = manager(context) ?: return false
      val note = build(context, token, postedAt, timeoutMs) ?: return false
      nm.notify(NOTIFICATION_ID, note)
      true
    } catch (_: Exception) {
      // Notifications blocked: nothing to show, nothing to surface.
      false
    }
  }

  /**
   * The note still up gets its new timeout (no alert: silent channel, only once). A note no longer
   * up (swiped away, notifications cleared, a reboot) is never brought back.
   */
  fun refresh(context: Context, token: String, postedAt: Long, timeoutMs: Long) {
    try {
      if (!showing(context)) return
      if (timeoutMs <= 0L) {
        cancel(context)
        return
      }
      val nm = manager(context) ?: return
      val note = build(context, token, postedAt, timeoutMs) ?: return
      nm.notify(NOTIFICATION_ID, note)
    } catch (_: Exception) {
      // Nothing to refresh.
    }
  }

  fun cancel(context: Context) {
    try {
      manager(context)?.cancel(NOTIFICATION_ID)
    } catch (_: Exception) {
      // nothing to take down
    }
  }

  /** Whether the note is in the shade now (API 23+; Expo's minSdk is above it). */
  private fun showing(context: Context): Boolean =
    manager(context)?.activeNotifications?.any { it.id == NOTIFICATION_ID } ?: false

  private fun build(context: Context, token: String, postedAt: Long, timeoutMs: Long): android.app.Notification? {
    val open = open(context, token) ?: return null
    return NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_drive_notification)
      .setContentTitle(TITLE)
      .setContentText(TEXT)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setAutoCancel(true)
      .setOngoing(false)
      .setWhen(postedAt)
      .setShowWhen(true)
      .setTimeoutAfter(timeoutMs)
      .setContentIntent(open)
      .build()
  }

  /**
   * Opens RoadWise (its launcher activity, explicit) carrying the note's token, nothing else. Another
   * app can send the activity this extra too, but without the live token the claim is false.
   */
  private fun open(context: Context, token: String): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.putExtra(EXTRA_TAP, token).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(
      context,
      REQUEST_OPEN,
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
  }
}
