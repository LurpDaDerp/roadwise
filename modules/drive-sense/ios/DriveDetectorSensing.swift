// The drive detector's inputs (plan §3.1.1, §3.3, §3.6): rows (a candidate's buffer and evidence, a
// drive's journal), fixes (a candidate's and the "Not driving?" rest's last place, the wake's
// background task), live motion (walking, the cycling veto, car motion and vehicle signs, the
// fix-less hold), its own 5 s clock, and a relaunch (a drive resumed from its journal when its last
// row is 5 min old or less, else ended as an orphan). Main thread only.
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
      let veto = kind == "auto" && vetoNow()
      // A trusted row at 10 mph or more with no fresh walk, run or ride report is a vehicle sign.
      if kind == "auto" && DetectPolicy.moving(d) && !veto { lastVehicleTs = d.ts }
      let step = DetectPolicy.confirmStep(confirmState, d, kind, veto: veto, carFresh: kind == "auto" && carFresh())
      confirmState = step.state
      if step.confirmed {
        confirm(kind, from: confirmState.runStartTs)
        return
      }
      guard kind == "auto" else { return }
      // Beside the speed evidence: slow traffic, and the car link (a paired car or CarPlay current).
      let slowStep = DetectPolicy.slowTrafficStep(slowState, d)
      slowState = slowStep.state
      let link = DetectPolicy.linkStep(linkState, d, linked: CarLink.shared.linked, veto: veto, carFresh: carFresh())
      linkState = link.state
      if slowStep.confirmed {
        confirm(kind, from: slowState.runStartTs)
      } else if link.confirmed {
        confirm(kind, from: linkState.runStartTs)
      }
    case "recording", "ending":
      record(d, body)
      if rec?.waitUntil != nil { endWaitAtDrivingSpeed() }
    default:
      break
    }
  }

  func onFix(_ fix: FixSample) {
    // Location updates now keep RoadWise running: the wake's task can end.
    if wakeTask != .invalid { endWakeTask() }
    let p = phase
    guard p == "suppressed" || p == "candidate" else { return }
    let d = DetectRow(ts: fix.t, lat: fix.lat, lng: fix.lng, hAcc: fix.hAcc, speed: fix.speed, speedAcc: fix.speedAcc, gnssValid: fix.hAcc >= 0)
    guard DetectPolicy.trusted(d) else { return }
    lastFix = (lat: d.lat, lng: d.lng)
    if p == "suppressed" && d.speed > DetectPolicy.STOP_MPS { lastOverStopTs = d.ts }
  }

  /// A confident walk or run stands from when it arrived until a report other than a walk or run
  /// replaces it; one at low confidence says nothing either way (JS reads it as "unsure" too). Car
  /// motion lasts until the report that replaces it; any confident automotive report during a
  /// candidate is a vehicle sign.
  func onActivity(_ a: MotionReport) {
    let car = a.confident && a.automotive && !a.stationary
    if car || carStanding { lastCarMotionAt = max(lastCarMotionAt, a.at) }
    carStanding = car
    vehicleStanding = a.confident && a.automotive
    if vehicleStanding && phase == "candidate" { lastVehicleTs = a.at }
    latest = a
    vetoState = DetectPolicy.noteVeto(vetoState, at: a.at, onFoot: a.walking || a.cycling, automotive: a.automotive, confident: a.confident)
    if phase == "candidate" {
      slowState = DetectPolicy.slowTrafficReport(slowState, at: a.at, automotive: a.automotive, stationary: a.stationary, onFoot: a.walking || a.cycling, confident: a.confident)
    }
    if a.walking {
      if a.confident && walkSince == nil { walkSince = a.at }
    } else {
      walkSince = nil
    }
  }

  /// A confident cycling, walking or running report from the last 30 s holds an auto confirmation,
  /// unless a confident automotive report arrived after it (`DetectPolicy.onFootVeto`). A
  /// low-confidence, stationary or unknown report after it never lifts it.
  func vetoNow() -> Bool {
    DetectPolicy.onFootVeto(vetoState, DriveDetector.now())
  }

  /// The car link changed (the route, a pairing, a drive's outputs): JS hears it at once ("carLink",
  /// never buffered). Mid-drive, CarLink.shared.goneSince is the debounced "car disconnected since"
  /// (nil again once the car is back): JS's car-link end reads it, and the safety stop's mirror
  /// (`evaluateEnd`, every row and tick) does too.
  func onCarLink() {
    EventHub.detect.emitLive("carLink", CarLink.shared.json())
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

  /// Every 5 s while sensing: a candidate's deadline (`candidateTick`), the safety stop when rows
  /// stall, the rest's end.
  func tick() {
    guard let r = rec else { return }
    let now = DriveDetector.now()
    // A route change missed while suspended is read here (the link, and the "disconnected since").
    if r.state == "candidate" || isRecording { CarLink.shared.refresh() }
    switch r.state {
    case "candidate":
      candidateTick(r, now)
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
  /// from its journal or ends as an orphan; a rest resumes until its 3 h cap, its still clock from
  /// the relaunch.
  func resumeAtLaunch() {
    if let stored = DetectStateRecord.load() { rec = stored }
    CarLink.shared.reload()
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
      // The rest goes on until its cap (from when it began); nothing was sensed while RoadWise was
      // not running, so its still clock starts again here (a relaunch never ends it at once).
      if let moved = DetectPolicy.suppressionResume(until: r.suppressedUntil, now: now) {
        lastOverStopTs = moved
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
  /// sensors on, rows from past the gap's seq); older, it ends as an orphan for JS to finalize.
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
      // JS takes a relaunched Start-card drive back without its wait: native's goes with it.
      if r.waitUntil != nil {
        r.waitUntil = nil
        self.save(r)
      }
      // The last unsynced rows may be lost from the file but held by JS: the rows go on past a gap
      // of seqs (the `gap` line carries it), so none is handed out twice.
      let skipTo = DetectPolicy.resumeSeq(s.topSeq)
      self.nextSeq = skipTo + 1
      self.journal.appendMarker(driveId, [
        "k": "gap", "from": DetectStateRecord.ms(s.lastRowTs ?? startedAt), "to": DetectStateRecord.ms(now), "lastSeq": skipTo,
      ], close: false)
      // The still clock restarts at the last row journaled (a kill at a light does not end the drive).
      self.endClock = DetectPolicy.endClockAt(s.lastRowTs ?? now)
      CarLink.shared.beginDrive()
      // The count goes on from the drive's start, so its rows' steps keep growing past the gap.
      self.pedometer.start(driveId: driveId, from: Date(timeIntervalSince1970: startedAt / 1000))
      self.capture.beginSensing()
      self.capture.openCapture(startedAt: startedAt, mode: r.origin == "manual" ? "mounted" : "auto")
      self.startClock()
      self.emitState("resumed")
    }
  }
}
