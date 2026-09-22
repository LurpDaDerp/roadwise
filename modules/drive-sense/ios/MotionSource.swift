// 25 Hz device motion while capturing at `full` rate (README §7 "Frames").
//
// `.xArbitraryZVertical` only: the vehicle frame is learned from gravity and GNSS Δv, so no
// magnetometer or compass is ever used (a magnetic phone mount would bend it). CoreMotion's
// `gravity` and `userAcceleration` are already in the reference's convention (g, gravity toward
// the earth, a = g + ua), and `rotationRate` is rad/s, counter-clockwise positive. Samples stay
// native: they are handed to the capture's work queue and reduced per second, never sent to JS.
import CoreMotion
import Foundation

final class MotionSource {
  /// Apple recommends a single `CMMotionManager` per app.
  private static let manager = CMMotionManager()

  private let queue: OperationQueue
  private(set) var running = false
  /// Samples whose converted stamp fell back to the arrival time (diagnostics).
  private(set) var fellBack = 0

  /// `workQueue` is the capture's serial queue: samples are delivered on it.
  init(workQueue: DispatchQueue) {
    queue = OperationQueue()
    queue.name = "drivesense.motion"
    queue.maxConcurrentOperationCount = 1
    queue.underlyingQueue = workQueue
  }

  var available: Bool { Self.manager.isDeviceMotionAvailable }

  /// Starts 25 Hz updates; `onSample` runs on the work queue with the sample in epoch ms.
  /// Silent when device motion is unavailable: rows then use the IMU-absent encoding.
  func start(anchor: ClockAnchor, onSample: @escaping (ImuSample) -> Void) {
    let m = Self.manager
    guard !running, m.isDeviceMotionAvailable,
          CMMotionManager.availableAttitudeReferenceFrames().contains(.xArbitraryZVertical) else { return }
    running = true
    m.deviceMotionUpdateInterval = 1.0 / ExtractConstants.IMU_RATE_HZ
    m.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: queue) { [weak self] motion, _ in
      guard let self = self, self.running, let dm = motion else { return }
      let arrival = TimeBase.nowEpochMs()
      let conv = anchor.toEpochMs(dm.timestamp * 1000, arrivalEpochMs: arrival)
      if conv.fellBack { self.fellBack += 1 }
      let g = dm.gravity
      let ua = dm.userAcceleration
      let w = dm.rotationRate
      onSample(ImuSample(
        t: conv.t,
        ua: Vec3(x: ua.x, y: ua.y, z: ua.z),
        g: Vec3(x: g.x, y: g.y, z: g.z),
        w: Vec3(x: w.x, y: w.y, z: w.z)
      ))
    }
  }

  func stop() {
    guard running else { return }
    running = false
    Self.manager.stopDeviceMotionUpdates()
  }
}
