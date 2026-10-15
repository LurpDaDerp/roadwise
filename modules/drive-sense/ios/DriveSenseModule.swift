// DriveSense — the RoadWise drive-capture module (iOS). README.md is the binding contract;
// `src/types.ts` the typed half of it.
//
// v3 (plan §1 decision 4): a capture starts only from a JS `startCapture` (a user's tap in the
// foreground) and runs in the background on While Using through the `location` background mode.
// No arming, no OS wakes, no location relaunch, no Always.
//
// The module is a thin bridge: the capture core (`CaptureController`) and the event hub exist for
// the whole process, and every method below runs on the main queue, where they live. Rejections
// carry only the contract's `CodedError` codes.
import ExpoModulesCore
import Foundation

public final class DriveSenseModule: Module, DriveSenseEventSink {
  public func definition() -> ModuleDefinition {
    Name("DriveSense")

    // Keep this list identical to DRIVE_SENSE_EVENTS in src/types.ts and to DriveSenseModule.kt.
    Events("activity", "row", "screen", "thermal", "notificationAction", "call")

    OnCreate {
      EventHub.shared.attach(self)
    }

    OnDestroy {
      EventHub.shared.detach(self)
    }

    // Buffering (README §3) and the row watchdog (§6) both key on which events have a JS listener.
    OnStartObserving("activity") { EventHub.shared.startObserving("activity") }
    OnStopObserving("activity") { EventHub.shared.stopObserving("activity") }
    OnStartObserving("row") { EventHub.shared.startObserving("row") }
    OnStopObserving("row") { EventHub.shared.stopObserving("row") }
    OnStartObserving("screen") { EventHub.shared.startObserving("screen") }
    OnStopObserving("screen") { EventHub.shared.stopObserving("screen") }
    OnStartObserving("thermal") { EventHub.shared.startObserving("thermal") }
    OnStopObserving("thermal") { EventHub.shared.stopObserving("thermal") }
    OnStartObserving("notificationAction") { EventHub.shared.startObserving("notificationAction") }
    OnStopObserving("notificationAction") { EventHub.shared.stopObserving("notificationAction") }
    OnStartObserving("call") { EventHub.shared.startObserving("call") }
    OnStopObserving("call") { EventHub.shared.stopObserving("call") }

    AsyncFunction("startCapture") { (mode: String, promise: Promise) in
      if CaptureController.shared.startCapture(mode: mode) {
        promise.resolve(nil)
      } else {
        promise.reject("E_PERMISSION", "startCapture needs location permission (whenInUse or always)")
      }
    }.runOnQueue(.main)

    AsyncFunction("stopCapture") { (promise: Promise) in
      CaptureController.shared.stopCapture()
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("setCaptureRate") { (rate: String, promise: Promise) in
      CaptureController.shared.setCaptureRate(rate)
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("getState") { (promise: Promise) in
      promise.resolve(CaptureController.shared.state())
    }.runOnQueue(.main)

    AsyncFunction("getScreenState") { (promise: Promise) in
      let s = PhoneState.snapshot()
      promise.resolve(["locked": s.locked, "on": s.screenOn])
    }.runOnQueue(.main)

    AsyncFunction("getThermalState") { (promise: Promise) in
      promise.resolve(PhoneState.thermalLevel())
    }.runOnQueue(.main)

    AsyncFunction("requestMotionPermission") { (promise: Promise) in
      ActivitySource.requestPermission { result in
        promise.resolve(result)
      }
    }.runOnQueue(.main)

    AsyncFunction("excludeFromBackup") { (uri: String, promise: Promise) in
      do {
        try Backup.exclude(uri)
        promise.resolve(nil)
      } catch Backup.Failure.notFound(let message) {
        promise.reject("E_NOT_FOUND", message)
      } catch Backup.Failure.failed(let message) {
        promise.reject("E_IO", message)
      } catch {
        promise.reject("E_IO", error.localizedDescription)
      }
    }

    // The background surface (plan §6): forwarded to the Live Activity (`modules/live-drive`) when
    // one is running, through a process-local notification so the two pods stay independent.
    AsyncFunction("setDriveDisplay") { (state: DriveDisplayRecord, promise: Promise) in
      DriveDisplayBridge.post(state)
      promise.resolve(nil)
    }.runOnQueue(.main)

    // Android's ApplicationExitInfo has no iOS equivalent.
    AsyncFunction("getLastExitInfo") { (promise: Promise) in
      promise.resolve(nil)
    }

    // iOS has no per-app battery restriction for the user to lift (README §2).
    AsyncFunction("isIgnoringBatteryOptimizations") { (promise: Promise) in
      promise.resolve(true)
    }

    // The optional forgot-to-start reminder (README "Forgot-to-start reminder"). Not built on iOS
    // in this version: it reports itself unavailable and asks for nothing.
    AsyncFunction("setTripReminder") { (_: Bool, promise: Promise) in
      promise.resolve(["enabled": false, "state": "unavailable", "autoOff": false, "missing": [String](), "pausedUntil": NSNull()] as [String: Any])
    }

    AsyncFunction("getTripReminderStatus") { (promise: Promise) in
      promise.resolve(["enabled": false, "state": "unavailable", "autoOff": false, "missing": [String](), "pausedUntil": NSNull()] as [String: Any])
    }

    AsyncFunction("requestReminderLocation") { (promise: Promise) in
      promise.resolve("notNeeded")
    }

    // Heavy: runs on the module's own async queue, never the main queue.
    AsyncFunction("selfTest") { (vectorsJson: String, promise: Promise) in
      do {
        promise.resolve(try SelfTest.run(vectorsJson))
      } catch let e as SelfTest.InvalidInput {
        promise.reject("E_INVALID_INPUT", e.message)
      } catch {
        promise.reject("E_INVALID_INPUT", error.localizedDescription)
      }
    }
  }

  // MARK: - DriveSenseEventSink

  func deliver(_ event: String, _ body: [String: Any]) {
    sendEvent(event, body.mapValues { $0 as Any? })
  }
}

/// `setDriveDisplay`'s argument (`DriveDisplayState` in src/types.ts).
struct DriveDisplayRecord: Record {
  @Field var speed: Double?
  @Field var limit: Double?
  @Field var unit: String = "mph"
  @Field var points: Double?
  @Field var pointsDelta: Double?
  @Field var stopped: Bool = false
  @Field var ended: Bool = false
}

/// The hand-off to the Live Activity module. `modules/live-drive` observes `name` on main and
/// updates its activity if one is running; with no observer (Android, or no activity) the post is
/// a no-op. Keys mirror `DriveDisplayState`; a nil number is left out of `userInfo`.
enum DriveDisplayBridge {
  static let name = Notification.Name("roadwise.driveDisplay")

  static func post(_ s: DriveDisplayRecord) {
    var info: [String: Any] = ["unit": s.unit, "stopped": s.stopped, "ended": s.ended]
    if let v = s.speed { info["speed"] = v }
    if let v = s.limit { info["limit"] = v }
    if let v = s.points { info["points"] = v }
    if let v = s.pointsDelta { info["pointsDelta"] = v }
    NotificationCenter.default.post(name: name, object: nil, userInfo: info)
  }

  /// The capture ended natively (watchdog, or any `stopCapture`): the Live Activity must not outlive it.
  static func postEnded() {
    NotificationCenter.default.post(name: name, object: nil, userInfo: ["unit": "mph", "stopped": true, "ended": true])
  }
}
