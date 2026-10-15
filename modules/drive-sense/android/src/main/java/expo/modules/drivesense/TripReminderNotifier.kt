package expo.modules.drivesense

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * The forgot-to-start reminder's notification on Android. A silent channel (no sound, no
 * vibration: Android cannot tell a red light from parking, so the note may land while the car
 * still moves), withdrawn after [TripReminderPolicy.TTL_MS]. Tapping it opens RoadWise on Home
 * (`roadwise://home`); its one action, "Not driving", only quiets the reminder. Nothing here
 * starts or records a drive.
 */
object TripReminderNotifier {
  const val CHANNEL_ID = "trip_reminder"
  const val NOTIFICATION_ID = 7305
  private const val REQUEST_OPEN = 7306
  private const val REQUEST_NOT_DRIVING = 7307
  const val ACTION_NOT_DRIVING = "expo.modules.drivesense.REMINDER_NOT_DRIVING"
  const val TITLE = "Want to record this drive?"
  const val TEXT =
    "Looks like you're in a car. If you're driving, tap here when you're stopped and it's safe to open RoadWise and start your drive."
  const val NOT_DRIVING = "Not driving"

  private fun manager(context: Context): NotificationManager? =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager?

  /** Created when the reminder is turned on (and before a post), so Settings names it from the start. */
  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    try {
      val nm = manager(context) ?: return
      if (nm.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(CHANNEL_ID, "Drive reminder", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "A silent note when you seem to be driving with no drive recording"
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

  /** @return whether the notification went up. */
  fun post(context: Context): Boolean {
    return try {
      ensureChannel(context)
      val nm = manager(context) ?: return false
      val builder = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_drive_notification)
        .setContentTitle(TITLE)
        .setContentText(TEXT)
        .setStyle(NotificationCompat.BigTextStyle().bigText(TEXT))
        .setSilent(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setAutoCancel(true)
        .setOngoing(false)
        .setTimeoutAfter(TripReminderPolicy.TTL_MS)
        .setContentIntent(openHome(context))
        .addAction(0, NOT_DRIVING, notDriving(context))
      nm.notify(NOTIFICATION_ID, builder.build())
      true
    } catch (_: Exception) {
      // Notifications blocked: nothing to show, nothing to surface.
      false
    }
  }

  fun cancel(context: Context) {
    try {
      manager(context)?.cancel(NOTIFICATION_ID)
    } catch (_: Exception) {
      // nothing to take down
    }
  }

  /** Opens RoadWise on Home, where the driver taps Start Drive. It carries nothing that starts a drive. */
  private fun openHome(context: Context): PendingIntent {
    val home = Intent(Intent.ACTION_VIEW, Uri.parse("roadwise://home"))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val intent = if (home.resolveActivity(context.packageManager) != null) {
      home
    } else {
      (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: home).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    return PendingIntent.getActivity(
      context,
      REQUEST_OPEN,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
  }

  private fun notDriving(context: Context): PendingIntent {
    val intent = Intent(context, ReminderActionReceiver::class.java).setAction(ACTION_NOT_DRIVING)
    return PendingIntent.getBroadcast(
      context,
      REQUEST_NOT_DRIVING,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
  }
}
