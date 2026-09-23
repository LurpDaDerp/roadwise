// MediaPipe FaceLandmarker in LIVE_STREAM mode, with the facial transformation matrix on (the head
// pose source). Every symbol is verified against tasks-vision 0.10.35 (FaceLandmarker.java,
// FaceLandmarkerResult.java at tag v0.10.35): setOutputFacialTransformationMatrixes,
// setResultListener((result, input) -> …), setErrorListener, detectAsync(MPImage,
// ImageProcessingOptions, long), faceLandmarks(): List<List<NormalizedLandmark>>, and
// facialTransformationMatrixes(): Optional<List<float[]>> ("a flat column-major float array").
// Landmarks come back in the UNROTATED buffer frame; the rotation travels as
// ImageProcessingOptions.rotationDegrees (measured in V1).

package expo.modules.dmsvision

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult

/**
 * `onResult(timestampMs, landmarks 478×3 in the buffer frame or null, the matrix's 16 floats as
 * delivered or null, error or null)`, on MediaPipe's thread.
 */
class Landmarker(
  context: Context,
  gpu: Boolean,
  private val onResult: (Long, DoubleArray?, DoubleArray?, String?) -> Unit
) {
  @Volatile private var landmarker: FaceLandmarker?

  init {
    val base = BaseOptions.builder()
      .setModelAssetBuffer(DmsAssets.readDirectBuffer(context, "face_landmarker.task"))
      .setDelegate(if (gpu) Delegate.GPU else Delegate.CPU)
      .build()
    val options = FaceLandmarker.FaceLandmarkerOptions.builder()
      .setBaseOptions(base)
      .setRunningMode(RunningMode.LIVE_STREAM)
      .setNumFaces(1)
      .setMinFaceDetectionConfidence(0.5f)
      .setMinFacePresenceConfidence(0.5f)
      .setMinTrackingConfidence(0.5f)
      .setOutputFaceBlendshapes(false)
      .setOutputFacialTransformationMatrixes(true)
      .setResultListener { result, _ -> deliver(result) }
      .setErrorListener { error -> onResult(-1L, null, null, error.message ?: "landmarker error") }
      .build()
    landmarker = try {
      FaceLandmarker.createFromOptions(context, options)
    } catch (e: Exception) {
      throw DmsError.model("cannot create the FaceLandmarker: ${e.message}")
    }
  }

  /** MediaPipe copies the bitmap into its packet inside detectAsync; the caller may recycle it after. */
  fun detect(bitmap: Bitmap, rotationDegrees: Int, timestampMs: Long) {
    val lm = landmarker ?: throw DmsError.state("the landmarker is closed")
    val options = ImageProcessingOptions.builder().setRotationDegrees(rotationDegrees).build()
    lm.detectAsync(BitmapImageBuilder(bitmap).build(), options, timestampMs)
  }

  /** Only once no detectAsync can be running (CaptureController drains the analysis thread first). */
  fun close() {
    val lm = landmarker
    landmarker = null
    try { lm?.close() } catch (_: Exception) {}
  }

  private fun deliver(result: FaceLandmarkerResult?) {
    val ts = try { result?.timestampMs() ?: -1L } catch (_: Exception) { -1L }
    var landmarks: DoubleArray? = null
    val face = result?.faceLandmarks()?.firstOrNull()
    if (face != null && face.size == Landmarks.COUNT) {
      val out = DoubleArray(Landmarks.FLOATS)
      var finite = true
      for (i in 0 until Landmarks.COUNT) {
        val p = face[i]
        val x = p.x().toDouble()
        val y = p.y().toDouble()
        val z = p.z().toDouble()
        if (!x.isFinite() || !y.isFinite() || !z.isFinite()) { finite = false; break }
        out[i * 3] = x
        out[i * 3 + 1] = y
        out[i * 3 + 2] = z
      }
      if (finite) landmarks = out
    }
    var matrix: DoubleArray? = null
    if (landmarks != null) {
      // Copied as delivered; HeadPose.normaliseLayout decides the layout (Task 2 review I2).
      val m = result?.facialTransformationMatrixes()?.orElse(null)?.firstOrNull()
      if (m != null && m.size == 16) matrix = DoubleArray(16) { m[it].toDouble() }
    }
    onResult(ts, landmarks, matrix, null)
  }
}
