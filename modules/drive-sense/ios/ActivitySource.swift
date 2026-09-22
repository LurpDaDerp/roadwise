// Motion activity: live `activity` events while armed or capturing, `queryMotionHistory`, the
// motion permission, and the README §3 mapping.
//
// The live feed is the one thing that runs while armed: the motion coprocessor classifies
// activity whatever the app does, so subscribing costs the app nothing until an update arrives.
import CoreMotion
import Foundation

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

  // MARK: - History

  /// Activities with fromTs ≤ ts ≤ toTs, oldest first; empty when motion is not granted or the
  /// query fails. Resolves on main.
  static func history(fromTs: Double, toTs: Double, _ done: @escaping ([[String: Any]]) -> Void) {
    guard status() == "granted", fromTs.isFinite, toTs.isFinite, fromTs <= toTs else {
      done([])
      return
    }
    let from = Date(timeIntervalSince1970: fromTs / 1000)
    let to = Date(timeIntervalSince1970: toTs / 1000)
    manager.queryActivityStarting(from: from, to: to, to: queue) { activities, error in
      var out: [[String: Any]] = []
      if error == nil, let list = activities {
        let sorted = list.sorted { $0.startDate < $1.startDate }
        for a in sorted {
          let ts = Double(TimeBase.ts(a.startDate))
          if ts >= fromTs && ts <= toTs { out.append(activityPayload(a)) }
        }
      }
      DispatchQueue.main.async { done(out) }
    }
  }

  // MARK: - Live updates

  /// Main thread. Idempotent. Emits `activity`, skipping an update equal in type and confidence
  /// to the previous one.
  static func startLive() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard !live, status() == "granted" else { return }
    live = true
    lastEmitted = nil
    manager.startActivityUpdates(to: queue) { a in
      guard let a = a else { return }
      let payload = activityPayload(a)
      DispatchQueue.main.async {
        guard live else { return }
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
