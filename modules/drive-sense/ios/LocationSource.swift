// Location: 1 Hz fixes while capturing, and nothing otherwise (plan §1 decision 4). Standard
// updates (GPS) run only between `startCapture` and `stopCapture`; the same manager answers the
// authorisation question. Created and used on the main thread.
import CoreLocation
import Foundation

final class CaptureLocation: NSObject, CLLocationManagerDelegate {
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

  /// README §2 `DriveSenseState.location`. The app asks only for While Using; `always` appears
  /// only when the user upgraded it in Settings themselves.
  var authorization: String {
    switch manager.authorizationStatus {
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "whenInUse"
    case .notDetermined, .denied, .restricted: return "none"
    @unknown default: return "none"
    }
  }

  /// `full`: navigation accuracy (Core Location fuses the motion sensors into the fix, so its
  /// speed follows the car more closely), every fix (distance filter unset). `low` (rev1: I5):
  /// coarse, 50 m.
  func configure(low: Bool) {
    if low {
      manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
      manager.distanceFilter = 50
    } else {
      manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
      manager.distanceFilter = kCLDistanceFilterNone
    }
  }

  func start(low: Bool) {
    configure(low: low)
    guard !running else { return }
    running = true
    // Keeps a capture started in the foreground running in the background on While Using.
    manager.allowsBackgroundLocationUpdates = true
    manager.pausesLocationUpdatesAutomatically = false
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
