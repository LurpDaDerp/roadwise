package expo.modules.drivesense

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofenceStatusCodes
import com.google.android.gms.location.GeofencingEvent
import expo.modules.drivesense.detect.DriveDetector
import expo.modules.drivesense.detect.onRegionExit
import expo.modules.drivesense.detect.WakeSources

/**
 * The parked car's geofence ([WakeSources]): the phone left the 100 m around where the car last
 * parked, the drive detector's `region` wake. Reached only through the explicit, mutable
 * PendingIntent handed to Play services (not exported); the broadcast lets RoadWise start its
 * location service from the background (Android 12+). goAsync until the detector has acted.
 * GEOFENCE_NOT_AVAILABLE (location switched off) removes every geofence: the detector keeps that
 * on disk and sets it again at RoadWise's next launch or foreground (or a reboot, or the next end).
 */
class GeofenceReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION = "expo.modules.drivesense.GEOFENCE"
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION) return
    DriveSensePrefs.init(context)
    val event = GeofencingEvent.fromIntent(intent) ?: return
    if (event.hasError()) {
      if (event.errorCode == GeofenceStatusCodes.GEOFENCE_NOT_AVAILABLE) DriveDetector.get(context).onGeofenceLost()
      return
    }
    if (event.geofenceTransition != Geofence.GEOFENCE_TRANSITION_EXIT) return
    if (event.triggeringGeofences?.any { it.requestId == WakeSources.GEOFENCE_ID } != true) return
    val pending = goAsync()
    try {
      DriveDetector.get(context).onRegionExit { pending.finish() }
    } catch (e: Exception) {
      Log.w("DriveSense", "geofence exit not handled: ${e.javaClass.simpleName}")
      pending.finish()
    }
  }
}
