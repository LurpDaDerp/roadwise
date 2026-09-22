package expo.modules.drivesense

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the JS drive host while the app is not open (design §2.4, rev1: I15). [CaptureService]
 * starts it after its own foreground start (a transition wake or a sticky restart); JS registers
 * the task as `DriveSenseTask` (H2's `registerDriveHeadlessTask`), claims the capture with
 * `startCapture`, records until the drive is idle and uploads once. If that boot throws, the task
 * itself calls `stopCapture` (H2), and the native [Watchdog] is the second line.
 *
 * Timeout 0: a drive lasts as long as it lasts, and the task must not be killed mid-drive — the
 * watchdog, not a task timeout, is what stops an orphaned capture. `isAllowedInForeground` true:
 * the user may open the app mid-drive, and the task must keep running (allowedInForeground: true).
 */
class DriveSenseHeadlessService : HeadlessJsTaskService() {
  companion object {
    const val TASK_KEY = "DriveSenseTask"
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
    DriveSensePrefs.init(this)
    val data = Arguments.createMap()
    return HeadlessJsTaskConfig(
      taskKey = TASK_KEY,
      data = data,
      timeout = 0L,
      isAllowedInForeground = true
    )
  }
}
