// The drive detector's inputs (plan §3.1.1, §3.3, §3.6): rows (a candidate's buffer and hold, a
// drive's journal), fixes (the "Not driving?" rest, the wake's background task), live motion (walking,
// the cycling veto, the fix-less hold), its own 5 s clock, and a relaunch (a drive resumed from its
// journal when its last row is 5 min old or less, else ended as an orphan). Main thread only.
import Foundation
import UIKit

extension DriveDetector {
  // MARK: - Rows, fixes, motion

  func onRow(_ row: ExtractedRow, _ body: [String: Any]) {
    let d = DetectRow(ts: Double(row.ts), lat: row.lat, lng: row.lng, hAcc: row.hAcc, speed: row.speed, speedAcc: row.speedAcc, gnssValid: row.gnssValid)
    switch phase {
    case "candidate":
      buffer.append(d, body)
      guard !confirming, let r = rec else { return }
      let kind = r.origin == "manual" ? "manual" : "auto"
      let step = DetectPolicy.confirmStep(confirmState, d, kind, veto: kind == "auto" && vetoNow())
      confirmState = step.state
      if step.confirmed { confirm(kind) }
    case "recording", "ending":
      record(d, body)
    default:
      break
    }
  }

  func onFix(_ fix: FixSample) {
    // Location updates now keep RoadWise running: the wake's task can end.
    if wakeTask != .invalid { endWakeTask() }
    guard phase == "suppressed" else { return }
    let d = DetectRow(ts: fix.t, lat: fix.lat, lng: fix.lng, hAcc: fix.hAcc, speed: fix.speed, speedAcc: fix.speedAcc, gnssValid: fix.hAcc >= 0)
    guard DetectPolicy.trusted(d) else { return }
    lastFix = (lat: d.lat, lng: d.lng)
    if d.speed > DetectPolicy.STOP_MPS { lastOverStopTs = d.ts }
  }

  /// A confident walk or run stands from when it arrived until another report replaces it.
  func onActivity(_ a: MotionReport) {
    latest = a
    if a.walking && a.confident {
      if walkSince == nil { walkSince = a.at }
    } else {
      walkSince = nil
    }
  }

  /// A confident cycling, walking or running report from the last 30 s holds an auto confirmation.
  func vetoNow() -> Bool {
    guard let a = latest else { return false }
    return a.confident && (a.walking || a.cycling) && DriveDetector.now() - a.at <= DetectPolicy.VETO_FRESH_MS
  }

  /// The standing report is moving car motion (a tunnel, a garage): a fix-less row holds the still clock.
  func automotiveNow() -> Bool {
    guard let a = latest else { return false }
    return a.confident && a.automotive && !a.stationary
  }

  // MARK: - The clock

  func startClock() {
    guard clock == nil else { return }
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(wallDeadline: .now() + DetectPolicy.TICK_MS / 1000, repeating: DetectPolicy.TICK_MS / 1000, leeway: .seconds(1))
    t.setEventHandler { [weak self] in self?.tick() }
    t.resume()
    clock = t
  }

  func stopClock() {
    clock?.setEventHandler {}
    clock?.cancel()
    clock = nil
  }

  /// Every 5 s while sensing: a candidate's deadline, the safety stop when rows stall, the rest's end.
  func tick() {
    guard let r = rec else { return }
    let now = DriveDetector.now()
    switch r.state {
    case "candidate":
      guard !confirming else { return }
      let kind = r.origin == "manual" ? "manual" : "auto"
      if let cause = DetectPolicy.candidateDue(kind, since: r.since, waitUntil: r.waitUntil, walkSince: walkSince, now: now) {
        endCandidate(reason: cause, rest: cause == "timeout")
      }
    case "recording", "ending":
      evaluateEnd()
    case "suppressed":
      guard let since = r.suppressedSince, let until = r.suppressedUntil else {
        endSuppression()
        return
      }
      if DetectPolicy.suppressionDue(since: since, until: until, lastOverStopTs: lastOverStopTs, walkSince: walkSince, now: now) != nil {
        endSuppression()
      }
    default:
      stopClock()
    }
  }

  /// The rest is over: GPS off, the parked region at the last fix, armed again. The last end is untouched.
  func endSuppression() {
    guard var r = rec, r.state == "suppressed" else { return }
    settle(&r, DriveDetector.now())
    save(r)
    capture.endSensing()
    stopClock()
    if r.state == "armed", let f = lastFix { wakes.setParked(f) }
    lastFix = nil
    lastOverStopTs = nil
    walkSince = nil
    syncWakes()
    emitState("suppressionEnded")
  }

  // MARK: - A relaunch

  /// didFinishLaunching (DriveDetectAppDelegate) and the first unlock after a reboot. The wakes are
  /// asked for again; a candidate never survives a process; a drive open in the last process resumes
  /// from its journal or ends as an orphan; a rest resumes until its 3 h cap.
  func resumeAtLaunch() {
    if let stored = DetectStateRecord.load() { rec = stored }
    guard var r = rec else { return }
    // Already sensing in this process (a second call): nothing to resume.
    guard capture.sensing == .off else {
      syncWakes()
      return
    }
    let now = DriveDetector.now()
    switch r.state {
    case "candidate":
      settle(&r, now)
      save(r)
      capture.clearStaleOpenFlag()
    case "recording", "ending":
      if let driveId = r.driveId {
        resumeDrive(driveId)
      } else {
        settle(&r, now)
        save(r)
      }
    case "suppressed":
      if let until = r.suppressedUntil, now < until {
        capture.beginSuppressedSensing()
        startClock()
      } else {
        settle(&r, now)
        save(r)
      }
      capture.clearStaleOpenFlag()
    default:
      capture.clearStaleOpenFlag()
    }
    syncWakes()
  }

  /// The journal says where the drive got to: a last row 5 min old or less resumes it (a `gap` line,
  /// sensors on, rows from the next seq); older, it ends as an orphan for JS to finalize.
  func resumeDrive(_ driveId: String) {
    journal.reopen(driveId) { [weak self] summary in
      guard let self = self, var r = self.rec, r.driveId == driveId, self.capture.sensing == .off else { return }
      let now = DriveDetector.now()
      guard let s = summary else {
        // No journal: nothing to resume or hand over.
        self.settle(&r, now)
        self.save(r)
        self.capture.closeCapture()
        self.syncWakes()
        self.emitState("ended")
        return
      }
      self.nextSeq = s.lastSeq + 1
      self.lastRowTs = s.lastRowTs
      if let lat = s.lastFixLat, let lng = s.lastFixLng { self.lastFix = (lat: lat, lng: lng) }
      let startedAt = r.startedAt ?? now
      guard DetectPolicy.resumeDecision(lastRowTs: s.lastRowTs, startedAt: startedAt, now: now) == "resume" else {
        self.commitEnd(cause: "orphan", endedAt: now)
        return
      }
      self.journal.appendMarker(driveId, ["k": "gap", "from": DetectStateRecord.ms(s.lastRowTs ?? startedAt), "to": DetectStateRecord.ms(now)], close: false)
      // The still clock restarts at the last row journaled (a kill at a light does not end the drive).
      self.endClock = DetectPolicy.endClockAt(s.lastRowTs ?? now)
      self.capture.beginSensing()
      self.capture.openCapture(startedAt: startedAt, mode: r.origin == "manual" ? "mounted" : "auto")
      self.startClock()
      self.emitState("resumed")
    }
  }
}
