package expo.modules.dmsvision

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * ONNX Runtime wrapper for the bundled gaze network (gaze_direct.onnx, 867,069 parameters).
 *
 * Mirrors deployment-stack/dms/gaze_model.py: batch 1, two intra-op threads, all graph
 * optimizations, inputs `cloud` (1, 478, 3) / `context` (1, 7) / `validity` (1, 478) float32,
 * outputs `gaze` (1, 3) and `rotation` (1, 3, 3). Mirror TTA is out of scope for this version.
 *
 * Pinned to com.microsoft.onnxruntime:onnxruntime-android 1.30.0; every API used here is verified
 * against microsoft/onnxruntime v1.30.0 java/src/main/java/ai/onnxruntime.
 */
class DmsVisionGaze {
  companion object {
    const val CLOUD_FLOATS = DMS_NUM_LANDMARKS * 3   // 1434
    const val CONTEXT_FLOATS = 7
    const val VALIDITY_FLOATS = DMS_NUM_LANDMARKS    // 478
    const val OUTPUT_FLOATS = 12                     // gaze[3] + rotation[9], row-major
  }

  private val lock = Any()
  private var environment: OrtEnvironment? = null
  private var session: OrtSession? = null
  private var metadata: JSONObject? = null

  /** Loads and caches gaze_direct.meta.json. Independent of the ORT session. */
  fun loadMetadata(context: Context): JSONObject = synchronized(lock) {
    metadata ?: run {
      val bytes = DmsVisionAssets.readBytes(context, "gaze_direct.meta.json")
      val parsed = try {
        JSONObject(String(bytes, Charsets.UTF_8))
      } catch (e: Exception) {
        throw DmsVisionException("gaze_direct.meta.json is not valid JSON: ${e.message}")
      }
      metadata = parsed
      parsed
    }
  }

  /** Creates the inference session if it does not exist yet. Safe to call repeatedly. */
  fun prepare(context: Context) = synchronized(lock) { prepareLocked(context) }

  private fun prepareLocked(context: Context) {
    if (session != null) return
    val model = DmsVisionAssets.readBytes(context, "gaze_direct.onnx")
    try {
      val env = OrtEnvironment.getEnvironment()
      val options = OrtSession.SessionOptions()
      options.setIntraOpNumThreads(2)
      options.setInterOpNumThreads(1)
      options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      session = env.createSession(model, options)
      environment = env
    } catch (e: Exception) {
      throw DmsVisionException("failed to create the ONNX session: ${e.message}")
    }
  }

  fun close() = synchronized(lock) {
    try {
      session?.close()
    } catch (_: Exception) {
      // ignore
    }
    session = null
    // OrtEnvironment.getEnvironment() is a process-wide singleton; it is not closed here.
    environment = null
  }

  /**
   * One batch-1 forward pass. [cloud] / [contextTensor] / [validity] are little-endian float32
   * byte arrays; the result is 12 little-endian float32: gaze[3] then rotation[9] row-major.
   */
  fun predict(
    context: Context,
    cloud: ByteArray,
    contextTensor: ByteArray,
    validity: ByteArray
  ): ByteArray {
    checkLength(cloud, CLOUD_FLOATS, "cloud")
    checkLength(contextTensor, CONTEXT_FLOATS, "context")
    checkLength(validity, VALIDITY_FLOATS, "validity")

    return synchronized(lock) {
      prepareLocked(context)
      val env = environment ?: throw DmsVisionException("the ONNX environment is not available")
      val ortSession = session ?: throw DmsVisionException("the ONNX session is not available")
      try {
        OnnxTensor.createTensor(env, floatsOf(cloud), longArrayOf(1, DMS_NUM_LANDMARKS.toLong(), 3))
          .use { cloudValue ->
            OnnxTensor.createTensor(env, floatsOf(contextTensor), longArrayOf(1, CONTEXT_FLOATS.toLong()))
              .use { contextValue ->
                OnnxTensor.createTensor(env, floatsOf(validity), longArrayOf(1, DMS_NUM_LANDMARKS.toLong()))
                  .use { validityValue ->
                    val inputs = mapOf(
                      "cloud" to cloudValue,
                      "context" to contextValue,
                      "validity" to validityValue
                    )
                    ortSession.run(inputs).use { result -> encodeOutputs(result) }
                  }
              }
          }
      } catch (e: DmsVisionException) {
        throw e
      } catch (e: Exception) {
        throw DmsVisionException("gaze inference failed: ${e.message}")
      }
    }
  }

  private fun encodeOutputs(result: OrtSession.Result): ByteArray {
    val gaze = result.get("gaze").orElse(null) as? OnnxTensor
      ?: throw DmsVisionException("the ONNX session did not return 'gaze'")
    val rotation = result.get("rotation").orElse(null) as? OnnxTensor
      ?: throw DmsVisionException("the ONNX session did not return 'rotation'")
    val gazeFloats = gaze.floatBuffer
    val rotationFloats = rotation.floatBuffer
    if (gazeFloats.remaining() != 3 || rotationFloats.remaining() != 9) {
      throw DmsVisionException(
        "unexpected output sizes: gaze ${gazeFloats.remaining()}, rotation ${rotationFloats.remaining()}"
      )
    }
    val out = ByteBuffer.allocate(OUTPUT_FLOATS * 4).order(ByteOrder.LITTLE_ENDIAN)
    while (gazeFloats.hasRemaining()) out.putFloat(gazeFloats.get())
    while (rotationFloats.hasRemaining()) out.putFloat(rotationFloats.get())
    return out.array()
  }

  private fun floatsOf(bytes: ByteArray) =
    ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()

  private fun checkLength(data: ByteArray, floats: Int, name: String) {
    if (data.size != floats * 4) {
      throw DmsVisionException("$name must be $floats float32 (${floats * 4} bytes), got ${data.size}")
    }
  }
}
