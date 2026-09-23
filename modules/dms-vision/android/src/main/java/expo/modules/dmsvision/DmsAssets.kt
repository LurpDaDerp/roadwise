// The bundled models, read from the module's assets (merged into the app's at build time). Nothing
// is downloaded or copied to storage: MediaPipe takes a direct ByteBuffer and ONNX Runtime a byte
// array, so asset compression does not matter.

package expo.modules.dmsvision

import android.content.Context
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

object DmsAssets {
  fun readBytes(context: Context, name: String): ByteArray {
    try {
      context.assets.open(name).use { input ->
        val out = ByteArrayOutputStream(maxOf(input.available(), 1 shl 16))
        input.copyTo(out)
        return out.toByteArray()
      }
    } catch (e: Exception) {
      throw DmsError.model("the bundled asset $name is missing: ${e.message}")
    }
  }

  fun readDirectBuffer(context: Context, name: String): ByteBuffer {
    val bytes = readBytes(context, name)
    val buffer = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder())
    buffer.put(bytes)
    buffer.rewind()
    return buffer
  }

  /** sha256 of a bundled file (diagnostics only; computed on request, never per frame). */
  fun sha256(context: Context, name: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(readBytes(context, name))
    return digest.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
  }
}
