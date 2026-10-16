// The forgot-to-start reminder's JS face on iOS: the switch, the status Settings shows, and the one
// "Always" location request, made only from the driver's tap that turns the reminder on.
import CoreLocation
import CoreMotion
import Foundation

extension TripReminder {
  /// JS `setTripReminder`: on keeps the session; off forgets everything and stops the wake.
  func setEnabled(_ on: Bool, _ done: @escaping ([String: Any]) -> Void) {
    let s = TripReminderPolicy.setEnabled(TripReminderPolicy.settle(loadState() ?? ReminderState(), Self.nowMs(), captureOpen), on)
    saveState(s)
    if s.token.isEmpty { TripReminderNotifier.remove() }
    if !on { endLook("ended") }
    syncWake(s)
    status(done)
  }

  /// JS `getTripReminderStatus`: brought up to now (motion folded in), with what is missing.
  func status(_ done: @escaping ([String: Any]) -> Void) {
    refresh { stored in
      let s = stored ?? ReminderState()
      let always = self.slcManager.authorizationStatus == .authorizedAlways
      let precise = self.slcManager.accuracyAuthorization == .fullAccuracy
      let available = CMMotionActivityManager.isActivityAvailable() && CLLocationManager.significantLocationChangeMonitoringAvailable()
      TripReminderNotifier.authorized { notificationsOk in
        var missing: [String] = []
        if ActivitySource.status() != "granted" { missing.append("motion") }
        if !notificationsOk { missing.append("notifications") }
        if !always {
          missing.append("locationAlways")
        } else if !precise {
          missing.append("locationPrecise")
        }
        let state: String
        if !available {
          state = "unavailable"
        } else if !s.enabled {
          state = "off"
        } else if !missing.isEmpty {
          state = "needs"
        } else {
          state = "on"
        }
        done([
          "enabled": s.enabled,
          "state": state,
          "missing": state == "needs" ? missing : [String](),
        ])
      }
    }
  }

  /// JS `requestReminderLocation`: "Always" asked once, only with While Using already granted
  /// (never the provisional path). Resolves on the first of: a changed authorization; RoadWise
  /// active again (re-read 1 s later: "Keep Only While Using" changes nothing); no prompt at all
  /// within 1 s; 60 s.
  func requestAlways(_ done: @escaping (String) -> Void) {
    let current = slcManager.authorizationStatus
    if current == .authorizedAlways {
      done("always")
      return
    }
    if current != .authorizedWhenInUse || defaults.bool(forKey: Key.alwaysAsked) || alwaysPending != nil {
      done(answer(current))
      return
    }
    defaults.set(true, forKey: Key.alwaysAsked)
    alwaysBefore = current
    alwaysResigned = false
    alwaysPending = done
    slcManager.requestAlwaysAuthorization()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
      if !self.alwaysResigned { self.finishAlways() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { self.finishAlways() }
  }

  func finishAlways() {
    guard let done = alwaysPending else { return }
    alwaysPending = nil
    alwaysResigned = false
    done(answer(slcManager.authorizationStatus))
    if let s = loadState() { syncWake(s) }
  }

  private func answer(_ status: CLAuthorizationStatus) -> String {
    switch status {
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "whenInUse"
    default: return "denied"
    }
  }
}
