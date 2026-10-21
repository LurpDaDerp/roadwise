// Motion activity: live `activity` events while the detector senses (a candidate, a drive, the "Not
// driving?" rest), the motion permission, the README §3 mapping, and the motion history a wake and
// a start's back-fill read.
//
// The live feed costs nothing to subscribe to: the motion coprocessor classifies activity whatever
// the app does. Every live report also goes to the detector (`onLive`: the walking end, the cycling
// veto, the fix-less hold) before the duplicate filter that keeps the JS feed quiet.
import CoreMotion
import Foundation

/// A live motion report as the detector reads it, with when it arrived (epoch ms).
struct MotionReport {
  /// walking or running
  var walking: Bool
  var cycling: Bool
  var automotive: Bool
  var stationary: Bool
  /// medium or high
  var confident: Bool
  var at: Double
}

enum ActivitySource {
  private static let manager = CMMotionActivityManager()
  private static let queue: OperationQueue = {
    let q = OperationQueue()
    q.name = "drivesense.activity"
    q.maxConcurrentOperationCount = 1
    return q
  }()
  /// Main thread only.
  private static var live = false
  private static var lastEmitted: (type: String, confidence: String)?
  /// Every live report, on main (the drive detector).
  static var onLive: ((MotionReport) -> Void)?

  // MARK: - Mapping (README §3, iOS)

  /// `type` is the first set flag in the order walking → running → cycling → automotive →
  /// stationary → unknown, so a car at a red light (`automotive && stationary`) is automotive.
  static func activityPayload(_ a: CMMotionActivity) -> [String: Any] {
    return ["type": activityType(a), "confidence": activityConfidence(a), "ts": NSNumber(value: TimeBase.ts(a.startDate))]
  }

  private static func activityType(_ a: CMMotionActivity) -> String {
    if a.walking { return "walking" }
    if a.running { return "running" }
    if a.cycling { return "cycling" }
    if a.automotive { return "automotive" }
    if a.stationary { return "stationary" }
    return "unknown"
  }

  private static func activityConfidence(_ a: CMMotionActivity) -> String {
    switch a.confidence {
    case .low: return "low"
    case .medium: return "medium"
    case .high: return "high"
    @unknown default: return "low"
    }
  }

  // MARK: - Authorisation (README §2 `DriveSenseState.motion`)

  static func status() -> String {
    guard CMMotionActivityManager.isActivityAvailable() else { return "unavailable" }
    switch CMMotionActivityManager.authorizationStatus() {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "undetermined"
    @unknown default: return "denied"
    }
  }

  /// Prompts with a one-minute history query only when the OS still can; resolves on main.
  static func requestPermission(_ done: @escaping (String) -> Void) {
    let s = status()
    guard s == "undetermined" else {
      done(s == "granted" ? "granted" : s == "unavailable" ? "unavailable" : "denied")
      return
    }
    let now = Date()
    manager.queryActivityStarting(from: now.addingTimeInterval(-60), to: now, to: queue) { _, _ in
      DispatchQueue.main.async { done(status() == "granted" ? "granted" : "denied") }
    }
  }

  // MARK: - The motion history (a wake's gate, a start's back-fill; nothing reaches JS)

  /// The motion history between two moments, summarized by the policy (`DetectPolicy.summarize`):
  /// the newest moving car stretch, the run it belongs to, and whether the driver is on foot now.
  /// Resolves on main; empty without Motion & Fitness.
  static func motionSummary(from: Date, to: Date, _ done: @escaping (DetectMotion) -> Void) {
    lookBack(from: from, to: to) { list in
      done(DetectPolicy.summarize(list, to.timeIntervalSince1970 * 1000))
    }
  }

  /// The one history query besides the permission prompt. Empty without motion access.
  private static func lookBack(from: Date, to: Date, _ done: @escaping ([DetectActivity]) -> Void) {
    guard status() == "granted", from < to else {
      done([])
      return
    }
    manager.queryActivityStarting(from: from, to: to, to: queue) { activities, _ in
      let list = (activities ?? []).map { a in
        DetectActivity(
          start: a.startDate.timeIntervalSince1970 * 1000,
          automotive: a.automotive,
          stationary: a.stationary,
          onFoot: a.walking || a.running || a.cycling,
          confident: a.confidence != .low
        )
      }
      DispatchQueue.main.async { done(list) }
    }
  }

  // MARK: - Live updates

  /// Main thread. Idempotent. Hands every report to the detector, and emits `activity`, skipping an
  /// update equal in type and confidence to the previous one.
  static func startLive() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard !live, status() == "granted" else { return }
    live = true
    lastEmitted = nil
    manager.startActivityUpdates(to: queue) { a in
      guard let a = a else { return }
      let payload = activityPayload(a)
      let report = MotionReport(
        walking: a.walking || a.running,
        cycling: a.cycling,
        automotive: a.automotive,
        stationary: a.stationary,
        confident: a.confidence != .low,
        at: TimeBase.nowEpochMs()
      )
      DispatchQueue.main.async {
        guard live else { return }
        onLive?(report)
        let key = (payload["type"] as? String ?? "", payload["confidence"] as? String ?? "")
        if let l = lastEmitted, l.type == key.0, l.confidence == key.1 { return }
        lastEmitted = (key.0, key.1)
        EventHub.shared.emit("activity", payload)
      }
    }
  }

  static func stopLive() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard live else { return }
    live = false
    manager.stopActivityUpdates()
  }
}
