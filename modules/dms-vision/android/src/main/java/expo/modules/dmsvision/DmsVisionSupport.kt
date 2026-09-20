package expo.modules.dmsvision

import android.content.Context
import android.graphics.Rect
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.os.PowerManager
import android.util.Size
import android.util.SizeF
import android.view.Surface
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

const val DMS_NUM_LANDMARKS = 478

class DmsVisionException(message: String) : CodedException(message)

// ---------------------------------------------------------------------------------------------
// Bundled assets
// ---------------------------------------------------------------------------------------------

/**
 * Reads a file from the module's own `src/main/assets` (merged into the app's assets at build
 * time). Nothing is downloaded and nothing is copied to the cache: MediaPipe takes the model as a
 * direct [ByteBuffer] and ONNX Runtime takes it as a byte array, so asset compression is
 * irrelevant.
 */
object DmsVisionAssets {
  fun readBytes(context: Context, name: String): ByteArray {
    try {
      context.assets.open(name).use { input ->
        val out = ByteArrayOutputStream(maxOf(input.available(), 1 shl 16))
        input.copyTo(out)
        return out.toByteArray()
      }
    } catch (e: Exception) {
      throw DmsVisionException("bundled asset $name is missing: ${e.message}")
    }
  }

  fun readDirectBuffer(context: Context, name: String): ByteBuffer {
    val bytes = readBytes(context, name)
    val buffer = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder())
    buffer.put(bytes)
    buffer.rewind()
    return buffer
  }
}

// ---------------------------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------------------------

/**
 * Maps the physical device orientation reported by `OrientationEventListener` to the
 * `Surface.ROTATION_*` value that `ImageAnalysis.setTargetRotation` expects. Verbatim from the
 * CameraX "Rotations" guidance.
 */
fun dmsSurfaceRotation(orientationDegrees: Int): Int = when {
  orientationDegrees >= 45 && orientationDegrees < 135 -> Surface.ROTATION_270
  orientationDegrees >= 135 && orientationDegrees < 225 -> Surface.ROTATION_180
  orientationDegrees >= 225 && orientationDegrees < 315 -> Surface.ROTATION_90
  else -> Surface.ROTATION_0
}

/** Names match the iOS side so the JS contract is platform-independent. */
fun dmsOrientationName(surfaceRotation: Int): String = when (surfaceRotation) {
  Surface.ROTATION_90 -> "landscapeLeft"
  Surface.ROTATION_180 -> "portraitUpsideDown"
  Surface.ROTATION_270 -> "landscapeRight"
  else -> "portrait"
}

// ---------------------------------------------------------------------------------------------
// Landmark transform
// ---------------------------------------------------------------------------------------------

/**
 * Rotates MediaPipe's normalized landmarks from the UNROTATED buffer frame into the upright frame
 * and serializes them as little-endian float32, point-major (x, y, z) * 478.
 *
 * MediaPipe Tasks returns landmarks in the unrotated input frame even when
 * `ImageProcessingOptions.rotationDegrees` is set. Measured with mediapipe 0.10.35 and this exact
 * `face_landmarker.task` (2026-09-18): the transform below reproduces the landmarks of a
 * physically pre-rotated image to 0.003-0.005 normalized units, while the raw buffer-frame points
 * differ by 0.28-0.45.
 *
 * `z` is NOT rescaled - MediaPipe already scales it by the projected face-ROI x-axis measured in
 * the output (x / W, y / H) frame, which for a 90/270 degree rotation equals the upright width.
 * See docs/dms/NATIVE_LAYER.md.
 */
fun dmsSerializeLandmarks(interleaved: FloatArray, rotationDegrees: Int): ByteArray {
  val rotation = ((rotationDegrees % 360) + 360) % 360
  val out = ByteBuffer.allocate(interleaved.size * 4).order(ByteOrder.LITTLE_ENDIAN)
  var i = 0
  while (i + 2 < interleaved.size) {
    val bx = interleaved[i]
    val by = interleaved[i + 1]
    val ux: Float
    val uy: Float
    when (rotation) {
      90 -> { ux = 1.0f - by; uy = bx }
      180 -> { ux = 1.0f - bx; uy = 1.0f - by }
      270 -> { ux = by; uy = 1.0f - bx }
      else -> { ux = bx; uy = by }
    }
    out.putFloat(ux)
    out.putFloat(uy)
    out.putFloat(interleaved[i + 2])
    i += 3
  }
  return out.array()
}

// ---------------------------------------------------------------------------------------------
// Camera intrinsics
// ---------------------------------------------------------------------------------------------

/**
 * Focal length and principal point in pixels of the DELIVERED (unrotated) analysis buffer.
 * `source` is "intrinsics" when it was derived from the camera characteristics and "default" when
 * the 70 degree fallback horizontal field of view was used.
 */
data class DmsIntrinsics(
  val fx: Double,
  val fy: Double,
  val cx: Double,
  val cy: Double,
  val bufferWidth: Int,
  val bufferHeight: Int,
  val source: String
) {
  fun uprightSize(rotationDegrees: Int): Pair<Int, Int> {
    val swapped = (((rotationDegrees % 360) + 360) % 360) % 180 != 0
    return if (swapped) Pair(bufferHeight, bufferWidth) else Pair(bufferWidth, bufferHeight)
  }

  /** `fx / uprightWidth`; a 90/270 degree rotation swaps the image axes. */
  fun focalScale(rotationDegrees: Int): Double {
    val swapped = (((rotationDegrees % 360) + 360) % 360) % 180 != 0
    val fxUpright = if (swapped) fy else fx
    val uprightWidth = (if (swapped) bufferHeight else bufferWidth).toDouble()
    if (uprightWidth <= 0.0 || !fxUpright.isFinite() || fxUpright <= 0.0) return 0.0
    return fxUpright / uprightWidth
  }

  companion object {
    const val DEFAULT_HORIZONTAL_FOV_DEGREES = 70.0

    fun fromFieldOfView(hfovDegrees: Double, width: Int, height: Int, source: String): DmsIntrinsics {
      val usable = hfovDegrees > 1.0 && hfovDegrees < 179.0
      val hfov = if (usable) hfovDegrees else DEFAULT_HORIZONTAL_FOV_DEGREES
      val fx = width.toDouble() / (2.0 * Math.tan(Math.toRadians(hfov / 2.0)))
      return DmsIntrinsics(fx, fx, width / 2.0, height / 2.0, width, height,
        if (usable) source else "default")
    }

    fun default(width: Int, height: Int): DmsIntrinsics =
      fromFieldOfView(DEFAULT_HORIZONTAL_FOV_DEGREES, width, height, "default")
      .copy(source = "default")
  }
}

/**
 * Computes the front camera's intrinsics for a delivered buffer of [width] x [height] from the
 * Camera2 characteristics, following the AOSP centre-crop rule:
 *
 *   mmPerPx   = physicalSize / pixelArraySize
 *   active_mm = activeArray * mmPerPx
 *   the stream is a CENTRED crop of the active array with the stream's aspect ratio
 *   fx_px     = focalLength_mm * outW / cropW_mm
 *
 * `LENS_INTRINSIC_CALIBRATION` is deliberately NOT used: AOSP marks it optional, it is commonly
 * null or zeroed on front cameras, and its units are pixels in the pre-correction active array
 * coordinate system, which is a different frame from the delivered buffer.
 *
 * The characteristics are read through `CameraManager` rather than CameraX's
 * `Camera2CameraInfo`, which is an opt-in experimental interop API; the first front-facing camera
 * id is the one `CameraSelector.DEFAULT_FRONT_CAMERA` resolves to.
 */
fun dmsFrontCameraIntrinsics(context: Context, width: Int, height: Int): DmsIntrinsics {
  if (width <= 0 || height <= 0) return DmsIntrinsics.default(maxOf(width, 1), maxOf(height, 1))
  try {
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    for (id in manager.cameraIdList) {
      val characteristics = manager.getCameraCharacteristics(id)
      if (characteristics.get(CameraCharacteristics.LENS_FACING) !=
        CameraCharacteristics.LENS_FACING_FRONT
      ) {
        continue
      }
      val focalLengths = characteristics.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
      val physical: SizeF? = characteristics.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
      val pixelArray: Size? = characteristics.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
      val activeArray: Rect? = characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
      if (focalLengths == null || focalLengths.isEmpty() || physical == null ||
        pixelArray == null || activeArray == null ||
        pixelArray.width <= 0 || pixelArray.height <= 0 ||
        activeArray.width() <= 0 || activeArray.height() <= 0 ||
        physical.width <= 0f || physical.height <= 0f
      ) {
        return DmsIntrinsics.default(width, height)
      }
      val focal = focalLengths[0].toDouble()
      if (focal <= 0.0) return DmsIntrinsics.default(width, height)

      val mmPerPxX = physical.width.toDouble() / pixelArray.width.toDouble()
      val mmPerPxY = physical.height.toDouble() / pixelArray.height.toDouble()
      val activeWidthMm = activeArray.width() * mmPerPxX
      val activeHeightMm = activeArray.height() * mmPerPxY

      val outAspect = width.toDouble() / height.toDouble()
      val activeAspect = activeWidthMm / activeHeightMm
      val cropWidthMm: Double
      val cropHeightMm: Double
      if (outAspect > activeAspect) {
        cropWidthMm = activeWidthMm
        cropHeightMm = activeWidthMm / outAspect
      } else {
        cropHeightMm = activeHeightMm
        cropWidthMm = activeHeightMm * outAspect
      }
      if (cropWidthMm <= 0.0 || cropHeightMm <= 0.0) return DmsIntrinsics.default(width, height)

      val fx = focal * width.toDouble() / cropWidthMm
      val fy = focal * height.toDouble() / cropHeightMm
      if (!fx.isFinite() || !fy.isFinite() || fx <= 1.0 || fy <= 1.0) {
        return DmsIntrinsics.default(width, height)
      }
      return DmsIntrinsics(fx, fy, width / 2.0, height / 2.0, width, height, "intrinsics")
    }
  } catch (_: Exception) {
    // fall through to the default
  }
  return DmsIntrinsics.default(width, height)
}

// ---------------------------------------------------------------------------------------------
// Thermal
// ---------------------------------------------------------------------------------------------

/** "nominal" | "fair" | "serious" | "critical" | "unknown" (below API 29). */
fun dmsThermalStateName(context: Context): String {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "unknown"
  val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return "unknown"
  return dmsThermalStatusName(power.currentThermalStatus)
}

fun dmsThermalStatusName(status: Int): String = when (status) {
  PowerManager.THERMAL_STATUS_NONE -> "nominal"
  PowerManager.THERMAL_STATUS_LIGHT, PowerManager.THERMAL_STATUS_MODERATE -> "fair"
  PowerManager.THERMAL_STATUS_SEVERE -> "serious"
  PowerManager.THERMAL_STATUS_CRITICAL,
  PowerManager.THERMAL_STATUS_EMERGENCY,
  PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
  else -> "unknown"
}

fun dmsLowPowerMode(context: Context): Boolean {
  val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
  return try {
    power.isPowerSaveMode
  } catch (_: Exception) {
    false
  }
}
