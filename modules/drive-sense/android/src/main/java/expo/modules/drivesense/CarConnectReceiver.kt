package expo.modules.drivesense

import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.IntentCompat
import expo.modules.drivesense.detect.DriveDetector
import expo.modules.drivesense.detect.onCarConnected

/**
 * A paired car's Bluetooth connecting: the drive detector's `car` wake on Android (ruling 2; the
 * detector's wakes are in [expo.modules.drivesense.detect.WakeSources]). Disabled in the manifest
 * and enabled only while automatic drives run with a car paired, so no Bluetooth connection starts
 * RoadWise otherwise. Exported because the Bluetooth stack (its own app) sends ACL_CONNECTED; the
 * action is a protected broadcast, which no other app can send. Android sends it only to an app with
 * Nearby devices (BLUETOOTH_CONNECT, Android 12+; BLUETOOTH below), and such a Bluetooth broadcast
 * may start a foreground service from the background. A device that is not a paired car does
 * nothing (the address is matched, never kept). goAsync until the detector has acted.
 */
class CarConnectReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != BluetoothDevice.ACTION_ACL_CONNECTED) return
    val address = try {
      IntentCompat.getParcelableExtra(intent, BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)?.address
    } catch (_: Exception) {
      null
    } ?: return
    DriveSensePrefs.init(context)
    val pending = goAsync()
    try {
      DriveDetector.get(context).onCarConnected(address) { pending.finish() }
    } catch (e: Exception) {
      Log.w("DriveSense", "car connection not handled: ${e.javaClass.simpleName}")
      pending.finish()
    }
  }
}
