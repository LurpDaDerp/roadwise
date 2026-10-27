// The iOS sensing core: GPS, the 25 Hz motion feed, the live motion activity and the 1 s row tick,
// for whatever the drive detector needs (a candidate, a recording drive, the "Not driving?" rest),
// and the capture state JS reads (`getState`). One instance for the process, created on main and
// used on main only; row work happens on `RowPipeline.queue`.
//
// Rows of the detector's sensing go to `onRow` (the detector buffers or journals them and emits
// them with their `seq`); a plain capture (a JS `startCapture` with nothing open: tests and dev
// tools) emits its rows straight to JS without one. Phone use is not read: rows carry the fixed
// phone sample. JS sees a capture (`capturing`) only while a drive records, never during a candidate.
import CoreLocation
import Foundation

final class CaptureController {
  static let shared = CaptureController()

  enum Key {
    /// Also read by modules/live-drive: a Live Activity found at launch is kept only while this is true.
    static let captureOpen = "drivesense.captureOpen"
    static let captureMode = "drivesense.captureMode"
  }

  /// What the sensors serve: nothing, the detector, a plain JS capture, or the "Not driving?" rest.
  enum Sensing {
    case off
    case detector
    case plain
    case suppressed
  }

  private let defaults = UserDefaults.standard
  private let location = CaptureLocation()
  private let pipeline = RowPipeline()
  private lazy var motion = MotionSource(workQueue: pipeline.queue)
  private let phone = PhoneStateMonitor()
  private let calls = CallObserver()
  private var rowTimer: DispatchSourceTimer?

  /// The detector's rows (the row and its `row` payload, without `seq`), on main.
  var onRow: ((ExtractedRow, [String: Any]) -> Void)?
  /// Every fix while anything senses, on main.
  var onFix: ((FixSample) -> Void)?

  /// The persisted capture-open flag as this process found it (rev1: I2): the previous process died
  /// mid-drive. The drive itself is resumed or ended from its journal.
  let captureWasOpen: Bool
  private(set) var sensing: Sensing = .off
  private var sensingRate = "full"
  private(set) var capturing = false
  private(set) var mode: String?
  private(set) var captureStartedAt: Int64?
  private(set) var lastRowTs: Int64?
  private var generation = 0
  private var anchor = ClockAnchor.now()

  private init() {
    dispatchPrecondition(condition: .onQueue(.main))
    captureWasOpen = defaults.bool(forKey: Key.captureOpen)
    location.onFix = { [weak self] fix in self?.handleFix(fix) }
    pipeline.onRow = { [weak self] row, mock, gen in
      DispatchQueue.main.async { self?.deliverRow(row, mock: mock, generation: gen) }
    }
  }

  var locationAuthorization: String { location.authorization }
  var preciseLocation: Bool { location.precise }

  // MARK: - The detector's sensing

  /// A candidate or a drive: navigation GPS, the motion feed, the row tick. A drive confirmed from a
  /// candidate keeps the same sensors (no gap).
  func beginSensing() {
    if sensing == .detector { return }
    if sensing != .off { endSensors() }
    sensing = .detector
    startSensors()
  }

  /// "Not driving?": ten-metre GPS and the live motion activity; no IMU, no rows.
  func beginSuppressedSensing() {
    if sensing != .off { endSensors() }
    sensing = .suppressed
    generation += 1
    ActivitySource.startLive()
    location.start(.suppressed)
  }

  func endSensing() {
    guard sensing != .off else { return }
    endSensors()
    sensing = .off
  }

  /// A drive records (confirmed or resumed): JS sees a capture from its traced start.
  func openCapture(startedAt: Double, mode newMode: String) {
    capturing = true
    mode = newMode
    captureStartedAt = Int64(jsRound(startedAt))
    defaults.set(true, forKey: Key.captureOpen)
    defaults.set(newMode, forKey: Key.captureMode)
  }

  /// The drive ended or was cancelled.
  func closeCapture() {
    capturing = false
    mode = nil
    captureStartedAt = nil
    defaults.set(false, forKey: Key.captureOpen)
  }

  /// At launch with no drive to resume: the flag a dead process left behind goes.
  func clearStaleOpenFlag() {
    if !capturing { defaults.set(false, forKey: Key.captureOpen) }
  }

  /// A row to JS (the detector's, with its `seq`; a plain capture's, without).
  func emitRow(_ body: [String: Any], ts: Int64) {
    lastRowTs = ts
    EventHub.shared.emit("row", body)
  }

  // MARK: - A plain capture (JS `startCapture` with nothing open)

  /// JS `startCapture`: re-modes the drive that records; with nothing sensing, starts a plain capture.
  /// A candidate or a rest owns the sensors: nothing more starts. Needs While Using at least.
  func startCapture(mode newMode: String) -> Bool {
    guard locationAuthorization != "none" else { return false }
    if capturing {
      mode = newMode
      defaults.set(newMode, forKey: Key.captureMode)
      return true
    }
    guard sensing == .off else { return true }
    sensing = .plain
    startSensors()
    openCapture(startedAt: anchor.epochMs, mode: newMode)
    return true
  }

  /// Ends a plain capture (a detector drive's end is the detector's).
  func stopPlainCapture() {
    guard sensing == .plain else { return }
    endSensing()
    closeCapture()
    DriveDisplayBridge.postEnded()
  }

  func setCaptureRate(_ newRate: String) {
    guard capturing, sensing == .detector || sensing == .plain, newRate != sensingRate else { return }
    sensingRate = newRate
    if newRate == "low" {
      // Close the queued rows with the samples already buffered, before the IMU buffer is dropped.
      pipeline.queue.async { self.pipeline.flush() }
      stopFullRateSensors()
      location.configure(.low)
    } else {
      location.configure(.full)
      startFullRateSensors()
    }
  }

  // MARK: - Sensors

  private func startSensors() {
    generation += 1
    let gen = generation
    sensingRate = "full"
    anchor = ClockAnchor.now()
    pipeline.queue.async { self.pipeline.reset(generation: gen) }
    phone.start()
    calls.start()
    ActivitySource.startLive()
    location.start(.full)
    startFullRateSensors()
  }

  private func endSensors() {
    generation += 1
    let gen = generation
    stopFullRateSensors()
    location.stop()
    pipeline.queue.async { self.pipeline.reset(generation: gen) }
    phone.stop()
    calls.stop()
    ActivitySource.stopLive()
  }

  /// 25 Hz device motion onto the work queue, and the 1 s row tick on main.
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

  private var rowsFlow: Bool { sensing == .detector || sensing == .plain }

  private func tick() {
    guard rowsFlow, sensingRate == "full" else { return }
    let ts = jsRound(TimeBase.nowEpochMs())
    let p = phone.poll()
    let gen = generation
    pipeline.queue.async { self.pipeline.tick(ts: ts, phone: p, generation: gen) }
  }

  private func handleFix(_ fix: FixSample) {
    guard sensing != .off else { return }
    onFix?(fix)
    guard rowsFlow else { return }
    let gen = generation
    if sensingRate == "low" {
      let p = phone.poll()
      pipeline.queue.async { self.pipeline.lowRateFix(fix, phone: p, generation: gen) }
    } else {
      // Only a drive JS records shows a speed: a watch's fixes would wake JS for nothing.
      if capturing { emitSpeed(fix) }
      pipeline.queue.async { self.pipeline.addFix(fix) }
    }
  }

  /// The `speed` event (README §3): this fix's speed the moment it lands, with how old it already
  /// is, for the driving screen (the waiting screen too). Live only: dropped with no JS listener.
  private func emitSpeed(_ fix: FixSample) {
    let age = Swift.max(0, TimeBase.nowEpochMs() - fix.t)
    EventHub.shared.emitLive("speed", [
      "ts": NSNumber(value: Int64(jsRound(fix.t))),
      "speed": fix.speed >= 0 ? fix.speed : -1.0,
      "speedAcc": fix.speedAcc >= 0 ? fix.speedAcc : -1.0,
      "hAcc": fix.hAcc >= 0 ? fix.hAcc : -1.0,
      "ageMs": NSNumber(value: Int64(jsRound(age))),
    ])
  }

  /// The `row` payload: the FeatureRow keys plus the bridge-only `mock` (the window's fix was
  /// simulated) and `call` ("ring" | "live", absent with no call: README §1).
  private func deliverRow(_ row: ExtractedRow, mock: Bool, generation gen: Int) {
    guard rowsFlow, gen == generation else { return }
    var body = row.payload
    body["mock"] = mock
    if let c = calls.state() { body["call"] = c }
    if sensing == .plain {
      emitRow(body, ts: row.ts)
    } else {
      onRow?(row, body)
    }
  }

  // MARK: - State

  func state() -> [String: Any] {
    return [
      "capturing": capturing,
      "rate": capturing ? (sensingRate as Any) : NSNull(),
      "mode": mode.map { $0 as Any } ?? NSNull(),
      "platform": "ios",
      "location": locationAuthorization,
      "motion": ActivitySource.status(),
      // Phone use is not tracked: no lock state, no proof.
      "lockSignal": "unreliable",
      "lockProof": false,
      "lockDelayMs": NSNull(),
      "captureWasOpen": captureWasOpen,
      "captureStartedAt": captureStartedAt.map { NSNumber(value: $0) as Any } ?? NSNull(),
      "lastRowTs": lastRowTs.map { NSNumber(value: $0) as Any } ?? NSNull(),
    ]
  }
}
