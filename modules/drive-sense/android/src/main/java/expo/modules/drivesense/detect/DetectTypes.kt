package expo.modules.drivesense.detect

import expo.modules.drivesense.FeatureRow

// The drive detector's vocabulary on Android: the Kotlin shapes of the types in
// `src/detect/policy.ts`, field for field, so `DetectPolicy` can be a line-by-line port of the
// TypeScript reference. Pure: no android.*, androidx.* or org.json, so the JVM unit tests
// (src/test) run every rule. Every time is epoch ms and every speed m/s, as Double like the
// reference's `number` (a row's ts is a whole number of ms, which a Double holds exactly, and the
// self-test's rows 997 ms apart need no rounding). The string unions of the reference are enums
// here; `wire` is the reference's spelling, which the self-test and the bridge read and write.

/** Anything with a place: a row, a fix, the last end (policy.ts `LatLng`, read structurally there). */
interface GeoPoint {
  val lat: Double
  val lng: Double
}

data class LatLng(override val lat: Double, override val lng: Double) : GeoPoint

/** The row fields the detector reads (policy.ts `DetectRow`; a `FeatureRow` has them all). */
data class DetectRow(
  val ts: Double,
  override val lat: Double,
  override val lng: Double,
  val hAcc: Double,
  val speed: Double,
  val speedAcc: Double,
  val gnssValid: Boolean
) : GeoPoint {
  companion object {
    /** The detector's view of a capture row: its integer ts as epoch ms, the rest as it is. */
    fun of(row: FeatureRow): DetectRow =
      DetectRow(row.ts.toDouble(), row.lat, row.lng, row.hAcc, row.speed, row.speedAcc, row.gnssValid)
  }
}

/** The last committed end: when it was decided, the cut, the place (policy.ts `DetectLastEnd`). */
data class DetectLastEnd(
  val decidedAt: Double,
  val cut: Double,
  override val lat: Double,
  override val lng: Double,
  val driveId: String
) : GeoPoint

/** A rule's answer for one row: the state to carry on with, and whether it confirmed. */
data class PolicyStep<S>(val state: S, val confirmed: Boolean)

enum class TriggerKind(val wire: String) {
  AUTO("auto"),
  MANUAL("manual");

  companion object {
    fun of(wire: String): TriggerKind? = entries.firstOrNull { it.wire == wire }
  }
}

enum class DetectPhase(val wire: String) {
  OFF("off"),
  ARMED("armed"),
  CANDIDATE("candidate"),
  RECORDING("recording"),
  ENDING("ending"),
  SUPPRESSED("suppressed");

  companion object {
    fun of(wire: String): DetectPhase? = entries.firstOrNull { it.wire == wire }
  }
}

enum class StartSource(val wire: String) {
  TRACE("trace"),
  MOTION("motion"),
  WAKE("wake")
}

/**
 * What woke the detector, in the reference's words. `REGION` (leaving the parked spot) and `APP`
 * (RoadWise came to the front) ignore the rest after an empty candidate; the others honour it. The
 * Android runtime names its own wakes with these (which wake counts as which is the runtime's).
 */
enum class WakeReason(val wire: String) {
  SLC("slc"),
  REGION("region"),
  VISIT("visit"),
  APP("app"),
  /** Android only (ruling 2): a paired car's Bluetooth connecting. */
  CAR("car");

  companion object {
    fun of(wire: String): WakeReason? = entries.firstOrNull { it.wire == wire }
  }
}

enum class WakeGate(val wire: String) {
  OK("ok"),
  OFF("off"),
  NO_OWNER("noOwner"),
  PERMISSION("permission"),
  BUSY("busy"),
  RESTING("resting"),
  CAPPED("capped")
}

enum class MotionGate(val wire: String) {
  OK("ok"),
  NOT_FRESH("notFresh"),
  ON_FOOT("onFoot")
}

enum class CandidateCause(val wire: String) {
  CAP("cap"),
  TIMEOUT("timeout"),
  WALKING("walking"),
  WAIT_TIMEOUT("waitTimeout")
}

enum class SafetyCause(val wire: String) {
  STILL("still"),
  WALKING("walking"),
  LIMIT("limit")
}

enum class SuppressionCause(val wire: String) {
  CAP("cap"),
  WALKING("walking"),
  STILL("still")
}

enum class ResumeDecision(val wire: String) {
  RESUME("resume"),
  ORPHAN("orphan")
}

// ——— Wakes ———

/** One motion-history sample as the wake reads it (policy.ts `ActivitySample`). */
data class ActivitySample(
  val start: Double,
  val automotive: Boolean,
  /** A car standing still (automotive + stationary) is no car motion. */
  val stationary: Boolean,
  /** walking, running or cycling */
  val onFoot: Boolean,
  val confident: Boolean
)

data class MotionSummary(
  /** When the newest moving car motion ended (0: none). */
  val lastAutomotiveAt: Double,
  /** When the car run it belongs to began (0: none). */
  val automotiveSince: Double,
  /** The newest sample is a confident walk, run or ride. */
  val onFootNow: Boolean
)

data class WakeCtx(
  val now: Double,
  val reason: WakeReason,
  val phase: DetectPhase,
  /** JS armed it (signed in, onboarded). */
  val armed: Boolean,
  val hasOwner: Boolean,
  /** The permissions detection needs (on iPhone: Always, Precise and Motion & Fitness). */
  val permissionsOk: Boolean,
  val candidateRestUntil: Double,
  val candidateStarts: List<Double>
)

// ——— Status ———

enum class DetectMissing(val wire: String) {
  LOCATION_ALWAYS("locationAlways"),
  LOCATION_PRECISE("locationPrecise"),
  MOTION("motion"),
  BACKGROUND_REFRESH("backgroundRefresh"),
  LIVE_ACTIVITIES("liveActivities")
}

enum class DetectStatus(val wire: String) {
  ON("on"),
  NEEDS("needs"),
  UNAVAILABLE("unavailable"),
  OFF("off")
}

enum class LocationAccess(val wire: String) {
  NONE("none"),
  WHEN_IN_USE("whenInUse"),
  ALWAYS("always");

  companion object {
    fun of(wire: String): LocationAccess? = entries.firstOrNull { it.wire == wire }
  }
}

enum class MotionAccess(val wire: String) {
  GRANTED("granted"),
  DENIED("denied"),
  UNDETERMINED("undetermined"),
  UNAVAILABLE("unavailable");

  companion object {
    fun of(wire: String): MotionAccess? = entries.firstOrNull { it.wire == wire }
  }
}

enum class BackgroundRefresh(val wire: String) {
  AVAILABLE("available"),
  DENIED("denied"),
  RESTRICTED("restricted");

  companion object {
    fun of(wire: String): BackgroundRefresh? = entries.firstOrNull { it.wire == wire }
  }
}

data class StatusInputs(
  /** JS armed it (signed in and onboarded). */
  val armed: Boolean,
  /** The wakes and the motion feed exist on this phone. */
  val hardware: Boolean,
  val location: LocationAccess,
  val precise: Boolean,
  val motion: MotionAccess,
  val backgroundRefresh: BackgroundRefresh,
  /** On iPhone the Live Activities switch; on Android the drive notification can show. */
  val liveActivities: Boolean
)

data class DetectStatusResult(val status: DetectStatus, val missing: List<DetectMissing>, val requiredOk: Boolean)
