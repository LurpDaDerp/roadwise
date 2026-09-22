// The iOS drive-sense core: arming and wakes, capture and its rate, the persisted flags, and
// `getState`. One instance for the process, created on the main thread by the app-delegate
// subscriber at launch (before any module exists) and used on the main thread only; row work
// happens on `RowPipeline.queue`.
//
// Battery (design §3.5, README §1): armed = OS-delivered wakes plus the motion-activity feed —
// no GPS, no IMU, no timers. GPS 1 Hz and IMU 25 Hz only while capturing at `full`; at `low` the
// IMU and the 1 s tick stop and a row is emitted per coarse fix.
import CoreLocation
import Foundation

final class CaptureController {
  static let shared = CaptureController()

  private enum Key {
    static let armed = "drivesense.armed"
    static let captureOpen = "drivesense.captureOpen"
    static let captureMode = "drivesense.captureMode"
  }

  private let defaults = UserDefaults.standard
  private let wakes = WakeLocation()
  private let location = CaptureLocation()
  private let pipeline = RowPipeline()
  private lazy var motion = MotionSource(workQueue: pipeline.queue)
  private let phone = PhoneStateMonitor()
  private let calls = CallObserver()
  private let watchdog = Watchdog()
  private let wakeTask = WakeTask()
  private var rowTimer: DispatchSourceTimer?

  /// The persisted capture-open flag as this process found it (rev1: I2).
  let captureWasOpen: Bool
  private(set) var armed: Bool
  private(set) var capturing = false
  private(set) var rate: String?
  private(set) var mode: String?
  private(set) var captureStartedAt: Int64?
  private(set) var lastRowTs: Int64?
  private var generation = 0
  private var anchor = ClockAnchor.now()

  private init() {
    dispatchPrecondition(condition: .onQueue(.main))
    captureWasOpen = defaults.bool(forKey: Key.captureOpen)
    armed = defaults.bool(forKey: Key.armed)
    wakes.onWake = { [weak self] reason, loc in self?.handleWake(reason: reason, location: loc) }
    wakes.onAuthorizationChange = { [weak self] in self?.enforceArmingPermissions() }
    location.onFix = { [weak self] fix in self?.handleFix(fix) }
    pipeline.onRow = { [weak self] row, gen in
      DispatchQueue.main.async { self?.emitRow(row, generation: gen) }
    }
    watchdog.onExpire = { [weak self] in self?.stopCapture() }
    EventHub.shared.onListeningChanged = { [weak self] event, listening in
      guard let self = self, event == "row" else { return }
      self.watchdog.rowListening(listening, capturing: self.capturing)
    }
  }

  // MARK: - Permissions

  var locationAuthorization: String { wakes.authorization }

  private var armPermitted: Bool {
    locationAuthorization == "always" && ActivitySource.status() == "granted"
  }

  /// `armed` is the effective arming: a revoked permission disarms and clears the flag.
  func enforceArmingPermissions() {
    if armed && !armPermitted { disarmNow() }
  }

  // MARK: - Launch (DriveSenseAppDelegateSubscriber)

  /// Re-attaches the OS wakes after a launch. On a location-key relaunch with a capture open,
  /// restarts full capture at once, under the watchdog's 60 s claim (design §2.4).
  func launched(forLocation: Bool) {
    enforceArmingPermissions()
    if armed {
      wakes.startWakes()
      ActivitySource.startLive()
    }
    // A relaunch in the background can start GPS only with Always (which a location relaunch implies).
    if forLocation && defaults.bool(forKey: Key.captureOpen) && !capturing && locationAuthorization == "always" {
      let m = defaults.string(forKey: Key.captureMode) ?? "auto"
      beginCapture(mode: m, nativeStarted: true)
    }
  }

  // MARK: - Arming

  enum ArmFailure: Error {
    case unavailable
    case permission(String)
  }

  func arm() throws {
    wakeTask.end()
    let motionStatus = ActivitySource.status()
    if motionStatus == "unavailable" { throw ArmFailure.unavailable }
    guard armPermitted else {
      disarmNow()
      throw ArmFailure.permission("arm needs location 'always' and motion 'granted' (have \(locationAuthorization), \(motionStatus))")
    }
    if !armed {
      armed = true
      defaults.set(true, forKey: Key.armed)
    }
    wakes.startWakes()
    ActivitySource.startLive()
  }

  func disarm() {
    wakeTask.end()
    disarmNow()
  }

  private func disarmNow() {
    armed = false
    defaults.set(false, forKey: Key.armed)
    wakes.stopWakes()
    if !capturing { ActivitySource.stopLive() }
  }

  /// An OS wake: re-centre the exit region on the wake's own location, hold a background task
  /// over the JS boot, and tell JS. While a claimed capture runs there is nothing to wake.
  private func handleWake(reason: String, location loc: CLLocation?) {
    guard armed else { return }
    if let l = loc { wakes.recentre(on: l) }
    if capturing && !watchdog.awaitingClaim { return }
    wakeTask.begin()
    EventHub.shared.emit("wake", ["reason": reason, "ts": TimeBase.nowTs()])
  }

  // MARK: - Capture

  /// JS `startCapture`: starts a capture, or claims and re-modes the running one.
  func startCapture(mode newMode: String) -> Bool {
    guard locationAuthorization != "none" else { return false }
    if capturing {
      mode = newMode
      defaults.set(newMode, forKey: Key.captureMode)
      watchdog.claimed()
    } else {
      beginCapture(mode: newMode, nativeStarted: false)
    }
    wakeTask.end()
    return true
  }

  private func beginCapture(mode newMode: String, nativeStarted: Bool) {
    generation += 1
    let gen = generation
    capturing = true
    rate = "full"
    mode = newMode
    anchor = ClockAnchor.now()
    captureStartedAt = Int64(jsRound(anchor.epochMs))
    defaults.set(true, forKey: Key.captureOpen)
    defaults.set(newMode, forKey: Key.captureMode)
    pipeline.queue.async { self.pipeline.reset(generation: gen) }
    phone.start()
    calls.start()
    ActivitySource.startLive()
    location.start(low: false)
    startFullRateSensors()
    watchdog.captureStarted(nativeStarted: nativeStarted, rowListening: EventHub.shared.isListening("row"))
  }

  func stopCapture() {
    guard capturing else { return }
    generation += 1
    let gen = generation
    capturing = false
    rate = nil
    mode = nil
    captureStartedAt = nil
    defaults.set(false, forKey: Key.captureOpen)
    watchdog.captureStopped()
    stopFullRateSensors()
    location.stop()
    pipeline.queue.async { self.pipeline.reset(generation: gen) }
    phone.stop()
    calls.stop()
    if !armed { ActivitySource.stopLive() }
  }

  func setCaptureRate(_ newRate: String) {
    guard capturing, newRate != rate else { return }
    rate = newRate
    if newRate == "low" {
      // Close the queued rows with the samples already buffered, before the IMU buffer is dropped.
      pipeline.queue.async { self.pipeline.flush() }
      stopFullRateSensors()
      location.configure(low: true)
    } else {
      location.configure(low: false)
      startFullRateSensors()
    }
  }

  /// 25 Hz device motion onto the work queue, and the 1 s row tick (which also polls the phone
  /// state) on main.
  private func startFullRateSensors() {
    let a = anchor
    pipeline.queue.async {
      self.pipeline.setImuExpected(self.motion.available)
      self.motion.start(anchor: a) { [weak self] s in self?.pipeline.addSample(s) }
    }
    rowTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 1.0, repeating: 1.0, leeway: .milliseconds(20))
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    rowTimer = timer
  }

  private func stopFullRateSensors() {
    rowTimer?.setEventHandler {}
    rowTimer?.cancel()
    rowTimer = nil
    pipeline.queue.async {
      self.motion.stop()
      self.pipeline.setImuExpected(false)
    }
  }

  private func tick() {
    guard capturing, rate == "full" else { return }
    let ts = jsRound(TimeBase.nowEpochMs())
    let p = phone.poll()
    let gen = generation
    pipeline.queue.async { self.pipeline.tick(ts: ts, phone: p, generation: gen) }
  }

  private func handleFix(_ fix: FixSample) {
    guard capturing else { return }
    let gen = generation
    if rate == "low" {
      let p = phone.poll()
      pipeline.queue.async { self.pipeline.lowRateFix(fix, phone: p, generation: gen) }
    } else {
      pipeline.queue.async { self.pipeline.addFix(fix) }
    }
  }

  private func emitRow(_ row: ExtractedRow, generation gen: Int) {
    guard capturing, gen == generation else { return }
    lastRowTs = row.ts
    EventHub.shared.emit("row", row.payload)
  }

  // MARK: - State

  func state() -> [String: Any] {
    enforceArmingPermissions()
    return [
      "armed": armed,
      "capturing": capturing,
      "rate": rate.map { $0 as Any } ?? NSNull(),
      "mode": mode.map { $0 as Any } ?? NSNull(),
      "platform": "ios",
      "location": locationAuthorization,
      "motion": ActivitySource.status(),
      "lockSignal": PhoneState.lockSignal(),
      "captureWasOpen": captureWasOpen,
      "captureStartedAt": captureStartedAt.map { NSNumber(value: $0) as Any } ?? NSNull(),
      "lastRowTs": lastRowTs.map { NSNumber(value: $0) as Any } ?? NSNull(),
    ]
  }
}
