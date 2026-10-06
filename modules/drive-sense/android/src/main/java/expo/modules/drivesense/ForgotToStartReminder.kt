package expo.modules.drivesense

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * The optional forgot-to-start reminder (spec "Starting and ending a drive"; plan §6). Off by
 * default. While it is on, [ActivityTransitionReceiver] reports IN_VEHICLE enters and exits here:
 * a vehicle period of at least [MIN_VEHICLE_MS] during which no capture ran posts, after its EXIT,
 * a quiet local notification "Forgot to record? Tap Start before your next drive." — never while
 * in the vehicle, at most once per [MIN_INTERVAL_MS], and it never starts a capture (the user
 * taps Start in the app). The state is persisted ([DriveSensePrefs]) so it survives the process.
 */
object ForgotToStartReminder {
  const val CHANNEL_ID = "reminders"
  const val NOTIFICATION_ID = 7305
  private const val REQUEST_OPEN = 7306
  const val MIN_VEHICLE_MS = 5 * 60_000L
  const val MIN_INTERVAL_MS = 6 * 60 * 60_000L
  const val TEXT = "Forgot to record? Tap Start before your next drive."

  fun onVehicleEnter(context: Context, ts: Long) {
    val prefs = DriveSensePrefs.init(context)
    if (!prefs.reminderEnabled) return
    prefs.vehicleEnteredAt = ts
    prefs.captureRanInVehicle = CaptureService.isCapturing
  }

  /** A capture began: whatever vehicle period is open has been recorded. */
  fun onCaptureStarted(context: Context) {
    val prefs = DriveSensePrefs.init(context)
    if (prefs.vehicleEnteredAt > 0) prefs.captureRanInVehicle = true
  }

  fun onVehicleExit(context: Context, ts: Long) {
    val prefs = DriveSensePrefs.init(context)
    val enteredAt = prefs.vehicleEnteredAt
    val recorded = prefs.captureRanInVehicle || CaptureService.isCapturing
    prefs.vehicleEnteredAt = 0L
    prefs.captureRanInVehicle = false
    if (!prefs.reminderEnabled || enteredAt <= 0 || recorded) return
    if (ts - enteredAt < MIN_VEHICLE_MS) return
    val now = System.currentTimeMillis()
    if (now - prefs.lastReminderAt < MIN_INTERVAL_MS) return
    if (post(context)) prefs.lastReminderAt = now
  }

  private fun post(context: Context): Boolean {
    return try {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager? ?: return false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
        val channel = NotificationChannel(CHANNEL_ID, "Reminders", NotificationManager.IMPORTANCE_LOW).apply {
          description = "A quiet note after a drive that was not recorded"
          setSound(null, null)
          enableVibration(false)
        }
        nm.createNotificationChannel(channel)
      }
      val builder = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_drive_notification)
        .setContentTitle("Forgot to record?")
        .setContentText(TEXT)
        .setStyle(NotificationCompat.BigTextStyle().bigText(TEXT))
        .setSilent(true)
        .setAutoCancel(true)
        .setCategory(NotificationCompat.CATEGORY_REMINDER)
        .setPriority(NotificationCompat.PRIORITY_LOW)
      openAppIntent(context)?.let { builder.setContentIntent(it) }
      nm.notify(NOTIFICATION_ID, builder.build())
      true
    } catch (_: Exception) {
      // Notifications blocked (POST_NOTIFICATIONS refused): nothing to do, nothing to surface.
      false
    }
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
