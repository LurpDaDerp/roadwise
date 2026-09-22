// Phone state for the rows and the `screen` / `thermal` events (README §5).
//
// iOS gives an app no direct lock or screen state. `isProtectedDataAvailable` is the proxy:
// with a passcode it turns false about 10 s after the side-button press (the file-protection
// grace period), so `locked` lags the real lock (`lockSignal: 'lagged'`; the drive host confirms a
// lock for 12 s). Without a passcode it never turns false, so a locked phone looks unlocked
// (`lockSignal: 'unreliable'`; the host then does not count background time as phone use).
import Foundation
import LocalAuthentication
import UIKit

enum PhoneState {
  /// The phone flags now. Main thread only (UIApplication).
  static func snapshot() -> PhoneSample {
    dispatchPrecondition(condition: .onQueue(.main))
    let app = UIApplication.shared
    let available = app.isProtectedDataAvailable
    return PhoneSample(locked: !available, screenOn: available, appForeground: app.applicationState == .active)
  }

  /// `lagged` with a passcode, `unreliable` without one.
  static func lockSignal() -> String {
    var error: NSError?
    let hasPasscode = LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    return hasPasscode ? "lagged" : "unreliable"
  }

  static func thermalLevel() -> String {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "critical"
    }
  }
}

/// While capturing: emits `screen` when the polled lock/screen pair changes and `thermal` when
/// the thermal state changes. The 1 Hz poll is the capture's own row tick (no timer of its own);
/// at `low` rate it is sampled on each fix instead.
final class PhoneStateMonitor {
  private var last: (locked: Bool, on: Bool)?
  private var lastThermal: String?
  private var thermalObserver: NSObjectProtocol?

  /// Main thread. Takes the current state as the baseline without emitting it.
  func start() {
    dispatchPrecondition(condition: .onQueue(.main))
    let s = PhoneState.snapshot()
    last = (s.locked, s.screenOn)
    lastThermal = PhoneState.thermalLevel()
    guard thermalObserver == nil else { return }
    thermalObserver = NotificationCenter.default.addObserver(
      forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.thermalChanged()
    }
  }

  func stop() {
    dispatchPrecondition(condition: .onQueue(.main))
    if let o = thermalObserver { NotificationCenter.default.removeObserver(o) }
    thermalObserver = nil
    last = nil
    lastThermal = nil
  }

  /// Main thread. Reads the phone state and emits `screen` if it changed; returns it for the row.
  func poll() -> PhoneSample {
    let s = PhoneState.snapshot()
    if let l = last, l.locked != s.locked || l.on != s.screenOn {
      EventHub.shared.emit("screen", ["locked": s.locked, "on": s.screenOn, "ts": TimeBase.nowTs()])
    }
    last = (s.locked, s.screenOn)
    return s
  }

  private func thermalChanged() {
    guard thermalObserver != nil else { return }
    let level = PhoneState.thermalLevel()
    guard level != lastThermal else { return }
    lastThermal = level
    EventHub.shared.emit("thermal", ["level": level, "ts": TimeBase.nowTs()])
  }
}
