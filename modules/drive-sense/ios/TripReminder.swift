// The optional forgot-to-start reminder on iOS (README "Forgot-to-start reminder"). Off by default.
// While it is on, with "Always" and precise location, a significant-location change wakes (or
// relaunches) the app; the last 3 h of motion history says whether the car is driving (car motion,
// not a car standing still); a bounded GPS look (at most 10 min, ending after 3 min without 10 mph)
// looks for a stop (under 3 mph for 12 s after 10 mph); one note goes up for the session.
// `TripReminderPolicy` decides every step; this class reads the phone and acts.
//
// It never starts a capture and never touches `CaptureController.shared`: the capture pushes its
// start and end here (one direction only). The note carries a one-use token; a tap reaches JS
// through expo-notifications, and JS asks `claim` before it starts the drive itself. Main thread
// only, and every async continuation reloads the stored state before it saves. The GPS look is in
// TripReminderLook.swift; the JS switch, the status and the "Always" request in
// TripReminderAccess.swift.
import CoreLocation
import Foundation
import UIKit

final class TripReminder: NSObject, CLLocationManagerDelegate {
  static let shared = TripReminder()

  enum Key {
    static let state = "drivesense.tripReminder"
    static let alwaysAsked = "drivesense.tripReminder.alwaysAsked"
  }

  let defaults = UserDefaults.standard
  /// Significant-location changes: the wake. Also the manager the "Always" request goes through.
  let slcManager = CLLocationManager()
  /// The bounded GPS look. The capture's own location source is never touched.
  let lookManager = CLLocationManager()
  /// Pushed by CaptureController; false in a fresh process, as no capture survives a relaunch.
  private(set) var captureOpen = false
  private var slcRunning = false
  private var slcStartedAt: Double = 0
  var look: LookTracker?
  /// A walking or notification check is in flight for the look: fixes still move the tracker,
  /// but only the check acts.
  var checking = false
  private var waking = false
  /// Counts wakes, so a wake that iOS expired and that finishes late never clears a newer wake's flag.
  private var wakeId = 0
  var clock: DispatchSourceTimer?
  /// The "Always" request in flight (TripReminderAccess.swift).
  var alwaysPending: ((String) -> Void)?
  var alwaysBefore: CLAuthorizationStatus = .notDetermined
  var alwaysResigned = false

  private override init() {
    super.init()
    dispatchPrecondition(condition: .onQueue(.main))
    slcManager.delegate = self
    lookManager.delegate = self
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(appBecameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(appWillResignActive), name: UIApplication.willResignActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(protectedDataAvailable), name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
  }

  static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

  // MARK: - State

  /// The stored state, or nil when nothing is stored: then nothing is decided and nothing is saved.
  /// Before the first unlock after a reboot (or in a process iOS started then) a stored state can
  /// read as missing, so a missing read is never saved back as the default; the default is off, so
  /// there is nothing to keep either. Only `setEnabled` writes a first state. Unreadable data is off;
  /// a stored v2 keeps only its switch.
  func loadState() -> ReminderState? {
    guard let data = defaults.data(forKey: Key.state) else { return nil }
    return TripReminderPolicy.fromStored(data)
  }

  func saveState(_ s: ReminderState) {
    if let data = try? JSONEncoder().encode(s) { defaults.set(data, forKey: Key.state) }
  }

  /// Wakes are possible: "Always", precise, and the hardware for significant-location changes.
  var wakeAllowed: Bool {
    slcManager.authorizationStatus == .authorizedAlways && slcManager.accuracyAuthorization == .fullAccuracy
      && CLLocationManager.significantLocationChangeMonitoringAvailable()
  }

  /// Significant-location changes run while the reminder is on and allowed; otherwise they stop,
  /// and with them the look, and a note still up comes down here (its token goes).
  func syncWake(_ s: ReminderState) {
    let want = s.enabled && wakeAllowed
    if want && !slcRunning {
      slcRunning = true
      slcStartedAt = Self.nowMs()
      slcManager.startMonitoringSignificantLocationChanges()
    } else if !want {
      slcRunning = false
      slcManager.stopMonitoringSignificantLocationChanges()
      endLook("ended")
      TripReminderNotifier.remove()
      if let s0 = loadState(), !s0.token.isEmpty { saveState(TripReminderPolicy.noteGone(s0)) }
    }
  }

  func context(notificationsOk: Bool) -> ReminderCtx {
    var c = ReminderCtx()
    c.permissionsOk = notificationsOk && wakeAllowed && ActivitySource.status() == "granted"
    c.capturing = captureOpen
    return c
  }

  /// The last 3 h of motion history, read only while the stored reminder is on. Off (also the state
  /// a sign-out leaves) nothing is queried and `done` gets an empty summary at once: off has no
  /// session, and the folds act only on a session, so it changes nothing. Answers on main.
  func motionWhileOn(_ done: @escaping (MotionSummary) -> Void) {
    guard loadState()?.enabled == true else {
      done(MotionSummary(lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false))
      return
    }
    ActivitySource.recentAutomotive(done)
  }

  /// Brings the stored state up to now: the motion history (empty without Motion & Fitness, or with
  /// the reminder off) folded in, then the time rule. A note whose session ended comes down. `done`
  /// gets the saved state (nil when nothing is stored).
  func refresh(_ done: @escaping (ReminderState?) -> Void = { _ in }) {
    guard loadState() != nil else {
      done(nil)
      return
    }
    motionWhileOn { motion in
      guard let s0 = self.loadState() else {
        done(nil)
        return
      }
      let now = Self.nowMs()
      let s = TripReminderPolicy.foldMotion(TripReminderPolicy.clampTimes(s0, now), now, motion, self.captureOpen)
      self.saveState(s)
      if s.token.isEmpty { TripReminderNotifier.remove() }
      done(s)
    }
  }

  /// JS `claimReminderTap`: the tap on the note JS got from expo-notifications. True once, for the
  /// note's token, while its session lasts (motion folded in first) and no drive is open. The note
  /// comes down whatever the answer, if its token is spent or gone.
  func claim(_ token: String, _ done: @escaping (Bool) -> Void) {
    refresh { _ in
      guard let s0 = self.loadState() else {
        done(false)
        return
      }
      let r = TripReminderPolicy.claim(s0, token, Self.nowMs(), self.captureOpen, false)
      self.saveState(r.state)
      if r.state.token.isEmpty { TripReminderNotifier.remove() }
      done(r.ok)
    }
  }

  // MARK: - Launch and the app's state

  /// didFinishLaunching (TripReminderAppDelegate): restart the wake (an app relaunched for a
  /// location change must ask again), then bring the state up to now.
  func resumeAtLaunch() {
    guard let s0 = loadState() else { return }
    syncWake(s0)
    refresh()
  }

  @objc private func protectedDataAvailable() { resumeAtLaunch() }

  @objc private func appWillResignActive() {
    if alwaysPending != nil { alwaysResigned = true }
  }

  /// RoadWise is on screen: the state is brought up to now. A live note and a running look stay
  /// (pulling the notification shade over RoadWise is not a reason to lose the session's reminder).
  @objc private func appBecameActive() {
    if alwaysPending != nil && alwaysResigned {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.finishAlways() }
    }
    refresh { s in
      if let s = s { self.syncWake(s) }
    }
  }

  // MARK: - The capture (pushed, never read)

  /// A drive started (any way): the look ends, the note goes. The motion history is folded in at the
  /// drive's start first, so a session whose last wake came well before the car parked is judged on
  /// the car's real last motion, not on a stale clock.
  func onCaptureStarted() {
    captureOpen = true
    endLook("ended")
    TripReminderNotifier.remove()
    let at = Self.nowMs()
    guard loadState() != nil else { return }
    motionWhileOn { motion in
      guard let s0 = self.loadState() else { return }
      let folded = TripReminderPolicy.foldMotion(TripReminderPolicy.clampTimes(s0, at), at, motion, false)
      self.saveState(TripReminderPolicy.captureStarted(folded, at))
    }
  }

  /// A drive ended: its end is the session's last driving moment. (The motion reads are answered in
  /// order on one queue, so this lands after the start's. With the reminder off nothing is read and
  /// both steps run at once on a state with no session, so their order changes nothing.)
  func onCaptureEnded() {
    captureOpen = false
    let at = Self.nowMs()
    guard loadState() != nil else { return }
    motionWhileOn { motion in
      guard let s0 = self.loadState() else { return }
      let folded = TripReminderPolicy.foldMotion(TripReminderPolicy.clampTimes(s0, at), at, motion, true)
      self.saveState(TripReminderPolicy.captureEnded(folded, at, at))
    }
  }

  // MARK: - The wake: significant-location change → motion history → GPS look

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    if manager === lookManager {
      for l in locations { onFix(l) }
      return
    }
    // Starting the monitor delivers the last known fix at once; an old one is not a wake.
    guard let l = locations.last,
          l.timestamp.timeIntervalSince1970 * 1000 >= slcStartedAt - TripReminderPolicy.AUTOMOTIVE_FRESH_MS else { return }
    onWake()
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard manager === slcManager else { return }
    if alwaysPending != nil && manager.authorizationStatus != alwaysBefore {
      finishAlways()
      return
    }
    if let s = loadState() { syncWake(s) }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // A look without fixes ends on its clock.
  }

  private func onWake() {
    guard !waking, look == nil, loadState() != nil else { return }
    wakeId &+= 1
    let thisWake = wakeId
    waking = true
    // The wake's checks finish inside a background task (the look, if any, then keeps the app
    // running through its own location updates). If iOS ends the task first, the next wake may run;
    // only the latest wake clears the flag.
    let task = ReminderBackgroundTask()
    task.begin(onExpire: { if self.wakeId == thisWake { self.waking = false } })
    let finish = {
      if self.wakeId == thisWake { self.waking = false }
      task.end()
    }
    TripReminderNotifier.authorized { notificationsOk in
      guard let s1 = self.loadState() else {
        finish()
        return
      }
      let ctx = self.context(notificationsOk: notificationsOk)
      // The cheap checks first: no motion query and no GPS unless they pass.
      guard TripReminderPolicy.gate(s1, ctx, Self.nowMs(), .wake) == "ok" else {
        let s = TripReminderPolicy.settle(s1, Self.nowMs(), ctx.capturing)
        self.saveState(s)
        if s.token.isEmpty { TripReminderNotifier.remove() }
        finish()
        return
      }
      ActivitySource.recentAutomotive { motion in
        if let s2 = self.loadState() {
          let r = TripReminderPolicy.onWake(s2, Self.nowMs(), motion, self.context(notificationsOk: notificationsOk))
          self.saveState(r.state)
          if r.dropped { TripReminderNotifier.remove() }
          if r.startLook && self.look == nil { self.startLook() }
        }
        finish()
      }
    }
  }
}

/// One background task for a wake's checks, ended once (by the wake or by iOS's expiry, which also
/// runs `onExpire`).
final class ReminderBackgroundTask {
  private var id: UIBackgroundTaskIdentifier = .invalid

  func begin(onExpire: @escaping () -> Void) {
    id = UIApplication.shared.beginBackgroundTask(withName: "drivesense.tripReminder") { [weak self] in
      onExpire()
      self?.end()
    }
  }

  func end() {
    guard id != .invalid else { return }
    UIApplication.shared.endBackgroundTask(id)
    id = .invalid
  }
}
