package expo.modules.drivesense.detect

import expo.modules.drivesense.AppVisibility
import expo.modules.drivesense.CaptureService
import expo.modules.drivesense.DetectEventBus
import expo.modules.drivesense.DriveStartNote
import expo.modules.drivesense.EventBus
import expo.modules.drivesense.FeatureRow
import expo.modules.drivesense.JournalSummary
import expo.modules.drivesense.RowJournalRead
import java.util.UUID
import org.json.JSONObject

// The drive detector's drive (the iOS `DriveDetectorDrive.swift` and the relaunch half of
// `DriveDetectorSensing.swift`): a drive begins with a start (the Start card's tap, or a watch's
// traced start), a journal and `driveStarted`; its rows are journaled with their `seq` and handed to
// JS; the native safety stop or JS's `stopCapture` commits its end (the parked spot set, and after
// an automatic end the linger's watch); "Not driving?" cancels it and rests; a new process resumes
// it or ends it as an orphan. Detector thread only (every function here runs on `DriveDetector.handler`).

private fun ms(d: Double?): Any = DriveDetectRecord.ms(d) ?: JSONObject.NULL

/**
 * The Start card: a manual drive opens at once, from the tap ([tap]), journaled like any drive. It
 * waits for driving speed (`waitUntil`, 5 min from the tap or the last touch, where JS ends it
 * unsaved): meanwhile the safety stop never ends it on a walk, and on the still clock only past
 * that deadline (`DetectPolicy.endDue`). A rest after "Not driving?" ends here.
 */
internal fun DriveDetector.beginManualDrive(tap: Double) {
  var r = rec ?: return
  // A watch running gives way (its rows dropped, its service now the drive's) and, like a confirmed
  // one, leaves the hourly cap's record.
  if (r.state == "candidate" && watching) {
    r = r.copy(candidateStarts = DetectPolicy.startsAfter(r.candidateStarts, r.since, sawVehicle = true))
    watching = false
    clearWatch()
    stopClock()
  }
  save(
    r.copy(
      state = "candidate",
      origin = "manual",
      since = tap,
      driveId = null,
      startedAt = null,
      startSource = null,
      waitUntil = tap + DetectPolicy.WAIT_MAX_MS,
      suppressedSince = null,
      suppressedUntil = null,
      rest = RestStanding()
    )
  )
  handler.removeCallbacks(restTask)
  emitState("waiting")
  beginDrive(tap, StartSource.WAKE.wire, null, null, kind = "manual", waitUntil = tap + DetectPolicy.WAIT_MAX_MS)
}

/** A Start-card drive at driving speed (two trusted rows at 10 mph or more in a row): its wait is over. */
internal fun DriveDetector.endWaitAtDrivingSpeed() {
  val r = rec ?: return
  if (endClock.lastDroveTs == null || r.waitUntil == null) return
  save(r.copy(waitUntil = null))
  emitState("confirmed")
}

/**
 * A watch confirmed: the drive begins at its traced start, its service becomes the drive's in place
 * (the drive notification replaces "Checking for a drive"; with no RoadWise screen open the
 * background JS starts to take it in), the "drive started" note goes up ([DriveStartNote]), and the
 * buffered rows from the start on are journaled and handed to JS (the safety stop waits for the
 * first live row, so an old movement replayed against the clock now never ends the drive it starts).
 */
internal fun DriveDetector.beginAutoDrive(start: TracedStart, firstTs: Double) {
  val kept = buffer.items.filter { it.row.ts >= firstTs }
  watching = false
  clearWatch()
  beginDrive(start.startedAt, start.startSource.wire, start.startLat, start.startLng, kind = "auto", waitUntil = null)
  CaptureService.promoteWatch(app, RowJournalRead.jsMs(start.startedAt), "auto")
  // Only once the drive really began (a detector with no record begins nothing).
  if (rec?.recording == true) DriveStartNote.driveStarted(app, "auto")
  for (item in kept) record(item.row, item.body, evaluate = false)
}

/** The drive begins: recorded, journaled from its first row (seq 1), announced to JS, its clock on. */
internal fun DriveDetector.beginDrive(startedAt: Double, startSource: String, startLat: Double?, startLng: Double?, kind: String, waitUntil: Double?) {
  val r = rec ?: return
  val now = DriveDetector.now()
  val driveId = UUID.randomUUID().toString().lowercase()
  val continues = DetectPolicy.continuesFrom(r.lastEnd, startedAt, startLat, startLng)
  save(
    r.copy(
      // A confirmed candidate was a real drive: it leaves the hourly cap's record.
      candidateStarts = DetectPolicy.startsAfter(r.candidateStarts, r.since, sawVehicle = true),
      state = "recording",
      since = now,
      driveId = driveId,
      startedAt = startedAt,
      startSource = startSource,
      waitUntil = waitUntil
    )
  )
  val start = JSONObject()
    .put("k", "start")
    .put("v", 1)
    .put("driveId", driveId)
    .put("origin", kind)
    .put("startedAt", ms(startedAt))
    .put("startSource", startSource)
    .put("startLat", startLat ?: JSONObject.NULL)
    .put("startLng", startLng ?: JSONObject.NULL)
    .put("continues", continues)
    .put("confirmedAt", ms(now))
    .put("nativeBuild", nativeBuild)
  journal.open(driveId, start) { dropped ->
    if (dropped > 0) handler.post { rec?.let { save(it.copy(journalDropped = it.journalDropped + dropped)) } }
  }
  nextSeq = 1
  lastRowTs = null
  lastFix = null
  walkSince = null
  lingering = false
  lastVehicleTs = null
  endClock = DetectPolicy.endClockAt(now)
  carLink.beginDrive()
  sensing = true
  resumePending = false
  DetectEventBus.emit(
    "driveStarted",
    linkedMapOf(
      "driveId" to driveId,
      "origin" to kind,
      "startedAt" to DriveDetectRecord.ms(startedAt),
      "startSource" to startSource,
      "startLat" to startLat,
      "startLng" to startLng,
      "continues" to continues,
      "confirmedAt" to DriveDetectRecord.ms(now),
      "firstSeq" to 1
    )
  )
  emitState("confirmed")
  startClock()
}

/** One capture row (the capture thread hands it over): a watch buffers it, a sensed drive journals it. */
fun DriveDetector.onRow(row: FeatureRow, body: Map<String, Any?>, watchRow: Boolean) {
  handler.post {
    val r = rec
    // A watch's row (or a drive's row while its service turns into the linger's watch): the candidate's.
    if (r?.state == "candidate" && watching) {
      candidateRow(DetectRow.of(row), body)
      return@post
    }
    // A watch's row with no candidate behind it (the watch is over) stops its service; one that
    // arrives as the confirmed watch's service turns into the drive's is the drive's.
    if (watchRow && !(r?.recording == true && sensing)) {
      CaptureService.stopWatch(app)
      return@post
    }
    when (captureRowFate(sensing, starting, resuming, r?.recording == true)) {
      CaptureRowFate.SENSED -> Unit
      CaptureRowFate.WAIT -> return@post
      // A capture with no drive behind it (a start that answered too late, after its refusal): it stops.
      CaptureRowFate.STOP -> {
        CaptureService.stopDetector(app, 0L)
        return@post
      }
      // A resume counted as refused whose capture began after all: the drive is taken back (or
      // ends as an orphan), so the capture is sensed or stopped, never left running unbounded.
      CaptureRowFate.TAKE_BACK -> {
        r?.driveId?.let { resumeDrive(it) } ?: CaptureService.stopDetector(app, 0L)
        return@post
      }
    }
    record(DetectRow.of(row), body)
    if (rec?.waitUntil != null) endWaitAtDrivingSpeed()
  }
}

/**
 * One row of the drive: journaled and emitted (DriveSense's `row`) with the next `seq`, the
 * safety-stop clock fed (the capture's `steps` included) and, a live row ([evaluate]), checked. A
 * walk the car has driven since is dropped, as JS drops it.
 */
internal fun DriveDetector.record(d: DetectRow, body: Map<String, Any?>, evaluate: Boolean = true) {
  val driveId = rec?.driveId ?: return
  val line = LinkedHashMap(body)
  line["seq"] = nextSeq
  nextSeq += 1
  journalLine(line)?.let { journal.appendRow(driveId, it) }
  EventBus.emit("row", line)
  lastRowTs = d.ts
  // Only live rows count toward the car link's tally: a buffered row is from before the confirmation.
  if (evaluate) carLink.countRow()
  if (DetectPolicy.trusted(d)) lastFix = LatLng(d.lat, d.lng)
  endClock = DetectPolicy.endOnRow(endClock, d, automotiveNow = automotiveNow())
  (line["steps"] as? Number)?.let { endClock = DetectPolicy.endOnSteps(endClock, d.ts, it.toDouble()) }
  if (walkSince != null && DetectPolicy.walkStanding(endClock, walkSince) == null) walkSince = null
  if (evaluate) evaluateEnd()
}

/** A row payload as a journal line's object; null when it cannot be one (a NaN). */
private fun journalLine(line: Map<String, Any?>): JSONObject? =
  try {
    val o = JSONObject()
    for ((k, v) in line) o.put(k, v ?: JSONObject.NULL)
    o
  } catch (_: Exception) {
    null
  }

/**
 * The safety stop: native ends the drive 10 s after the JS walking end or a minute after another JS
 * rule would have (the car link's end: a minute after JS's 15 s, the paired car or Android Auto gone
 * with nothing over 3 mph since); meanwhile the state says `ending` while a JS end is overdue and
 * `recording` again once the car moves.
 */
internal fun DriveDetector.evaluateEnd() {
  val r = rec ?: return
  val startedAt = r.startedAt
  if (!r.recording || startedAt == null) return
  val now = DriveDetector.now()
  val d = DetectPolicy.endDue(endClock, startedAt, now, walkSince, r.waitUntil, carLink.goneSince)
  val due = d.due
  if (due != null) {
    commitEnd(due.wire, now, linger = due == SafetyCause.STILL || due == SafetyCause.WALKING)
    return
  }
  val next = if (d.overdue == null) "recording" else "ending"
  if (next == r.state) return
  save(r.copy(state = next, since = now))
  emitState(if (next == "recording") "moved" else if (d.overdue == SafetyCause.WALKING) "walking" else "stillClock")
}

/**
 * Commits the drive's end: journaled (`end`) and closed, the last end and the parked spot at the
 * last trusted fix, armed again. A native cause goes to JS as `driveEnded`; JS's own ("js", its cut
 * as `endedAt`) does not. Native never computes a cut: its `endedAt` is when it decided. Sensing
 * then stops (the service keeps RoadWise running 25 s more so JS can store the drive and post its
 * recap), except after an automatic end ([linger]: 5 min still, or a walk) of a drive no longer
 * waiting for driving speed while automatic drives are armed: the service runs on as the linger's
 * watch (3 min, 5 with evidence, outside the hourly cap), so a car that sets off again soon is
 * confirmed at once as a new drive with its whole route; "Checking for a drive" replaces the drive
 * notification at once, and RoadWise stays running through it, as long as the 25 s hold and more.
 */
internal fun DriveDetector.commitEnd(cause: String, endedAt: Double, linger: Boolean = false) {
  val r = rec ?: return
  val driveId = r.driveId
  if (!r.recording || driveId == null) return
  val now = DriveDetector.now()
  val lingerAfter = linger && r.waitUntil == null && sensing && CaptureService.detectorRunning()
  // A drive that reached driving speed tells the car link which outputs it had (before the clock resets).
  carLink.endDrive(driveId, endedAt, drove = endClock.lastDroveTs != null)
  val lastSeq = nextSeq - 1
  val rowTs = lastRowTs
  journal.appendMarker(
    driveId,
    JSONObject()
      .put("k", "end")
      .put("endedAt", ms(endedAt))
      .put("cause", cause)
      .put("decidedAt", ms(now))
      .put("lastRowTs", ms(rowTs))
      .put("lastSeq", lastSeq),
    close = true
  )
  // A drive with no trusted fix (a Start drive cancelled indoors) keeps the last end: the car is
  // still where it last parked.
  var n = r
  val spot = lastFix
  spot?.let { f -> n = n.copy(lastEnd = DetectLastEnd(now, if (cause == "js") endedAt else now, f.lat, f.lng, driveId)) }
  val settled = settle(n, now)
  save(settled)
  val lingers = lingerAfter && settled.state == "armed"
  finishSensing(holdMs = DetectPolicy.END_TASK_MAX_MS.toLong(), demote = lingers)
  lastFix = null
  if (settled.state == "armed" && spot != null) park(spot)
  if (cause != "js") {
    DetectEventBus.emit(
      "driveEnded",
      linkedMapOf("driveId" to driveId, "endedAt" to DriveDetectRecord.ms(endedAt), "cause" to cause, "decidedAt" to DriveDetectRecord.ms(now), "lastSeq" to lastSeq, "lastRowTs" to DriveDetectRecord.ms(rowTs))
    )
  }
  emitState("ended")
  syncWakes()
  if (lingers) beginCandidate("linger")
}

/**
 * Whether JS's end was an automatic one (`DetectPolicy.lingerAfterJsEnd`): 5 min still, or a walk
 * the car has not driven since that has stood JS's 3 s floor less a row, with the last trusted fix
 * at a walker's pace or under, more than 15 s old, or missing.
 */
internal fun DriveDetector.automaticEndDue(): Boolean {
  val r = rec ?: return false
  val startedAt = r.startedAt ?: return false
  if (!r.recording) return false
  return DetectPolicy.lingerAfterJsEnd(endClock, startedAt, DriveDetector.now(), walkSince, r.waitUntil, carLink.goneSince)
}

/**
 * "Not driving?": the drive is cancelled (its journal deleted, nothing kept) and detection rests
 * with no GPS until a 20 s walk, 5 min without vehicle motion, or 3 h (ruling 4: the activity
 * transitions are its eyes; car motion in the live feed's last 2 min, or an IN_VEHICLE transition
 * still standing in the motion history, holds its still clock: a passenger still riding, whatever
 * the one live report at the tap said). The last end stays as it was.
 */
fun DriveDetector.notDriving(done: () -> Unit) {
  handler.post {
    val r = rec
    val driveId = r?.driveId
    if (r == null || !r.recording || driveId == null) {
      done()
      return@post
    }
    val now = DriveDetector.now()
    val lastSeq = nextSeq - 1
    val rowTs = lastRowTs
    carLink.endDrive(driveId, now, drove = false)
    journal.delete(driveId)
    save(
      r.copy(
        state = "suppressed",
        since = now,
        origin = null,
        waitUntil = null,
        driveId = null,
        startedAt = null,
        startSource = null,
        suppressedSince = now,
        suppressedUntil = now + DetectPolicy.SUPPRESS_MAX_MS,
        rest = DetectPolicy.restSeed(carFresh(), history)
      )
    )
    finishSensing(holdMs = DetectPolicy.END_TASK_MAX_MS.toLong())
    lastFix = null
    checkRest()
    syncWakes()
    DetectEventBus.emit(
      "driveEnded",
      linkedMapOf("driveId" to driveId, "endedAt" to DriveDetectRecord.ms(now), "cause" to "cancelled", "decidedAt" to DriveDetectRecord.ms(now), "lastSeq" to lastSeq, "lastRowTs" to DriveDetectRecord.ms(rowTs))
    )
    emitState("notDriving")
    done()
  }
}

/**
 * Sensing ends: the capture stops (its notification goes; RoadWise is held [holdMs] more), or with
 * [demote] runs on as the linger's watch; the "drive started" note goes; the drive's clocks reset.
 */
internal fun DriveDetector.finishSensing(holdMs: Long, demote: Boolean = false) {
  if (demote) CaptureService.demoteToWatch(app) else CaptureService.stopDetector(app, holdMs)
  DriveStartNote.remove(app)
  watching = false
  stopClock()
  sensing = false
  resumePending = false
  nextSeq = 1
  lastRowTs = null
  walkSince = null
  carStanding = false
  endClock = DetectPolicy.endClockAt(0.0)
  clearStaleCapture()
}

/**
 * The journal says where the drive got to: a last row 5 min old or less resumes it (sensing again,
 * then a `gap` line and rows from past the gap's seq); older, it ends as an orphan for JS to
 * finalize. A start Android refuses leaves the drive as it is, for the next foreground, wake or process.
 * The wakes that came meanwhile are replayed once it settles ([HeldWakes]); a sticky restart's
 * service (already in the foreground) is kept through them, so a drive that ended can watch at once.
 */
internal fun DriveDetector.resumeDrive(driveId: String) {
  resuming = true
  journal.reopen(driveId) { summary ->
    handler.post {
      resuming = false
      // The sticky restart asked while the journal was read, or its service is already in the
      // foreground. A restart whose service comes later still gets its `app` wake ([HeldWakes.owed]).
      val sticky = stickyResume || (CaptureService.foregroundRunning() && !CaptureService.isCapturing)
      stickyResume = false
      if (sticky) CaptureService.holdRelease()
      heldWakes.settling(sticky)
      val ended = settleResume(driveId, summary)
      for ((reason, done) in heldWakes.drain(ended, sticky, noop = {})) onWake(reason, done)
      if (sticky) CaptureService.endReleaseHold()
    }
  }
}

/** The resume's answer from the journal ([resumeDrive]). True when the drive ended here. */
private fun DriveDetector.settleResume(driveId: String, summary: JournalSummary?): Boolean {
  val r = rec
  if (r == null || r.driveId != driveId || !r.recording || sensing) return false
  val now = DriveDetector.now()
  if (summary == null) {
    // No journal: nothing to resume or hand over; its "drive started" note goes too.
    save(settle(r, now))
    DriveStartNote.remove(app)
    resumePending = false
    clearStaleCapture()
    CaptureService.releaseIfIdle()
    emitState("ended")
    return true
  }
  nextSeq = summary.lastSeq + 1
  lastRowTs = summary.lastRowTs
  val lat = summary.lastFixLat
  val lng = summary.lastFixLng
  if (lat != null && lng != null) lastFix = LatLng(lat, lng)
  val startedAt = r.startedAt ?: now
  if (DetectPolicy.resumeDecision(summary.lastRowTs, startedAt, now) != ResumeDecision.RESUME) {
    commitEnd("orphan", now)
    return true
  }
  startResumed(driveId, summary, startedAt, if (r.origin == "manual") "mounted" else "auto", retry = true)
  return false
}

/**
 * The resumed drive's sensing. A refusal once the service is in the foreground after all (the
 * system's sticky restart got there meanwhile) or RoadWise has come to the front (a launch's process
 * start runs before its screen shows) is tried once more.
 */
private fun DriveDetector.startResumed(driveId: String, s: JournalSummary, startedAt: Double, mode: String, retry: Boolean) {
  CaptureService.startDetector(app, RowJournalRead.jsMs(startedAt), mode, restart = true) { code ->
    handler.post {
      if (code != null && retry && (CaptureService.foregroundRunning() || AppVisibility.visible())) startResumed(driveId, s, startedAt, mode, retry = false)
      else onResumeSensing(driveId, s, startedAt, code)
    }
  }
}

/** The resumed drive's service answered: sensing again (the `gap` line, the rows past it), or refused (left for later). */
private fun DriveDetector.onResumeSensing(driveId: String, s: JournalSummary, startedAt: Double, code: String?) {
  val r = rec
  if (r == null || r.driveId != driveId || !r.recording || sensing) return
  if (code != null) {
    // The record and the journal stay as they are: the next foreground, wake or process start
    // resumes the drive (or ends it as an orphan, past its 5 min).
    resumePending = true
    return
  }
  resumePending = false
  val now = DriveDetector.now()
  // JS takes a relaunched Start-card drive back without its wait: native's goes with it.
  if (r.waitUntil != null) save(r.copy(waitUntil = null))
  // The last unsynced rows may be lost from the file but held by JS: the rows go on past a gap of
  // seqs (the `gap` line carries it), so none is handed out twice.
  val skipTo = DetectPolicy.resumeSeq(s.topSeq)
  nextSeq = skipTo + 1
  journal.appendMarker(
    driveId,
    JSONObject().put("k", "gap").put("from", ms(s.lastRowTs ?: startedAt)).put("to", ms(now)).put("lastSeq", skipTo),
    close = false
  )
  // The still clock restarts at the last row journaled (a kill at a light does not end the drive).
  endClock = DetectPolicy.endClockAt(s.lastRowTs ?: now)
  carLink.beginDrive()
  walkSince = null
  carStanding = false
  sensing = true
  startClock()
  // With no RoadWise screen open, the service has started the headless JS host to take it in.
  emitState("resumed")
}
