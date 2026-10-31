// The iOS drive detector (plan §3.1.1): notices a drive, confirms it, traces its start back,
// journals it and hands it to JS; stops on its own only as a safety stop (JS decides ends, R1).
// off → armed (JS armed it, Always + Precise + Motion) → candidate (a wake, RoadWise coming to the
// front, the watch after an automatic end, or the Start card) → recording ⇄ ending (a JS end rule
// is overdue) → armed; "Not driving?" → suppressed → armed. The record (`DetectStateRecord`) is
// saved before each transition's side effects. Every decision is `DetectPolicy`'s; this class reads
// the phone and acts. Wakes and candidates are in DriveDetectorWatch.swift; rows, fixes, motion, the
// clock and a relaunch in DriveDetectorSensing.swift. Main thread only.
import Foundation
import UIKit

final class DriveDetector {
  static let shared = DriveDetector()

  let capture = CaptureController.shared
  let access = DriveDetectAccess.shared
  let wakes = WakeSources()
  let journal = RowJournal.shared
  /// The record as saved (nil: nothing stored, or unreadable before the first unlock).
  var rec: DetectStateRecord?

  // Runtime only: nothing here outlives the process.
  var buffer = RowBuffer()
  var confirmState = ConfirmState()
  /// The candidate's other two auto paths beside the speed evidence (round 11): slow traffic and the car link.
  var slowState = SlowTrafficState()
  var linkState = LinkState()
  var confirming = false
  var endClock = DetectPolicy.endClockAt(0)
  var nextSeq = 1
  var lastRowTs: Double?
  var lastFix: (lat: Double, lng: Double)?
  var lastOverStopTs: Double?
  var walkSince: Double?
  var latest: MotionReport?
  /// The on-foot veto's memory: the last confident on-foot and automotive reports' arrivals.
  var vetoState = VetoState()
  /// This candidate's standing motion report (reset as it opens): confident moving car motion, and
  /// any confident automotive report (a car at a light too).
  var carStanding = false
  var vehicleStanding = false
  /// When confident moving car motion was last seen (a wake's motion history, the live feed); 0: never.
  var lastCarMotionAt: Double = 0
  /// This candidate's last vehicle sign (a trusted row at 10 mph or more, unvetoed, or a confident
  /// automotive report); nil: none yet.
  var lastVehicleTs: Double?
  /// The candidate is the watch after an automatic end (`linger`): no hourly cap, rest or parked spot.
  var lingering = false
  /// The drive's step count (rows' `steps`, the safety stop's step walk).
  let pedometer = PedometerSource()
  var clock: DispatchSourceTimer?
  var wakeTask: UIBackgroundTaskIdentifier = .invalid
  var waking = false
  var wakeId = 0
  var endTask: UIBackgroundTaskIdentifier = .invalid
  var endTaskId = 0
  private var unlockObserver: NSObjectProtocol?
  private var activeObserver: NSObjectProtocol?

  private init() {
    dispatchPrecondition(condition: .onQueue(.main))
    rec = DetectStateRecord.load()
    wakes.onWake = { [weak self] reason in self?.onWake(reason) }
    wakes.onAuthorization = { [weak self] in self?.sync(reason: "permissionLost") }
    access.onChange = { [weak self] in self?.sync(reason: "permissionLost") }
    capture.onRow = { [weak self] row, body in self?.onRow(row, body) }
    capture.onFix = { [weak self] fix in self?.onFix(fix) }
    ActivitySource.onLive = { [weak self] a in self?.onActivity(a) }
    CarLink.shared.onChange = { [weak self] in self?.onCarLink() }
    DriveNotifier.install()
    // The first unlock after a reboot: the record becomes readable.
    unlockObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.resumeAtLaunch() }
    // RoadWise came to the front: an "app" wake (mid-drive, the watch opens at once).
    activeObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.appForeground() }
  }

  static func now() -> Double { jsRound(TimeBase.nowEpochMs()) }

  var phase: String { rec?.state ?? "off" }
  var isRecording: Bool { phase == "recording" || phase == "ending" }
  func isLive(_ driveId: String) -> Bool { isRecording && rec?.driveId == driveId }

  func save(_ r: DetectStateRecord) {
    rec = r
    r.save()
  }

  /// Detection may run: JS armed it for an owner, and Always, Precise and Motion are allowed.
  func allowed(_ r: DetectStateRecord) -> Bool { r.armed && r.ownerId != nil && access.snapshot().requiredOk }

  func stateJSON(reason: String? = nil) -> [String: Any] {
    (rec ?? DetectStateRecord()).json(access.snapshot(), reason: reason)
  }

  func emitState(_ reason: String) {
    EventHub.detect.emit("detectState", stateJSON(reason: reason))
  }

  /// Back to armed (or off without the arming or the permissions); the drive's fields cleared.
  func settle(_ r: inout DetectStateRecord, _ now: Double) {
    r.state = allowed(r) ? "armed" : "off"
    r.origin = nil
    r.since = now
    r.waitUntil = nil
    r.driveId = nil
    r.startedAt = nil
    r.startSource = nil
    r.suppressedSince = nil
    r.suppressedUntil = nil
  }

  // MARK: - JS

  /// `setArmed`: JS's arming for an owner (a different owner forgets the last end), then `sync`.
  func setArmed(_ armed: Bool, ownerId: String) -> [String: Any] {
    var r = rec ?? DetectStateRecord()
    if armed && r.ownerId != nil && r.ownerId != ownerId { r.lastEnd = nil }
    r.armed = armed
    r.ownerId = armed ? ownerId : nil
    save(r)
    sync(reason: armed ? "armed" : "disarmed")
    return stateJSON()
  }

  /// `getState`: the state now; the journal-dropped count is reported once.
  func getState() -> [String: Any] {
    let out = stateJSON()
    if var r = rec, r.journalDropped > 0 {
      r.journalDropped = 0
      save(r)
    }
    return out
  }

  /// Brings the state in line with the arming and the permissions. A drive in progress finishes first.
  func sync(reason: String) {
    guard var r = rec else { return }
    let ok = allowed(r)
    let now = DriveDetector.now()
    switch r.state {
    case "off" where ok:
      r.state = "armed"
      r.since = now
      save(r)
      wakes.start()
      wakes.setParked(r.lastEnd.map { (lat: $0.lat, lng: $0.lng) })
      emitState("armed")
    case "armed" where !ok:
      r.state = "off"
      r.since = now
      save(r)
      emitState(r.armed ? "permissionLost" : "disarmed")
    case "candidate":
      let manualOk = access.snapshot().location != "none"
      if (r.origin == "manual" && !manualOk) || (r.origin != "manual" && !ok) {
        endCandidate(reason: r.armed ? "permissionLost" : "disarmed", rest: false)
      }
    case "suppressed" where !ok:
      endSuppression()
    default:
      break
    }
    syncWakes()
  }

  /// The wakes run while detection is allowed and not off (through a drive, for a relaunch), and
  /// while any drive records with Location Always, armed or not (a Start drive with automatic drives
  /// off, a disarm mid-drive), so iOS relaunches RoadWise after a kill. Unarmed, the wake gate
  /// refuses every wake they bring.
  func syncWakes() {
    guard let r = rec else { return }
    if (allowed(r) && r.state != "off") || (isRecording && access.snapshot().location == "always") { wakes.start() } else { wakes.stop() }
  }

  /// `startWaiting`: the Start card. While Using and Precise are enough (the app is in front). The
  /// drive opens at once, from the tap (`beginManualDrive`), and waits for driving speed meanwhile.
  func startWaiting() -> [String: Any] {
    let p = access.snapshot()
    guard p.location != "none", p.precise else { return ["ok": false, "reason": "permission"] }
    if rec == nil { save(DetectStateRecord()) }
    guard let r = rec else { return ["ok": false, "reason": "unavailable"] }
    if r.state == "recording" || r.state == "ending" || capture.sensing == .plain { return ["ok": false, "reason": "busy"] }
    beginManualDrive()
    guard let r1 = rec, isRecording, let driveId = r1.driveId, let startedAt = r1.startedAt, let waitUntil = r1.waitUntil else {
      return ["ok": false, "reason": "unavailable"]
    }
    return ["ok": true, "waitUntil": DetectStateRecord.ms(waitUntil), "driveId": driveId, "startedAt": DetectStateRecord.ms(startedAt)]
  }

  /// `extendWaiting`: any touch while a Start-card drive waits for driving speed; the new deadline,
  /// or nil when it waits no more.
  func extendWaiting() -> Double? {
    guard var r = rec, isRecording, r.origin == "manual", r.waitUntil != nil else { return nil }
    let until = DriveDetector.now() + DetectPolicy.WAIT_MAX_MS
    r.waitUntil = until
    save(r)
    emitState("extended")
    return until
  }

  func cancelWaiting() {
    guard let r = rec, r.state == "candidate", r.origin == "manual" else { return }
    endCandidate(reason: "cancelled", rest: false)
  }

  /// DriveSense `stopCapture`: a recording drive's end from JS (its cut, else now); else a plain
  /// capture's. A JS end JS calls automatic (`end.automatic`: the parking spot's, among others) or
  /// that a JS end rule would have made by now was automatic: the watch lingers.
  func stopCapture(end: CaptureEnd?) {
    if isRecording {
      commitEnd(cause: "js", endedAt: end?.drivingEndedAt ?? DriveDetector.now(), linger: end?.automatic == true || automaticEndDue())
    } else {
      capture.stopPlainCapture()
    }
  }

  // MARK: - Background tasks

  /// One background task per wake, until the first fix (location updates then keep RoadWise running)
  /// or `WAKE_TASK_MAX_MS`; a late finish never ends a newer wake's task.
  func beginWakeTask() {
    endWakeTask()
    wakeId &+= 1
    let id = wakeId
    waking = true
    wakeTask = UIApplication.shared.beginBackgroundTask(withName: "drivesense.wake") { [weak self] in
      if self?.wakeId == id { self?.endWakeTask() }
    }
    DispatchQueue.main.asyncAfter(wallDeadline: .now() + DetectPolicy.WAKE_TASK_MAX_MS / 1000) { [weak self] in
      if self?.wakeId == id { self?.endWakeTask() }
    }
  }

  func endWakeTask() {
    waking = false
    guard wakeTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(wakeTask)
    wakeTask = .invalid
  }

  /// One background task per drive end, so JS can take the end in, store the drive and post its
  /// recap before iOS suspends a RoadWise whose GPS just went off; it ends after `END_TASK_MAX_MS`
  /// (or when iOS says time is up). A newer end's task replaces it; a late finish never ends it.
  func beginEndTask() {
    endEndTask()
    endTaskId &+= 1
    let id = endTaskId
    endTask = UIApplication.shared.beginBackgroundTask(withName: "drivesense.end") { [weak self] in
      if self?.endTaskId == id { self?.endEndTask() }
    }
    DispatchQueue.main.asyncAfter(wallDeadline: .now() + DetectPolicy.END_TASK_MAX_MS / 1000) { [weak self] in
      if self?.endTaskId == id { self?.endEndTask() }
    }
  }

  func endEndTask() {
    guard endTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(endTask)
    endTask = .invalid
  }
}
