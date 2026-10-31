// The pedometer while a drive records: CMPedometer's live step count from the drive's start, put
// on each of its rows as the bridge-only `steps` (`FeatureRow.steps`) and fed to the safety stop's
// step walk (`DetectPolicy.endOnSteps`). Motion & Fitness covers it (the activity permission).
// Without it, on a phone that cannot count steps, or after an error, rows carry no count and the
// step walk never applies. Main thread only.
import CoreMotion
import Foundation

final class PedometerSource {
  private let pedometer = CMPedometer()
  /// The drive the count is for; nil when stopped.
  private var driveId: String?
  /// Bumped at every start and stop, so a late update from an earlier count is dropped.
  private var generation = 0
  /// The steps counted since the drive's start, or nil before the first update (and when stopped
  /// or failed). Only grows while one count runs.
  private(set) var steps: Int?

  /// Steps can be counted here and Motion & Fitness is granted.
  static func usable() -> Bool {
    guard CMPedometer.isStepCountingAvailable() else { return false }
    return CMPedometer.authorizationStatus() == .authorized
  }

  /// Counts steps from `from` (the drive's start) for `driveId`. A count already running for the
  /// same drive goes on (a resume); another drive's stops first. Nothing when not `usable`.
  func start(driveId: String, from: Date) {
    dispatchPrecondition(condition: .onQueue(.main))
    if self.driveId == driveId { return }
    stop()
    self.driveId = driveId
    guard PedometerSource.usable() else { return }
    generation &+= 1
    let gen = generation
    pedometer.startUpdates(from: from) { [weak self] data, error in
      let n = data?.numberOfSteps.intValue
      DispatchQueue.main.async {
        guard let self = self, self.generation == gen else { return }
        if error != nil {
          // An error ends this drive's count: its rows carry none from here (no step walk).
          self.generation &+= 1
          self.steps = nil
          self.pedometer.stopUpdates()
          return
        }
        guard let n = n, n >= 0 else { return }
        self.steps = max(n, self.steps ?? 0)
      }
    }
  }

  /// The drive ended (or was cancelled, or wiped): the count stops and is forgotten.
  func stop() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard driveId != nil else { return }
    generation &+= 1
    driveId = nil
    steps = nil
    pedometer.stopUpdates()
  }
}
