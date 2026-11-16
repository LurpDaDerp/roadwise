package expo.modules.drivesense.detect

// The drive detector's live motion and the "Not driving?" rest on Android (the iOS
// `DriveDetectorSensing.swift`, ruling 4). Live reports come while RoadWise senses (a watch, a
// drive); the rest senses nothing itself (no GPS, no service): it reads the activity transitions
// Play services delivers and ends on a 20 s walk, 5 min without vehicle motion, or 3 h, its
// evidence kept in the record so it survives RoadWise's process coming and going. Detector thread
// only, but for [onActivity], which posts.

/**
 * One live report (ActivitySource, every 5 s while sensing). A confident walk or run stands from
 * when it arrived until a report other than a walk or run replaces it; one at low confidence says
 * nothing either way. Car motion lasts until the report that replaces it; any confident automotive
 * report during a candidate is a vehicle sign. It also feeds the on-foot veto and slow traffic.
 */
fun DriveDetector.onActivity(a: MotionReport) {
  handler.post {
    val car = a.confident && a.automotive && !a.stationary
    if (car || carStanding) lastCarMotionAt = maxOf(lastCarMotionAt, a.at)
    carStanding = car
    vehicleStanding = a.confident && a.automotive
    val candidate = rec?.state == "candidate" && watching
    if (vehicleStanding && candidate) lastVehicleTs = a.at
    vetoState = DetectPolicy.noteVeto(vetoState, VetoReport(a.at, onFoot = a.walking || a.cycling, automotive = a.automotive, confident = a.confident))
    if (candidate) {
      slowState = DetectPolicy.slowTrafficReport(
        slowState,
        SlowReport(a.at, automotive = a.automotive, stationary = a.stationary, onFoot = a.walking || a.cycling, confident = a.confident)
      )
    }
    if (a.walking) {
      if (a.confident && walkSince == null) walkSince = a.at
    } else {
      walkSince = null
    }
  }
}

// ——— the rest after "Not driving?" ———

/**
 * A batch of transitions during the rest: what stood before each transition is checked at its time
 * (a walk that stood 20 s before the car came, or before a later transition of the same batch ended
 * it), then the evidence moves on (and is kept) and what stands now is checked.
 */
internal fun DriveDetector.restOnTransitions(batch: List<TimedTransition>, arrival: Double) {
  val r = rec ?: return
  if (r.state != "suppressed") return
  val since = r.suppressedSince
  val until = r.suppressedUntil
  if (since == null || until == null) {
    endSuppression()
    return
  }
  val step = DetectPolicy.restOnBatch(since, until, r.rest, batch, arrival)
  if (step.due != null) {
    endSuppression()
    return
  }
  save(r.copy(rest = step.standing))
  checkRest()
}

/** The rest's end, if it is due now; else the next look is timed (and every wake, foreground and state read looks again). */
internal fun DriveDetector.checkRest() {
  val r = rec ?: return
  if (r.state != "suppressed") return
  val since = r.suppressedSince
  val until = r.suppressedUntil
  if (since == null || until == null || DetectPolicy.restDue(since, until, r.rest, DriveDetector.now()) != null) {
    endSuppression()
    return
  }
  handler.removeCallbacks(restTask)
  handler.postDelayed(restTask, (DetectPolicy.restNextCheck(since, until, r.rest) - DriveDetector.now()).toLong().coerceAtLeast(1_000L))
}

/**
 * The rest is over: armed again (or off), and the parked spot where the phone came to rest: its
 * last known fix when Play services holds a fresh one (no GPS is turned on for it). The last end is
 * untouched.
 */
internal fun DriveDetector.endSuppression() {
  val r = rec ?: return
  if (r.state != "suppressed") return
  handler.removeCallbacks(restTask)
  val settled = settle(r, DriveDetector.now())
  save(settled)
  if (settled.state == "armed") wakes.lastKnown { spot -> if (spot != null) handler.post { park(spot) } }
  syncWakes()
  emitState("suppressionEnded")
}

/** The standing report is moving car motion (a tunnel, a garage): a fix-less row holds the still clock. */
internal fun DriveDetector.automotiveNow(): Boolean = carStanding
