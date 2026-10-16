// The lock probe (README §5): whether this iPhone reports a lock in time for screen switches.
//
// iOS has no public lock signal. The rows' `locked` comes from protected data going away, which
// with a passcode required "Immediately" (forced by Face ID and Touch ID unlock) happens about 10 s
// after the side-button press. RoadWise counts an iPhone's screen switches only once the phone has
// shown such a report within 15 s of RoadWise leaving the screen (the "lock proof"): measured here
// from `didEnterBackground` to `protectedDataWillBecomeUnavailable`, persisted, and also written by
// JS after a proof inside a drive (`markLockProof`).
//
// Outside a drive the app may be suspended before the report comes, so on a passcode phone that is
// not proven yet each departure begins one finite background task, ended by the report, by a return
// to the front or after 16 s, at most 20 times per install. During a capture the drive keeps
// RoadWise running in the background (`CaptureController` says so through `captureRunning`), so a
// departure then is still measured but begins no task and uses none of the 20. Without a passcode
// nothing runs and the proof is cleared (`passcodeGone`, from `getState`). Main thread only; no
// app-delegate hook.
import Foundation
import UIKit

final class LockProbe {
  static let shared = LockProbe()

  /// A lock reported within this long of RoadWise leaving the screen proves the phone.
  static let LOCK_PROOF_MAX_MS = 15_000.0
  /// Background tasks begun per install before the probe relies on in-drive proof alone.
  static let PROBE_MAX_TRIES = 20
  /// The longest one background task waits for the report, seconds.
  static let PROBE_TASK_S = 16.0

  private enum Key {
    static let proof = "drivesense.lockProof"
    static let delay = "drivesense.lockDelayMs"
    static let tries = "drivesense.lockProbeTries"
  }

  private let defaults = UserDefaults.standard
  private var observers: [NSObjectProtocol] = []
  /// When RoadWise last left the screen (epoch ms); cleared by a return or a measured report.
  private var leftAt: Double?
  private var task: UIBackgroundTaskIdentifier = .invalid
  private var endWork: DispatchWorkItem?
  /// A capture is running: RoadWise stays alive in the background, so no task is needed.
  private var capturing = false

  private init() {}

  /// Idempotent; hops to main itself. Called from the module's `OnCreate`.
  func start() {
    DispatchQueue.main.async {
      guard self.observers.isEmpty else { return }
      let center = NotificationCenter.default
      self.observers = [
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
          self?.left()
        },
        center.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main) { [weak self] _ in
          self?.locked()
        },
        center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
          self?.back()
        },
      ]
    }
  }

  /// The phone has proven it reports a lock in time.
  var proven: Bool { defaults.bool(forKey: Key.proof) }

  /// The delay measured with the proof (ms), or nil before any.
  var lockDelayMs: Int64? { (defaults.object(forKey: Key.delay) as? NSNumber)?.int64Value }

  /// JS `markLockProof`: a lock reported within 15 s of RoadWise leaving, seen inside a drive.
  func mark(delayMs: Double) {
    dispatchPrecondition(condition: .onQueue(.main))
    record(delayMs)
  }

  /// `CaptureController`, as a capture starts (true) and stops (false).
  func captureRunning(_ running: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))
    capturing = running
  }

  /// No passcode now: the proof, the delay and the try counter go, so a passcode set later starts afresh.
  func passcodeGone() {
    dispatchPrecondition(condition: .onQueue(.main))
    defaults.removeObject(forKey: Key.proof)
    defaults.removeObject(forKey: Key.delay)
    defaults.removeObject(forKey: Key.tries)
  }

  private func left() {
    leftAt = TimeBase.nowEpochMs()
    guard !capturing, !proven, PhoneState.lockSignal() == "lagged", task == .invalid else { return }
    let tries = defaults.integer(forKey: Key.tries)
    guard tries < Self.PROBE_MAX_TRIES else { return }
    defaults.set(tries + 1, forKey: Key.tries)
    task = UIApplication.shared.beginBackgroundTask(withName: "drivesense.lockProbe") { [weak self] in
      self?.endTask()
    }
    let work = DispatchWorkItem { [weak self] in self?.endTask() }
    endWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.PROBE_TASK_S, execute: work)
  }

  private func locked() {
    if let at = leftAt {
      record(TimeBase.nowEpochMs() - at)
      leftAt = nil
    }
    endTask()
  }

  private func back() {
    leftAt = nil
    endTask()
  }

  /// A delay of 15 s or less proves the phone; a longer one proves nothing and is not kept.
  private func record(_ delayMs: Double) {
    guard delayMs.isFinite, delayMs >= 0, delayMs <= Self.LOCK_PROOF_MAX_MS else { return }
    defaults.set(true, forKey: Key.proof)
    defaults.set(NSNumber(value: Int64(jsRound(delayMs))), forKey: Key.delay)
  }

  private func endTask() {
    endWork?.cancel()
    endWork = nil
    if task != .invalid {
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
  }
}
