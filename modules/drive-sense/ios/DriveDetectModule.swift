// DriveDetect — the iOS drive detector's bridge (plan §3.1.1; `src/detect/types.ts` is the binding
// contract). A second Expo module in the drive-sense pod, registered for Apple only: Android has no
// such module, and JS reads its absence as "drives start only from the Start card". Every method runs
// on main, where the detector lives; only `discardDrive` on the live drive rejects (E_BUSY).
import ExpoModulesCore
import Foundation

public final class DriveDetectModule: Module, DriveSenseEventSink {
  public func definition() -> ModuleDefinition {
    Name("DriveDetect")

    // Keep this list identical to DRIVE_DETECT_EVENTS in src/detect/types.ts.
    Events("detectState", "driveStarted", "driveEnded")

    OnCreate {
      EventHub.detect.attach(self)
    }

    OnDestroy {
      EventHub.detect.detach(self)
    }

    // Buffering (README §3): an event nobody listens for waits for the first listener.
    OnStartObserving("detectState") { EventHub.detect.startObserving("detectState") }
    OnStopObserving("detectState") { EventHub.detect.stopObserving("detectState") }
    OnStartObserving("driveStarted") { EventHub.detect.startObserving("driveStarted") }
    OnStopObserving("driveStarted") { EventHub.detect.stopObserving("driveStarted") }
    OnStartObserving("driveEnded") { EventHub.detect.startObserving("driveEnded") }
    OnStopObserving("driveEnded") { EventHub.detect.stopObserving("driveEnded") }

    AsyncFunction("setArmed") { (armed: Bool, ownerId: String, promise: Promise) in
      promise.resolve(DriveDetector.shared.setArmed(armed, ownerId: ownerId))
    }.runOnQueue(.main)

    AsyncFunction("getState") { (promise: Promise) in
      promise.resolve(DriveDetector.shared.getState())
    }.runOnQueue(.main)

    // The one "Always" request: only from While Using, once per install.
    AsyncFunction("requestAlways") { (promise: Promise) in
      DriveDetectAccess.shared.requestAlways { promise.resolve($0) }
    }.runOnQueue(.main)

    AsyncFunction("startWaiting") { (promise: Promise) in
      promise.resolve(DriveDetector.shared.startWaiting())
    }.runOnQueue(.main)

    AsyncFunction("extendWaiting") { (promise: Promise) in
      let until = DriveDetector.shared.extendWaiting()
      promise.resolve(until.map { NSNumber(value: Int64(jsRound($0))) })
    }.runOnQueue(.main)

    AsyncFunction("cancelWaiting") { (promise: Promise) in
      DriveDetector.shared.cancelWaiting()
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("notDriving") { (promise: Promise) in
      DriveDetector.shared.notDriving()
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("listDrives") { (promise: Promise) in
      RowJournal.shared.list { promise.resolve($0) }
    }.runOnQueue(.main)

    AsyncFunction("readRows") { (driveId: String, afterSeq: Int, limit: Int, promise: Promise) in
      guard DriveDetectModule.isDriveId(driveId) else {
        let none: [String: Any] = ["rows": [Any](), "lastSeq": max(0, afterSeq), "done": true]
        promise.resolve(none)
        return
      }
      let n = min(max(1, limit), DetectPolicy.READ_ROWS_MAX)
      RowJournal.shared.read(driveId, afterSeq: max(0, afterSeq), limit: n) { rows, last, done in
        let page: [String: Any] = ["rows": rows, "lastSeq": last, "done": done]
        promise.resolve(page)
      }
    }.runOnQueue(.main)

    AsyncFunction("discardDrive") { (driveId: String, promise: Promise) in
      if DriveDetector.shared.isLive(driveId) {
        promise.reject("E_BUSY", "the drive is still recording")
        return
      }
      guard DriveDetectModule.isDriveId(driveId) else {
        promise.resolve(nil)
        return
      }
      RowJournal.shared.delete(driveId) { promise.resolve(nil) }
    }.runOnQueue(.main)
  }

  /// A drive id names a file: a lowercase UUID and nothing else.
  static func isDriveId(_ s: String) -> Bool {
    s.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil
  }

  // MARK: - DriveSenseEventSink

  func deliver(_ event: String, _ body: [String: Any]) {
    sendEvent(event, body.mapValues { $0 as Any? })
  }
}
