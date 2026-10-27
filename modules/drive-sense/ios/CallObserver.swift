// `call` events from CallKit's call observer (iOS only; README §3).
//
// `CXCallObserver` is passive — the system tells it about call changes; it polls nothing and
// needs no entitlement or permission. The alert layer uses `call` to hold spoken alerts during a
// phone call.
import CallKit
import Foundation

final class CallObserver: NSObject, CXCallObserverDelegate {
  private var observer: CXCallObserver?
  private var active = false

  /// Main thread. Starts observing; if a call is already in progress, says so once, because a
  /// capture that starts mid-call would otherwise not learn of it until the call ends.
  func start() {
    dispatchPrecondition(condition: .onQueue(.main))
    if observer == nil {
      let o = CXCallObserver()
      o.setDelegate(self, queue: .main)
      observer = o
    }
    active = anyCallActive()
    if active { emit(true) }
  }

  /// Main thread. A call still up says it is over: nothing tells JS once observing stops, and the
  /// next start says so only for a call in progress.
  func stop() {
    dispatchPrecondition(condition: .onQueue(.main))
    observer?.setDelegate(nil, queue: nil)
    observer = nil
    if active { emit(false) }
    active = false
  }

  func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
    let now = anyCallActive()
    guard now != active else { return }
    active = now
    emit(now)
  }

  private func anyCallActive() -> Bool {
    observer?.calls.contains { !$0.hasEnded } ?? false
  }

  /// Main thread, while capturing. The call state for the rows' bridge-only `call` key (README §1):
  /// `"live"` while a call is connected, `"ring"` while one rings or dials, nil with none.
  func state() -> String? {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let calls = observer?.calls else { return nil }
    if calls.contains(where: { $0.hasConnected && !$0.hasEnded }) { return "live" }
    if calls.contains(where: { !$0.hasEnded }) { return "ring" }
    return nil
  }

  /// A fresh read for `audioOutputState` (a DashPal alert with or without a drive open, so with or
  /// without an observer running). It emits nothing.
  static func anyCallActiveNow() -> Bool {
    CXCallObserver().calls.contains { !$0.hasEnded }
  }

  private func emit(_ isActive: Bool) {
    EventHub.shared.emit("call", ["active": isActive, "ts": TimeBase.nowTs()])
  }
}
