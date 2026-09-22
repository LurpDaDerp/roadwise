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

  func stop() {
    dispatchPrecondition(condition: .onQueue(.main))
    observer?.setDelegate(nil, queue: nil)
    observer = nil
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

  private func emit(_ isActive: Bool) {
    EventHub.shared.emit("call", ["active": isActive, "ts": TimeBase.nowTs()])
  }
}
