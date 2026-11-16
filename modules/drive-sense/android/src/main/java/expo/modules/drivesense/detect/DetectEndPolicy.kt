package expo.modules.drivesense.detect

import kotlin.math.min

// The native safety stop and the "Not driving?" rest (policy.ts "The native safety stop", "Not
// driving?"): extensions of [DetectPolicy], in the reference's order. R1: JS ends drives; native
// stops sensing on its own only once a JS end rule is overdue by the slack. Pure, like the rest of
// the policy.

/** A row's pedometer count, as the step walk logs it. */
data class StepCount(val ts: Double, val steps: Double)

/** The last trusted fix the end clock holds: when, how fast, where. */
data class EndFix(val ts: Double, val mps: Double, override val lat: Double, override val lng: Double) : GeoPoint

/** What the still clock and the walking veto know, row by row (policy.ts `EndClock`). */
data class EndClock(
  /** The last movement (the confirmation to begin with). */
  val lastMoveTs: Double,
  /** Fix-less car time since then, which the still clock does not count. */
  val holdMs: Double = 0.0,
  /** Trusted rows over 5 mph in a row. */
  val paceRun: Int = 0,
  /** Where the car went still (the first trusted fix since the last movement). */
  val anchor: LatLng? = null,
  /** The last trusted fix. */
  val lastFix: EndFix? = null,
  /** The last row was a trusted one at 10 mph or more. */
  val prevDrive: Boolean = false,
  /** The second of the last two trusted rows in a row at 10 mph or more (JS's `lastDroveAt`). */
  val lastDroveTs: Double? = null,
  /** The last trusted row over 3 mph (END_CRAWL_MPS). */
  val lastFastTs: Double? = null,
  /** The rows' pedometer counts in the last STEP_WINDOW_MS, oldest first ([endOnSteps]). */
  val steps: List<StepCount> = emptyList(),
  /** When the step walk was first due (JS's row clock: the row's end), until the car next goes over 3 mph. */
  val stepWalkTs: Double? = null
)

/** `due`: native stops sensing now; `overdue`: a JS end rule would have ended the drive by now. */
data class EndDecision(val due: SafetyCause?, val overdue: SafetyCause?)

/** A fresh clock for a drive confirmed (or resumed) at `ts`. */
fun DetectPolicy.endClockAt(ts: Double): EndClock = EndClock(lastMoveTs = ts)

/**
 * One recorded row. Two trusted rows over 5 mph in a row, or a trusted fix 100 m from where the car
 * went still, is movement: the clock restarts there. A row with no valid fix while the phone's
 * standing motion report is car motion (`automotiveNow`) adds a second to the hold, up to an hour.
 * Two trusted rows at 10 mph or more in a row are driving (`lastDroveTs` at the second), which voids
 * a walk that arrived at or before it ([walkStanding]).
 */
fun DetectPolicy.endOnRow(c: EndClock, r: DetectRow, automotiveNow: Boolean): EndClock {
  if (trusted(r)) {
    val paceRun = if (r.speed > MOVE_MPS) c.paceRun + 1 else 0
    val prevDrive = r.speed >= MOVING_MPS
    val lastDroveTs = if (prevDrive && c.prevDrive) r.ts else c.lastDroveTs
    val lastFix = EndFix(r.ts, r.speed, r.lat, r.lng)
    // Over 3 mph the car may be moving: a step walk due before it is void.
    val fast = r.speed > END_CRAWL_MPS
    val lastFastTs = if (fast) r.ts else c.lastFastTs
    val stepWalkTs = if (fast) null else c.stepWalkTs
    val far = c.anchor != null && distanceM(c.anchor, r) >= MOVE_DISPLACEMENT_M
    if (paceRun >= MOVE_PACE_ROWS || far) {
      return c.copy(
        lastMoveTs = r.ts,
        holdMs = 0.0,
        paceRun = paceRun,
        anchor = LatLng(r.lat, r.lng),
        lastFix = lastFix,
        prevDrive = prevDrive,
        lastDroveTs = lastDroveTs,
        lastFastTs = lastFastTs,
        stepWalkTs = stepWalkTs
      )
    }
    return c.copy(
      paceRun = paceRun,
      anchor = c.anchor ?: LatLng(r.lat, r.lng),
      lastFix = lastFix,
      prevDrive = prevDrive,
      lastDroveTs = lastDroveTs,
      lastFastTs = lastFastTs,
      stepWalkTs = stepWalkTs
    )
  }
  val holdMs = if (!r.gnssValid && automotiveNow) min(FIXLESS_HOLD_MAX_MS, c.holdMs + ROW_MS) else c.holdMs
  return c.copy(paceRun = 0, holdMs = holdMs, prevDrive = false)
}

/**
 * A row's pedometer count (`steps`, after [endOnRow] for the same row), as JS's step walk reads it
 * (`motion.ts` `noteSteps`, `stepWalk`): the counts of the last STEP_WINDOW_MS (a lower count is a
 * pedometer that started again, and starts the log again), and the step walk due at the row's end
 * once they span STEP_WALK_MIN steps or more with no trusted fix over 3 mph in the STEP_CALM_MS
 * before it. Once due it stays due (`stepWalkTs`) until the car goes over 3 mph.
 */
fun DetectPolicy.endOnSteps(c: EndClock, ts: Double, steps: Double): EndClock {
  val last = c.steps.lastOrNull()
  val log: List<StepCount> =
    if (last != null && steps < last.steps) {
      listOf(StepCount(ts, steps))
    } else if (last != null && ts <= last.ts) {
      c.steps
    } else {
      c.steps.filter { m -> m.ts >= ts - STEP_WINDOW_MS } + StepCount(ts, steps)
    }
  val first = log.firstOrNull()
  val newest = log.lastOrNull()
  val t = ts + ROW_MS
  val calm = c.lastFastTs == null || t - c.lastFastTs > STEP_CALM_MS
  val walked = first != null && newest != null && newest.steps - first.steps >= STEP_WALK_MIN
  return c.copy(steps = log, stepWalkTs = c.stepWalkTs ?: (if (walked && calm) t else null))
}

/**
 * The standing walk's arrival, or null once the car has driven at or after it (`lastDroveTs` at or
 * after `walkSince`): as JS voids a walk the car drove after (`checkFoot`), only a walk that arrived
 * after the car was last at driving speed counts toward the walking end or the linger.
 */
fun DetectPolicy.walkStanding(c: EndClock, walkSince: Double?): Double? =
  if (walkSince != null && (c.lastDroveTs == null || c.lastDroveTs < walkSince)) walkSince else null

/**
 * `overdue`: a JS end rule would have ended the drive by now (12 h; a walk standing 10 s that the car
 * has not driven since, with no fix over 3 mph in the last 15 s; a step walk ([endOnSteps]); 5 min
 * without movement, holds excluded; the paired car gone CAR_GONE_MS with no trusted fix over 3 mph
 * since, `carGoneSince` being the car link's debounced "gone since"). `due`: the same plus the slack
 * (10 s on either walk, a minute on the others), when native stops sensing on its own. The limit
 * comes first, then walking, then still (the car link's end is a still one). `waitUntil`: a
 * Start-card drive still waiting for driving speed (JS ends it unsaved at that deadline, 5 min from
 * the tap or the last touch): no walking or car-link end (the walk to the car), and the still end
 * only once the deadline has passed too, so a touch that keeps the wait keeps the drive.
 */
fun DetectPolicy.endDue(
  c: EndClock,
  startedAt: Double,
  now: Double,
  walkSince: Double?,
  waitUntil: Double? = null,
  carGoneSince: Double? = null
): EndDecision {
  val carDriving = c.lastFix != null && c.lastFix.mps > END_CRAWL_MPS && now - c.lastFix.ts <= WALK_STALE_FIX_MS
  val age = now - startedAt
  val walk = walkStanding(c, walkSince)
  val walked = if (waitUntil == null && walk != null && !carDriving) now - walk else -1.0
  val stepped = if (waitUntil == null && c.stepWalkTs != null) now - c.stepWalkTs else -1.0
  val still = now - c.lastMoveTs - c.holdMs
  val gone =
    if (waitUntil == null && carGoneSince != null && (c.lastFastTs == null || c.lastFastTs < carGoneSince)) now - carGoneSince else -1.0
  fun pick(slack: Double, walkSlack: Double): SafetyCause? {
    if (age >= MAX_DRIVE_MS + slack) return SafetyCause.LIMIT
    if (walked >= WALK_END_MS + walkSlack || stepped >= walkSlack) return SafetyCause.WALKING
    if (still >= STILL_END_MS + slack && (waitUntil == null || now >= waitUntil + slack)) return SafetyCause.STILL
    if (gone >= CAR_GONE_MS + slack) return SafetyCause.STILL
    return null
  }
  return EndDecision(due = pick(SAFETY_SLACK_MS, WALK_SAFETY_SLACK_MS), overdue = pick(0.0, 0.0))
}

/**
 * Whether JS's end (`stopCapture`) was an automatic one, so the linger watches on after it: a JS end
 * rule would have made it by now ([endDue] overdue STILL or WALKING), or a walk the car has not
 * driven since ([walkStanding]) has stood WALK_STAND_MIN_MS less a row (JS counts its walking end on
 * the row clock, which runs a row ahead of the wall clock native reads here) while the last trusted
 * fix was at a walker's pace or under (WALKER_PACE_MAX_MPS), more than WALK_STALE_FIX_MS old, or
 * missing. JS's walking end fires 10 s after the walk began as the phone dates it, so as soon as 3 s
 * after the report arrived, where native counts from the arrival and is not yet overdue. It also
 * lets a carried phone at 5 mph or under end the drive where [endDue] still reads the car as
 * driving; native keeps no carried state, so any fix that slow counts here. A spare linger is
 * harmless: a 20 s walk ends it, and it takes no hourly cap entry, rest or parked spot. Like the
 * walking end, never on a walk while a Start-card drive still waits for driving speed.
 */
fun DetectPolicy.lingerAfterJsEnd(
  c: EndClock,
  startedAt: Double,
  now: Double,
  walkSince: Double?,
  waitUntil: Double? = null,
  carGoneSince: Double? = null
): Boolean {
  val o = endDue(c, startedAt, now, walkSince, waitUntil, carGoneSince).overdue
  if (o == SafetyCause.STILL || o == SafetyCause.WALKING) return true
  // A step walk JS ended on the row native just recorded (its row clock runs a row ahead).
  if (waitUntil == null && c.stepWalkTs != null) return true
  val walk = walkStanding(c, walkSince)
  if (waitUntil != null || walk == null || now - walk < WALK_STAND_MIN_MS - ROW_MS) return false
  return c.lastFix == null || c.lastFix.mps <= WALKER_PACE_MAX_MPS || now - c.lastFix.ts > WALK_STALE_FIX_MS
}

// ——— "Not driving?" ———

/** Suppression ends at its 3 h cap, on a walk standing 20 s, or after 5 min with nothing over 3 mph. */
fun DetectPolicy.suppressionDue(
  since: Double,
  until: Double,
  lastOverStopTs: Double?,
  walkSince: Double?,
  now: Double
): SuppressionCause? {
  if (now >= until) return SuppressionCause.CAP
  if (walkSince != null && now - walkSince >= WALK_CONFIRM_MS) return SuppressionCause.WALKING
  if (now - maxOf(since, lastOverStopTs ?: since) >= SUPPRESS_STILL_MS) return SuppressionCause.STILL
  return null
}

/**
 * A relaunch while detection rests: the rest goes on until its 3 h cap, still measured from when
 * "Not driving?" began it (`until`), and its still clock starts again at the relaunch. Nothing was
 * sensed while RoadWise was not running, and a relaunch comes from a wake (the phone moved) or from
 * the driver, so the rest ends no sooner than 5 min after it. The still clock's restart (`now`), or
 * null when the rest is over.
 */
fun DetectPolicy.suppressionResume(until: Double?, now: Double): Double? =
  if (until != null && now < until) now else null
