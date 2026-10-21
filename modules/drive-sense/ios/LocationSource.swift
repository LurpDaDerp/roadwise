// Location: 1 Hz fixes while the detector senses or a plain capture runs, and nothing otherwise.
// Every mode keeps the distance filter unset (iOS 16.4+ suspends an app whose updates use one while
// significant-change monitoring runs) and never shows the blue background-location indicator (U3:
// the status-bar arrow is enough, and the Dynamic Island stays free for the Live Activity). The same
// manager answers the authorisation and precise-location questions. Created and used on main.
import CoreLocation
import Foundation

final class CaptureLocation: NSObject, CLLocationManagerDelegate {
  /// `full`: a candidate or a drive; `low`: a drive at the coarse rate (rev1: I5); `suppressed`: the
  /// "Not driving?" rest, ten-metre accuracy.
  enum Mode {
    case full
    case low
    case suppressed
  }

  private let manager = CLLocationManager()
  private(set) var running = false
  var onFix: ((FixSample) -> Void)?

  override init() {
    super.init()
    manager.delegate = self
    manager.activityType = .automotiveNavigation
    manager.pausesLocationUpdatesAutomatically = false
    manager.showsBackgroundLocationIndicator = false
  }

  /// README §2 `DriveSenseState.location`.
  var authorization: String {
    switch manager.authorizationStatus {
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "whenInUse"
    case .notDetermined, .denied, .restricted: return "none"
    @unknown default: return "none"
    }
  }

  var precise: Bool { manager.accuracyAuthorization == .fullAccuracy }

  /// `full`: navigation accuracy (Core Location fuses the motion sensors into the fix, so its speed
  /// follows the car more closely). `low`: coarse. `suppressed`: ten metres. Every fix in each.
  func configure(_ mode: Mode) {
    switch mode {
    case .full: manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
    case .low: manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    case .suppressed: manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }
    manager.distanceFilter = kCLDistanceFilterNone
  }

  func start(_ mode: Mode) {
    configure(mode)
    guard !running else { return }
    running = true
    // Keeps sensing in the background: with Always for a drive that started on its own, with While
    // Using for one started from the app in front.
    manager.allowsBackgroundLocationUpdates = true
    manager.pausesLocationUpdatesAutomatically = false
    manager.showsBackgroundLocationIndicator = false
    manager.startUpdatingLocation()
  }

  func stop() {
    guard running else { return }
    running = false
    manager.stopUpdatingLocation()
    manager.allowsBackgroundLocationUpdates = false
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard running else { return }
    for l in locations {
      // `CLLocation.timestamp` is a Date already: used directly (README §7 "Time base").
      // Unknowns stay negative here; the extractor maps them (−1, or hAcc 9999).
      onFix?(FixSample(
        t: l.timestamp.timeIntervalSince1970 * 1000,
        lat: l.coordinate.latitude,
        lng: l.coordinate.longitude,
        hAcc: l.horizontalAccuracy,
        speed: l.speed,
        speedAcc: l.speedAccuracy,
        course: l.course,
        alt: l.altitude,
        mock: Self.isSimulated(l)
      ))
    }
  }

  /// Mock-location detection (spec "Integrity · GPS spoofing"): iOS 15+ reports a simulated fix.
  static func isSimulated(_ l: CLLocation) -> Bool {
    if #available(iOS 15.0, *) {
      return l.sourceInformation?.isSimulatedBySoftware ?? false
    }
    return false
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Silence while moving (SR9): rows carry the no-fix encoding until fixes return.
  }
}
