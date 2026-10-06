package expo.modules.drivesense

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability

/** The authorisations `DriveSenseState` reports (README §2 `location`, `motion`). */
object DriveSensePermissions {
  private fun granted(context: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  fun hasForegroundLocation(context: Context): Boolean =
    granted(context, Manifest.permission.ACCESS_FINE_LOCATION) ||
      granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)

  /**
   * `whenInUse` / `none`. The app never declares the background-location permission (plan §1 decision 4), so
   * `always` is never reported on Android: a drive started from the foreground keeps its location
   * foreground service with While Using.
   */
  fun location(context: Context): String = if (hasForegroundLocation(context)) "whenInUse" else "none"

  fun playServicesAvailable(context: Context): Boolean =
    try {
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    } catch (_: Exception) {
      false
    }

  fun motionGranted(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || granted(context, Manifest.permission.ACTIVITY_RECOGNITION)

  /** `granted` / `denied` / `undetermined` / `unavailable`. */
  fun motion(context: Context): String {
    if (!playServicesAvailable(context)) return "unavailable"
    if (motionGranted(context)) return "granted"
    return if (DriveSensePrefs.init(context).motionRequested) "denied" else "undetermined"
  }
}
