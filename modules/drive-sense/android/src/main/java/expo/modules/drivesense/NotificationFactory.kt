package expo.modules.drivesense

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * The drive notification: the capture's foreground-service notification, and Android's Live
 * Activity (spec "The Live Activity"; ruling 6). It shows what the Live Activity shows
 * ([DriveNotificationText]): the speed and its unit as the title, the number in the driving screen's
 * speeding tint; the posted limit as the driving screen's sign (the large icon, [LimitSignBitmap])
 * and as "Limit 35"; the weather line while the driving screen shows its weather card; "Not
 * driving?" while that option lasts. A tap opens the driving screen (`roadwise://drive`, as the Live
 * Activity's tap does); nothing on it is a button. TalkBack reads VoiceOver's words.
 *
 * Its look: on Android 16 QPR1 and later, with Live Updates allowed for RoadWise
 * ([LiveUpdates.allowed]), it asks to be promoted to a Live Update (on the lock screen and the
 * always-on display at the top, and a status-bar chip with the speed, [DriveNotificationText.chip]):
 * the system's own colours then (a promoted notification may not be colorized), with the sky accent
 * as its colour (gold without one), as the Dynamic Island wears the accent. Everywhere else it is
 * colorized in the app's sky (its middle stop, navy until the app sends its look), as the Live
 * Activity's lock-screen banner is.
 *
 * Its channel, "drive_live" ("Drive in progress"), is default importance so lock screens show it
 * in full (and so it can be promoted), with no sound, vibration or badge: it never alerts, and a
 * drive's start never peeks as a heads-up. The channel it replaced ("drive_recording", low
 * importance) is deleted. Shown immediately as a foreground service starts
 * (FOREGROUND_SERVICE_IMMEDIATE: Android 12+ may otherwise hold a location service's notification
 * back for 10 s). It exists exactly while the capture it describes runs; [DriveNotificationController]
 * decides when it is posted.
 */
object NotificationFactory {
  const val CHANNEL_ID = "drive_live"
  /** The low-importance channel this one replaced; deleted, as a channel's importance never changes in place. */
  private const val OLD_CHANNEL_ID = "drive_recording"
  const val NOTIFICATION_ID = 7302
  private const val REQUEST_OPEN = 7303

  /** The Live Activity's tap (`Copy.tapURL`): the driving screen while recording. */
  const val DRIVE_LINK = "roadwise://drive"

  /** The Live Activity's colours before the app sends its look: navy ground, gold accent. */
  private const val NAVY = 0xFF001D3D.toInt()
  private const val GOLD = 0xFFFFC300.toInt()

  /** expo-notifications' status-bar glyph (the RoadWise mark, `assets/notification-icon.png`), as the app's manifest names it. */
  private const val APP_ICON_META = "expo.modules.notifications.default_notification_icon"

  @Volatile
  private var smallIcon = 0

  /** The channels were set up in this process (once, not at every post). */
  @Volatile
  private var channelReady = false

  fun ensureChannel(context: Context) {
    if (channelReady || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager? ?: return
    try {
      if (nm.getNotificationChannel(OLD_CHANNEL_ID) != null) nm.deleteNotificationChannel(OLD_CHANNEL_ID)
    } catch (_: Exception) {
      // a channel a running service still posts on cannot go: it goes in a later process
    }
    if (nm.getNotificationChannel(CHANNEL_ID) != null) {
      channelReady = true
      return
    }
    val channel = NotificationChannel(CHANNEL_ID, "Drive in progress", NotificationManager.IMPORTANCE_DEFAULT).apply {
      description = "Your speed and the speed limit while RoadWise records a drive"
      setSound(null, null)
      enableVibration(false)
      enableLights(false)
      setShowBadge(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    nm.createNotificationChannel(channel)
    channelReady = true
  }

  /** "#RRGGBB" as a colour; null for null or one that does not parse. */
  private fun color(hex: String?): Int? = hex?.let { runCatching { Color.parseColor(it) }.getOrNull() }

  /** The ground of the colorized look: the sky's middle stop, navy without one. */
  fun skyColor(d: DriveDisplay): Int = color(d.skyMid) ?: NAVY

  /** A Live Update's colour: the sky accent, gold without one. */
  fun accentColor(d: DriveDisplay): Int = color(d.accent) ?: GOLD

  /** The title: the speed's number in the speeding tint (the plain text colour without one), then its unit. */
  private fun title(d: DriveDisplay): CharSequence {
    val text = DriveNotificationText.title(d)
    val tint = color(d.speedTint) ?: return text
    val range = DriveNotificationText.speedRange(d)
    return SpannableString(text).apply {
      setSpan(ForegroundColorSpan(tint), range.first, range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
  }

  /**
   * The notification showing [d] (already in its stale form when stale). [promoted]: ask for a Live
   * Update ([LiveUpdates.allowed] says whether it may). [onDismiss]: the delete intent, the driver
   * swiping it away (Android 14+ lets a foreground service's notification go).
   */
  fun build(context: Context, d: DriveDisplay, promoted: Boolean, onDismiss: PendingIntent?): Notification {
    ensureChannel(context)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(smallIcon(context))
      .setContentTitle(title(d))
      .setContentText(DriveNotificationText.text(d))
      .setTicker(DriveNotificationText.accessibility(d))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    LimitSignBitmap.of(context, DriveNotificationText.number(d.limit), d.unit)?.let { builder.setLargeIcon(it) }
    DriveNotificationText.bigText(d)?.let { builder.setStyle(NotificationCompat.BigTextStyle().bigText(it)) }
    if (promoted) {
      builder
        .setRequestPromotedOngoing(true)
        .setShortCriticalText(DriveNotificationText.chip(d))
        .setColor(accentColor(d))
    } else {
      // A foreground service's notification may be colorized: it wears the app's sky.
      builder.setColor(skyColor(d)).setColorized(true)
    }
    openDriveIntent(context)?.let { builder.setContentIntent(it) }
    onDismiss?.let { builder.setDeleteIntent(it) }
    return builder.build()
  }

  /** The RoadWise mark the app's other notifications use; the module's own glyph if the app names none. */
  private fun smallIcon(context: Context): Int {
    if (smallIcon != 0) return smallIcon
    val fromApp = try {
      val pm = context.packageManager
      val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.getApplicationInfo(context.packageName, PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()))
      } else {
        @Suppress("DEPRECATION")
        pm.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      }
      info.metaData?.getInt(APP_ICON_META, 0) ?: 0
    } catch (_: Exception) {
      0
    }
    smallIcon = if (fromApp != 0) fromApp else R.drawable.ic_drive_notification
    return smallIcon
  }

  /** `roadwise://drive` in RoadWise itself (the router opens the driving screen); the launcher's intent if nothing takes it. */
  private fun openDriveIntent(context: Context): PendingIntent? {
    val drive = Intent(Intent.ACTION_VIEW, Uri.parse(DRIVE_LINK)).setPackage(context.packageName)
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

/**
 * Whether the drive notification may be a Live Update: Android 16 QPR1 (API 36.1) or later, where
 * promoted notifications reached phones, and RoadWise allowed to post them (Settings › Apps ›
 * RoadWise › Notifications › Live updates; `POST_PROMOTED_NOTIFICATIONS` is declared, so it starts
 * allowed). Read at every post, so a change in Settings shows with the next update.
 */
object LiveUpdates {
  /** Android 16 (BAKLAVA). */
  private const val API_36 = 36

  /** API 36.1 as `Build.VERSION.SDK_INT_FULL` writes it (major × 100 000 + minor). */
  const val SDK_INT_FULL_36_1 = 36 * 100_000 + 1

  fun supported(): Boolean = Build.VERSION.SDK_INT > API_36 || (Build.VERSION.SDK_INT == API_36 && sdkIntFull() >= SDK_INT_FULL_36_1)

  @RequiresApi(API_36)
  private fun sdkIntFull(): Int = Build.VERSION.SDK_INT_FULL

  fun allowed(context: Context): Boolean {
    if (!supported()) return false
    return try {
      NotificationManagerCompat.from(context).canPostPromotedNotifications()
    } catch (_: Exception) {
      false
    }
  }
}
