// The optional forgot-to-start reminder on iOS (README "Forgot-to-start reminder"). Off by default.
// While it is on, with "Always" and precise location, a significant-location change wakes (or
// relaunches) the app; a motion check decides whether a car trip is under way; a bounded GPS
// session (at most 10 min, twice a trip) looks for the first real stop (under 3 mph for 12 s after
// 10 mph); one notification goes up; the session watches up to 5 min for the car moving on, and
// stops. `TripReminderPolicy` decides every step; this class reads the phone and acts.
//
// It only ever notifies. It never starts a capture and never touches `CaptureController.shared`:
// the capture pushes its start and end here (one direction only), and the notification only opens
// Home. Main thread only. The GPS session is in TripReminderSession.swift; the JS switch, the
// status and the "Always" request in TripReminderAccess.swift.
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
  /// The bounded GPS session. The capture's own location source is never touched.
  let sessionManager = CLLocationManager()
  /// Pushed by CaptureController; false in a fresh process, as no capture survives a relaunch.
  private(set) var captureOpen = false
  private var slcRunning = false
  private var slcStartedAt: Double = 0
  var tracker: SessionTracker?
  /// A motion or notification check is in flight for the session: fixes still move the tracker,
  /// but only the check acts.
  var checking = false
  private var waking = false
  var clock: DispatchSourceTimer?
  /// The "Always" request in flight (TripReminderAccess.swift).
  var alwaysPending: ((String) -> Void)?
  var alwaysBefore: CLAuthorizationStatus = .notDetermined
  var alwaysResigned = false

  private override init() {
    super.init()
    dispatchPrecondition(condition: .onQueue(.main))
    slcManager.delegate = self
    sessionManager.delegate = self
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
  /// there is nothing to keep either. Only `setEnabled` writes a first state. Unreadable data is off.
  func loadState() -> ReminderState? {
    guard let data = defaults.data(forKey: Key.state) else { return nil }
    if let s = try? JSONDecoder().decode(ReminderState.self, from: data), s.v == 2 { return s }
    return ReminderState()
  }

  func saveState(_ s: ReminderState) {
    if let data = try? JSONEncoder().encode(s) { defaults.set(data, forKey: Key.state) }
  }

  /// Wakes are possible: "Always", precise, and the hardware for significant-location changes.
  var wakeAllowed: Bool {
    slcManager.authorizationStatus == .authorizedAlways && slcManager.accuracyAuthorization == .fullAccuracy
      && CLLocationManager.significantLocationChangeMonitoringAvailable()
  }

  /// Significant-location changes run while the reminder is on and allowed (paused or quiet
  /// included, so a pause can end without RoadWise being opened); otherwise they stop, and with them
  /// the session and its watch, so a note still up comes down here (nothing else would take it down).
  func syncWake(_ s: ReminderState) {
    let want = s.enabled && wakeAllowed
    if want && !slcRunning {
      slcRunning = true
      slcStartedAt = Self.nowMs()
      slcManager.startMonitoringSignificantLocationChanges()
    } else if !want {
      slcRunning = false
      slcManager.stopMonitoringSignificantLocationChanges()
      endSession()
      TripReminderNotifier.remove()
      if let s0 = loadState(), s0.showing { saveState(TripReminderPolicy.appForeground(s0)) }
    }
  }

  func context(notificationsOk: Bool) -> ReminderCtx {
    var c = ReminderCtx()
    c.permissionsOk = notificationsOk && wakeAllowed && ActivitySource.status() == "granted"
    c.capturing = captureOpen
    c.appForeground = UIApplication.shared.applicationState == .active
    c.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    return c
  }

  // MARK: - Launch and the app's state

  /// didFinishLaunching (TripReminderAppDelegate): settle, take down a stale note, register the
  /// category, and restart the wake (an app relaunched for a location change must ask again).
  func resumeAtLaunch() {
    guard let s0 = loadState() else { return }
    let s = TripReminderPolicy.settle(s0, Self.nowMs())
    saveState(s)
    if !s.showing { TripReminderNotifier.remove() }
    if s.enabled { TripReminderNotifier.registerCategory() }
    syncWake(s)
  }

  @objc private func protectedDataAvailable() { resumeAtLaunch() }

  @objc private func appWillResignActive() {
    if alwaysPending != nil { alwaysResigned = true }
  }

  /// RoadWise is on screen: Home is visible, so the note and any session end.
  @objc private func appBecameActive() {
    if alwaysPending != nil && alwaysResigned {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.finishAlways() }
    }
    guard let s0 = loadState() else { return }
    let s = TripReminderPolicy.appForeground(TripReminderPolicy.settle(s0, Self.nowMs()))
    saveState(s)
    TripReminderNotifier.remove()
    endSession()
    syncWake(s)
  }

  // MARK: - The capture (pushed, never read)

  func onCaptureStarted() {
    captureOpen = true
    endSession()
    TripReminderNotifier.remove()
    guard let s0 = loadState() else { return }
    let now = Self.nowMs()
    saveState(TripReminderPolicy.captureStarted(TripReminderPolicy.settle(s0, now), now))
  }

  func onCaptureEnded() {
    captureOpen = false
    guard let s0 = loadState() else { return }
    let now = Self.nowMs()
    saveState(TripReminderPolicy.captureEnded(TripReminderPolicy.settle(s0, now), now))
  }

  /// The notification's "Not driving" (TripReminderAppDelegate): down, 12 h quiet, counted as unused.
  func onNotDriving() {
    TripReminderNotifier.remove()
    endSession()
    guard let s0 = loadState() else { return }
    let now = Self.nowMs()
    let s = TripReminderPolicy.resolve(TripReminderPolicy.settle(s0, now), .notDriving, now)
    saveState(s)
    syncWake(s)
  }

  // MARK: - The wake: significant-location change → motion check → GPS session

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    if manager === sessionManager {
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
    // A session without fixes ends on its clock.
  }

  private func onWake() {
    guard !waking, tracker == nil, let s0 = loadState() else { return }
    let now = Self.nowMs()
    let s = TripReminderPolicy.settle(s0, now)
    saveState(s)
    if !s.showing { TripReminderNotifier.remove() }
    // The back-off may just have turned it off: the wake stops with it.
    if s.enabled != s0.enabled { syncWake(s) }
    waking = true
    // The wake's checks finish inside a background task (the session, if any, then keeps the app
    // running through its own location updates). If iOS ends the task first, the next wake may run.
    let task = ReminderBackgroundTask()
    task.begin(onExpire: { self.waking = false })
    let finish = {
      self.waking = false
      task.end()
    }
    TripReminderNotifier.authorized { notificationsOk in
      let ctx = self.context(notificationsOk: notificationsOk)
      // The cheap checks first: no motion query and no GPS unless they pass.
      guard TripReminderPolicy.gate(s, ctx, now, .wake) == "ok" else {
        finish()
        return
      }
      let since = Date(timeIntervalSince1970: TripReminderPolicy.motionSince(s, now) / 1000)
      ActivitySource.recentAutomotive(since: since) { motion in
        if let s1 = self.loadState() {
          let r = TripReminderPolicy.onWake(s1, Self.nowMs(), motion, ctx)
          self.saveState(r.state)
          if r.state.enabled != s1.enabled { self.syncWake(r.state) }
          if r.startSession && self.tracker == nil { self.startSession() }
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
