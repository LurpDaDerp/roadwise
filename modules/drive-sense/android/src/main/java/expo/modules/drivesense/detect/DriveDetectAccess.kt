package expo.modules.drivesense.detect

import android.Manifest
import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.drivesense.DriveSensePermissions
import expo.modules.drivesense.NotificationFactory

/**
 * The drive detector's permissions on Android (the iOS `DriveDetectAccess.swift`): what is allowed
 * now ([snapshot]) and the "Always" answer ([alwaysAnswer]).
 *
 * The Start card needs While Using and Precise (`ACCESS_FINE_LOCATION`), as on iPhone: an
 * approximate grant alone is refused (`permission`). The Android meanings of the iOS-only fields:
 * `backgroundRefresh` is `denied` only while the app's battery use is Restricted
 * (`ActivityManager.isBackgroundRestricted`, ruling 5: Optimized, the default, is fine), and
 * `liveActivities` is whether the drive notification can show (notifications allowed and the
 * `drive_live` channel not blocked).
 *
 * Automatic drives need their wakes and "Allow all the time", which this build does not have yet:
 * `hardware` is false (the status is `unavailable` when armed, so no screen offers the switch),
 * location is never `always`, and the one "Always" request answers the current grant without asking.
 */
class DriveDetectAccess(context: Context) {
  private val app = context.applicationContext

  private fun granted(permission: String): Boolean =
    ContextCompat.checkSelfPermission(app, permission) == PackageManager.PERMISSION_GRANTED

  fun snapshot(): DetectAccess {
    val location = LocationAccess.of(DriveSensePermissions.location(app)) ?: LocationAccess.NONE
    return DetectAccess(
      location = location,
      precise = location != LocationAccess.NONE && granted(Manifest.permission.ACCESS_FINE_LOCATION),
      motion = MotionAccess.of(DriveSensePermissions.motion(app)) ?: MotionAccess.UNAVAILABLE,
      backgroundRefresh = if (backgroundRestricted()) BackgroundRefresh.DENIED else BackgroundRefresh.AVAILABLE,
      liveActivities = driveNotificationAllowed(),
      canAskAlways = false,
      hardware = false
    )
  }

  /** `requestAlways`: the current answer (this build never asks for "Allow all the time"). */
  fun alwaysAnswer(): String = when (snapshot().location) {
    LocationAccess.ALWAYS -> "always"
    LocationAccess.WHEN_IN_USE -> "whenInUse"
    LocationAccess.NONE -> "denied"
  }

  /** Battery use Restricted for RoadWise (Android 9+): the background work automatic drives need may not run. */
  private fun backgroundRestricted(): Boolean =
    try {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
        (app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager?)?.isBackgroundRestricted == true
    } catch (_: Exception) {
      false
    }

  /** The drive notification can show: notifications on, and its channel (once made) not turned off. */
  private fun driveNotificationAllowed(): Boolean =
    try {
      val nm = NotificationManagerCompat.from(app)
      if (!nm.areNotificationsEnabled()) {
        false
      } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        true
      } else {
        val channel = (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager?)?.getNotificationChannel(NotificationFactory.CHANNEL_ID)
        channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
      }
    } catch (_: Exception) {
      false
    }
}
