package expo.modules.drivesense.detect

/**
 * The live motion feed on Android (the iOS `ActivitySource.swift` live updates): while RoadWise
 * senses (a watch, a drive, a plain capture) Play services' activity recognition reports what the
 * phone is doing every 5 s, as a list of activities with a confidence (0-100) each. This maps one
 * report to the `activity` event's words (README §3) and to the detector's [MotionReport], the way
 * iOS maps a CMMotionActivity:
 * - the type is the most probable activity: IN_VEHICLE → `automotive`, ON_BICYCLE → `cycling`,
 *   WALKING → `walking`, RUNNING → `running`, ON_FOOT → whichever of walking and running the
 *   report rates higher (walking when neither is listed), STILL → `stationary`, anything else
 *   (TILTING, UNKNOWN) → `unknown`;
 * - its confidence: under 50 `low`, 50 to 74 `medium`, 75 and up `high`; medium and high are
 *   "confident", as iOS reads them.
 * The activity numbers are Play services' `DetectedActivity` constants (the source-text test holds
 * them equal). Pure.
 */
object LiveActivity {
  const val IN_VEHICLE = 0
  const val ON_BICYCLE = 1
  const val ON_FOOT = 2
  const val STILL = 3
  const val UNKNOWN = 4
  const val TILTING = 5
  const val WALKING = 7
  const val RUNNING = 8

  const val MEDIUM_MIN = 50
  const val HIGH_MIN = 75

  /** One activity of a report: Play services' type and its confidence (0-100). */
  data class Rated(val type: Int, val confidence: Int)

  /** The `activity` event's type and confidence. */
  data class Report(val type: String, val confidence: String) {
    val confident: Boolean get() = confidence != "low"

    /** The detector's view of it, arrived at [at] (epoch ms). */
    fun motion(at: Double): MotionReport = MotionReport(
      walking = type == "walking" || type == "running",
      cycling = type == "cycling",
      automotive = type == "automotive",
      stationary = type == "stationary",
      confident = confident,
      at = at
    )
  }

  fun bucket(confidence: Int): String = when {
    confidence >= HIGH_MIN -> "high"
    confidence >= MEDIUM_MIN -> "medium"
    else -> "low"
  }

  /** The report's words; null for an empty report. The first of equally rated activities wins. */
  fun of(list: List<Rated>): Report? {
    var best: Rated? = null
    for (a in list) if (best == null || a.confidence > best.confidence) best = a
    val top = best ?: return null
    val type = when (top.type) {
      IN_VEHICLE -> "automotive"
      ON_BICYCLE -> "cycling"
      WALKING -> "walking"
      RUNNING -> "running"
      ON_FOOT -> {
        val walk = list.firstOrNull { it.type == WALKING }?.confidence ?: -1
        val run = list.firstOrNull { it.type == RUNNING }?.confidence ?: -1
        if (run > walk) "running" else "walking"
      }
      STILL -> "stationary"
      else -> "unknown"
    }
    return Report(type, bucket(top.confidence))
  }
}

/**
 * A live motion report as the detector reads it (the iOS `MotionReport`), with when it arrived
 * (epoch ms). `walking`: walking or running.
 */
data class MotionReport(
  val walking: Boolean,
  val cycling: Boolean,
  val automotive: Boolean,
  val stationary: Boolean,
  /** medium or high */
  val confident: Boolean,
  val at: Double
)
