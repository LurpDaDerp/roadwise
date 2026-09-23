// Errors the module rejects with; `code` is a contract code (src/types.ts DMS_VISION_ERROR_CODES).
// JVM only: DmsVisionModule hands `code` and `message` to the promise.

package expo.modules.dmsvision

class DmsError private constructor(val code: String, message: String) : Exception(message) {
  companion object {
    fun badArgs(m: String) = DmsError("E_BAD_ARGS", m)
    fun permission(m: String) = DmsError("E_PERMISSION", m)
    fun notForeground(m: String) = DmsError("E_NOT_FOREGROUND", m)
    fun camera(m: String) = DmsError("E_CAMERA", m)
    fun model(m: String) = DmsError("E_MODEL", m)
    fun state(m: String) = DmsError("E_STATE", m)
  }
}
