// The iOS drive-sense core: capture and its rate, the persisted flags, and `getState`. One
// instance for the process, created lazily on the main thread by the first module call and used
// on the main thread only; row work happens on `RowPipeline.queue`.
//
// v3 (plan §1 decision 4): nothing of the capture runs between captures — no wakes, no motion
// feed, no timers. (The optional forgot-to-start reminder, `TripReminder`, has its own wake and
// never starts a capture; this class tells it when a capture starts and ends and never hears from it.)
// GPS 1 Hz and IMU 25 Hz only while capturing at `full`; at `low` the IMU and the 1 s tick stop
// and a row is emitted per coarse fix. A capture started in the foreground keeps running in the
// background on While Using through the `location` background mode (app.config.ts).
import CoreLocation
import Foundation

final class CaptureController {
  static let shared = CaptureController()

  private enum Key {
    static let captureOpen = "drivesense.captureOpen"
    static let captureMode = "drivesense.captureMode"
  }

  private let defaults = UserDefaults.standard
  private let location = CaptureLocation()
  private let pipeline = RowPipeline()
  private lazy var motion = MotionSource(workQueue: pipeline.queue)
  private let phone = PhoneStateMonitor()
  private let calls = CallObserver()
  private let watchdog = Watchdog()
  private var rowTimer: DispatchSourceTimer?

  /// The persisted capture-open flag as this process found it (rev1: I2). iOS never restarts a
  /// capture on its own (no location relaunch without Always), so this only tells JS that the
  /// previous process died mid-drive; the flag is cleared here so it reports once.
  let captureWasOpen: Bool
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
    if captureWasOpen { defaults.set(false, forKey: Key.captureOpen) }
    location.onFix = { [weak self] fix in self?.handleFix(fix) }
    pipeline.onRow = { [weak self] row, mock, gen in
      DispatchQueue.main.async { self?.emitRow(row, mock: mock, generation: gen) }
    }
    watchdog.onExpire = { [weak self] in self?.stopCapture() }
    EventHub.shared.onListeningChanged = { [weak self] event, listening in
      guard let self = self, event == "row" else { return }
      self.watchdog.rowListening(listening, capturing: self.capturing)
    }
  }

  // MARK: - Permissions

  var locationAuthorization: String { location.authorization }

  // MARK: - Capture

  /// JS `startCapture`: starts a capture, or re-modes the running one. Needs While Using at least.
  func startCapture(mode newMode: String) -> Bool {
    guard locationAuthorization != "none" else { return false }
    if capturing {
      mode = newMode
      defaults.set(newMode, forKey: Key.captureMode)
    } else {
      beginCapture(mode: newMode)
    }
    return true
  }

  private func beginCapture(mode newMode: String) {
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
    // The motion-activity feed runs only during a capture (walking auto-end).
    ActivitySource.startLive()
    location.start(low: false)
    startFullRateSensors()
    watchdog.captureStarted(rowListening: EventHub.shared.isListening("row"))
    // The forgot-to-start reminder learns a drive is open (one direction only).
    TripReminder.shared.onCaptureStarted()
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
    ActivitySource.stopLive()
    DriveDisplayBridge.postEnded()
    // No forgot-to-start reminder for the next 10 min.
    TripReminder.shared.onCaptureEnded()
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
    watchdog.check() // a guard may be due (its timer can lag in sleep); may stop the capture
    guard capturing else { return }
    let gen = generation
    if rate == "low" {
      let p = phone.poll()
      pipeline.queue.async { self.pipeline.lowRateFix(fix, phone: p, generation: gen) }
    } else {
      pipeline.queue.async { self.pipeline.addFix(fix) }
    }
  }

  /// The `row` payload: the FeatureRow keys plus the bridge-only `mock` (v3, plan §6: the window's
  /// fix was simulated) and `call` ("ring" | "live", absent with no call: README §1).
  private func emitRow(_ row: ExtractedRow, mock: Bool, generation gen: Int) {
    watchdog.check()
    guard capturing, gen == generation else { return }
    lastRowTs = row.ts
    var body = row.payload
    body["mock"] = mock
    if let c = calls.state() { body["call"] = c }
    EventHub.shared.emit("row", body)
  }

  // MARK: - State

  func state() -> [String: Any] {
    let lockSignal = PhoneState.lockSignal()
    // No passcode: a lock can never be told from a switch, and a proof from before means nothing now.
    if lockSignal == "unreliable" { LockProbe.shared.passcodeGone() }
    return [
      "capturing": capturing,
      "rate": rate.map { $0 as Any } ?? NSNull(),
      "mode": mode.map { $0 as Any } ?? NSNull(),
      "platform": "ios",
      "location": locationAuthorization,
      "motion": ActivitySource.status(),
      "lockSignal": lockSignal,
      "lockProof": LockProbe.shared.proven,
      "lockDelayMs": LockProbe.shared.lockDelayMs.map { NSNumber(value: $0) as Any } ?? NSNull(),
      "captureWasOpen": captureWasOpen,
      "captureStartedAt": captureStartedAt.map { NSNumber(value: $0) as Any } ?? NSNull(),
      "lastRowTs": lastRowTs.map { NSNumber(value: $0) as Any } ?? NSNull(),
    ]
  }
}
