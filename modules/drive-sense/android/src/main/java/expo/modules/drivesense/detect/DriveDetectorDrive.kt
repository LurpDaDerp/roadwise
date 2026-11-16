package expo.modules.drivesense.detect

import expo.modules.drivesense.AppVisibility
import expo.modules.drivesense.CaptureService
import expo.modules.drivesense.DetectEventBus
import expo.modules.drivesense.EventBus
import expo.modules.drivesense.FeatureRow
import expo.modules.drivesense.JournalSummary
import expo.modules.drivesense.RowJournalRead
import java.util.UUID
import org.json.JSONObject

// The drive detector's drive (the iOS `DriveDetectorDrive.swift` and the relaunch half of
// `DriveDetectorSensing.swift`): a drive begins with a start, a journal and `driveStarted`; its rows
// are journaled with their `seq` and handed to JS; the native safety stop or JS's `stopCapture`
// commits its end; "Not driving?" cancels it and rests; a new process resumes it or ends it as an
// orphan. Detector thread only (every function here runs on `DriveDetector.handler`).

private fun ms(d: Double?): Any = DriveDetectRecord.ms(d) ?: JSONObject.NULL

/**
 * The Start card: a manual drive opens at once, from the tap ([tap]), journaled like any drive. It
 * waits for driving speed (`waitUntil`, 5 min from the tap or the last touch, where JS ends it
 * unsaved): meanwhile the safety stop never ends it on a walk, and on the still clock only past
 * that deadline (`DetectPolicy.endDue`). A rest after "Not driving?" ends here.
 */
internal fun DriveDetector.beginManualDrive(tap: Double) {
  val r = rec ?: return
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
      suppressedUntil = null
    )
  )
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
  endClock = DetectPolicy.endClockAt(now)
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

/** One capture row (the capture thread hands it over): a sensed drive journals it. */
fun DriveDetector.onRow(row: FeatureRow, body: Map<String, Any?>) {
  handler.post {
    val r = rec
    if (!sensing || r == null || !r.recording) return@post
    record(DetectRow.of(row), body)
    if (rec?.waitUntil != null) endWaitAtDrivingSpeed()
  }
}

/**
 * One row of the drive: journaled and emitted (DriveSense's `row`) with the next `seq`, the
 * safety-stop clock fed (the capture's `steps` included) and checked. A walk the car has driven
 * since is dropped, as JS drops it.
 */
internal fun DriveDetector.record(d: DetectRow, body: Map<String, Any?>) {
  val driveId = rec?.driveId ?: return
  val line = LinkedHashMap(body)
  line["seq"] = nextSeq
  nextSeq += 1
  journalLine(line)?.let { journal.appendRow(driveId, it) }
  EventBus.emit("row", line)
  lastRowTs = d.ts
  if (DetectPolicy.trusted(d)) lastFix = LatLng(d.lat, d.lng)
  endClock = DetectPolicy.endOnRow(endClock, d, automotiveNow = carStanding)
  (line["steps"] as? Number)?.let { endClock = DetectPolicy.endOnSteps(endClock, d.ts, it.toDouble()) }
  if (walkSince != null && DetectPolicy.walkStanding(endClock, walkSince) == null) walkSince = null
  evaluateEnd()
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
 * rule would have; meanwhile the state says `ending` while a JS end is overdue and `recording`
 * again once the car moves. The car link's end comes with the car link.
 */
internal fun DriveDetector.evaluateEnd() {
  val r = rec ?: return
  val startedAt = r.startedAt
  if (!r.recording || startedAt == null) return
  val now = DriveDetector.now()
  val d = DetectPolicy.endDue(endClock, startedAt, now, walkSince, r.waitUntil, null)
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
 * Commits the drive's end: journaled (`end`) and closed, sensing off (the service keeps RoadWise
 * running 25 s more so JS can store the drive and post its recap), the last end at the last trusted
 * fix, armed again. A native cause goes to JS as `driveEnded`; JS's own ("js", its cut as `endedAt`)
 * does not. Native never computes a cut: its `endedAt` is when it decided. [linger] (an automatic
 * end) is for the watch that follows an automatic end, which comes with automatic detection.
 */
@Suppress("UNUSED_PARAMETER")
internal fun DriveDetector.commitEnd(cause: String, endedAt: Double, linger: Boolean = false) {
  val r = rec ?: return
  val driveId = r.driveId
  if (!r.recording || driveId == null) return
  val now = DriveDetector.now()
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
  lastFix?.let { f -> n = n.copy(lastEnd = DetectLastEnd(now, if (cause == "js") endedAt else now, f.lat, f.lng, driveId)) }
  save(settle(n, now))
  finishSensing(holdMs = DetectPolicy.END_TASK_MAX_MS.toLong())
  lastFix = null
  if (cause != "js") {
    DetectEventBus.emit(
      "driveEnded",
      linkedMapOf("driveId" to driveId, "endedAt" to DriveDetectRecord.ms(endedAt), "cause" to cause, "decidedAt" to DriveDetectRecord.ms(now), "lastSeq" to lastSeq, "lastRowTs" to DriveDetectRecord.ms(rowTs))
    )
  }
  emitState("ended")
}

/**
 * "Not driving?": the drive is cancelled (its journal deleted, nothing kept) and detection rests
 * until its 3 h cap (Android's rest needs no GPS; its walking and still ends come with the
 * automatic wakes it holds back). The last end stays as it was.
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
        suppressedUntil = now + DetectPolicy.SUPPRESS_MAX_MS
      )
    )
    finishSensing(holdMs = DetectPolicy.END_TASK_MAX_MS.toLong())
    lastFix = null
    scheduleRest()
    DetectEventBus.emit(
      "driveEnded",
      linkedMapOf("driveId" to driveId, "endedAt" to DriveDetectRecord.ms(now), "cause" to "cancelled", "decidedAt" to DriveDetectRecord.ms(now), "lastSeq" to lastSeq, "lastRowTs" to DriveDetectRecord.ms(rowTs))
    )
    emitState("notDriving")
    done()
  }
}

/** Sensing ends: the capture stops (its notification goes; RoadWise is held [holdMs] more) and the drive's clocks reset. */
internal fun DriveDetector.finishSensing(holdMs: Long) {
  CaptureService.stopDetector(app, holdMs)
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
 * finalize. A start Android refuses leaves the drive as it is, for the next foreground or process.
 */
internal fun DriveDetector.resumeDrive(driveId: String) {
  resuming = true
  journal.reopen(driveId) { summary ->
    handler.post {
      resuming = false
      val r = rec
      if (r == null || r.driveId != driveId || !r.recording || sensing) return@post
      val now = DriveDetector.now()
      if (summary == null) {
        // No journal: nothing to resume or hand over.
        save(settle(r, now))
        resumePending = false
        clearStaleCapture()
        CaptureService.releaseIfIdle()
        emitState("ended")
        return@post
      }
      nextSeq = summary.lastSeq + 1
      lastRowTs = summary.lastRowTs
      val lat = summary.lastFixLat
      val lng = summary.lastFixLng
      if (lat != null && lng != null) lastFix = LatLng(lat, lng)
      val startedAt = r.startedAt ?: now
      if (DetectPolicy.resumeDecision(summary.lastRowTs, startedAt, now) != ResumeDecision.RESUME) {
        commitEnd("orphan", now)
        return@post
      }
      startResumed(driveId, summary, startedAt, if (r.origin == "manual") "mounted" else "auto", retry = true)
    }
  }
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
    // The record and the journal stay as they are: the next foreground or process start resumes
    // the drive (or ends it as an orphan, past its 5 min).
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
  walkSince = null
  carStanding = false
  sensing = true
  startClock()
  emitState("resumed")
  // Nobody may be there to take it in: the headless JS host runs it (the service started it if no
  // RoadWise screen is open).
  if (!AppVisibility.visible()) CaptureService.ensureHeadless()
}
