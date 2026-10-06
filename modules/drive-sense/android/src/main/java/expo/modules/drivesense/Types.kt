package expo.modules.drivesense

// Input, output and state shapes of the extraction port — `src/extract/types.ts`, field for field.

/** One IMU sample after normalisation (device frame), `t` in epoch ms (may be fractional). */
data class ImuSample(val t: Double, val ua: Vec3, val g: Vec3, val w: Vec3)

/** One raw sample in the reference sign convention: `a` includes gravity, in g (face-up ≈ [0, 0, −1]). */
data class RawImuSample(val t: Double, val a: Vec3, val w: Vec3)

/** The gravity filter's carry-over between batches (`mags`: |a| of the last ≤ GRAVITY_GATE_SAMPLES − 1 samples, oldest first). */
data class GravityState(val g: Vec3?, val t: Double?, val mags: List<Double>)

/**
 * One GNSS fix as delivered (unknowns as negative numbers), `t` in epoch ms. `mock` (v3, plan §6):
 * the fix came from a mock location provider — it rides on the `row` payload beside the
 * FeatureRow keys and never enters the extractor.
 */
data class FixSample(
  val t: Double,
  val lat: Double,
  val lng: Double,
  val hAcc: Double,
  val speed: Double,
  val speedAcc: Double,
  val course: Double,
  val alt: Double,
  val mock: Boolean = false
)

data class PhoneSample(val locked: Boolean, val screenOn: Boolean, val appForeground: Boolean)

/** `setDriveDisplay`'s argument (plan §6): what the foreground notification shows. */
data class DriveDisplay(
  val speed: Double?,
  val limit: Double?,
  val unit: String,
  val points: Double?,
  val pointsDelta: Double?,
  val stopped: Boolean,
  val ended: Boolean
) {
  companion object {
    /** Before JS has sent anything: "— mph · limit —", no points, no action. */
    val EMPTY = DriveDisplay(null, null, "mph", null, null, stopped = false, ended = false)

    private fun num(v: Any?): Double? = (v as? Number)?.toDouble()?.takeIf { it.isFinite() }

    fun from(m: Map<String, Any?>): DriveDisplay = DriveDisplay(
      speed = num(m["speed"]),
      limit = num(m["limit"]),
      unit = if (m["unit"] == "km/h") "km/h" else "mph",
      points = num(m["points"]),
      pointsDelta = num(m["pointsDelta"]),
      stopped = m["stopped"] as? Boolean ?: false,
      ended = m["ended"] as? Boolean ?: false
    )
  }
}

/** M1's `FeatureRow`, exactly its 27 keys (README §4); the six DMS motion fields last (Task C0). */
data class FeatureRow(
  val ts: Long,
  val lat: Double,
  val lng: Double,
  val hAcc: Double,
  val speed: Double,
  val speedAcc: Double,
  val course: Double,
  val alt: Double,
  val gnssValid: Boolean,
  val aLonMax: Double,
  val aLonMin: Double,
  val aLatMax: Double,
  val aLatMin: Double,
  val yawRateMax: Double,
  val jerkMax: Double,
  val gravityStability: Double,
  val orientationDelta: Double,
  val handlingScore: Double,
  val locked: Boolean,
  val screenOn: Boolean,
  val appForeground: Boolean,
  // DMS motion evidence (Task C0): no IMU → false / 0 / null.
  val frameAligned: Boolean = false,
  val aLonMean: Double = 0.0,
  val accRms: Double? = null,
  val gravX: Double? = null,
  val gravY: Double? = null,
  val gravZ: Double? = null
) {
  /**
   * The bridge payload for the `row` event: exactly the contract's keys, finite numbers, integer ts;
   * a null optional is JSON null, never a dropped key.
   */
  fun toMap(): Map<String, Any?> = linkedMapOf(
    "ts" to ts,
    "lat" to lat,
    "lng" to lng,
    "hAcc" to hAcc,
    "speed" to speed,
    "speedAcc" to speedAcc,
    "course" to course,
    "alt" to alt,
    "gnssValid" to gnssValid,
    "aLonMax" to aLonMax,
    "aLonMin" to aLonMin,
    "aLatMax" to aLatMax,
    "aLatMin" to aLatMin,
    "yawRateMax" to yawRateMax,
    "jerkMax" to jerkMax,
    "gravityStability" to gravityStability,
    "orientationDelta" to orientationDelta,
    "handlingScore" to handlingScore,
    "locked" to locked,
    "screenOn" to screenOn,
    "appForeground" to appForeground,
    "frameAligned" to frameAligned,
    "aLonMean" to aLonMean,
    "accRms" to accRms,
    "gravX" to gravX,
    "gravY" to gravY,
    "gravZ" to gravZ
  )

  /** Every number finite (README §1). A row that is not is never emitted. */
  fun isFinite(): Boolean = listOf(
    lat, lng, hAcc, speed, speedAcc, course, alt, aLonMax, aLonMin, aLatMax, aLatMin,
    yawRateMax, jerkMax, gravityStability, orientationDelta, handlingScore, aLonMean
  ).all { it.isFinite() } && listOfNotNull(accRms, gravX, gravY, gravZ).all { it.isFinite() }
}

data class LastFix(val lat: Double, val lng: Double, val alt: Double)

data class PrevValidFix(val t: Double, val speed: Double)

data class PrevLon(val t: Double, val v: Double)

/** Forward-axis alignment and its reset detector (`AlignmentState`). */
data class AlignmentState(
  val f: Vec3?,
  val agree: Int,
  val aligned: Boolean,
  val gravityRing: List<Vec3>,
  val gravityDevS: Int
)

data class ExtractState(
  val lastFix: LastFix?,
  val prevValidFix: PrevValidFix?,
  val lastImuT: Double?,
  val hTail: List<Vec3>,
  val prevLon: PrevLon?,
  val alignment: AlignmentState
)
