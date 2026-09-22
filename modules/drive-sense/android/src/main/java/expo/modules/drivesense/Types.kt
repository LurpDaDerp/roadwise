package expo.modules.drivesense

// Input, output and state shapes of the extraction port — `src/extract/types.ts`, field for field.

/** One IMU sample after normalisation (device frame), `t` in epoch ms (may be fractional). */
data class ImuSample(val t: Double, val ua: Vec3, val g: Vec3, val w: Vec3)

/** One raw sample in the reference sign convention: `a` includes gravity, in g (face-up ≈ [0, 0, −1]). */
data class RawImuSample(val t: Double, val a: Vec3, val w: Vec3)

/** The gravity filter's carry-over between batches (`mags`: |a| of the last ≤ GRAVITY_GATE_SAMPLES − 1 samples, oldest first). */
data class GravityState(val g: Vec3?, val t: Double?, val mags: List<Double>)

/** One GNSS fix as delivered (unknowns as negative numbers), `t` in epoch ms. */
data class FixSample(
  val t: Double,
  val lat: Double,
  val lng: Double,
  val hAcc: Double,
  val speed: Double,
  val speedAcc: Double,
  val course: Double,
  val alt: Double
)

data class PhoneSample(val locked: Boolean, val screenOn: Boolean, val appForeground: Boolean)

/** M1's `FeatureRow`, exactly its 21 keys (README §4). */
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
  val appForeground: Boolean
) {
  /** The bridge payload for the `row` event: exactly the contract's keys, finite numbers, integer ts. */
  fun toMap(): Map<String, Any> = linkedMapOf(
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
    "appForeground" to appForeground
  )

  /** Every number finite (README §1). A row that is not is never emitted. */
  fun isFinite(): Boolean = listOf(
    lat, lng, hAcc, speed, speedAcc, course, alt, aLonMax, aLonMin, aLatMax, aLatMin,
    yawRateMax, jerkMax, gravityStability, orientationDelta, handlingScore
  ).all { it.isFinite() }
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
