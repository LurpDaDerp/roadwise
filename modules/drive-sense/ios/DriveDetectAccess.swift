// The drive detector's permissions (plan §3.1.4): what is allowed now, and the one "Always" request.
// Drives start on their own only with Location Always, Precise Location and Motion & Fitness; the
// Start card needs While Using and Precise. Background App Refresh and Live Activities are reported,
// never required. "Always" is asked once per install, only from While Using; afterwards the answer is
// the current one and JS offers Settings.
import ActivityKit
import CoreLocation
import CoreMotion
import Foundation
import UIKit

/// The permissions now (`DetectState.permissions`, plus whether the phone can detect at all).
struct DetectPermissions {
  /// "none" | "whenInUse" | "always"
  var location: String
  var precise: Bool
  var motion: String
  /// "available" | "denied" | "restricted"
  var backgroundRefresh: String
  var liveActivities: Bool
  var canAskAlways: Bool
  /// Significant-location changes and motion activity exist on this phone.
  var hardware: Bool

  func inputs(armed: Bool) -> StatusInputs {
    StatusInputs(armed: armed, hardware: hardware, location: location, precise: precise, motion: motion, backgroundRefresh: backgroundRefresh, liveActivities: liveActivities)
  }

  var requiredOk: Bool { DetectPolicy.statusOf(inputs(armed: true)).requiredOk }

  var json: [String: Any] {
    ["location": location, "precise": precise, "motion": motion, "backgroundRefresh": backgroundRefresh, "liveActivities": liveActivities, "canAskAlways": canAskAlways]
  }
}

final class DriveDetectAccess: NSObject, CLLocationManagerDelegate {
  static let shared = DriveDetectAccess()

  private static let alwaysAskedKey = "drivesense.detect.alwaysAsked"
  private let defaults = UserDefaults.standard
  /// Answers the authorisation and accuracy questions, and makes the "Always" request.
  private let manager = CLLocationManager()
  private var pending: ((String) -> Void)?
  private var before: CLAuthorizationStatus = .notDetermined
  private var resigned = false
  /// The authorisation changed (on main): the detector re-checks its arming.
  var onChange: (() -> Void)?

  private override init() {
    super.init()
    manager.delegate = self
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  /// Main thread (UIApplication).
  func snapshot() -> DetectPermissions {
    let status = manager.authorizationStatus
    let location = status == .authorizedAlways ? "always" : status == .authorizedWhenInUse ? "whenInUse" : "none"
    let refresh: String
    switch UIApplication.shared.backgroundRefreshStatus {
    case .available: refresh = "available"
    case .restricted: refresh = "restricted"
    case .denied: refresh = "denied"
    @unknown default: refresh = "denied"
    }
    return DetectPermissions(
      location: location,
      precise: manager.accuracyAuthorization == .fullAccuracy,
      motion: ActivitySource.status(),
      backgroundRefresh: refresh,
      liveActivities: ActivityAuthorizationInfo().areActivitiesEnabled,
      canAskAlways: location == "whenInUse" && !defaults.bool(forKey: Self.alwaysAskedKey) && pending == nil,
      hardware: CLLocationManager.significantLocationChangeMonitoringAvailable() && CMMotionActivityManager.isActivityAvailable()
    )
  }

  /// `requestAlways`: asked once, only from While Using (never the provisional path). Resolves on the
  /// first of: a changed authorisation; RoadWise active again (re-read 1 s later: "Keep Only While
  /// Using" changes nothing); no prompt at all within 1 s; 60 s.
  func requestAlways(_ done: @escaping (String) -> Void) {
    let current = manager.authorizationStatus
    if current == .authorizedAlways {
      done("always")
      return
    }
    if current != .authorizedWhenInUse || defaults.bool(forKey: Self.alwaysAskedKey) || pending != nil {
      done(Self.answer(current))
      return
    }
    defaults.set(true, forKey: Self.alwaysAskedKey)
    before = current
    resigned = false
    pending = done
    manager.requestAlwaysAuthorization()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
      if !self.resigned { self.finish() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { self.finish() }
  }

  private func finish() {
    guard let done = pending else { return }
    pending = nil
    resigned = false
    done(Self.answer(manager.authorizationStatus))
  }

  private static func answer(_ status: CLAuthorizationStatus) -> String {
    switch status {
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "whenInUse"
    default: return "denied"
    }
  }

  @objc private func willResignActive() {
    if pending != nil { resigned = true }
  }

  @objc private func didBecomeActive() {
    if pending != nil && resigned {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.finish() }
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if pending != nil && manager.authorizationStatus != before { finish() }
    onChange?()
  }
}
