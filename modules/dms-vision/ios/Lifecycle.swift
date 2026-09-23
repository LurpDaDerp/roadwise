// The native-owned lifecycle rules (README §6), pure so they compile and run anywhere. The fake in
// src/fake.ts implements the same rules, and CaptureController applies them on its 1 Hz tick and
// on each thermal notification. Foundation only.

import Foundation

/// The thermal floor with its dwells. Hotter levels 2 and 3 apply at once; level 1 applies only after
/// `fair` has held THERMAL_L1_ENTRY_DWELL_MS; a cooler state applies after THERMAL_COOL_DWELL_MS.
struct ThermalFloor {
  private(set) var level = 0
  private var raw = 0
  private var rawSinceMs = 0.0

  /// `name` is "nominal" | "fair" | "serious" | "critical" | "unknown".
  static func levelOf(_ name: String) -> Int {
    switch name {
    case "fair": return 1
    case "serious": return 2
    case "critical": return 3
    default: return 0
    }
  }

  /// Report the OS state (on every notification, and on each tick). Returns true if the floor moved.
  @discardableResult
  mutating func observe(_ name: String, nowMs: Double) -> Bool {
    let r = ThermalFloor.levelOf(name)
    if r != raw {
      raw = r
      rawSinceMs = nowMs
    }
    let before = level
    if raw > level {
      if raw >= 2 || nowMs - rawSinceMs >= Double(DmsConstants.THERMAL_L1_ENTRY_DWELL_MS) { level = raw }
    } else if raw < level {
      if nowMs - rawSinceMs >= Double(DmsConstants.THERMAL_COOL_DWELL_MS) { level = raw }
    }
    return level != before
  }

  var fpsCap: Int { return DmsConstants.THERMAL_FPS_CAP[level] }
  var allowsGazeNet: Bool { return DmsConstants.THERMAL_GAZE_NET[level] }
  var allowsCamera: Bool { return level < 3 }
}

enum LifecycleAction: Equatable {
  case none
  case pauseWatchdog
  case stopWatchdog
  case release
}

/// The watchdog and release timers, decided from times alone (ms on one monotonic clock).
enum LifecycleRules {
  /// `running`/`paused`: the current state. `lastHeartbeatMs`: the last start/setPolicy.
  /// `pausedSinceMs`: when the current pause began (nil when not paused).
  static func decide(nowMs: Double, running: Bool, paused: Bool, lastHeartbeatMs: Double, pausedSinceMs: Double?) -> LifecycleAction {
    let silent = nowMs - lastHeartbeatMs
    if (running || paused) && silent >= Double(DmsConstants.WATCHDOG_PAUSE_MS + DmsConstants.WATCHDOG_STOP_MS) {
      return .stopWatchdog
    }
    if running && silent >= Double(DmsConstants.WATCHDOG_PAUSE_MS) { return .pauseWatchdog }
    if paused, let since = pausedSinceMs, nowMs - since >= Double(DmsConstants.MODEL_RELEASE_AFTER_PAUSE_MS) {
      return .release
    }
    return .none
  }
}

/// Rolling latency percentiles over the last second's samples (reported once per second).
struct LatencyWindow {
  private var samples: [Double] = []

  mutating func add(_ ms: Double) {
    if samples.count < 240 { samples.append(ms) }
  }

  /// (p50, p95) and reset; (nil, nil) when empty.
  mutating func take() -> (p50: Double?, p95: Double?) {
    defer { samples.removeAll(keepingCapacity: true) }
    if samples.isEmpty { return (nil, nil) }
    let s = samples.sorted()
    func q(_ p: Double) -> Double { return s[min(s.count - 1, Int((p * Double(s.count - 1)).rounded()))] }
    return (q(0.5), q(0.95))
  }
}
