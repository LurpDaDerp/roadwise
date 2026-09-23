// The gaze network (gaze_direct.onnx, 867,069 parameters), compiled ONLY with DMS_GAZE_NET=1: the
// release gate keeps it and ONNX Runtime out of production builds (README §7, THIRD_PARTY.md).
// Session: CPU, one intra-op and one inter-op thread, spinning off, all graph optimisations. Every
// API used here was verified against onnxruntime-android 1.30.0 in V1.

package expo.modules.dmsvision

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import java.nio.FloatBuffer

object GazeNetFactory {
  const val available = true
  val onnxRuntimeVersion: String? = "1.30.0"

  fun modelSha256(context: Context): String? =
    try { DmsAssets.sha256(context, "gaze_direct.onnx") } catch (_: Exception) { null }

  fun make(context: Context): GazeNetRunner? = OrtGazeNet(DmsAssets.readBytes(context, "gaze_direct.onnx"))
}

class OrtGazeNet(model: ByteArray) : GazeNetRunner {
  private val lock = Any()
  private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
  private var session: OrtSession?

  init {
    val options = OrtSession.SessionOptions()
    options.setIntraOpNumThreads(1)
    options.setInterOpNumThreads(1)
    options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
    // A spinning worker between frames is a permanently hot core; this model's wake-up cost is tiny.
    options.addConfigEntry("session.intra_op.allow_spinning", "0")
    options.addConfigEntry("session.inter_op.allow_spinning", "0")
    session = try {
      env.createSession(model, options)
    } catch (e: Exception) {
      throw DmsError.model("cannot create the gaze session: ${e.message}")
    }
  }

  override fun close() {
    synchronized(lock) {
      try { session?.close() } catch (_: Exception) {}
      session = null
      // OrtEnvironment is a process-wide singleton; it is not closed here.
    }
  }

  override fun run(cloud: FloatArray, context: FloatArray, validity: FloatArray): Pair<DoubleArray, DoubleArray> {
    if (cloud.size != 1434 || context.size != 7 || validity.size != 478) {
      throw DmsError.badArgs("gaze inputs have the wrong sizes")
    }
    synchronized(lock) {
      val s = session ?: throw DmsError.model("the gaze session is closed")
      OnnxTensor.createTensor(env, FloatBuffer.wrap(cloud), longArrayOf(1, 478, 3)).use { c ->
        OnnxTensor.createTensor(env, FloatBuffer.wrap(context), longArrayOf(1, 7)).use { x ->
          OnnxTensor.createTensor(env, FloatBuffer.wrap(validity), longArrayOf(1, 478)).use { v ->
            s.run(mapOf("cloud" to c, "context" to x, "validity" to v)).use { result ->
              val gaze = result.get("gaze").orElse(null) as? OnnxTensor
                ?: throw DmsError.model("the gaze session did not return gaze")
              val rotation = result.get("rotation").orElse(null) as? OnnxTensor
                ?: throw DmsError.model("the gaze session did not return rotation")
              val g = gaze.floatBuffer
              val r = rotation.floatBuffer
              if (g.remaining() != 3 || r.remaining() != 9) throw DmsError.model("unexpected gaze output sizes")
              return Pair(DoubleArray(3) { g.get().toDouble() }, DoubleArray(9) { r.get().toDouble() })
            }
          }
        }
      }
    }
  }
}
