// The drive detector's drive (plan §3.2-§3.6): a confirmation becomes a drive with a traced start,
// a journal and `driveStarted`; its rows are journaled with their `seq` and emitted to JS; the native
// safety stop or JS's `stopCapture` commits its end (the parked region set, armed again); "Not
// driving?" cancels it and rests detection. Main thread only.
import Foundation

extension DriveDetector {
  /// The hold confirmed on the buffer's last row: the start traced back (an auto drive whose rows
  /// begin moving reads the motion history for when the car set off), then the drive begins.
  func confirm(_ kind: String) {
    guard let runStart = confirmState.runStartTs, let h = buffer.index(ofTs: runStart) else { return }
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

  /// The drive begins: recorded, journaled from its first kept row (seq 1), announced to JS, and the
  /// "Recording your drive" check scheduled.
  func beginDrive(_ start: TracedStart, kind: String, firstTs: Double) {
    guard var r = rec else { return }
    let now = DriveDetector.now()
    let driveId = UUID().uuidString.lowercased()
    let continues = DetectPolicy.continuesFrom(r.lastEnd, start.startedAt, start.startLat, start.startLng)
    r.state = "recording"
    r.since = now
    r.driveId = driveId
    r.startedAt = start.startedAt
    r.startSource = start.startSource
    r.waitUntil = nil
    save(r)
    confirming = false
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
    capture.openCapture(startedAt: start.startedAt, mode: kind == "auto" ? "auto" : "mounted")
    let kept = buffer.items.filter { $0.row.ts >= firstTs }
    buffer.clear()
    for item in kept { record(item.row, item.body) }
    DriveNotifier.scheduleFallback { [weak self] in self?.isLive(driveId) == true }
    EventHub.detect.emit("driveStarted", [
      "driveId": driveId, "origin": kind, "startedAt": DetectStateRecord.ms(start.startedAt), "startSource": start.startSource,
      "startLat": start.startLat.map { $0 as Any } ?? NSNull(), "startLng": start.startLng.map { $0 as Any } ?? NSNull(),
      "continues": continues, "confirmedAt": DetectStateRecord.ms(now), "firstSeq": 1,
    ])
    emitState("confirmed")
  }

  /// One row of the drive: journaled and emitted with the next `seq`, the safety-stop clock fed.
  func record(_ d: DetectRow, _ body: [String: Any]) {
    guard let driveId = rec?.driveId else { return }
    var line = body
    line["seq"] = nextSeq
    nextSeq += 1
    journal.appendRow(driveId, line)
    capture.emitRow(line, ts: Int64(d.ts))
    lastRowTs = d.ts
    if DetectPolicy.trusted(d) { lastFix = (lat: d.lat, lng: d.lng) }
    endClock = DetectPolicy.endOnRow(endClock, d, automotiveNow: automotiveNow())
    evaluateEnd()
  }

  /// The safety stop: native ends the drive a minute after a JS rule would have; meanwhile the state
  /// says `ending` while a JS end is overdue and `recording` again once the car moves.
  func evaluateEnd() {
    guard var r = rec, isRecording, let startedAt = r.startedAt else { return }
    let now = DriveDetector.now()
    let d = DetectPolicy.endDue(endClock, startedAt: startedAt, now: now, walkSince: walkSince)
    if let cause = d.due {
      commitEnd(cause: cause, endedAt: now)
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
  /// trusted fix, armed again. A native cause goes to JS as `driveEnded`; JS's own ("js", with its cut
  /// as `endedAt`) does not. Native never computes a cut: its `endedAt` is when it decided.
  func commitEnd(cause: String, endedAt: Double) {
    guard var r = rec, isRecording, let driveId = r.driveId else { return }
    let now = DriveDetector.now()
    let lastSeq = nextSeq - 1
    let rowTs = lastRowTs
    journal.appendMarker(driveId, [
      "k": "end", "endedAt": DetectStateRecord.ms(endedAt), "cause": cause, "decidedAt": DetectStateRecord.ms(now),
      "lastRowTs": DetectStateRecord.ms(rowTs), "lastSeq": lastSeq,
    ], close: true)
    r.lastEnd = lastFix.map { DetectLastEnd(decidedAt: now, cut: cause == "js" ? endedAt : now, lat: $0.lat, lng: $0.lng, driveId: driveId) }
    settle(&r, now)
    save(r)
    finishSensing()
    if r.state == "armed" { wakes.setParked(lastFix) }
    lastFix = nil
    syncWakes()
    if cause != "js" {
      EventHub.detect.emit("driveEnded", [
        "driveId": driveId, "endedAt": DetectStateRecord.ms(endedAt), "cause": cause, "decidedAt": DetectStateRecord.ms(now),
        "lastSeq": lastSeq, "lastRowTs": DetectStateRecord.ms(rowTs),
      ])
    }
    emitState("ended")
  }

  /// "Not driving?": the drive is cancelled (its journal deleted, nothing kept) and detection rests
  /// on ten-metre GPS until a walk, 5 min with nothing over 3 mph, or 3 h. The last end stays as it was.
  func notDriving() {
    guard var r = rec, isRecording, let driveId = r.driveId else { return }
    let now = DriveDetector.now()
    let lastSeq = nextSeq - 1
    let rowTs = lastRowTs
    journal.delete(driveId)
    r.state = "suppressed"
    r.since = now
    r.origin = nil
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
    confirming = false
    nextSeq = 1
    lastRowTs = nil
    lastFix = nil
    lastOverStopTs = nil
    walkSince = nil
    save(DetectStateRecord())
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
