package expo.modules.drivesense

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms the activity-transition subscription after a reboot or an app update, both of which drop
 * it (design §2.4). Only if the persisted armed flag is set AND the permissions arming needs are
 * still granted; otherwise the flag is cleared so nothing re-arms without permission (README §2).
 * No GPS, no capture: a capture open before a reboot is left for JS to recover (`captureWasOpen`).
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    val prefs = DriveSensePrefs.init(context)
    if (!prefs.armed) return
    val permitted = DriveSensePermissions.location(context) == "always" &&
      DriveSensePermissions.motion(context) == "granted"
    if (!permitted) {
      prefs.armed = false
      return
    }
    val pending = goAsync()
    ActivityTransitions.subscribe(context) { error ->
      if (error != null) prefs.armed = false
      pending.finish()
    }
    EventBus.emit("wake", linkedMapOf("reason" to "boot", "ts" to System.currentTimeMillis()))
  }
}
