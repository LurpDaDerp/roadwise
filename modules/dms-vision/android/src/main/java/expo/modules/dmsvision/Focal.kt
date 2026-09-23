// The Android focal length for the gaze net's camera context (plan rev1: m11): `focalScale` =
// fx / upright width. Source 1: the camera characteristics, as the AOSP centred-crop rule (the stream
// is a centred crop of the active array with the stream's aspect ratio). Source 2: a 70° horizontal
// field of view. Used ONLY by the gaze net. Port of src/reference/focal.ts, pinned by the
// `focal-android` vector. JVM only; CameraSetup reads the characteristics.

package expo.modules.dmsvision

import kotlin.math.tan

/** The characteristic fields (lengths in mm, sizes in pixels). */
class SensorGeometry(
  val focalLengthMm: Double,
  val physicalWidthMm: Double,
  val physicalHeightMm: Double,
  val pixelArrayWidth: Int,
  val pixelArrayHeight: Int,
  val activeWidth: Int,
  val activeHeight: Int
)

object Focal {
  const val DEFAULT_HFOV_DEG = 70.0

  /** [fx, fy] of a `width` × `height` BUFFER, or null when a field is missing or unusable. */
  fun fromSensor(s: SensorGeometry?, width: Int, height: Int): DoubleArray? {
    if (s == null || width <= 0 || height <= 0) return null
    if (!(s.focalLengthMm > 0) || !(s.physicalWidthMm > 0) || !(s.physicalHeightMm > 0)) return null
    if (s.pixelArrayWidth <= 0 || s.pixelArrayHeight <= 0 || s.activeWidth <= 0 || s.activeHeight <= 0) return null
    val activeWidthMm = s.activeWidth * (s.physicalWidthMm / s.pixelArrayWidth)
    val activeHeightMm = s.activeHeight * (s.physicalHeightMm / s.pixelArrayHeight)
    val outAspect = width.toDouble() / height
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
    val fx = s.focalLengthMm * width / cropWidthMm
    val fy = s.focalLengthMm * height / cropHeightMm
    if (!fx.isFinite() || !fy.isFinite() || fx <= 1 || fy <= 1) return null
    return doubleArrayOf(fx, fy)
  }

  /** fx / upright width: the sensor's focal lengths, else the field of view (square pixels). */
  fun focalScale(s: SensorGeometry?, width: Int, height: Int, rotation: Int): Double {
    val swapped = rotation % 180 != 0
    val uprightWidth = (if (swapped) height else width).toDouble()
    if (uprightWidth <= 0) return 0.0
    val f = fromSensor(s, width, height)
    if (f != null) return (if (swapped) f[1] else f[0]) / uprightWidth
    val fxBuffer = width / (2 * tan(DEFAULT_HFOV_DEG * Math.PI / 360))
    return fxBuffer / uprightWidth
  }
}
