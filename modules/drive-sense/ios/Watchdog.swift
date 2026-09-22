// Two guards against native work nobody asked for (rev1: C2 and I3; README §6).
//
// `Watchdog`: only JS can decide a drive is over, so native must not keep sensing when JS is not
// there. A capture native started by itself (the relaunch restart) must be claimed by a JS
// `startCapture` within 60 s, and any capture with no JS `row` listener attached for 5 minutes
// is stopped. The liveness signal is the listener itself — no JS timer or heartbeat.
//
// `WakeTask`: every OS wake holds a background task so the JS bundle can boot and query the motion
// history before iOS suspends the process again; it ends when JS answers (`startCapture`, `arm`,
// `disarm`) or after 25 s, whichever comes first.
//
// Main thread only. Both run timers only while their condition holds, never while idle-armed.
import Foundation
import UIKit

final class Watchdog {
  static let CLAIM_TIMEOUT_S: Double = 60
  static let NO_LISTENER_TIMEOUT_S: Double = 300

  private var claimItem: DispatchWorkItem?
  private var listenerItem: DispatchWorkItem?
  /// Called on main when a guard fires; the controller stops the capture.
  var onExpire: (() -> Void)?

  /// A native-started capture is still waiting for its JS claim.
  var awaitingClaim: Bool { claimItem != nil }

  func captureStarted(nativeStarted: Bool, rowListening: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))
    cancelAll()
    if nativeStarted {
      claimItem = schedule(Self.CLAIM_TIMEOUT_S) { [weak self] in
        self?.claimItem = nil
        self?.onExpire?()
      }
    }
    if !rowListening { startListenerClock() }
  }

  /// A JS `startCapture` claimed the capture.
  func claimed() {
    dispatchPrecondition(condition: .onQueue(.main))
    claimItem?.cancel()
    claimItem = nil
  }

  /// The JS `row` listener attached or went away.
  func rowListening(_ listening: Bool, capturing: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))
    if listening || !capturing {
      listenerItem?.cancel()
      listenerItem = nil
    } else if listenerItem == nil {
      startListenerClock()
    }
  }

  func captureStopped() {
    dispatchPrecondition(condition: .onQueue(.main))
    cancelAll()
  }

  private func startListenerClock() {
    listenerItem = schedule(Self.NO_LISTENER_TIMEOUT_S) { [weak self] in
      self?.listenerItem = nil
      self?.onExpire?()
    }
  }

  private func cancelAll() {
    claimItem?.cancel()
    claimItem = nil
    listenerItem?.cancel()
    listenerItem = nil
  }

  private func schedule(_ seconds: Double, _ body: @escaping () -> Void) -> DispatchWorkItem {
    let item = DispatchWorkItem(block: body)
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    return item
  }
}

final class WakeTask {
  static let WAKE_TASK_S: Double = 25

  private var task: UIBackgroundTaskIdentifier = .invalid
  private var endItem: DispatchWorkItem?

  /// Begins (or extends to a fresh 25 s) the wake's background task.
  func begin() {
    dispatchPrecondition(condition: .onQueue(.main))
    if task == .invalid {
      task = UIApplication.shared.beginBackgroundTask(withName: "drivesense.wake") { [weak self] in
        self?.end()
      }
    }
    endItem?.cancel()
    let item = DispatchWorkItem { [weak self] in self?.end() }
    endItem = item
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.WAKE_TASK_S, execute: item)
  }

  func end() {
    dispatchPrecondition(condition: .onQueue(.main))
    endItem?.cancel()
    endItem = nil
    guard task != .invalid else { return }
    let t = task
    task = .invalid
    UIApplication.shared.endBackgroundTask(t)
  }
}
