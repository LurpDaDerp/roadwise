// The drive detector's wakes (plan §3.1.1; native-ios §4.1): one location manager for
// significant-location changes, the parked car's region ("roadwise.parked", 100 m, exit only, set
// at the last end's place and replaced, never accumulated) and visits. Each can relaunch a
// suspended or terminated RoadWise; none turns GPS on. Significant changes stay on during a drive
// too, so iOS relaunches the app after a kill and the drive resumes from its journal. Main thread.
import CoreLocation
import Foundation

final class WakeSources: NSObject, CLLocationManagerDelegate {
  static let regionId = "roadwise.parked"

  private let manager = CLLocationManager()
  private(set) var running = false
  private var startedAt: Double = 0
  /// A wake: "slc", "region" or "visit".
  var onWake: ((String) -> Void)?
  /// The authorisation changed.
  var onAuthorization: (() -> Void)?

  override init() {
    super.init()
    manager.delegate = self
    manager.showsBackgroundLocationIndicator = false
  }

  /// Significant changes and visits on (asked for again in every process: a relaunched app must).
  func start() {
    guard !running else { return }
    running = true
    startedAt = TimeBase.nowEpochMs()
    if CLLocationManager.significantLocationChangeMonitoringAvailable() {
      manager.startMonitoringSignificantLocationChanges()
    }
    manager.startMonitoringVisits()
  }

  /// Everything off, the parked region included (also what an earlier process left running).
  func stop() {
    running = false
    manager.stopMonitoringSignificantLocationChanges()
    manager.stopMonitoringVisits()
    setParked(nil)
  }

  /// The parked car's region at `place` (nil: none). Only "roadwise.parked" is ever touched.
  func setParked(_ place: (lat: Double, lng: Double)?) {
    for r in manager.monitoredRegions where r.identifier == Self.regionId {
      manager.stopMonitoring(for: r)
    }
    guard let p = place, CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
    let radius = min(DetectPolicy.PARKED_REGION_RADIUS_M, manager.maximumRegionMonitoringDistance)
    let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: p.lat, longitude: p.lng), radius: radius, identifier: Self.regionId)
    region.notifyOnEntry = false
    region.notifyOnExit = true
    manager.startMonitoring(for: region)
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    // Starting the monitor delivers the last known fix at once; an old one is not a wake.
    guard let l = locations.last, l.timestamp.timeIntervalSince1970 * 1000 >= startedAt - DetectPolicy.SLC_STALE_MS else { return }
    onWake?("slc")
  }

  func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
    guard region.identifier == Self.regionId else { return }
    onWake?("region")
  }

  func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
    // A departure from a place, reported soon after it happened (an arrival has no departure yet).
    guard visit.departureDate != Date.distantFuture,
          Date().timeIntervalSince(visit.departureDate) * 1000 <= DetectPolicy.VISIT_FRESH_MS else { return }
    onWake?("visit")
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    onAuthorization?()
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Significant changes resume on their own.
  }

  func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
    // A region that cannot be watched leaves significant changes and visits as the wakes.
  }
}
