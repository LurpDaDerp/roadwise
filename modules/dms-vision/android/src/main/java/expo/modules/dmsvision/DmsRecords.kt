// The argument records of `start` and `setPolicy`. Their field names are EXACTLY the keys of
// src/wire.ts `startOptionsSchema` / `capturePolicySchema` (native-android.test.ts compares them).
// Every field is nullable here so a missing or mistyped value is refused by `validated()` with
// E_BAD_ARGS, never by the bridge with a generic error.

package expo.modules.dmsvision

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class StartOptions(val token: String, val fps: Int, val gazeNet: Boolean, val every: Int, val gpu: Boolean, val rotationOffset: Int)

class StartOptionsRecord : Record {
  @Field var gateToken: String? = null
  @Field var fps: Double? = null
  @Field var gazeNet: Boolean? = null
  @Field var gazeNetEvery: Double? = null
  @Field var delegate: String? = null
  @Field var rotationOffsetDegrees: Double? = null

  fun validated(): StartOptions {
    val token = gateToken?.takeIf { it.isNotEmpty() } ?: throw DmsError.badArgs("a gate token is required")
    val f = fps?.takeIf { v -> DmsConstants.ALLOWED_FPS.any { it.toDouble() == v } } ?: throw DmsError.badArgs("fps")
    val net = gazeNet ?: throw DmsError.badArgs("gazeNet")
    val e = gazeNetEvery?.takeIf { it == 1.0 || it == 2.0 } ?: throw DmsError.badArgs("gazeNetEvery")
    val d = delegate?.takeIf { it == "cpu" || it == "gpu" } ?: throw DmsError.badArgs("delegate")
    val r = rotationOffsetDegrees?.takeIf { v -> DmsConstants.ALLOWED_ROTATIONS.any { it.toDouble() == v } }
      ?: throw DmsError.badArgs("rotationOffsetDegrees")
    return StartOptions(token, f.toInt(), net, e.toInt(), d == "gpu", r.toInt())
  }
}

class CapturePolicy(
  val token: String, val capture: String, val fps: Int, val gazeNet: Boolean, val every: Int,
  val setupMode: Boolean, val previewAllowed: Boolean
)

class CapturePolicyRecord : Record {
  @Field var gateToken: String? = null
  @Field var capture: String? = null
  @Field var fps: Double? = null
  @Field var gazeNet: Boolean? = null
  @Field var gazeNetEvery: Double? = null
  @Field var setupMode: Boolean? = null
  @Field var previewAllowed: Boolean? = null

  fun validated(): CapturePolicy {
    val token = gateToken?.takeIf { it.isNotEmpty() } ?: throw DmsError.badArgs("a gate token is required")
    val c = capture?.takeIf { it == "run" || it == "pause" } ?: throw DmsError.badArgs("capture")
    val f = fps?.takeIf { v -> DmsConstants.ALLOWED_FPS.any { it.toDouble() == v } } ?: throw DmsError.badArgs("fps")
    val net = gazeNet ?: throw DmsError.badArgs("gazeNet")
    val e = gazeNetEvery?.takeIf { it == 1.0 || it == 2.0 } ?: throw DmsError.badArgs("gazeNetEvery")
    val setup = setupMode ?: throw DmsError.badArgs("setupMode")
    val preview = previewAllowed ?: throw DmsError.badArgs("previewAllowed")
    return CapturePolicy(token, c, f.toInt(), net, e.toInt(), setup, preview)
  }
}
