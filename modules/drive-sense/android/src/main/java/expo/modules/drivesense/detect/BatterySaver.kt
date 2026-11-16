package expo.modules.drivesense.detect

import android.content.Context
import android.os.Build
import android.os.PowerManager

/**
 * Battery Saver limiting location (the drive detector's state: [DetectAccess.batterySaver]). Battery
 * Saver on with a location mode that stops background fixes while the screen is off or RoadWise is
 * behind (`GPS_DISABLED_WHEN_SCREEN_OFF`, `ALL_DISABLED_WHEN_SCREEN_OFF`, `FOREGROUND_ONLY`) can
 * make automatic drives start late or end early. `NO_CHANGE` and `THROTTLE_REQUESTS_WHEN_SCREEN_OFF`
 * (which slows other apps' requests but keeps a foreground service's) do not count. Below Android 9
 * the mode can't be read, so Battery Saver on counts (Android 8's saver turns GPS off with the
 * screen). Read where the state is made (`DriveDetectAccess.snapshot`); RoadWise hears the switch
 * change only while its JS runtime runs (DriveDetectModule's receiver), never from a receiver of its
 * own in the manifest.
 */
object BatterySaver {
  /** Pure: whether this power-save state limits the background location automatic drives use. */
  fun limitsLocation(powerSave: Boolean, sdkInt: Int, locationMode: Int?): Boolean {
    if (!powerSave) return false
    if (sdkInt < Build.VERSION_CODES.P || locationMode == null) return true
    return when (locationMode) {
      PowerManager.LOCATION_MODE_GPS_DISABLED_WHEN_SCREEN_OFF,
      PowerManager.LOCATION_MODE_ALL_DISABLED_WHEN_SCREEN_OFF,
      PowerManager.LOCATION_MODE_FOREGROUND_ONLY -> true
      else -> false
    }
  }

  /** The phone now; false when it can't be read. */
  fun read(context: Context): Boolean =
    try {
      val pm = context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager?
      if (pm == null) {
        false
      } else {
        val powerSave = pm.isPowerSaveMode
        val mode = if (powerSave && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pm.locationPowerSaveMode else null
        limitsLocation(powerSave, Build.VERSION.SDK_INT, mode)
      }
    } catch (_: Exception) {
      false
    }
}
