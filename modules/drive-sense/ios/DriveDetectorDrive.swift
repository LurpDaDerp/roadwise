// The drive detector's drive (plan §3.2-§3.6): a confirmation becomes a drive with a traced start,
// a journal and `driveStarted`; its rows are journaled with their `seq` and emitted to JS; the native
// safety stop or JS's `stopCapture` commits its end (the parked region set, armed again); "Not
// driving?" cancels it and rests detection. Main thread only.
import Foundation

extension DriveDetector {
  /// A path confirmed on the buffer's last row (the speed evidence, slow traffic or the car link;
  /// `runStart`: its run's first row): the start traced back (an auto drive whose rows begin moving
  /// reads the motion history for when the car set off), then the drive begins. A run that began
  /// before the oldest buffered row traces from the first one (the motion history then dates a
  /// drive whose rows begin moving).
  func confirm(_ kind: String, from runStart: Double?) {
    let h = runStart.flatMap { buffer.index(ofTs: $0) } ?? 0
    confirming = true
    let rows = buffer.rows
    let lastEnd = rec?.lastEnd
    let finish: (Double) -> Void = { [weak self] automotiveSince in
      guard let self = self, self.phase == "candidate", !rows.isEmpty else { return }
      let start = DetectPolicy.startOf(rows, h, kind, automotiveSince, lastEnd)
      self.beginDrive(start, kind: kind, firstTs: rows[start.index].ts)
    }
    guard kind == "auto", DetectPolicy.traceStart(rows, h) == nil else {
      finish(0)
      return
    }
    let to = Date()
    let fromMs = max(lastEnd?.decidedAt ?? 0, to.timeIntervalSince1970 * 1000 - DetectPolicy.MOTION_LOOKBACK_MS)
    ActivitySource.motionSummary(from: Date(timeIntervalSince1970: fromMs / 1000), to: to) { m in finish(m.automotiveSince) }
  }

  /// The Start card: a manual drive opens at once, from the tap, journaled like any drive (an open
  /// auto candidate gives way to it, its rows dropped). It waits for driving speed (`waitUntil`, 5 min
  /// from the tap or the last touch, where JS ends it unsaved): meanwhile the safety stop never ends
  /// it on a walk, and on the still clock only past that deadline (`DetectPolicy.endDue`).
  func beginManualDrive() {
    if phase == "candidate", var r = rec {
      r.origin = "manual"
      save(r)
    } else {
      beginCandidate(origin: "manual", reason: "waiting")
    }
    let now = DriveDetector.now()
    buffer.clear()
    confirmState = ConfirmState()
    slowState = SlowTrafficState()
    linkState = LinkState()
    confirming = false
    let start = TracedStart(index: 0, startedAt: now, startSource: "wake", startLat: nil, startLng: nil)
    beginDrive(start, kind: "manual", firstTs: now, waitUntil: now + DetectPolicy.WAIT_MAX_MS)
  }

  /// A Start-card drive waiting for driving speed: two trusted rows at 10 mph or more in a row (the
  /// end clock's `lastDroveTs`, JS's driving speed) end the wait, and the safety stop's usual rules
  /// apply from there.
  func endWaitAtDrivingSpeed() {
    guard endClock.lastDroveTs != nil, var r = rec, r.waitUntil != nil else { return }
    r.waitUntil = nil
    save(r)
    emitState("confirmed")
  }

  /// The drive begins: recorded, journaled from its first kept row (seq 1), announced to JS, and the
  /// "Recording your drive" check scheduled. `waitUntil`: a Start-card drive's wait for driving speed.
  func beginDrive(_ start: TracedStart, kind: String, firstTs: Double, waitUntil: Double? = nil) {
    guard var r = rec else { return }
    let now = DriveDetector.now()
    let driveId = UUID().uuidString.lowercased()
    let continues = DetectPolicy.continuesFrom(r.lastEnd, start.startedAt, start.startLat, start.startLng)
    // A confirmed candidate was a real drive: it leaves the hourly cap's record.
    r.candidateStarts = DetectPolicy.startsAfter(r.candidateStarts, since: r.since, sawVehicle: true)
    r.state = "recording"
    r.since = now
    r.driveId = driveId
    r.startedAt = start.startedAt
    r.startSource = start.startSource
    r.waitUntil = waitUntil
    save(r)
    confirming = false
    lingering = false
    lastVehicleTs = nil
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
    let startLine: [String: Any] = [
      "k": "start", "v": 1, "driveId": driveId, "origin": kind,
      "startedAt": DetectStateRecord.ms(start.startedAt), "startSource": start.startSource,
      "startLat": start.startLat.map { $0 as Any } ?? NSNull(), "startLng": start.startLng.map { $0 as Any } ?? NSNull(),
      "continues": continues, "confirmedAt": DetectStateRecord.ms(now), "nativeBuild": build,
    ]
    journal.open(driveId, start: startLine) { [weak self] dropped in
      guard let self = self, dropped > 0, var r1 = self.rec else { return }
      r1.journalDropped += dropped
      self.save(r1)
    }
    nextSeq = 1
    lastRowTs = nil
    lastFix = nil
    endClock = DetectPolicy.endClockAt(now)
    CarLink.shared.beginDrive()
    pedometer.start(driveId: driveId, from: Date(timeIntervalSince1970: start.startedAt / 1000))
    capture.openCapture(startedAt: start.startedAt, mode: kind == "auto" ? "auto" : "mounted")
    let kept = buffer.items.filter { $0.row.ts >= firstTs }
    buffer.clear()
    // The buffered rows can span 30 min: the safety stop waits for the first live row, so an old
    // movement replayed against the clock now never ends the drive it starts.
    for item in kept { record(item.row, item.body, evaluate: false) }
    DriveNotifier.scheduleFallback { [weak self] in self?.isLive(driveId) == true }
    EventHub.detect.emit("driveStarted", [
      "driveId": driveId, "origin": kind, "startedAt": DetectStateRecord.ms(start.startedAt), "startSource": start.startSource,
      "startLat": start.startLat.map { $0 as Any } ?? NSNull(), "startLng": start.startLng.map { $0 as Any } ?? NSNull(),
      "continues": continues, "confirmedAt": DetectStateRecord.ms(now), "firstSeq": 1,
    ])
    emitState("confirmed")
    // Significant changes run through the drive, so a kill is relaunched (a Start drive unarmed too).
    syncWakes()
  }

  /// One row of the drive: journaled and emitted with the next `seq` and the pedometer's count so far
  /// (`steps`, once it has one), the safety-stop clock fed and (a live row) checked. A walk the car
  /// has driven since (the walk to the car, a misread at a light or at speed) is dropped, as JS
  /// drops it, so the next confident walking report starts a new one.
  func record(_ d: DetectRow, _ body: [String: Any], evaluate: Bool = true) {
    guard let driveId = rec?.driveId else { return }
    var line = body
    let steps = pedometer.steps
    if let n = steps { line["steps"] = n }
    line["seq"] = nextSeq
    nextSeq += 1
    journal.appendRow(driveId, line)
    capture.emitRow(line, ts: Int64(d.ts))
    lastRowTs = d.ts
    CarLink.shared.countRow()
    if DetectPolicy.trusted(d) { lastFix = (lat: d.lat, lng: d.lng) }
    endClock = DetectPolicy.endOnRow(endClock, d, automotiveNow: automotiveNow())
    if let n = steps { endClock = DetectPolicy.endOnSteps(endClock, ts: d.ts, steps: n) }
    if walkSince != nil && DetectPolicy.walkStanding(endClock, walkSince) == nil { walkSince = nil }
    if evaluate { evaluateEnd() }
  }

  /// The safety stop: native ends the drive 10 s after the JS walking end or a minute after another
  /// JS rule would have; meanwhile the state says `ending` while a JS end is overdue and `recording`
  /// again once the car moves.
  func evaluateEnd() {
    guard var r = rec, isRecording, let startedAt = r.startedAt else { return }
    let now = DriveDetector.now()
    let d = DetectPolicy.endDue(endClock, startedAt: startedAt, now: now, walkSince: walkSince, waitUntil: r.waitUntil, carGoneSince: CarLink.shared.goneSince)
    if let cause = d.due {
      commitEnd(cause: cause, endedAt: now, linger: cause == "still" || cause == "walking")
      return
    }
    let next = d.overdue == nil ? "recording" : "ending"
    guard next != r.state else { return }
    r.state = next
    r.since = now
    save(r)
    emitState(next == "recording" ? "moved" : d.overdue == "walking" ? "walking" : "stillClock")
  }

  /// Commits the drive's end: journaled (`end`) and closed, sensing off, the parked region at the last
  /// trusted fix, armed again, all inside a background task (JS stores the drive and posts its recap).
  /// A native cause goes to JS as `driveEnded`; JS's own ("js", with its cut as `endedAt`) does not.
  /// Native never computes a cut: its `endedAt` is when it decided. `linger`: an automatic end (5 min
  /// still, or a walk); unless it was a Start-card drive still waiting for driving speed, a candidate
  /// watches on at once, so a car that sets off again soon is confirmed at once as a new drive with
  /// its whole route.
  func commitEnd(cause: String, endedAt: Double, linger: Bool = false) {
    guard var r = rec, isRecording, let driveId = r.driveId else { return }
    let now = DriveDetector.now()
    let lingerAfter = linger && r.waitUntil == nil
    // A drive that reached driving speed tells the car link which outputs it had (before the clock resets).
    CarLink.shared.endDrive(driveId: driveId, endedAt: endedAt, drove: endClock.lastDroveTs != nil)
    pedometer.stop()
    let lastSeq = nextSeq - 1
    let rowTs = lastRowTs
    journal.appendMarker(driveId, [
      "k": "end", "endedAt": DetectStateRecord.ms(endedAt), "cause": cause, "decidedAt": DetectStateRecord.ms(now),
      "lastRowTs": DetectStateRecord.ms(rowTs), "lastSeq": lastSeq,
    ], close: true)
    // A drive with no trusted fix (a Start drive cancelled indoors) keeps the last end and its
    // parked spot: the car is still where it last parked.
    if let f = lastFix { r.lastEnd = DetectLastEnd(decidedAt: now, cut: cause == "js" ? endedAt : now, lat: f.lat, lng: f.lng, driveId: driveId) }
    settle(&r, now)
    save(r)
    beginEndTask()
    finishSensing()
    if r.state == "armed", let f = lastFix { wakes.setParked(f) }
    lastFix = nil
    syncWakes()
    if cause != "js" {
      EventHub.detect.emit("driveEnded", [
        "driveId": driveId, "endedAt": DetectStateRecord.ms(endedAt), "cause": cause, "decidedAt": DetectStateRecord.ms(now),
        "lastSeq": lastSeq, "lastRowTs": DetectStateRecord.ms(rowTs),
      ])
    }
    emitState("ended")
    if lingerAfter, rec?.state == "armed", capture.sensing == .off { beginCandidate(origin: "auto", reason: "linger") }
  }

  /// A JS end that a JS end rule would have made by now was an automatic one
  /// (`DetectPolicy.lingerAfterJsEnd`): 5 min still, or a walk the car has not driven since that has
  /// stood JS's 3 s floor less a row (2 s; JS's row clock runs a row ahead), with the last trusted
  /// fix at a walker's pace or under (a carried phone), more than 15 s old, or missing.
  func automaticEndDue() -> Bool {
    guard let r = rec, isRecording, let startedAt = r.startedAt else { return false }
    return DetectPolicy.lingerAfterJsEnd(endClock, startedAt: startedAt, now: DriveDetector.now(), walkSince: walkSince, waitUntil: r.waitUntil, carGoneSince: CarLink.shared.goneSince)
  }

  /// "Not driving?": the drive is cancelled (its journal deleted, nothing kept) and detection rests
  /// on ten-metre GPS until a walk, 5 min with nothing over 3 mph, or 3 h. The last end stays as it was.
  func notDriving() {
    guard var r = rec, isRecording, let driveId = r.driveId else { return }
    let now = DriveDetector.now()
    let lastSeq = nextSeq - 1
    let rowTs = lastRowTs
    CarLink.shared.endDrive(driveId: driveId, endedAt: now, drove: false)
    pedometer.stop()
    journal.delete(driveId)
    r.state = "suppressed"
    r.since = now
    r.origin = nil
    r.waitUntil = nil
    r.driveId = nil
    r.startedAt = nil
    r.startSource = nil
    r.suppressedSince = now
    r.suppressedUntil = now + DetectPolicy.SUPPRESS_MAX_MS
    save(r)
    finishSensing()
    lastFix = nil
    lastOverStopTs = nil
    walkSince = nil
    capture.beginSuppressedSensing()
    startClock()
    EventHub.detect.emit("driveEnded", [
      "driveId": driveId, "endedAt": DetectStateRecord.ms(now), "cause": "cancelled", "decidedAt": DetectStateRecord.ms(now),
      "lastSeq": lastSeq, "lastRowTs": DetectStateRecord.ms(rowTs),
    ])
    emitState("notDriving")
    // The drive no longer holds the wakes on: unarmed, they stop for the rest.
    syncWakes()
  }

  /// `wipe` (a sign-out, a device or account switch): nothing of the last owner stays. A candidate,
  /// a Start-card wait, a drive or a rest stops (no `driveEnded`: JS ends its own drive first), every
  /// journal file goes, and the record starts again empty: no owner, not armed, no last end, no rest,
  /// no drive, off. The wakes and the parked region stop. `done` on main once the files are gone.
  func wipe(done: @escaping () -> Void) {
    let waiting = rec?.state == "candidate" && rec?.origin == "manual"
    if isRecording {
      finishSensing()
    } else if capture.sensing == .detector || capture.sensing == .suppressed {
      capture.endSensing()
    }
    stopClock()
    endWakeTask()
    buffer.clear()
    confirmState = ConfirmState()
    slowState = SlowTrafficState()
    linkState = LinkState()
    confirming = false
    nextSeq = 1
    lastRowTs = nil
    lastFix = nil
    lastOverStopTs = nil
    walkSince = nil
    lastVehicleTs = nil
    lingering = false
    save(DetectStateRecord())
    CarLink.shared.wipe()
    pedometer.stop()
    wakes.stop()
    journal.wipe(done: done)
    emitState(waiting ? "cancelled" : "disarmed")
  }

  /// Sensing and the capture JS sees end; the note and the Live Activity go.
  func finishSensing() {
    capture.endSensing()
    capture.closeCapture()
    stopClock()
    DriveNotifier.cancel()
    DriveNotifier.remove()
    DriveDisplayBridge.postEnded()
    nextSeq = 1
    lastRowTs = nil
    walkSince = nil
    endClock = DetectPolicy.endClockAt(0)
  }
}
