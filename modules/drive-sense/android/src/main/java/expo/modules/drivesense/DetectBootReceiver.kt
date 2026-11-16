package expo.modules.drivesense

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import expo.modules.drivesense.detect.DriveDetector

/**
 * Sets the drive detector's wakes again after a reboot or an app update, which drop Play services'
 * registrations (the activity transitions and the parked geofence). Disabled in the manifest and
 * enabled by the detector only while its wakes run ([expo.modules.drivesense.detect.WakeSources]),
 * so a phone without automatic drives never runs it. It starts nothing itself: the process start it
 * causes resumes a drive left open (DriveSensePackage), and it re-registers under goAsync.
 */
class DetectBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    DriveSensePrefs.init(context)
    val pending = goAsync()
    try {
      DriveDetector.get(context).rearm { pending.finish() }
    } catch (_: Exception) {
      pending.finish()
    }
  }
}
