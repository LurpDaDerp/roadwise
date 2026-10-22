// The drive detector's watch (plan §3.3): a wake (a significant change, the parked car's region, a
// visit, RoadWise coming to the front) opens an auto candidate, which watches GPS and motion while it
// sees vehicle signs, at most 30 min (`DetectPolicy.candidateDue`); an automatic end opens one at
// once (the linger), so a quick restart within 150 m re-opens the held drive instead of splitting
// it; a region exit during the linger turns it into an ordinary watch. A candidate's end decides the
// rest, the hourly cap's record and a parked spot. Main thread only.
import Foundation

extension DriveDetector {
  // MARK: - Wakes

  /// RoadWise came to the front (`didBecomeActive`, or JS `appForeground`): an "app" wake. It skips
  /// the rest an empty candidate left, never the hourly cap or the motion gate.
  func appForeground() {
    onWake("app")
  }

  func onWake(_ reason: String) {
    if reason == "region", lingerToWatch() { return }
    guard !waking, let r = rec else { return }
    let ctx = WakeCtx(now: DriveDetector.now(), reason: reason, phase: r.state, armed: r.armed, hasOwner: r.ownerId != nil,
                      permissionsOk: access.snapshot().requiredOk, candidateRestUntil: r.candidateRestUntil, candidateStarts: r.candidateStarts)
    guard DetectPolicy.wakeGate(ctx) == "ok", capture.sensing == .off else { return }
    beginWakeTask()
    // A region exit is car-motion evidence enough; the others need car motion in the last 2 min.
    if reason == "region" {
      beginCandidate(origin: "auto", reason: "wake:region")
      return
    }
    let to = Date()
    ActivitySource.motionSummary(from: to.addingTimeInterval(-DetectPolicy.MOTION_LOOKBACK_MS / 1000), to: to) { [weak self] m in
      guard let self = self else { return }
      guard self.phase == "armed", self.capture.sensing == .off, DetectPolicy.motionGate(m, DriveDetector.now()) == "ok" else {
        self.endWakeTask()
        return
      }
      self.beginCandidate(origin: "auto", reason: "wake:\(reason)", carMotionAt: m.lastAutomotiveAt)
    }
  }

  /// A region exit during the linger: the phone has left the parked spot (a car idling where it
  /// parked never does), and iOS sends that exit only once, so it is never dropped as "busy". The
  /// linger becomes an ordinary watch from the exit, as a region wake's candidate would be: in the
  /// hourly cap's record until it sees a vehicle, kept open by its vehicle signs (rows at 10 mph or
  /// more included) up to the 30 min cap, and an empty timeout leaves the parked spot where the
  /// phone rests. Its evidence stays. False (nothing done) unless the linger is running.
  func lingerToWatch() -> Bool {
    guard lingering, var r = rec, r.state == "candidate", r.origin == "auto" else { return false }
    let now = DriveDetector.now()
    lingering = false
    r.since = now
    r.candidateStarts = DetectPolicy.recentStarts(r.candidateStarts, now) + [now]
    save(r)
    emitState("wake:region")
    return true
  }

  // MARK: - Candidates

  /// A candidate opens: GPS, IMU and live motion on, the buffer and the evidence empty. `carMotionAt`:
  /// the wake's newest moving car motion (0: none read). An auto one counts toward the hourly cap,
  /// except the linger after an automatic end ("linger").
  func beginCandidate(origin: String, reason: String, carMotionAt: Double = 0) {
    guard var r = rec else {
      endWakeTask()
      return
    }
    let now = DriveDetector.now()
    let linger = reason == "linger"
    r.state = "candidate"
    r.origin = origin
    r.since = now
    r.driveId = nil
    r.startedAt = nil
    r.startSource = nil
    r.waitUntil = origin == "manual" ? now + DetectPolicy.WAIT_MAX_MS : nil
    if origin == "auto" && !linger { r.candidateStarts = DetectPolicy.recentStarts(r.candidateStarts, now) + [now] }
    r.suppressedSince = nil
    r.suppressedUntil = nil
    save(r)
    buffer.clear()
    confirmState = ConfirmState()
    confirming = false
    walkSince = nil
    lingering = linger
    lastVehicleTs = nil
    lastFix = nil
    // The standing report is this candidate's own: an older one may no longer stand.
    carStanding = false
    vehicleStanding = false
    lastCarMotionAt = max(lastCarMotionAt, carMotionAt)
    capture.beginSensing()
    startClock()
    emitState(reason)
  }

  /// A candidate ends unconfirmed: sensors off, nothing kept. `rest`: the next significant-change and
  /// visit wakes rest. Only a candidate that saw no vehicle stays in the hourly cap's record, and one
  /// that timed out seeing none leaves the parked spot where the phone rests (the next departure from
  /// there is a region exit). The linger does neither: the drive's own end placed the parked spot.
  func endCandidate(reason: String, rest: Bool) {
    guard var r = rec, r.state == "candidate" else { return }
    let now = DriveDetector.now()
    let sawVehicle = lastVehicleTs != nil
    let parkHere = r.origin == "auto" && !lingering && reason == "timeout" && !sawVehicle
    if rest { r.candidateRestUntil = now + DetectPolicy.CANDIDATE_REST_MS }
    r.candidateStarts = DetectPolicy.startsAfter(r.candidateStarts, since: r.since, sawVehicle: sawVehicle)
    settle(&r, now)
    save(r)
    buffer.clear()
    confirmState = ConfirmState()
    confirming = false
    capture.endSensing()
    stopClock()
    endWakeTask()
    if parkHere, r.state == "armed", let f = lastFix { wakes.setParked(f) }
    lastFix = nil
    lastVehicleTs = nil
    lingering = false
    syncWakes()
    emitState(reason)
  }

  /// Car motion is fresh: the standing report is confident moving car motion, or some was seen in the
  /// last 2 min (what the 15-20 mph band needs).
  func carFresh() -> Bool {
    carStanding || DriveDetector.now() - lastCarMotionAt <= DetectPolicy.AUTOMOTIVE_FRESH_MS
  }

  /// The candidate's clock (every 5 s): a standing automotive report is a vehicle sign now; then the
  /// policy's deadline. The linger is for a quick restart: it watches 3 min from the end (5 once it
  /// holds evidence), whatever it sees, so a car idling where it parked never keeps GPS on; a region
  /// exit makes it an ordinary watch (`lingerToWatch`). Rest only after one that saw no vehicle, or
  /// at the cap; never after the linger.
  func candidateTick(_ r: DetectStateRecord, _ now: Double) {
    guard !confirming else { return }
    let kind = r.origin == "manual" ? "manual" : "auto"
    if kind == "auto" && vehicleStanding { lastVehicleTs = now }
    let due = DetectPolicy.candidateDue(kind, since: r.since, waitUntil: r.waitUntil, walkSince: walkSince, now: now,
                                        lastVehicleTs: lingering ? nil : lastVehicleTs, hasEvidence: confirmState.evidence > 0)
    guard let cause = due else { return }
    endCandidate(reason: cause, rest: !lingering && (cause == "cap" || (cause == "timeout" && lastVehicleTs == nil)))
  }
}
