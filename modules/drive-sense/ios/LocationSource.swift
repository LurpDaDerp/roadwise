// Location: OS-delivered wakes while armed (`WakeLocation`) and 1 Hz fixes while capturing
// (`CaptureLocation`). Two managers so the capture's configuration never touches arming.
//
// Battery (design §3.5): arming runs no GPS. Significant-change monitoring and one 150 m exit
// region are cell/Wi-Fi based and relaunch the app when it has been terminated. The region is
// re-centred on every wake's own location (rev1: I4), so a moving car produces a chain of cheap
// wakes — each re-querying the motion history in JS — rather than one wake that may come too early
// for the history to say "automotive". Standard updates (GPS) run only between `startCapture` and
// `stopCapture`. Every location manager is created and used on the main thread.
import CoreLocation
import Foundation

final class WakeLocation: NSObject, CLLocationManagerDelegate {
  static let EXIT_REGION_RADIUS_M: Double = 150
  /// A cached location older than this is not used to centre the region on `arm()`.
  static let ARM_LOCATION_MAX_AGE_S: Double = 900
  static let REGION_ID = "drivesense.exit"

  let manager = CLLocationManager()
  /// (reason, the wake's own location if it has one)
  var onWake: ((_ reason: String, _ location: CLLocation?) -> Void)?
  var onAuthorizationChange: (() -> Void)?
  private var centredOn: Date?

  override init() {
    super.init()
    manager.delegate = self
  }

  var authorization: String {
    switch manager.authorizationStatus {
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "whenInUse"
    case .notDetermined, .denied, .restricted: return "none"
    @unknown default: return "none"
    }
  }

  func startWakes() {
    manager.startMonitoringSignificantLocationChanges()
    if let cached = manager.location, -cached.timestamp.timeIntervalSinceNow <= Self.ARM_LOCATION_MAX_AGE_S {
      recentre(on: cached)
    }
  }

  func stopWakes() {
    manager.stopMonitoringSignificantLocationChanges()
    for region in manager.monitoredRegions where region.identifier == Self.REGION_ID {
      manager.stopMonitoring(for: region)
    }
    centredOn = nil
  }

  /// One exit region around `location`; replaces the previous one (same identifier).
  func recentre(on location: CLLocation) {
    guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
    let radius = min(Self.EXIT_REGION_RADIUS_M, manager.maximumRegionMonitoringDistance)
    let region = CLCircularRegion(center: location.coordinate, radius: radius, identifier: Self.REGION_ID)
    region.notifyOnEntry = false
    region.notifyOnExit = true
    manager.startMonitoring(for: region)
    centredOn = location.timestamp
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    onWake?("significantChange", locations.last)
  }

  func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
    guard region.identifier == Self.REGION_ID else { return }
    // The callback carries no location. The manager's own is the one region monitoring just used
    // when it is newer than the current centre; otherwise the region is left as it is and the
    // next significant-change wake re-centres it (no GPS is started to find out).
    var own: CLLocation?
    if let l = manager.location, centredOn == nil || l.timestamp > centredOn! { own = l }
    onWake?("geofence", own)
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    onAuthorizationChange?()
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Silence while moving (SR9): nothing to report; the next wake arrives regardless.
  }

  func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
    // Significant-change monitoring still wakes the app without the region.
  }
}

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

  /// `full`: best accuracy, every fix (distance filter unset). `low` (rev1: I5): coarse, 50 m.
  func configure(low: Bool) {
    if low {
      manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
      manager.distanceFilter = 50
    } else {
      manager.desiredAccuracy = kCLLocationAccuracyBest
      manager.distanceFilter = kCLDistanceFilterNone
    }
  }

  func start(low: Bool) {
    configure(low: low)
    guard !running else { return }
    running = true
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
        alt: l.altitude
      ))
    }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Silence while moving (SR9): rows carry the no-fix encoding until fixes return.
  }
}
