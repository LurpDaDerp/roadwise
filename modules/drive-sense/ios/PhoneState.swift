// Phone state for the rows and the `thermal` event (README §5).
//
// Phone use is not tracked, so iOS reads no lock or screen state at all: every row carries the
// fixed sample below (the row's three phone keys stay because the row contract is shared with
// Android and with stored traces; JS ignores them) and the `screen` event is never emitted. The
// thermal state remains (diagnostics).
import Foundation

enum PhoneState {
  /// The fixed sample every iOS row carries: nothing is read.
  static func snapshot() -> PhoneSample {
    PhoneSample(locked: false, screenOn: true, appForeground: true)
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

/// While sensing: emits `thermal` when the thermal state changes, and hands the row tick the fixed
/// phone sample.
final class PhoneStateMonitor {
  private var lastThermal: String?
  private var thermalObserver: NSObjectProtocol?

  /// Main thread.
  func start() {
    dispatchPrecondition(condition: .onQueue(.main))
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
    lastThermal = nil
  }

  /// The row's phone sample (fixed).
  func poll() -> PhoneSample {
    PhoneState.snapshot()
  }

  private func thermalChanged() {
    guard thermalObserver != nil else { return }
    let level = PhoneState.thermalLevel()
    guard level != lastThermal else { return }
    lastThermal = level
    EventHub.shared.emit("thermal", ["level": level, "ts": TimeBase.nowTs()])
  }
}
