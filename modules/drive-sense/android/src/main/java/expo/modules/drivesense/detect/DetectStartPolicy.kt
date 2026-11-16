package expo.modules.drivesense.detect

import kotlin.math.max
import kotlin.math.min

// The confirmation and the start (policy.ts "Confirmation", "Slow traffic", "The car link", "The
// start"): extensions of [DetectPolicy], so the runtime calls `DetectPolicy.confirmStep(...)` like
// every other rule. Pure, like the rest of the policy. Each function keeps the reference's order of
// operations: the evidence is a float sum, and a different order could land a hair either side of 1.

/**
 * The confirmation in progress (policy.ts `ConfirmState`). The Start card's hold: when its run of
 * fast rows began, and when the current dip began. The auto evidence: how much has built (1
 * confirms), when the first interval that earned since the last forget began (`runStartTs`, where
 * the trace-back starts), the previous row's time and earning rate, and the last trusted row over
 * 3 mph.
 */
data class ConfirmState(
  val runStartTs: Double? = null,
  val dipStartTs: Double? = null,
  val evidence: Double = 0.0,
  val prevTs: Double? = null,
  val prevRate: Double = 0.0,
  val lastMoveTs: Double? = null
)

/**
 * A live motion report as the on-foot veto reads it (policy.ts `VetoReport`): when it arrived,
 * whether it says on foot (walking, running or cycling) or in a vehicle (automotive, a car standing
 * at a light too), and whether it is confident (medium or high).
 */
data class VetoReport(val at: Double, val onFoot: Boolean, val automotive: Boolean, val confident: Boolean)

/** The on-foot veto's memory: when the last confident on-foot report arrived, and the last confident automotive one (null: none). */
data class VetoState(val onFootAt: Double? = null, val automotiveAt: Double? = null)

/** A live motion report as the slow-traffic path and the car link read it (policy.ts `SlowReport`; `at`: its arrival). */
data class SlowReport(
  val at: Double,
  val automotive: Boolean,
  /** A car standing at a light is no car motion. */
  val stationary: Boolean,
  /** walking, running or cycling */
  val onFoot: Boolean,
  val confident: Boolean
)

/** The last trusted fix the slow-traffic path holds, with its speed. */
data class SlowFix(val ts: Double, override val lat: Double, override val lng: Double, val mps: Double) : GeoPoint

/**
 * The slow-traffic path's accumulators for one candidate (policy.ts `SlowTrafficState`): the
 * confident moving car motion banked (`carMs`) and the standing report's arrival when it is car
 * motion (`carSince`); the automotive coverage (any confident automotive report, a car standing at a
 * light too) banked since the first trusted row over 3 mph (`vehMs`, `moveStartTs`) and the standing
 * report's arrival when it is one (`vehSince`); the first and last confident automotive report's
 * arrival; whether a confident on-foot report arrived since the candidate opened (for good); the
 * first and last trusted fix (with its speed), the trusted path between them; the sum and count of
 * the trusted rows over 3 mph (the average); the first trusted row at 5 mph or more (`runStartTs`,
 * where the trace-back starts) and the last trusted row over 3 mph.
 */
data class SlowTrafficState(
  val carMs: Double = 0.0,
  val carSince: Double? = null,
  val vehMs: Double = 0.0,
  val vehSince: Double? = null,
  val firstCarAt: Double? = null,
  val lastCarAt: Double? = null,
  val onFoot: Boolean = false,
  val first: LatLng? = null,
  val last: SlowFix? = null,
  val pathM: Double = 0.0,
  val sumMps: Double = 0.0,
  val movingRows: Int = 0,
  val moveStartTs: Double? = null,
  val runStartTs: Double? = null,
  val lastMoveTs: Double? = null
)

/** One Bluetooth (or CarPlay) output of the audio route as the link reads it (policy.ts `CarPort`; `carAudio` is CarPlay). */
data class CarPort(val uid: String, val type: String)

/**
 * The car link start in progress (policy.ts `LinkState`): the run of link rows, when it began, the
 * last one's time, and the candidate's on-foot mark (a confident walking, running or cycling report
 * since it opened, lifted only by a later confident automotive report).
 */
data class LinkState(val run: Int = 0, val runStartTs: Double? = null, val prevTs: Double? = null, val onFoot: Boolean = false)

/** Where a confirmed drive begins, and from which row its rows are kept (policy.ts `TracedStart`). */
data class TracedStart(
  /** The first kept row (an index into the rows given). */
  val index: Int,
  val startedAt: Double,
  val startSource: StartSource,
  val startLat: Double?,
  val startLng: Double?
)

/** The evidence is a float sum, which may land a hair under 1 (`EVIDENCE_EPS` in policy.ts). */
private const val EVIDENCE_EPS = 0.000000001

// ——— Confirmation ———

/**
 * The hold (ms) a speed (m/s) needs to confirm an auto drive on its own: (5/3)·(30 − mph) s, the
 * line from AUTO_HOLD_MS_15 at 15 mph down to 0 at AUTO_INSTANT_MPS (30 mph), never under
 * AUTO_HOLD_MIN_MS (the GPS-spike guard, a little under the 1 s row interval: at 30 mph and over a
 * drive confirms on the second good reading in a row despite timer jitter, never on one); infinite
 * at 15 mph and under.
 */
fun DetectPolicy.autoHoldMs(mps: Double): Double {
  if (!(mps > AUTO_MIN_MPS)) return Double.POSITIVE_INFINITY
  return max(AUTO_HOLD_MIN_MS, (AUTO_HOLD_MS_15 * (AUTO_INSTANT_MPS - mps)) / (AUTO_INSTANT_MPS - AUTO_MIN_MPS))
}

/**
 * One row of the auto evidence. A trusted row over 15 mph earns at `1 / autoHoldMs(speed)` per ms,
 * unless `veto` (a fresh confident cycling, walking or running report) or it is under 20 mph without
 * fresh car motion (`carFresh`). The interval between two rows that both earn adds its length at the
 * slower one's rate, so a lone fast reading earns nothing; a gap over AUTO_ROW_GAP_MAX_MS adds
 * nothing. Crawling and stops keep the evidence; 5 min with no trusted row over 3 mph forgets it. It
 * confirms once the evidence reaches 1.
 */
private fun DetectPolicy.autoStep(s: ConfirmState, r: DetectRow, veto: Boolean, carFresh: Boolean): PolicyStep<ConfirmState> {
  val ok = trusted(r)
  val earns = ok && !veto && r.speed > AUTO_MIN_MPS && (r.speed >= AUTO_MPS_20 || carFresh)
  val rate = if (earns) 1 / autoHoldMs(r.speed) else 0.0
  var e = s.evidence
  var first = s.runStartTs
  val p = s.prevTs
  if (p != null && rate > 0 && s.prevRate > 0 && r.ts - p > 0 && r.ts - p <= AUTO_ROW_GAP_MAX_MS) {
    e += (r.ts - p) * min(rate, s.prevRate)
    if (first == null) first = p
  }
  val lastMove = if (ok && r.speed > STOP_MPS) r.ts else s.lastMoveTs
  if (e > 0 && lastMove != null && r.ts - lastMove >= AUTO_FORGET_MS) {
    e = 0.0
    first = null
  }
  val state = ConfirmState(runStartTs = first, dipStartTs = null, evidence = e, prevTs = r.ts, prevRate = rate, lastMoveTs = lastMove)
  return PolicyStep(state, e >= 1 - EVIDENCE_EPS && !veto)
}

/**
 * One row of the confirmation. Auto: the evidence ([autoStep]; `carFresh`: confident car motion in
 * the last 2 min). The Start card: a trusted row at 10 mph or over extends the run (and ends any
 * dip), and the run confirms once it spans 15 s on the row clock; a row under it, or untrusted,
 * starts or extends a dip, and a dip spanning more than CONFIRM_DIP_MAX_MS breaks the run.
 */
fun DetectPolicy.confirmStep(
  s: ConfirmState,
  r: DetectRow,
  kind: TriggerKind,
  veto: Boolean = false,
  carFresh: Boolean = false
): PolicyStep<ConfirmState> {
  if (kind == TriggerKind.AUTO) return autoStep(s, r, veto, carFresh)
  if (trusted(r) && r.speed >= CONFIRM_MPS_MANUAL) {
    val run = s.runStartTs ?: r.ts
    return PolicyStep(ConfirmState(runStartTs = run, dipStartTs = null), r.ts - run >= CONFIRM_HOLD_MS_MANUAL && !veto)
  }
  val runStart = s.runStartTs ?: return PolicyStep(ConfirmState(), false)
  val dip = s.dipStartTs ?: r.ts
  if (r.ts - dip > CONFIRM_DIP_MAX_MS) return PolicyStep(ConfirmState(), false)
  return PolicyStep(ConfirmState(runStartTs = runStart, dipStartTs = dip), false)
}

/** One live report into the veto's memory. A low-confidence report changes nothing, and neither does a stationary or unknown one. */
fun DetectPolicy.noteVeto(s: VetoState, r: VetoReport): VetoState {
  if (!r.confident) return s
  return VetoState(onFootAt = if (r.onFoot) r.at else s.onFootAt, automotiveAt = if (r.automotive) r.at else s.automotiveAt)
}

/**
 * The on-foot veto at `now` (the auto trigger's `veto`): a confident walking, running or cycling
 * report that arrived in the last VETO_FRESH_MS holds an auto confirmation, unless a confident
 * automotive report arrived after it. Only the car lifts it early: a low-confidence, stationary or
 * unknown report after it never does.
 */
fun DetectPolicy.onFootVeto(s: VetoState, now: Double): Boolean {
  val onFootAt = s.onFootAt
  if (onFootAt == null || now - onFootAt > VETO_FRESH_MS) return false
  return s.automotiveAt == null || s.automotiveAt <= onFootAt
}

// ——— Slow traffic (a second auto path beside the speed evidence) ———

/** The car motion the candidate has seen by `now`: what is banked plus the standing car report's stretch. */
fun DetectPolicy.slowTrafficCarMs(s: SlowTrafficState, now: Double): Double =
  if (s.carSince != null && now > s.carSince) s.carMs + (now - s.carSince) else s.carMs

/** The automotive coverage by `now` since the first trusted row over 3 mph: banked plus the standing automotive report's stretch since then. */
fun DetectPolicy.slowTrafficVehMs(s: SlowTrafficState, now: Double): Double {
  if (s.moveStartTs == null || s.vehSince == null) return s.vehMs
  val from = max(s.vehSince, s.moveStartTs)
  return if (now > from) s.vehMs + (now - from) else s.vehMs
}

/** The slow-traffic path holds evidence: some car motion and not on foot (the candidate then waits 5 min, not 3). */
fun DetectPolicy.slowTrafficHeld(s: SlowTrafficState, now: Double): Boolean = !s.onFoot && slowTrafficCarMs(s, now) > 0

/**
 * One live report. A report stands until the next replaces it: the car motion and the automotive
 * coverage standing until now are banked; a confident automotive report starts a new coverage
 * stretch (a car standing at a light too) and, when not stationary, a new car motion stretch
 * (anything else, a low-confidence one too, stands as neither), and dates the first and last
 * automotive report. A confident walking, running or cycling report marks the candidate on foot for
 * good.
 */
fun DetectPolicy.slowTrafficReport(s: SlowTrafficState, r: SlowReport): SlowTrafficState {
  val carMs = if (s.carSince != null && r.at > s.carSince) s.carMs + (r.at - s.carSince) else s.carMs
  val car = r.confident && r.automotive && !r.stationary
  val veh = r.confident && r.automotive
  return s.copy(
    carMs = carMs,
    carSince = if (car) r.at else null,
    vehMs = slowTrafficVehMs(s, r.at),
    vehSince = if (veh) r.at else null,
    firstCarAt = if (veh) (s.firstCarAt ?: r.at) else s.firstCarAt,
    lastCarAt = if (veh) r.at else s.lastCarAt,
    onFoot = s.onFoot || (r.confident && r.onFoot)
  )
}

/**
 * Whether the slow-traffic path confirms: never on foot; 20 s of car motion, from automotive reports
 * 10 s or more apart, with automotive coverage for 80 % of the time since the first trusted row over
 * 3 mph; a 400 m trusted path, the last trusted fix 200 m in a straight line from the first, and a
 * 10 mph average over the trusted rows over 3 mph.
 */
fun DetectPolicy.slowTrafficConfirmed(s: SlowTrafficState, now: Double): Boolean {
  val first = s.first
  val last = s.last
  if (s.onFoot || first == null || last == null || s.movingRows == 0) return false
  val firstCarAt = s.firstCarAt
  val lastCarAt = s.lastCarAt
  val moveStartTs = s.moveStartTs
  if (firstCarAt == null || lastCarAt == null || moveStartTs == null) return false
  return slowTrafficCarMs(s, now) >= SLOW_CAR_MS &&
    lastCarAt - firstCarAt >= SLOW_CAR_SPAN_MS &&
    slowTrafficVehMs(s, now) >= SLOW_CAR_COVER_MIN * (now - moveStartTs) &&
    s.pathM >= SLOW_PATH_M &&
    distanceM(first, last) >= SLOW_NET_M &&
    s.sumMps / s.movingRows >= SLOW_AVG_MPS
}

/**
 * One row of the slow-traffic path. As the speed evidence, 5 min with no trusted row over 3 mph
 * forgets it all (not the on-foot mark; a standing car or automotive report starts its stretch
 * again here, and two new reports 10 s apart are needed). A trusted row over 3 mph adds the step
 * from the last trusted fix to the path when that fix is at most AUTO_ROW_GAP_MAX_MS older (a
 * stopped car's GPS jitter, and a jump across a gap, add nothing), never more than 1.5 times what the
 * faster of the two rows covers in the time plus 5 m (a GPS jump inside the gap adds no more), and
 * its speed to the average; the first one starts the coverage clock; every trusted row is the last
 * fix (and the first, when none is yet).
 */
fun DetectPolicy.slowTrafficStep(s: SlowTrafficState, r: DetectRow): PolicyStep<SlowTrafficState> {
  val n =
    if (s.lastMoveTs != null && r.ts - s.lastMoveTs >= AUTO_FORGET_MS) {
      SlowTrafficState(
        onFoot = s.onFoot,
        carSince = if (s.carSince == null) null else r.ts,
        vehSince = if (s.vehSince == null) null else r.ts
      )
    } else {
      s
    }
  val ok = trusted(r)
  val moved = ok && r.speed > STOP_MPS
  val last = n.last
  val gap = if (last == null) -1.0 else r.ts - last.ts
  var pathM = n.pathM
  if (moved && last != null && gap > 0 && gap <= AUTO_ROW_GAP_MAX_MS) {
    val cap = (max(r.speed, last.mps) * gap * SLOW_STEP_SLACK) / 1000 + SLOW_STEP_PAD_M
    pathM += min(distanceM(last, r), cap)
  }
  val state = n.copy(
    first = if (ok && n.first == null) LatLng(r.lat, r.lng) else n.first,
    last = if (ok) SlowFix(r.ts, r.lat, r.lng, r.speed) else n.last,
    pathM = pathM,
    sumMps = if (moved) n.sumMps + r.speed else n.sumMps,
    movingRows = if (moved) n.movingRows + 1 else n.movingRows,
    moveStartTs = n.moveStartTs ?: (if (moved) r.ts else null),
    runStartTs = n.runStartTs ?: (if (ok && r.speed >= MOVE_MPS) r.ts else null),
    lastMoveTs = if (moved) r.ts else n.lastMoveTs
  )
  return PolicyStep(state, slowTrafficConfirmed(state, r.ts))
}

// ——— The car link ———

/** Linked: any current output is a paired car (matched on its uid, whatever its name now), or CarPlay (`carAudio`). */
fun DetectPolicy.carLinked(current: List<CarPort>, paired: List<String>): Boolean =
  current.any { o -> o.type == "carAudio" || paired.contains(o.uid) }

/** CarPlay (`carAudio`) is among the current outputs: a car for certain, which a paired Bluetooth output is not. */
fun DetectPolicy.carPlayOn(current: List<CarPort>): Boolean = current.any { o -> o.type == "carAudio" }

/** "Most of the drive": an output current for more than half the rows of a drive of 2 min or more. */
fun DetectPolicy.carMostOfDrive(withRows: Int, rows: Int): Boolean =
  rows >= CAR_DRIVE_MIN_ROWS && withRows > rows * CAR_DRIVE_SHARE_MIN

/** One live report into the link's on-foot mark: a confident on-foot report sets it, a later confident automotive one lifts it; anything else changes nothing. */
fun DetectPolicy.linkReport(s: LinkState, r: SlowReport): LinkState {
  if (!r.confident) return s
  if (r.onFoot) return s.copy(onFoot = true)
  if (r.automotive) return s.copy(onFoot = false)
  return s
}

/**
 * One row of the car link start: with the link up (`linked`) and the candidate not on foot, a
 * trusted row at 5 mph or more with fresh car motion (with CarPlay current, `carPlay`, at 15 mph or
 * more without it too; a paired Bluetooth output alone could be headphones on a bike), extends the
 * run when it follows the last one within AUTO_ROW_GAP_MAX_MS, else begins one; any other row ends
 * it (the on-foot mark stays). Two in a row confirm.
 */
fun DetectPolicy.linkStep(s: LinkState, r: DetectRow, linked: Boolean, carPlay: Boolean, carFresh: Boolean): PolicyStep<LinkState> {
  val ok = linked && !s.onFoot && trusted(r) && r.speed >= LINK_MIN_MPS && (carFresh || (carPlay && r.speed >= LINK_NO_CAR_MPS))
  if (!ok) return PolicyStep(LinkState(onFoot = s.onFoot), false)
  val p = s.prevTs
  val goesOn = s.run > 0 && p != null && r.ts - p > 0 && r.ts - p <= AUTO_ROW_GAP_MAX_MS
  val state =
    if (goesOn) {
      LinkState(run = s.run + 1, runStartTs = s.runStartTs ?: r.ts, prevTs = r.ts, onFoot = s.onFoot)
    } else {
      LinkState(run = 1, runStartTs = r.ts, prevTs = r.ts, onFoot = s.onFoot)
    }
  return PolicyStep(state, state.run >= LINK_PACE_ROWS)
}

// ——— The start ———

/**
 * The trace-back (native-ios §6.2): from the first row of the confirming run (`h`), the start is the
 * last trusted row at or under 3 mph before it, unless the car was rolling (trusted, 5 mph or more)
 * before that stop less than TRACE_STOP_SPLIT_MS earlier (a red light inside the departure, a crawl
 * out of a jam included): then the search goes on back from there. Null when the rows begin already
 * moving. The loop ends: each pass searches strictly before the last (j < s < k).
 */
fun DetectPolicy.traceStart(rows: List<DetectRow>, h: Int): Int? {
  var k = min(max(h, 0), rows.size)
  while (true) {
    var s = -1
    for (i in k - 1 downTo 0) {
      if (slow(rows[i])) {
        s = i
        break
      }
    }
    if (s < 0) return null
    var j = -1
    for (i in s - 1 downTo 0) {
      if (rolling(rows[i])) {
        j = i
        break
      }
    }
    if (j < 0 || rows[s].ts - rows[j].ts >= TRACE_STOP_SPLIT_MS) return s
    k = j
  }
}

/**
 * The traced start, else the fallbacks: for an auto drive the motion history's car run (`MOTION`),
 * placed at the last end when the car could have come from there in the time; otherwise the first
 * row (`WAKE`), placed there when its fix is trusted. A Start-card drive never uses the motion
 * fallback. `rows` must be non-empty.
 */
fun DetectPolicy.startOf(
  rows: List<DetectRow>,
  h: Int,
  kind: TriggerKind,
  automotiveSince: Double,
  lastEnd: DetectLastEnd?
): TracedStart {
  val s = traceStart(rows, h)
  if (s != null) {
    val r = rows[s]
    return TracedStart(s, r.ts, StartSource.TRACE, r.lat, r.lng)
  }
  val first = rows[0]
  if (kind == TriggerKind.AUTO && automotiveSince > 0 && automotiveSince < first.ts) {
    val ref = rows.firstOrNull { trusted(it) }
    val plausible =
      lastEnd != null &&
        ref != null &&
        distanceM(lastEnd, ref) <= (PLAUSIBLE_MPS_MAX * (ref.ts - automotiveSince)) / 1000 + PLAUSIBLE_SLACK_M
    return TracedStart(
      0,
      automotiveSince,
      StartSource.MOTION,
      if (plausible) lastEnd?.lat else null,
      if (plausible) lastEnd?.lng else null
    )
  }
  val ok = trusted(first)
  return TracedStart(0, first.ts, StartSource.WAKE, if (ok) first.lat else null, if (ok) first.lng else null)
}

/** Native's warm-up hint: the start is within 5 min of the last end's decision and 150 m of its place. */
fun DetectPolicy.continuesFrom(lastEnd: DetectLastEnd?, startedAt: Double, lat: Double?, lng: Double?): Boolean {
  if (lastEnd == null || lat == null || lng == null) return false
  return startedAt - lastEnd.decidedAt <= CONTINUE_GAP_MS && distanceM(lastEnd, LatLng(lat, lng)) <= CONTINUE_DIST_M
}
