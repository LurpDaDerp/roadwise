package expo.modules.drivesense

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * The foreground-service notification, product S3: a low-importance channel with no sound, "Recording
 * your drive", then "Recording drive · N min" once JS gives the start time (updated once a minute),
 * no action while moving, and an **End drive** action only after
 * `setNotificationState({ stationary: true })`. It says only what is true: it exists exactly while
 * the capture it describes runs, and the watchdog stops a capture nobody records (README §6).
 */
object NotificationFactory {
  const val CHANNEL_ID = "drive_recording"
  const val NOTIFICATION_ID = 7302
  private const val REQUEST_OPEN = 7303
  private const val REQUEST_END = 7304

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager? ?: return
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "Drive recording", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Shown while RoadWise records a drive"
      setSound(null, null)
      enableVibration(false)
      setShowBadge(false)
    }
    nm.createNotificationChannel(channel)
  }

  /** "Recording drive · N min" when the start is known, else "Recording your drive". */
  fun title(startedAt: Long?, now: Long): String {
    if (startedAt == null || startedAt <= 0 || now < startedAt) return "Recording your drive"
    val minutes = (now - startedAt) / 60_000L
    return "Recording drive · $minutes min"
  }

  fun build(context: Context, startedAt: Long?, stationary: Boolean): Notification {
    ensureChannel(context)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_drive_notification)
      .setContentTitle(title(startedAt, System.currentTimeMillis()))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    openAppIntent(context)?.let { builder.setContentIntent(it) }
    if (stationary) {
      val end = Intent(context, CaptureService::class.java).setAction(CaptureService.ACTION_END_DRIVE)
      val pi = PendingIntent.getService(
        context,
        REQUEST_END,
        end,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      builder.addAction(0, "End drive", pi)
    }
    return builder.build()
  }

  private fun openAppIntent(context: Context): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
    return PendingIntent.getActivity(
      context,
      REQUEST_OPEN,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}
