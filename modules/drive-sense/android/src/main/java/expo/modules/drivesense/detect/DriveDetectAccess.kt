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
 * now ([snapshot]) and the "Always" answer ([alwaysAnswer]; the request itself is the module's, as it
 * needs RoadWise's activity).
 *
 * Automatic drives need "Allow all the time" location (ACCESS_BACKGROUND_LOCATION on Android 10+;
 * below 10 any location grant is all the time), Precise (`ACCESS_FINE_LOCATION`), Physical activity
 * (`ACTIVITY_RECOGNITION` on 10+) and Play services (the transitions and the geofence: `hardware`).
 * The Start card needs While Using and Precise, as on iPhone: an approximate grant alone is refused
 * (`permission`). The Android meanings of the iOS-only fields: `backgroundRefresh` is `denied` only
 * while the app's battery use is Restricted (`ActivityManager.isBackgroundRestricted`, ruling 5:
 * Optimized, the default, is fine); otherwise the wire's `backgroundRefresh` reads `restricted` while
 * Battery Saver limits location ([BatterySaver], never part of the status: [DetectAccess]), and
 * `liveActivities` is whether the drive notification can show (notifications allowed and the
 * `drive_live` channel not blocked). `canAskAlways`: While Using held on Android 10+ (Android 11+
 * answers the request with the app's location settings page, every time). JS reads a phone without
 * Play services (`motion` unavailable) as one without the detector.
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
      canAskAlways = location == LocationAccess.WHEN_IN_USE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q,
      hardware = DriveSensePermissions.playServicesAvailable(app),
      batterySaver = BatterySaver.read(app)
    )
  }

  /** `requestAlways`'s answer: the location grant now. */
  fun alwaysAnswer(): String = when (snapshot().location) {
    LocationAccess.ALWAYS -> "always"
    LocationAccess.WHEN_IN_USE -> "whenInUse"
    LocationAccess.NONE -> "denied"
  }
  private fun backgroundRestricted(): Boolean = backgroundRestricted(app)

  companion object {
    /**
     * Battery use Restricted for RoadWise (Android 9+): the background work automatic drives need
     * may not run. Also the capture service's read ([expo.modules.drivesense.ForegroundRules]).
     */
    fun backgroundRestricted(context: Context): Boolean =
      try {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
          (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager?)?.isBackgroundRestricted == true
      } catch (_: Exception) {
        false
      }
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
