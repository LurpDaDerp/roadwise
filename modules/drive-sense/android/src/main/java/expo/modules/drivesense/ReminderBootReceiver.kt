package expo.modules.drivesense

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-registers the reminder's activity-transition feed after a reboot or an app update, which drop
 * Play services registrations. Disabled in the manifest and enabled by [TripReminder] only while
 * the reminder is on, so a phone without the reminder never runs it. It only subscribes (the
 * replayed current activity repairs the reminder's vehicle state); it never starts a capture.
 */
class ReminderBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    val pending = goAsync()
    DriveSensePrefs.init(context)
    ActivityTransitions.sync(context, force = true) { pending.finish() }
  }
}
