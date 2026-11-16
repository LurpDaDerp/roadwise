package expo.modules.drivesense.detect

import org.json.JSONArray
import org.json.JSONObject

/**
 * The drive detector's half of the on-device self-test (plan §3.3). Each `detect` vector carries
 * one row of the decision table (`src/detect/vectors.ts`) without its name or `expected`; this runs
 * it through the PRODUCTION [DetectPolicy], never a copy, exactly as `runDetectRow` in
 * `src/detect/selfTest.ts` runs it through the reference, and answers the row's `actual`. JS matches
 * it against the row's `expected` (`diffDetectSelfTest`), so a Kotlin rule that drifts from the
 * table fails on the phone, and the JVM unit tests run the same rows (`src/test`). Android answers
 * every row kind: it never skips one.
 *
 * Pure: nothing here touches the phone, the stored state or the clock. A malformed row (a field
 * missing or of the wrong type, an unknown kind) answers `error`, never throws.
 */
object DetectSelfTest {
  private const val KIND = "detect"

  /** The result object for one vector: `{ name, kind: "detect", actual }`, or `error` for a malformed row. */
  fun result(name: String, inputs: JSONObject): JSONObject {
    val out = JSONObject().put("name", name).put("kind", KIND)
    return try {
      out.put("actual", actual(inputs))
    } catch (e: Exception) {
      out.put("error", e.message ?: e.javaClass.simpleName)
    }
  }

  /** The policy's answer to one row: what `runDetectRow` answers for it. */
  fun actual(v: JSONObject): JSONObject = when (val kind = v.getString("kind")) {
    "confirm" -> {
      val hit = confirm(trigger(v), rows(v, "rows"), flags(v, "veto"), flags(v, "car"))
      JSONObject().put("confirmedAt", nullable(hit?.confirmedAt)).put("runStartTs", nullable(hit?.runStartTs))
    }
    "trace" -> JSONObject().put("index", nullable(DetectPolicy.traceStart(rows(v, "rows"), int(v, "h"))))
    "slow" -> slow(v)
    "link" -> link(v)
    "car" -> {
      val current = objects(v.getJSONArray("current")).map { o -> CarPort(o.getString("uid"), o.getString("type")) }
      val pairedList = v.getJSONArray("paired")
      val paired = (0 until pairedList.length()).map { pairedList.getString(it) }
      JSONObject()
        .put("linked", DetectPolicy.carLinked(current, paired))
        .put("most", DetectPolicy.carMostOfDrive(int(v, "withRows"), int(v, "rows")))
    }
    "start" -> start(v)
    "summary" -> {
      val acts = objects(v.getJSONArray("activities")).map { o ->
        ActivitySample(num(o, "start"), bool(o, "automotive"), bool(o, "stationary"), bool(o, "onFoot"), bool(o, "confident"))
      }
      JSONObject().put("summary", summaryJson(DetectPolicy.summarize(acts, num(v, "now"))))
    }
    "motionGate" -> {
      val m = v.getJSONObject("summary")
      val summary = MotionSummary(num(m, "lastAutomotiveAt"), num(m, "automotiveSince"), bool(m, "onFootNow"))
      JSONObject().put("reason", DetectPolicy.motionGate(summary, num(v, "now")).wire)
    }
    "veto" -> {
      var s = VetoState()
      for (o in objects(v.getJSONArray("reports"))) {
        s = DetectPolicy.noteVeto(s, VetoReport(num(o, "at"), bool(o, "onFoot"), bool(o, "automotive"), bool(o, "confident")))
      }
      JSONObject().put("vetoed", DetectPolicy.onFootVeto(s, num(v, "now")))
    }
    "wake" -> JSONObject().put("reason", DetectPolicy.wakeGate(wakeCtx(v.getJSONObject("ctx"))).wire)
    "candidate" -> {
      val cause = DetectPolicy.candidateDue(
        trigger(v),
        num(v, "since"),
        optNum(v, "waitUntil"),
        optNum(v, "walkSince"),
        num(v, "now"),
        optNum(v, "lastVehicleTs"),
        optBool(v, "hasEvidence") ?: false
      )
      JSONObject().put("cause", nullable(cause?.wire))
    }
    "startsAfter" ->
      JSONObject().put("starts", JSONArray(DetectPolicy.startsAfter(nums(v.getJSONArray("starts")), num(v, "since"), bool(v, "sawVehicle"))))
    "end" -> end(v)
    "suppress" -> {
      val cause = DetectPolicy.suppressionDue(num(v, "since"), num(v, "until"), optNum(v, "lastOverStopTs"), optNum(v, "walkSince"), num(v, "now"))
      JSONObject().put("cause", nullable(cause?.wire))
    }
    "suppressResume" -> suppressResume(v)
    "resume" ->
      JSONObject().put("decision", DetectPolicy.resumeDecision(optNum(v, "lastRowTs"), num(v, "startedAt"), num(v, "now")).wire)
    "resumeSeq" -> {
      val top = num(v, "topSeq")
      require(top >= 0 && top <= MAX_SAFE_INTEGER && top == Math.floor(top)) { "a malformed resumeSeq row: topSeq $top" }
      JSONObject().put("lastSeq", DetectPolicy.resumeSeq(top.toLong()))
    }
    "status" -> {
      val s = DetectPolicy.statusOf(statusInputs(v.getJSONObject("inputs")))
      JSONObject().put("status", s.status.wire).put("missing", JSONArray(s.missing.map { it.wire }))
    }
    else -> throw IllegalArgumentException("unknown detect row kind '$kind'")
  }

  // ——— runners (selfTest.ts runConfirm and the row kinds that step through rows) ———

  private class Hit(val c: Int, val runStartTs: Double?, val confirmedAt: Double)

  /** The confirmation over `rows`: where it confirmed, the confirming row's index and its run's start. */
  private fun confirm(trigger: TriggerKind, rows: List<DetectRow>, veto: List<Boolean>, car: List<Boolean>): Hit? {
    var s = ConfirmState()
    rows.forEachIndexed { i, r ->
      val step = DetectPolicy.confirmStep(s, r, trigger, flag(veto, i), flag(car, i))
      s = step.state
      if (step.confirmed) return Hit(i, s.runStartTs, r.ts)
    }
    return null
  }

  private fun start(v: JSONObject): JSONObject {
    val trigger = trigger(v)
    val rows = rows(v, "rows")
    val automotiveSince = num(v, "automotiveSince")
    val lastEnd = if (v.isNull("lastEnd")) null else lastEnd(v.getJSONObject("lastEnd"))
    val hit = confirm(trigger, rows, emptyList(), flags(v, "car"))
      ?: return JSONObject().put("confirmedAt", JSONObject.NULL).put("start", JSONObject.NULL)
    val buffer = rows.subList(0, hit.c + 1)
    val h = buffer.indexOfFirst { it.ts == hit.runStartTs }
    val s = DetectPolicy.startOf(buffer, h, trigger, automotiveSince, lastEnd)
    val start = JSONObject()
      .put("index", s.index)
      .put("startedAt", s.startedAt)
      .put("startSource", s.startSource.wire)
      .put("startLat", nullable(s.startLat))
      .put("startLng", nullable(s.startLng))
      .put("continues", DetectPolicy.continuesFrom(lastEnd, s.startedAt, s.startLat, s.startLng))
    return JSONObject().put("confirmedAt", hit.confirmedAt).put("start", start)
  }

  /**
   * The slow-traffic path over rows and live reports in arrival order: where it confirmed, its run's
   * start, the trace-back from there over the rows so far, and the car motion banked by then.
   */
  private fun slow(v: JSONObject): JSONObject {
    var s = SlowTrafficState()
    val rows = ArrayList<DetectRow>()
    var last = 0.0
    for (step in objects(v.getJSONArray("steps"))) {
      if (step.has("report")) {
        val o = step.getJSONObject("report")
        s = DetectPolicy.slowTrafficReport(
          s,
          SlowReport(num(o, "at"), bool(o, "automotive"), bool(o, "stationary"), bool(o, "onFoot"), bool(o, "confident"))
        )
        last = num(o, "at")
        continue
      }
      val r = row(step.getJSONObject("row"))
      rows.add(r)
      last = r.ts
      val st = DetectPolicy.slowTrafficStep(s, r)
      s = st.state
      if (st.confirmed) {
        val h = rows.indexOfFirst { it.ts == s.runStartTs }
        return JSONObject()
          .put("confirmedAt", r.ts)
          .put("runStartTs", nullable(s.runStartTs))
          .put("traced", nullable(DetectPolicy.traceStart(rows, if (h < 0) 0 else h)))
          .put("carMs", DetectPolicy.slowTrafficCarMs(s, r.ts))
      }
    }
    return JSONObject()
      .put("confirmedAt", JSONObject.NULL)
      .put("runStartTs", JSONObject.NULL)
      .put("traced", JSONObject.NULL)
      .put("carMs", DetectPolicy.slowTrafficCarMs(s, last))
  }

  /** The car link start: the live reports (by arrival) go in before the row of their second. */
  private fun link(v: JSONObject): JSONObject {
    val rows = rows(v, "rows")
    val link = flags(v, "link")
    val carPlay = flags(v, "carPlay")
    val car = flags(v, "car")
    val reports = objects(v.getJSONArray("reports"))
      .map { o -> SlowReport(num(o, "at"), bool(o, "automotive"), optBool(o, "stationary") ?: false, bool(o, "onFoot"), bool(o, "confident")) }
      .sortedBy { it.at }
    var s = LinkState()
    var k = 0
    rows.forEachIndexed { i, r ->
      while (k < reports.size && reports[k].at <= r.ts) s = DetectPolicy.linkReport(s, reports[k++])
      val st = DetectPolicy.linkStep(s, r, flag(link, i), flag(carPlay, i), flag(car, i))
      s = st.state
      if (st.confirmed) return JSONObject().put("confirmedAt", r.ts).put("runStartTs", nullable(s.runStartTs))
    }
    return JSONObject().put("confirmedAt", JSONObject.NULL).put("runStartTs", JSONObject.NULL)
  }

  /** The end clock over rows (with their pedometer counts) and checks: `endDue` and the linger at each check. */
  private fun end(v: JSONObject): JSONObject {
    val startedAt = num(v, "startedAt")
    var clock = DetectPolicy.endClockAt(startedAt)
    val results = JSONArray()
    for (step in objects(v.getJSONArray("steps"))) {
      if (step.has("row")) {
        val r = row(step.getJSONObject("row"))
        clock = DetectPolicy.endOnRow(clock, r, bool(step, "automotive"))
        val steps = optNum(step, "steps")
        if (steps != null) clock = DetectPolicy.endOnSteps(clock, r.ts, steps)
      } else {
        val now = num(step, "check")
        val walkSince = optNum(step, "walkSince")
        val waitUntil = optNum(step, "waitUntil")
        val gone = optNum(step, "carGoneSince")
        val d = DetectPolicy.endDue(clock, startedAt, now, walkSince, waitUntil, gone)
        val linger = DetectPolicy.lingerAfterJsEnd(clock, startedAt, now, walkSince, waitUntil, gone)
        results.put(JSONObject().put("due", nullable(d.due?.wire)).put("overdue", nullable(d.overdue?.wire)).put("linger", linger))
      }
    }
    return JSONObject().put("results", results)
  }

  /** A relaunch mid-rest, then the rest's clock at each check (nothing over 3 mph, no walk). */
  private fun suppressResume(v: JSONObject): JSONObject {
    val since = num(v, "since")
    val until = num(v, "until")
    val checks = nums(v.getJSONArray("checks"))
    val moved = DetectPolicy.suppressionResume(until, num(v, "relaunch"))
      ?: return JSONObject().put("resumed", false).put("causes", JSONArray())
    val causes = JSONArray()
    for (t in checks) causes.put(nullable(DetectPolicy.suppressionDue(since, until, moved, null, t)?.wire))
    return JSONObject().put("resumed", true).put("causes", causes)
  }

  // ——— reading the row's JSON ———

  /** 2^53 − 1: the largest integer a JSON double (and so the wire) carries exactly. */
  private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

  private fun malformed(key: String): Nothing = throw IllegalArgumentException("a malformed row: '$key' is missing or not of its type")

  private fun num(o: JSONObject, key: String): Double = optNum(o, key) ?: malformed(key)

  /** A number, or null when the field is null or missing; anything else is malformed. */
  private fun optNum(o: JSONObject, key: String): Double? {
    if (!o.has(key) || o.isNull(key)) return null
    return (o.get(key) as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: malformed(key)
  }

  private fun int(o: JSONObject, key: String): Int {
    val x = num(o, key)
    if (x != Math.floor(x) || x < Int.MIN_VALUE || x > Int.MAX_VALUE) malformed(key)
    return x.toInt()
  }

  private fun bool(o: JSONObject, key: String): Boolean = optBool(o, key) ?: malformed(key)

  private fun optBool(o: JSONObject, key: String): Boolean? {
    if (!o.has(key) || o.isNull(key)) return null
    return o.get(key) as? Boolean ?: malformed(key)
  }

  private fun nums(a: JSONArray): List<Double> =
    (0 until a.length()).map { i -> (a.get(i) as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: malformed("[$i]") }

  private fun objects(a: JSONArray): List<JSONObject> = (0 until a.length()).map { a.getJSONObject(it) }

  /** A row's per-row flags (`veto`, `car`, `link`, `carPlay`): missing, or not a bool, is false (as `v.car?.[i] === true`). */
  private fun flags(o: JSONObject, key: String): List<Boolean> {
    val a = o.optJSONArray(key) ?: return emptyList()
    return (0 until a.length()).map { a.opt(it) == true }
  }

  private fun flag(list: List<Boolean>, i: Int): Boolean = i < list.size && list[i]

  private fun trigger(v: JSONObject): TriggerKind = TriggerKind.of(v.getString("trigger")) ?: malformed("trigger")

  private fun row(o: JSONObject): DetectRow =
    DetectRow(num(o, "ts"), num(o, "lat"), num(o, "lng"), num(o, "hAcc"), num(o, "speed"), num(o, "speedAcc"), bool(o, "gnssValid"))

  private fun rows(v: JSONObject, key: String): List<DetectRow> = objects(v.getJSONArray(key)).map { row(it) }

  private fun lastEnd(o: JSONObject): DetectLastEnd =
    DetectLastEnd(num(o, "decidedAt"), num(o, "cut"), num(o, "lat"), num(o, "lng"), o.getString("driveId"))

  private fun wakeCtx(o: JSONObject): WakeCtx = WakeCtx(
    now = num(o, "now"),
    reason = WakeReason.of(o.getString("reason")) ?: malformed("reason"),
    phase = DetectPhase.of(o.getString("phase")) ?: malformed("phase"),
    armed = bool(o, "armed"),
    hasOwner = bool(o, "hasOwner"),
    permissionsOk = bool(o, "permissionsOk"),
    candidateRestUntil = num(o, "candidateRestUntil"),
    candidateStarts = nums(o.getJSONArray("candidateStarts"))
  )

  private fun statusInputs(o: JSONObject): StatusInputs = StatusInputs(
    armed = bool(o, "armed"),
    hardware = bool(o, "hardware"),
    location = LocationAccess.of(o.getString("location")) ?: malformed("location"),
    precise = bool(o, "precise"),
    motion = MotionAccess.of(o.getString("motion")) ?: malformed("motion"),
    backgroundRefresh = BackgroundRefresh.of(o.getString("backgroundRefresh")) ?: malformed("backgroundRefresh"),
    liveActivities = bool(o, "liveActivities")
  )

  private fun summaryJson(m: MotionSummary): JSONObject =
    JSONObject().put("lastAutomotiveAt", m.lastAutomotiveAt).put("automotiveSince", m.automotiveSince).put("onFootNow", m.onFootNow)

  private fun nullable(x: Any?): Any = x ?: JSONObject.NULL
}
