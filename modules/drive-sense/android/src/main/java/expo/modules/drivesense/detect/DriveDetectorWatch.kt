package expo.modules.drivesense.detect

import expo.modules.drivesense.CaptureService

// The drive detector's wakes and watch on Android (the iOS `DriveDetectorWatch.swift` and the
// confirmation half of `DriveDetectorDrive.swift`): a wake (a confident IN_VEHICLE ENTER, the
// parked geofence's exit, RoadWise coming to the front) passes the policy's wake gate and, but for
// the geofence, its motion gate over the motion history, then opens an auto candidate: the location
// service in its watch form (GPS, IMU and rows into the buffer, "Checking for a drive", no JS),
// watching while it sees vehicle signs, at most 30 min (`DetectPolicy.candidateDue`). A
// confirmation (the speed hold, slow traffic or the car link) traces the start back over the buffer
// and the motion history and becomes the drive in place. A paired car's Bluetooth connecting is a
// wake too on Android (ruling 2; iPhone has no such wake). An automatic
// end opens the linger's watch in place; a geofence exit during the linger turns it into an
// ordinary watch. A candidate's end decides the rest, the hourly cap's record and a parked spot.
// Detector thread only (every function here runs on `DriveDetector.handler`).

/**
 * One delivered batch of activity transitions (ActivityTransitionReceiver), each with the time it
 * happened; [arrival]: when it arrived; [subscribedAt]: when the request on file was made (whatever
 * it replayed happened before). The motion history takes every one; the rest reads it; a confident
 * IN_VEHICLE ENTER is a wake, unless it is a replay from well before the request (a stale report,
 * as iOS skips a significant change older than 2 min at its start). [done] once the wake has acted.
 */
fun DriveDetector.onTransitions(batch: List<TimedTransition>, arrival: Double, subscribedAt: Double, done: () -> Unit) {
  handler.post {
    val r = rec
    if (r == null) {
      done()
      return@post
    }
    addHistory(batch.mapNotNull { t -> ActivityHistory.Kind.of(t.type, t.enter)?.let { ActivityHistory.Entry(t.at, it) } }, arrival)
    if (r.state == "suppressed") restOnTransitions(batch, arrival)
    val vehicle = batch.lastOrNull { it.type == "automotive" && it.enter }
    // The newest transition must still be the car: a batch that ends on foot is no drive starting.
    val carNow = vehicle != null && batch.last() === vehicle
    if (carNow && vehicle!!.at >= subscribedAt - DetectPolicy.SLC_STALE_MS) onWake(WakeReason.SLC, done) else done()
  }
}

/** The parked geofence's exit (GeofenceReceiver): a `region` wake, or the linger turned into a watch. */
fun DriveDetector.onRegionExit(done: () -> Unit) {
  handler.post { onWake(WakeReason.REGION, done) }
}

/**
 * A Bluetooth device connected ([expo.modules.drivesense.CarConnectReceiver]): when it is a paired
 * car, a `car` wake (its broadcast may start the location service from the background, Android 12+
 * with Nearby devices). Any other device does nothing.
 */
fun DriveDetector.onCarConnected(address: String, done: () -> Unit) {
  handler.post {
    if (carLink.isPaired(address)) onWake(WakeReason.CAR, done) else done()
  }
}

/**
 * A wake. A rest past its end ends first and a permission change is taken in; then the policy's
 * wake gate (armed, an owner, the permissions, nothing under way, the rest after an empty watch
 * for all but the geofence, a paired car and the app, at most 6 empty watches an hour). The
 * geofence's exit and a paired car connecting are car-motion evidence enough; the others need the
 * motion history's car motion in the last 2 min with the driver not on foot or on a bike
 * ([DetectPolicy.motionGate]).
 */
internal fun DriveDetector.onWake(reason: WakeReason, done: () -> Unit = {}) {
  // The journal is being read: the wake waits for the resume to settle (a drive ended as an orphan
  // then lets it watch), its done held with it.
  if (resuming) {
    heldWakes.hold(reason, done)
    return
  }
  if (reason == WakeReason.REGION && lingerToWatch()) {
    done()
    return
  }
  checkRest()
  sync("permissionLost")
  val r = rec
  if (r == null) {
    done()
    return
  }
  val now = DriveDetector.now()
  val ctx = WakeCtx(
    now = now,
    reason = reason,
    phase = DetectPhase.of(r.state) ?: DetectPhase.OFF,
    armed = r.armed,
    hasOwner = r.ownerId != null,
    permissionsOk = access.snapshot().requiredOk,
    candidateRestUntil = r.candidateRestUntil,
    candidateStarts = r.candidateStarts
  )
  if (DetectPolicy.wakeGate(ctx) != WakeGate.OK || starting || resuming || CaptureService.isCapturing) {
    done()
    return
  }
  if (reason == WakeReason.REGION) {
    beginCandidate("wake:region", done = done)
    return
  }
  // The car just came on (usually before it moves): car-motion evidence enough, as the geofence's exit.
  if (reason == WakeReason.CAR) {
    beginCandidate("wake:car", done = done)
    return
  }
  val m = motionSince(now - DetectPolicy.MOTION_LOOKBACK_MS, now)
  if (DetectPolicy.motionGate(m, now) != MotionGate.OK) {
    done()
    return
  }
  beginCandidate("wake:${reason.wire}", carMotionAt = m.lastAutomotiveAt, done = done)
}

/**
 * A geofence exit during the linger: the phone has left the parked spot (a car idling where it
 * parked never does), so the linger becomes an ordinary watch from the exit: in the hourly cap's
 * record until it sees a vehicle, kept open by its vehicle signs up to the 30 min cap, and an empty
 * timeout leaves the parked spot where the phone rests. Its evidence stays. False unless the linger runs.
 */
internal fun DriveDetector.lingerToWatch(): Boolean {
  val r = rec ?: return false
  if (!lingering || r.state != "candidate" || r.origin != "auto") return false
  val now = DriveDetector.now()
  lingering = false
  save(r.copy(since = now, candidateStarts = DetectPolicy.recentStarts(r.candidateStarts, now) + now))
  emitState("wake:region")
  return true
}

/**
 * An auto candidate opens: the record first (counted toward the hourly cap, except the linger),
 * then the watch's service (from the wake's broadcast or RoadWise in front; the linger's runs on
 * from the drive), the buffer and the evidence empty. [carMotionAt]: the wake's newest car motion.
 * A start Android refuses ends the candidate at once, uncounted (it never watched).
 */
internal fun DriveDetector.beginCandidate(reason: String, carMotionAt: Double = 0.0, done: () -> Unit = {}) {
  val r = rec
  if (r == null) {
    done()
    return
  }
  val now = DriveDetector.now()
  val linger = reason == "linger"
  save(
    r.copy(
      state = "candidate",
      origin = "auto",
      since = now,
      driveId = null,
      startedAt = null,
      startSource = null,
      waitUntil = null,
      candidateStarts = if (linger) r.candidateStarts else DetectPolicy.recentStarts(r.candidateStarts, now) + now,
      suppressedSince = null,
      suppressedUntil = null,
      rest = RestStanding()
    )
  )
  clearWatch()
  lingering = linger
  watchAfterEnd = linger
  watching = true
  // The standing report is this candidate's own: an older one may no longer stand.
  carStanding = false
  vehicleStanding = false
  walkSince = null
  lastCarMotionAt = maxOf(lastCarMotionAt, carMotionAt)
  carLink.refresh()
  startClock()
  emitState(reason)
  if (linger) {
    done()
    return
  }
  CaptureService.startWatch(app) { code ->
    handler.post {
      if (code != null) watchRefused(now)
    }
  }
  done()
}

/** The watch's service was refused: the candidate ends uncounted, with no rest. */
private fun DriveDetector.watchRefused(since: Double) {
  val r = rec ?: return
  if (r.state != "candidate" || r.since != since || !watching) return
  watching = false
  stopClock()
  clearWatch()
  save(settle(r.copy(candidateStarts = r.candidateStarts.filter { it != since }), DriveDetector.now()))
  syncWakes()
  emitState("cancelled")
}

/** The candidate's runtime state, emptied. */
internal fun DriveDetector.clearWatch() {
  buffer.clear()
  confirmState = ConfirmState()
  slowState = SlowTrafficState()
  linkState = LinkState()
  lastVehicleTs = null
  lingering = false
  watchAfterEnd = false
}

/**
 * A candidate ends unconfirmed: its service stops (the notification goes), nothing kept. [rest]:
 * the next transition wakes rest 10 min. Only a candidate that saw no vehicle stays in the hourly
 * cap's record, and one that timed out seeing none leaves the parked spot where the phone rests
 * (the next departure from there is a geofence exit). The linger does neither: the drive's own end
 * placed the parked spot.
 */
internal fun DriveDetector.endCandidate(reason: String, rest: Boolean) {
  val r = rec ?: return
  if (r.state != "candidate") return
  val now = DriveDetector.now()
  val sawVehicle = lastVehicleTs != null
  val parkHere = r.origin == "auto" && !lingering && reason == "timeout" && !sawVehicle
  val settled = settle(
    r.copy(
      candidateRestUntil = if (rest) now + DetectPolicy.CANDIDATE_REST_MS else r.candidateRestUntil,
      candidateStarts = DetectPolicy.startsAfter(r.candidateStarts, r.since, sawVehicle)
    ),
    now
  )
  save(settled)
  if (watching) CaptureService.stopDetector(app, 0L)
  watching = false
  stopClock()
  val spot = lastFix
  clearWatch()
  lastFix = null
  if (parkHere && settled.state == "armed" && spot != null) park(spot)
  syncWakes()
  emitState(reason)
}

/** The watch's service went away on its own (the system stopped it): the candidate ends, uncounted as a rest. */
fun DriveDetector.onCaptureGone() {
  handler.post {
    val r = rec ?: return@post
    if (r.state == "candidate" && watching) {
      watching = false
      endCandidate("cancelled", rest = false)
    }
  }
}

/** Car motion is fresh: the standing report is confident moving car motion, or some was seen in the last 2 min. */
internal fun DriveDetector.carFresh(): Boolean =
  carStanding || DriveDetector.now() - lastCarMotionAt <= DetectPolicy.AUTOMOTIVE_FRESH_MS

/** A confident walking, running or cycling report from the last 30 s holds an auto confirmation, unless the car came after it. */
internal fun DriveDetector.vetoNow(): Boolean = DetectPolicy.onFootVeto(vetoState, DriveDetector.now())

/**
 * The candidate's clock (every 5 s): a standing automotive report is a vehicle sign now; then the
 * policy's deadline. The linger watches 3 min from the end (5 once it holds evidence), whatever it
 * sees; rest only after one that saw no vehicle, or at the cap; never after the linger.
 */
internal fun DriveDetector.candidateTick(r: DriveDetectRecord, now: Double) {
  val kind = if (r.origin == "manual") TriggerKind.MANUAL else TriggerKind.AUTO
  if (kind == TriggerKind.AUTO && vehicleStanding) lastVehicleTs = now
  val due = DetectPolicy.candidateDue(
    kind,
    r.since,
    r.waitUntil,
    walkSince,
    now,
    lastVehicleTs = if (lingering) null else lastVehicleTs,
    hasEvidence = confirmState.evidence > 0 || DetectPolicy.slowTrafficHeld(slowState, now)
  ) ?: return
  endCandidate(due.wire, rest = !lingering && (due == CandidateCause.CAP || (due == CandidateCause.TIMEOUT && lastVehicleTs == null)))
}

/**
 * One watch row: into the buffer; a trusted row at 10 mph or more with no fresh walk, run or ride
 * report is a vehicle sign; then the speed evidence, slow traffic and the car link (a paired car or
 * Android Auto connected: two trusted rows at 5 mph or more with fresh car motion; Android Auto at
 * 15 mph or more without it too), each confirming on its own.
 */
internal fun DriveDetector.candidateRow(d: DetectRow, body: Map<String, Any?>) {
  buffer.append(d, body)
  if (DetectPolicy.trusted(d)) lastFix = LatLng(d.lat, d.lng)
  val veto = vetoNow()
  if (DetectPolicy.moving(d) && !veto) lastVehicleTs = d.ts
  val step = DetectPolicy.confirmStep(confirmState, d, TriggerKind.AUTO, veto = veto, carFresh = carFresh())
  confirmState = step.state
  if (step.confirmed) {
    confirm(confirmState.runStartTs)
    return
  }
  val slow = DetectPolicy.slowTrafficStep(slowState, d)
  slowState = slow.state
  val link = DetectPolicy.linkStep(linkState, d, linked = carLink.linked, carPlay = DetectPolicy.carPlayOn(CarLinkRules.ports(carLink.current)), carFresh = carFresh())
  linkState = link.state
  if (slow.confirmed) {
    confirm(slowState.runStartTs)
  } else if (link.confirmed) {
    confirm(linkState.runStartTs)
  }
}

/**
 * A path confirmed on the buffer's last row (`runStart`: its run's first row): the start traced
 * back over the buffer; a drive whose rows begin moving reads the motion history for when the car
 * set off (never before the last drive's end): so a geofence exit Android delivered minutes late
 * still starts the drive at the pull-away, placed at the parked spot when the car could have come
 * from there. Then the drive begins with the buffer's rows from its start on.
 */
internal fun DriveDetector.confirm(runStart: Double?) {
  val rows = buffer.rows
  if (rows.isEmpty()) return
  val h = runStart?.let { buffer.index(it) } ?: 0
  val lastEnd = rec?.lastEnd
  val now = DriveDetector.now()
  val automotiveSince =
    if (DetectPolicy.traceStart(rows, h) != null) {
      0.0
    } else {
      motionSince(maxOf(lastEnd?.decidedAt ?: 0.0, now - DetectPolicy.MOTION_LOOKBACK_MS), now).automotiveSince
    }
  val start = DetectPolicy.startOf(rows, h, TriggerKind.AUTO, automotiveSince, lastEnd)
  beginAutoDrive(start, rows[start.index].ts)
}
