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

  /// Deadlines are kept on CLOCK_MONOTONIC, which on Darwin keeps counting while the device sleeps
  /// and ignores wall-clock changes (review N2N3 M1: `asyncAfter(deadline:)` runs on mach absolute
  /// time, which stops in sleep, so at `low` rate while parked the 5-minute guard could stretch
  /// indefinitely). The timer that wakes us is on the wall clock (`asyncAfter(wallDeadline:)`, which
  /// also advances in sleep); every row and fix calls `check()` too, as Android does.
  private enum Kind { case claim, listener }
  private var claimDeadline: UInt64?
  private var listenerDeadline: UInt64?
  private var generation = 0
  /// Called on main when a guard fires; the controller stops the capture.
  var onExpire: (() -> Void)?

  /// A native-started capture is still waiting for its JS claim.
  var awaitingClaim: Bool { claimDeadline != nil }

  static func nowNs() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) }

  func captureStarted(nativeStarted: Bool, rowListening: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))
    cancelAll()
    if nativeStarted { arm(.claim, Self.CLAIM_TIMEOUT_S) }
    if !rowListening { arm(.listener, Self.NO_LISTENER_TIMEOUT_S) }
  }

  /// A JS `startCapture` claimed the capture.
  func claimed() {
    dispatchPrecondition(condition: .onQueue(.main))
    claimDeadline = nil
  }

  /// The JS `row` listener attached or went away.
  func rowListening(_ listening: Bool, capturing: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))
    if listening || !capturing {
      listenerDeadline = nil
    } else if listenerDeadline == nil {
      arm(.listener, Self.NO_LISTENER_TIMEOUT_S)
    }
  }

  func captureStopped() {
    dispatchPrecondition(condition: .onQueue(.main))
    cancelAll()
  }

  /// Main thread. Fires any guard whose deadline has passed (called on each row and fix, and by
  /// the guards' own timers).
  func check() {
    dispatchPrecondition(condition: .onQueue(.main))
    let now = Self.nowNs()
    var expired = false
    if let d = claimDeadline, now >= d {
      claimDeadline = nil
      expired = true
    }
    if let d = listenerDeadline, now >= d {
      listenerDeadline = nil
      expired = true
    }
    if expired { onExpire?() }
  }

  private func arm(_ kind: Kind, _ seconds: Double) {
    let deadline = Self.nowNs() + UInt64(seconds * 1_000_000_000)
    switch kind {
    case .claim: claimDeadline = deadline
    case .listener: listenerDeadline = deadline
    }
    schedule(kind, seconds, generation: generation)
  }

  /// A wall-clock timer that re-checks, and re-arms itself if a wall-clock change fired it early.
  private func schedule(_ kind: Kind, _ seconds: Double, generation gen: Int) {
    DispatchQueue.main.asyncAfter(wallDeadline: .now() + Swift.max(seconds, 0.05)) { [weak self] in
      guard let self = self, gen == self.generation else { return }
      self.check()
      let pending = kind == .claim ? self.claimDeadline : self.listenerDeadline
      if let d = pending {
        let now = Self.nowNs()
        self.schedule(kind, d > now ? Double(d - now) / 1_000_000_000 : 0, generation: gen)
      }
    }
  }

  private func cancelAll() {
    generation += 1
    claimDeadline = nil
    listenerDeadline = nil
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
