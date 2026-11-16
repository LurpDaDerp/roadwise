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

/**
 * `setDriveDisplay`'s argument (plan §6): what the drive notification shows, the Live Activity's
 * content field for field (`LiveDriveAttributes.ContentState`, validated as `liveDriveStateSchema`
 * validates it in JS: a value that does not fit is left out, never guessed at). The points and the
 * stopped flag JS still sends are not read: nothing on the notification shows them.
 */
data class DriveDisplay(
  /** Current speed in [unit]; null shows "-". */
  val speed: Double?,
  /** Posted limit in [unit]; null shows "-". */
  val limit: Double?,
  /** "mph" draws the US SPEED LIMIT plate, "km/h" the round red-ringed sign. */
  val unit: String,
  /** The drive is over (JS's last call before `stopCapture`): nothing more is posted for it. */
  val ended: Boolean = false,
  /** The driving screen's numeral colour at its speeding tint ("#RRGGBB"); null: the plain text colour. */
  val speedTint: String? = null,
  /** Over the limit now (TalkBack only). */
  val speeding: Boolean = false,
  /** The "Not driving?" hint shows. */
  val notDrivingAvailable: Boolean = false,
  /** The driving screen's dangerous-weather alert: its kind (a DangerKind id) and its title; both or neither. */
  val weatherKind: String? = null,
  val weatherText: String? = null,
  /** The app's sky ("#RRGGBB"): the driving screen's deepened sky top to bottom, and the sky accent. */
  val skyTop: String? = null,
  val skyMid: String? = null,
  val skyLow: String? = null,
  val accent: String? = null
) {
  /**
   * What shows once no update has come for [DriveNotificationText.STALE_AFTER_MS] (the app is gone),
   * as the widget's `displayState` does past its stale date: speed unknown, no tint, no hint, no
   * weather; the limit, the unit and the sky stay.
   */
  fun stale(): DriveDisplay = copy(
    speed = null,
    speedTint = null,
    speeding = false,
    notDrivingAvailable = false,
    weatherKind = null,
    weatherText = null
  )

  companion object {
    /** Before JS has sent anything: "- mph", "Limit -", navy. */
    val EMPTY = DriveDisplay(null, null, "mph")

    private fun num(v: Any?): Double? = (v as? Number)?.toDouble()?.takeIf { it.isFinite() }

    private val HEX = Regex("^#[0-9A-Fa-f]{6}$")

    /** A DangerKind id, as `liveDriveStateSchema` takes it. */
    private val KIND = Regex("^[a-z][a-z_]{0,31}$")

    /** The weather title's longest (`liveDriveStateSchema`: 1 to 60 characters). */
    private const val WEATHER_TEXT_MAX = 60

    private fun hex(v: Any?): String? = (v as? String)?.takeIf { HEX.matches(it) }

    private fun kind(v: Any?): String? = (v as? String)?.takeIf { KIND.matches(it) }

    private fun title(v: Any?): String? = (v as? String)?.takeIf { it.isNotEmpty() && it.length <= WEATHER_TEXT_MAX }

    fun from(m: Map<String, Any?>): DriveDisplay {
      // The weather line shows its symbol and its words, so it is both or nothing (the widget's WeatherLine).
      val kind = kind(m["weatherKind"])
      val text = title(m["weatherText"])
      val weather = kind != null && text != null
      return DriveDisplay(
        speed = num(m["speed"]),
        limit = num(m["limit"]),
        unit = if (m["unit"] == "km/h") "km/h" else "mph",
        ended = m["ended"] as? Boolean ?: false,
        speedTint = hex(m["speedTint"]),
        speeding = m["speeding"] as? Boolean ?: false,
        notDrivingAvailable = m["notDrivingAvailable"] as? Boolean ?: false,
        weatherKind = if (weather) kind else null,
        weatherText = if (weather) text else null,
        skyTop = hex(m["skyTop"]),
        skyMid = hex(m["skyMid"]),
        skyLow = hex(m["skyLow"]),
        accent = hex(m["accent"])
      )
    }
  }
}

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
