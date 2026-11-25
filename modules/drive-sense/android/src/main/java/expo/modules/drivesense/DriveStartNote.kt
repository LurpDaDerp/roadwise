package expo.modules.drivesense

import android.app.Notification
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
 * The "drive started" note (Settings › Notifications › "Drive started"): posted the moment an
 * automatic drive is confirmed while RoadWise isn't showing, so the driver knows RoadWise is
 * recording and can say "Not driving?". Never for a Start drive (the driver started it), never for
 * a drive resumed after a restart, and never with the switch off ([DriveSensePrefs.driveStartNoteOff],
 * so a drive that starts with no JS running reads it). It shows beside the drive notification: that
 * one carries the drive, this one says it began.
 *
 * Its channel, "drive_started" ("Drive started"), is high importance with no sound, vibration or
 * badge, so it peeks as a silent heads-up, as the iPhone banners its note with no sound. A tap opens
 * the driving screen (`roadwise://drive`, as the drive notification's tap does) and takes the note
 * away. It comes down when RoadWise comes to the front (the driving screen shows the drive), at
 * every end or cancel, and when the switch goes off.
 */
object DriveStartNote {
  const val CHANNEL_ID = "drive_started"
  const val NOTIFICATION_ID = 7304
  private const val REQUEST_OPEN = 7305

  const val TITLE = "Recording your drive. Stay safe."
  const val BODY = "Select to open your drive. Not driving? Open it to stop recording."
  private const val CHANNEL_NAME = "Drive started"
  private const val CHANNEL_DESCRIPTION = "When RoadWise starts recording a drive on its own."

  /** Whether an automatic drive that starts now posts the note: an automatic drive, the switch on, RoadWise not showing. */
  fun due(kind: String, switchOff: Boolean, appVisible: Boolean): Boolean = kind == "auto" && !switchOff && !appVisible

  /** The "Drive started" switch (JS `DriveDetect.setStartNote`). Off takes a posted note down. */
  fun setEnabled(context: Context, on: Boolean) {
    DriveSensePrefs.init(context).driveStartNoteOff = !on
    if (!on) remove(context)
  }

  /** A drive was confirmed: the note goes up at once when [due]. Any thread. */
  fun driveStarted(context: Context, kind: String) {
    val prefs = DriveSensePrefs.init(context)
    if (!due(kind, prefs.driveStartNoteOff, AppVisibility.visible())) return
    try {
      // Android 13+ without the notification permission (or notifications off): nothing would show.
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager? ?: return
      nm.notify(NOTIFICATION_ID, build(context))
    } catch (_: SecurityException) {
      // the permission went between the check and the post
    } catch (_: Exception) {
      // a post that fails leaves the drive notification to show the drive
    }
  }

  /** The note comes down (RoadWise in front, an end, a cancel, the switch off). Any thread. */
  fun remove(context: Context) {
    try {
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    } catch (_: Exception) {
      // nothing posted, or nothing to reach
    }
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager? ?: return
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH).apply {
      description = CHANNEL_DESCRIPTION
      setSound(null, null)
      enableVibration(false)
      enableLights(false)
      setShowBadge(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    nm.createNotificationChannel(channel)
  }

  private fun build(context: Context): Notification {
    ensureChannel(context)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(NotificationFactory.smallIcon(context))
      .setContentTitle(TITLE)
      .setContentText(BODY)
      .setStyle(NotificationCompat.BigTextStyle().bigText(BODY))
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      // No sound or vibration of its own (Android 7 reads these; 8+ the silent channel). Not
      // `setSilent`: a notification built silent never peeks as a heads-up.
      .setSound(null)
      .setVibrate(null)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      // Android 7 has no channels: the priority stands in for the channel's importance.
      .setPriority(NotificationCompat.PRIORITY_HIGH)
    openDriveIntent(context)?.let { builder.setContentIntent(it) }
    return builder.build()
  }

  /** `roadwise://drive` in RoadWise itself (the router opens the driving screen); the launcher's intent if nothing takes it. */
  private fun openDriveIntent(context: Context): PendingIntent? {
    val drive = Intent(Intent.ACTION_VIEW, Uri.parse(NotificationFactory.DRIVE_LINK)).setPackage(context.packageName)
    val intent = if (drive.resolveActivity(context.packageManager) != null) {
      drive
    } else {
      context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    }
    intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    return PendingIntent.getActivity(
      context,
      REQUEST_OPEN,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}
