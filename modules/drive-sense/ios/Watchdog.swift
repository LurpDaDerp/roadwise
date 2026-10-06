// A guard against native work nobody records (rev1: C2; README §6).
//
// Only JS can decide a drive is over, so native must not keep sensing when JS is not there: any
// capture with no JS `row` listener attached for 5 minutes is stopped. The liveness signal is the
// listener itself — no JS timer or heartbeat. (v3: iOS never starts a capture on its own, so the
// 60 s claim guard of earlier builds is gone with the relaunch path.)
//
// Main thread only. Runs a timer only while capturing.
import Foundation

final class Watchdog {
  static let NO_LISTENER_TIMEOUT_S: Double = 300

  /// Deadlines are kept on CLOCK_MONOTONIC, which on Darwin keeps counting while the device sleeps
  /// and ignores wall-clock changes (review N2N3 M1: `asyncAfter(deadline:)` runs on mach absolute
  /// time, which stops in sleep, so at `low` rate while parked the 5-minute guard could stretch
  /// indefinitely). The timer that wakes us is on the wall clock (`asyncAfter(wallDeadline:)`, which
  /// also advances in sleep); every row and fix calls `check()` too, as Android does.
  private var listenerDeadline: UInt64?
  private var generation = 0
  /// Called on main when the guard fires; the controller stops the capture.
  var onExpire: (() -> Void)?

  static func nowNs() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) }

  func captureStarted(rowListening: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))
    cancel()
    if !rowListening { beginDeadline(Self.NO_LISTENER_TIMEOUT_S) }
  }

  /// The JS `row` listener attached or went away.
  func rowListening(_ listening: Bool, capturing: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))
    if listening || !capturing {
      listenerDeadline = nil
    } else if listenerDeadline == nil {
      beginDeadline(Self.NO_LISTENER_TIMEOUT_S)
    }
  }

  func captureStopped() {
    dispatchPrecondition(condition: .onQueue(.main))
    cancel()
  }

  /// Main thread. Fires the guard if its deadline has passed (called on each row and fix, and by
  /// the guard's own timer).
  func check() {
    dispatchPrecondition(condition: .onQueue(.main))
    if let d = listenerDeadline, Self.nowNs() >= d {
      listenerDeadline = nil
      onExpire?()
    }
  }

  private func beginDeadline(_ seconds: Double) {
    listenerDeadline = Self.nowNs() + UInt64(seconds * 1_000_000_000)
    schedule(seconds, generation: generation)
  }

  /// A wall-clock timer that re-checks, and re-arms itself if a wall-clock change fired it early.
  private func schedule(_ seconds: Double, generation gen: Int) {
    DispatchQueue.main.asyncAfter(wallDeadline: .now() + Swift.max(seconds, 0.05)) { [weak self] in
      guard let self = self, gen == self.generation else { return }
      self.check()
      if let d = self.listenerDeadline {
        let now = Self.nowNs()
        self.schedule(d > now ? Double(d - now) / 1_000_000_000 : 0, generation: gen)
      }
    }
  }

  private func cancel() {
    generation += 1
    listenerDeadline = nil
  }
}
