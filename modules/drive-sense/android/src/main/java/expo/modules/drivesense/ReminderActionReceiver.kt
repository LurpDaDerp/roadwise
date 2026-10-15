package expo.modules.drivesense

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The reminder's "Not driving" action. Not exported: reached only through the explicit
 * PendingIntent [TripReminderNotifier] builds. It takes the note down and quiets the reminder for
 * [TripReminderPolicy.NOT_DRIVING_QUIET_MS]; it opens nothing and starts nothing.
 */
class ReminderActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != TripReminderNotifier.ACTION_NOT_DRIVING) return
    DriveSensePrefs.init(context)
    TripReminder.onNotDriving(context)
  }
}
