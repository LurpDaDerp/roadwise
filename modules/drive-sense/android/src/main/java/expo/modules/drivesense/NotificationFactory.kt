package expo.modules.drivesense

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import java.text.NumberFormat
import java.util.Locale

/**
 * The foreground-service notification — the Android half of the background surface (spec
 * "Driving screen · Background"; plan §6). A low-importance channel with no sound; title
 * "Driving"; text "34 mph · limit 35" ("—" for an unknown speed or limit); a points line
 * "1,240 pts (+18)" only when JS sends points (it does so only while stopped); the **End drive**
 * action only while stopped — the only control while moving is on the screen; tapping opens the
 * app. It exists exactly while the capture it describes runs, and the watchdog stops a capture
 * nobody records (README §6).
 */
object NotificationFactory {
  const val CHANNEL_ID = "drive_recording"
  const val NOTIFICATION_ID = 7302
  private const val REQUEST_OPEN = 7303
  private const val REQUEST_END = 7304
  const val TITLE = "Driving"

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

  /** "34 mph · limit 35"; "—" where unknown. */
  fun text(d: DriveDisplay): String {
    val speed = d.speed?.let { "${Math.round(it)} ${d.unit}" } ?: "— ${d.unit}"
    val limit = d.limit?.let { "${Math.round(it)}" } ?: "—"
    return "$speed · limit $limit"
  }

  /** "1,240 pts (+18)" — only when points are known; the delta only when non-zero and known. */
  fun pointsLine(d: DriveDisplay): String? {
    val points = d.points ?: return null
    val n = NumberFormat.getIntegerInstance(Locale.US)
    val delta = d.pointsDelta?.let { Math.round(it) }?.takeIf { it != 0L }
    val deltaText = delta?.let { " (${if (it > 0) "+" else "−"}${n.format(Math.abs(it))})" } ?: ""
    return "${n.format(Math.round(points))} pts$deltaText"
  }

  fun build(context: Context, display: DriveDisplay?): Notification {
    ensureChannel(context)
    val d = display ?: DriveDisplay.EMPTY
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_drive_notification)
      .setContentTitle(TITLE)
      .setContentText(text(d))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    pointsLine(d)?.let { builder.setSubText(it) }
    openAppIntent(context)?.let { builder.setContentIntent(it) }
    if (d.stopped && !d.ended) {
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
