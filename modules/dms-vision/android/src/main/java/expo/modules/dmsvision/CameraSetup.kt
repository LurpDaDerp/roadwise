// CameraX configuration: the analysis use case (RGBA_8888, keep-only-latest, about 640×480, no
// output rotation), the sensor cadence through the AE target range, the front camera's
// characteristics for the focal length, and the OS names the status reports. Every CameraX and
// Camera2 symbol here compiled in V1 against CameraX 1.4.2 (EAS builds e334cbc2 / cc91ab36).

package expo.modules.dmsvision

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.os.Build
import android.os.PowerManager
import android.util.Range
import android.util.Size
import android.view.Surface
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy

object CameraSetup {
  /**
   * RGBA_8888 so pixels are read as (R, G, B, A) at y·rowStride + x·pixelStride; keep-only-latest so a
   * busy pipeline drops frames instead of queueing them. Output rotation stays off (the default; it costs a
   * full copy per frame): the rotation travels to MediaPipe and the features as metadata. Analysis
   * buffers are never mirrored on CameraX.
   */
  fun buildAnalysis(targetRotation: Int): ImageAnalysis =
    ImageAnalysis.Builder()
      .setResolutionSelector(
        ResolutionSelector.Builder()
          .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
          .setResolutionStrategy(ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
          .build()
      )
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
      .setTargetRotation(targetRotation)
      .build()

  /**
   * Final review M-7: prefer a range that CONTAINS the policy fps (lower ≤ fps ≤ upper), the smallest upper
   * (so [5,15] or [7,15] at 5 fps rather than [15,15]: the sensor, and CameraX's RGBA conversion, run no
   * faster than needed); failing that, the old rule: the smallest upper ≥ fps, then the highest lower.
   */
  fun chooseFpsRange(available: Array<Range<Int>>, fps: Int): Range<Int>? {
    var containing: Range<Int>? = null
    var best: Range<Int>? = null
    for (range in available) {
      if (range.upper < fps) continue
      if (range.lower <= fps && fps <= range.upper) {
        val c = containing
        if (c == null || range.upper < c.upper || (range.upper == c.upper && range.lower > c.lower)) containing = range
      }
      val current = best
      if (current == null || range.upper < current.upper || (range.upper == current.upper && range.lower > current.lower)) best = range
    }
    return containing ?: best
  }

  /**
   * Drive the sensor at `fps` through CONTROL_AE_TARGET_FPS_RANGE (the range chooseFpsRange picks; a fixed
   * range stops auto-exposure from stretching the exposure in low light). Returns the range sent, or null
   * when the camera keeps its own (the software throttle still holds the cadence).
   */
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
  fun applyCadence(camera: Camera, fps: Int): Range<Int>? {
    val available = try {
      Camera2CameraInfo.from(camera.cameraInfo).getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
    } catch (_: Exception) {
      null
    } ?: return null
    val wanted = chooseFpsRange(available, fps) ?: return null
    return try {
      Camera2CameraControl.from(camera.cameraControl).setCaptureRequestOptions(
        CaptureRequestOptions.Builder().setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, wanted).build()
      )
      wanted
    } catch (_: Exception) {
      null
    }
  }

  /**
   * The first front camera's characteristics (the one DEFAULT_FRONT_CAMERA resolves to), for
   * Focal.focalScale; null when any field is missing. LENS_INTRINSIC_CALIBRATION is not used: it is
   * optional, often zero on front cameras, and in another coordinate frame.
   */
  fun sensorGeometry(context: Context): SensorGeometry? {
    return try {
      val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      for (id in manager.cameraIdList) {
        val c = manager.getCameraCharacteristics(id)
        if (c.get(CameraCharacteristics.LENS_FACING) != CameraCharacteristics.LENS_FACING_FRONT) continue
        val focal = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull() ?: return null
        val physical = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE) ?: return null
        val pixels = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE) ?: return null
        val active = c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE) ?: return null
        return SensorGeometry(
          focal.toDouble(), physical.width.toDouble(), physical.height.toDouble(),
          pixels.width, pixels.height, active.width(), active.height()
        )
      }
      null
    } catch (_: Exception) {
      null
    }
  }

  /** The device orientation (OrientationEventListener degrees) → the analysis target rotation. */
  fun surfaceRotation(orientationDegrees: Int): Int = when {
    orientationDegrees in 45 until 135 -> Surface.ROTATION_270
    orientationDegrees in 135 until 225 -> Surface.ROTATION_180
    orientationDegrees in 225 until 315 -> Surface.ROTATION_90
    else -> Surface.ROTATION_0
  }

  /** "nominal" | "fair" | "serious" | "critical" | "unknown" (the status schema's names). */
  fun thermalName(context: Context): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "unknown"
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return "unknown"
    return thermalName(power.currentThermalStatus)
  }

  fun thermalName(status: Int): String = when (status) {
    // README §6: level 1 is MODERATE; LIGHT is below the floor's first step.
    PowerManager.THERMAL_STATUS_NONE, PowerManager.THERMAL_STATUS_LIGHT -> "nominal"
    PowerManager.THERMAL_STATUS_MODERATE -> "fair"
    PowerManager.THERMAL_STATUS_SEVERE -> "serious"
    PowerManager.THERMAL_STATUS_CRITICAL, PowerManager.THERMAL_STATUS_EMERGENCY, PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
    else -> "unknown"
  }

  fun lowPower(context: Context): Boolean {
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return try { power.isPowerSaveMode } catch (_: Exception) { false }
  }
}
