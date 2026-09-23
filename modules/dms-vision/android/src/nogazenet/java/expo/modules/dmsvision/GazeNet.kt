// The gaze network on a build WITHOUT DMS_GAZE_NET=1 (every production build): it does not exist.
// build.gradle compiles this source set only when the switch is off, and src/gazenet/java otherwise.
// No model, no ONNX Runtime.

package expo.modules.dmsvision

import android.content.Context

object GazeNetFactory {
  const val available = false
  val onnxRuntimeVersion: String? = null

  /** The model's sha256 (diagnostics); null without the net. */
  @Suppress("UNUSED_PARAMETER")
  fun modelSha256(context: Context): String? = null

  @Suppress("UNUSED_PARAMETER")
  fun make(context: Context): GazeNetRunner? = null
}
