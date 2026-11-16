package expo.modules.drivesense.detect

import org.json.JSONArray
import org.json.JSONObject

/**
 * The drive detector's persisted state on Android (the iOS `DetectStateRecord`): one JSON string in
 * the detector's own preferences file, written (commit) before each transition's side effects and
 * read at every process start. Also the `DetectState` JS reads ([state]). Pure org.json, so the JVM
 * tests hold the round trip and the state's shape; the detector stores and loads the string.
 */
data class DriveDetectRecord(
  /** JS armed it (signed in, onboarded) for [ownerId]. */
  val armed: Boolean = false,
  val ownerId: String? = null,
  /** off | armed | candidate | recording | ending | suppressed */
  val state: String = "off",
  /** auto | manual, fixed when a candidate opens */
  val origin: String? = null,
  /** When the state was entered, epoch ms. */
  val since: Double = 0.0,
  /** The live drive: its id (= the JS client_trip_id), traced start and its source. */
  val driveId: String? = null,
  val startedAt: Double? = null,
  val startSource: String? = null,
  /** A Start-card wait's deadline. */
  val waitUntil: Double? = null,
  val candidateRestUntil: Double = 0.0,
  /** The last hour's candidate starts (the cap). */
  val candidateStarts: List<Double> = emptyList(),
  val lastEnd: DetectLastEnd? = null,
  val suppressedSince: Double? = null,
  val suppressedUntil: Double? = null,
  /** Journal files rotated away undrained since the last `getState`. */
  val journalDropped: Int = 0,
  /**
   * Android only, never in the state JS reads: the "Not driving?" rest's evidence from the activity
   * transitions ([RestStanding]), kept here because the rest outlives RoadWise's process.
   */
  val rest: RestStanding = RestStanding(),
  /**
   * Android only: where the parked spot's geofence is (the last end's place, a watch that saw no
   * vehicle and ran out, the end of a rest), so it is set again after a reboot or an update, which
   * drop it. Null: none.
   */
  val parked: LatLng? = null
) {
  val recording: Boolean get() = state == "recording" || state == "ending"

  fun toJson(): String {
    val o = JSONObject()
      .put("v", 1)
      .put("armed", armed)
      .put("state", state)
      .put("since", since)
      .put("candidateRestUntil", candidateRestUntil)
      .put("candidateStarts", JSONArray(candidateStarts))
      .put("journalDropped", journalDropped)
    ownerId?.let { o.put("ownerId", it) }
    origin?.let { o.put("origin", it) }
    driveId?.let { o.put("driveId", it) }
    startedAt?.let { o.put("startedAt", it) }
    startSource?.let { o.put("startSource", it) }
    waitUntil?.let { o.put("waitUntil", it) }
    suppressedSince?.let { o.put("suppressedSince", it) }
    suppressedUntil?.let { o.put("suppressedUntil", it) }
    lastEnd?.let { e ->
      o.put("lastEnd", JSONObject().put("decidedAt", e.decidedAt).put("cut", e.cut).put("lat", e.lat).put("lng", e.lng).put("driveId", e.driveId))
    }
    if (rest != RestStanding()) {
      val r = JSONObject().put("carStanding", rest.carStanding)
      rest.walkSince?.let { r.put("walkSince", it) }
      rest.carLeftAt?.let { r.put("carLeftAt", it) }
      o.put("rest", r)
    }
    parked?.let { o.put("parked", JSONObject().put("lat", it.lat).put("lng", it.lng)) }
    return o.toString()
  }

  /**
   * The `DetectState` (src/detect/types.ts, a strict shape) with the permissions now [p] and, for an
   * event, its [reason]. Every time an integer epoch ms; the drive's fields only while one records,
   * the wait's only while a candidate waits, the rest's only while resting (as iOS answers).
   */
  fun state(p: DetectAccess, reason: String? = null): Map<String, Any?> {
    val status = DetectPolicy.statusOf(p.inputs(armed))
    val live = recording
    val out = linkedMapOf<String, Any?>(
      "armed" to (armed && ownerId != null && state != "off"),
      "ownerId" to ownerId,
      "state" to state,
      "origin" to origin,
      "driveId" to (if (live) driveId else null),
      "startedAt" to ms(if (live) startedAt else null),
      "since" to ms(since),
      "waitUntil" to ms(if (state == "candidate") waitUntil else null),
      "lastEnd" to lastEnd?.let { e -> linkedMapOf<String, Any?>("decidedAt" to ms(e.decidedAt), "cut" to ms(e.cut), "lat" to e.lat, "lng" to e.lng, "driveId" to e.driveId) },
      "suppressedUntil" to ms(if (state == "suppressed") suppressedUntil else null),
      "status" to status.status.wire,
      "missing" to status.missing.map { it.wire },
      "permissions" to p.json(),
      "journalDropped" to journalDropped
    )
    if (reason != null) out["reason"] = reason
    return out
  }

  companion object {
    /** The stored record; null when nothing is stored or it cannot be read. */
    fun fromJson(raw: String?): DriveDetectRecord? {
      if (raw == null) return null
      return try {
        val o = JSONObject(raw)
        val starts = o.optJSONArray("candidateStarts")
        val e = o.optJSONObject("lastEnd")
        val rest = o.optJSONObject("rest")
        val parked = o.optJSONObject("parked")
        DriveDetectRecord(
          armed = o.optBoolean("armed", false),
          ownerId = text(o, "ownerId"),
          state = o.optString("state", "off").takeIf { DetectPhase.of(it) != null } ?: "off",
          origin = text(o, "origin"),
          since = o.optDouble("since", 0.0).takeIf { it.isFinite() } ?: 0.0,
          driveId = text(o, "driveId"),
          startedAt = num(o, "startedAt"),
          startSource = text(o, "startSource"),
          waitUntil = num(o, "waitUntil"),
          candidateRestUntil = num(o, "candidateRestUntil") ?: 0.0,
          candidateStarts = if (starts == null) emptyList() else (0 until starts.length()).mapNotNull { i -> starts.optDouble(i).takeIf { it.isFinite() } },
          lastEnd = e?.let {
            val driveId = text(it, "driveId")
            val decidedAt = num(it, "decidedAt")
            val cut = num(it, "cut")
            val lat = num(it, "lat")
            val lng = num(it, "lng")
            if (driveId == null || decidedAt == null || cut == null || lat == null || lng == null) null else DetectLastEnd(decidedAt, cut, lat, lng, driveId)
          },
          suppressedSince = num(o, "suppressedSince"),
          suppressedUntil = num(o, "suppressedUntil"),
          journalDropped = o.optInt("journalDropped", 0).coerceAtLeast(0),
          rest = if (rest == null) RestStanding() else RestStanding(num(rest, "walkSince"), rest.optBoolean("carStanding", false), num(rest, "carLeftAt")),
          parked = parked?.let {
            val lat = num(it, "lat")
            val lng = num(it, "lng")
            if (lat == null || lng == null) null else LatLng(lat, lng)
          }
        )
      } catch (_: Exception) {
        null
      }
    }

    private fun text(o: JSONObject, key: String): String? = if (o.has(key) && !o.isNull(key)) o.optString(key) else null

    private fun num(o: JSONObject, key: String): Double? {
      val v = o.opt(key)
      return if (v is Number && v.toDouble().isFinite()) v.toDouble() else null
    }

    /** An epoch ms as an integer for JS (`Math.round`, never negative), or null. */
    fun ms(d: Double?): Long? = if (d == null || !d.isFinite()) null else Math.round(maxOf(0.0, d))
  }
}

/**
 * The permissions now (`DetectState.permissions`), with the Android meanings: [backgroundRefresh]
 * is `DENIED` only while the app's battery use is Restricted (ruling 5: Optimized, the default, is
 * fine) and is the one the status reads, `liveActivities` is whether the drive notification can show
 * (notifications allowed and its channel not blocked: the Live Activity's Android twin, ruling 6),
 * and [hardware] whether the automatic wakes exist on this phone (Play services: the activity
 * transitions and the geofence). [batterySaver]: Battery Saver is on with a location mode that stops
 * background fixes ([BatterySaver.limitsLocation]); JS is told through the wire's `backgroundRefresh`
 * = `restricted` (when battery use is not Restricted), which Settings › Permissions and Home show as
 * their own Battery Saver line, while the status, its `missing` and the arming never count it (ruling
 * 5: only Restricted is a need; Battery Saver leaves the wakes working and only limits fixes).
 */
data class DetectAccess(
  val location: LocationAccess,
  val precise: Boolean,
  val motion: MotionAccess,
  val backgroundRefresh: BackgroundRefresh,
  val liveActivities: Boolean,
  val canAskAlways: Boolean,
  val hardware: Boolean,
  val batterySaver: Boolean = false
) {
  fun inputs(armed: Boolean): StatusInputs = StatusInputs(armed, hardware, location, precise, motion, backgroundRefresh, liveActivities)

  val requiredOk: Boolean get() = DetectPolicy.statusOf(inputs(true)).requiredOk

  /** What JS reads as `backgroundRefresh`: Restricted first, then Battery Saver limiting location. */
  val reportedRefresh: BackgroundRefresh
    get() = if (backgroundRefresh == BackgroundRefresh.AVAILABLE && batterySaver) BackgroundRefresh.RESTRICTED else backgroundRefresh

  fun json(): Map<String, Any?> = linkedMapOf(
    "location" to location.wire,
    "precise" to precise,
    "motion" to motion.wire,
    "backgroundRefresh" to reportedRefresh.wire,
    "liveActivities" to liveActivities,
    "canAskAlways" to canAskAlways
  )
}

/** What one capture row means to the detector (`DriveDetector.onRow`). */
enum class CaptureRowFate {
  /** The sensed drive's row: journaled and emitted. */
  SENSED,
  /** Dropped: a start or a resume is under way, or sensing is ending. */
  WAIT,
  /** A capture with no drive behind it (a start that answered after its refusal): it stops. */
  STOP,
  /**
   * A capture running for a recording drive that is not sensed: a resume whose start was counted
   * as refused and then began after all. The drive is taken back (the service is in the foreground
   * now, so the direct path), or ends as an orphan past its 5 min: never a capture left running
   * with no safety stop, no 12 h cap and no rows kept.
   */
  TAKE_BACK
}

/** [CaptureRowFate] for a row with the detector as it stands. Pure. */
fun captureRowFate(sensing: Boolean, starting: Boolean, resuming: Boolean, recording: Boolean): CaptureRowFate =
  when {
    sensing && recording -> CaptureRowFate.SENSED
    sensing || starting || resuming -> CaptureRowFate.WAIT
    !recording -> CaptureRowFate.STOP
    else -> CaptureRowFate.TAKE_BACK
  }

/**
 * The wakes that came while a resume read the journal (a broadcast that restarted the process lands
 * behind `resumeAtLaunch`). Each is held with its `done`, so the broadcast's `goAsync` and its
 * background start allowance last, and is replayed once the resume settles: a drive resumed answers
 * them busy; a drive ended (an orphan, or no journal) lets them open a watch. Detector thread only.
 */
class HeldWakes<D> {
  private val held = mutableListOf<Pair<WakeReason, D>>()

  fun hold(reason: WakeReason, done: D) {
    held += reason to done
  }

  /**
   * The wakes to replay, oldest first, and the list emptied. [ended]: the resume ended the drive;
   * [sticky]: the system's sticky restart has the service in the foreground. A sticky restart whose
   * drive ended with no wake held replays one `app` wake ([noop] its done), motion-gated as RoadWise
   * coming to the front, before its service is let go: the phone may still be in the car.
   */
  fun drain(ended: Boolean, sticky: Boolean, noop: D): List<Pair<WakeReason, D>> {
    val out = held.toList()
    held.clear()
    return if (out.isEmpty() && ended && sticky) listOf(WakeReason.APP to noop) else out
  }
}
