// The DmsVision wire and lifecycle constants. Every value mirrors modules/dms-vision/src/constants.ts,
// the single source (plan rev1: m1); __tests__/native-android.test.ts compares them. JVM only.

package expo.modules.dmsvision

object DmsConstants {
  const val FRAME_WIRE_VERSION = 1
  const val FRAME_STRIDE = 38
  const val FRAME_BYTES = 152
  const val BATCH_MS = 100
  const val WATCHDOG_PAUSE_MS = 10000
  const val WATCHDOG_STOP_MS = 60000
  const val MODEL_RELEASE_AFTER_PAUSE_MS = 300000
  const val THERMAL_L1_ENTRY_DWELL_MS = 60000
  const val THERMAL_COOL_DWELL_MS = 60000
  const val MAX_T_OFF_MS = 10000

  val ALLOWED_FPS: List<Int> = listOf(5, 8, 10, 15)
  val ALLOWED_ROTATIONS: List<Int> = listOf(0, 90, 180, 270)

  /** Thermal floor per level 0..3 (design §3.5: 15 → 8 → landmarks only → off). */
  val THERMAL_FPS_CAP: List<Int> = listOf(15, 8, 8, 0)
  val THERMAL_GAZE_NET: List<Boolean> = listOf(true, true, false, false)

  const val FLAG_NET_RAN = 1
  const val FLAG_EYE_CLIPPED_R = 2
  const val FLAG_EYE_CLIPPED_L = 4
  const val FLAG_MOUTH_CLIPPED = 8
  const val FLAG_POSE_MISSING = 16

  /** FRAME_FIELDS, in wire order. */
  val FIELD_NAMES: List<String> = listOf(
    "tOffMs", "face", "boxCx", "boxCy", "boxW", "boxH", "iod", "headYaw", "headPitch", "headRoll",
    "netYaw", "netPitch", "earR", "earL", "eyeWR", "eyeWL", "eyeLumaR", "eyeLumaL", "irisContrastR",
    "irisContrastL", "eyeSatR", "eyeSatL", "irisOxR", "irisOyR", "irisOxL", "irisOyL", "irisInR",
    "irisInL", "faceLuma", "blur", "mar", "mouthW", "frameLuma", "rotationDeg", "latLandmarkMs",
    "latTotalMs", "flags", "reserved"
  )
}

/** Record field indices (FRAME_FIELDS order). */
object F {
  const val tOffMs = 0
  const val face = 1
  const val boxCx = 2
  const val boxCy = 3
  const val boxW = 4
  const val boxH = 5
  const val iod = 6
  const val headYaw = 7
  const val headPitch = 8
  const val headRoll = 9
  const val netYaw = 10
  const val netPitch = 11
  const val earR = 12
  const val earL = 13
  const val eyeWR = 14
  const val eyeWL = 15
  const val eyeLumaR = 16
  const val eyeLumaL = 17
  const val irisContrastR = 18
  const val irisContrastL = 19
  const val eyeSatR = 20
  const val eyeSatL = 21
  const val irisOxR = 22
  const val irisOyR = 23
  const val irisOxL = 24
  const val irisOyL = 25
  const val irisInR = 26
  const val irisInL = 27
  const val faceLuma = 28
  const val blur = 29
  const val mar = 30
  const val mouthW = 31
  const val frameLuma = 32
  const val rotationDeg = 33
  const val latLandmarkMs = 34
  const val latTotalMs = 35
  const val flags = 36
  const val reserved = 37
}
