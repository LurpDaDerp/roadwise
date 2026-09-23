// The module's only logging: static event codes, never values (no times, landmarks, sizes or
// messages from the camera stack), so a log can never carry anything about the driver.

package expo.modules.dmsvision

import android.util.Log

object DmsLog {
  enum class Code {
    SESSION_STARTED, SESSION_STOPPED, SESSION_PAUSED, SESSION_RESUMED, BACKGROUND_STOPPED,
    THERMAL_PAUSED, WATCHDOG_PAUSED, WATCHDOG_STOPPED, MODELS_RELEASED, CAMERA_INTERRUPTED,
    CAMERA_ERROR, INTERRUPTION_ENDED, GAZE_NET_FAILED
  }

  private const val TAG = "DmsVision"

  fun code(c: Code) {
    Log.i(TAG, c.name)
  }
}
