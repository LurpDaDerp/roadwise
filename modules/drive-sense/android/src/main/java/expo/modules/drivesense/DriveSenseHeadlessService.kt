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
 * The service holds a partial wake lock until its task finishes or it is destroyed, so it always
 * has a native owner that ends it (review N2N3 I4):
 * - the watchdog stops this service at once when it stops an unclaimed capture;
 * - a normal stop of the capture stops it after [CaptureService.HEADLESS_GRACE_MS];
 * - and the task itself is bounded by [TASK_TIMEOUT_MS], longer than any plausible drive. If a drive
 *   outlasts it, only this service (and its wake lock) ends: the capture keeps its own foreground
 *   service and wake lock, and the JS runtime keeps receiving rows.
 *
 * `isAllowedInForeground` true: the user may open the app mid-drive, and the task must keep running
 * (allowedInForeground: true).
 */
class DriveSenseHeadlessService : HeadlessJsTaskService() {
  companion object {
    const val TASK_KEY = "DriveSenseTask"

    /** Six hours: bounded, never 0, and never shorter than a real drive. */
    const val TASK_TIMEOUT_MS = 6L * 60 * 60 * 1000
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
    DriveSensePrefs.init(this)
    val data = Arguments.createMap()
    return HeadlessJsTaskConfig(
      taskKey = TASK_KEY,
      data = data,
      timeout = TASK_TIMEOUT_MS,
      isAllowedInForeground = true
    )
  }
}
