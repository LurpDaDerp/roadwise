// The one bitmap MediaPipe reads, reused every frame of a session (T4-I2): no per-frame allocation.
// Analysis thread only; released at teardown once the analysis thread is drained and the graph closed.

package expo.modules.dmsvision

import android.graphics.Bitmap
import androidx.camera.core.ImageProxy
import java.nio.ByteBuffer

class FrameBitmap {
  private var bitmap: Bitmap? = null
  /** Padded rows packed tightly, reused every frame. */
  private var packed: ByteBuffer? = null

  /**
   * Fills the session's ARGB_8888 bitmap (its memory is R, G, B, A bytes: CameraX's RGBA_8888 layout)
   * from plane 0 without allocating: straight from the plane when the rows are tight, otherwise
   * through the packed buffer. Reads go through a duplicate, so the plane's own buffer (read later by
   * LumaSource) is not moved. Reusing it is safe because the controller accepts a frame only once the
   * previous detection has answered, so MediaPipe cannot still be reading it.
   */
  fun fill(proxy: ImageProxy): Bitmap {
    val w = proxy.width
    val h = proxy.height
    var b = bitmap
    if (b == null || b.width != w || b.height != h) {
      b?.recycle()
      b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
      bitmap = b
    }
    val plane = proxy.planes[0]
    val src = plane.buffer.duplicate()
    val tight = w * h * 4
    if (plane.rowStride == w * 4 && plane.pixelStride == 4) {
      src.rewind()
      src.limit(tight)
      b.copyPixelsFromBuffer(src)
    } else {
      var p = packed
      if (p == null || p.capacity() != tight) {
        p = ByteBuffer.allocateDirect(tight)
        packed = p
      }
      p.clear()
      for (y in 0 until h) {
        src.limit(y * plane.rowStride + w * 4)
        src.position(y * plane.rowStride)
        p.put(src)
      }
      p.rewind()
      b.copyPixelsFromBuffer(p)
    }
    return b
  }

  fun release() {
    bitmap?.recycle()
    bitmap = null
    packed = null
  }
}
