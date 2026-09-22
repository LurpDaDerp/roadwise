// DriveSense — the RoadWise background drive-capture module (iOS). README.md is the binding
// contract; `src/types.ts` the typed half of it.
//
// The module is a thin bridge: the capture core (`CaptureController`) and the event hub exist
// for the whole process — the app-delegate subscriber creates them at launch, before any module
// does — and every method below runs on the main queue, where they live. Rejections carry only
// the contract's `CodedError` codes.
import ExpoModulesCore

public final class DriveSenseModule: Module, DriveSenseEventSink {
  public func definition() -> ModuleDefinition {
    Name("DriveSense")

    // Keep this list identical to DRIVE_SENSE_EVENTS in src/types.ts and to DriveSenseModule.kt.
    Events("wake", "activity", "row", "screen", "thermal", "notificationAction", "call")

    OnCreate {
      EventHub.shared.attach(self)
    }

    OnDestroy {
      EventHub.shared.detach(self)
    }

    // Buffering (README §3) and the row watchdog (§6) both key on which events have a JS listener.
    OnStartObserving("wake") { EventHub.shared.startObserving("wake") }
    OnStopObserving("wake") { EventHub.shared.stopObserving("wake") }
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

    AsyncFunction("arm") { (promise: Promise) in
      do {
        try CaptureController.shared.arm()
        promise.resolve(nil)
      } catch CaptureController.ArmFailure.unavailable {
        promise.reject("E_UNAVAILABLE", "motion activity is not available on this device")
      } catch CaptureController.ArmFailure.permission(let message) {
        promise.reject("E_PERMISSION", message)
      } catch {
        promise.reject("E_PERMISSION", "arm failed: \(error.localizedDescription)")
      }
    }.runOnQueue(.main)

    AsyncFunction("disarm") { (promise: Promise) in
      CaptureController.shared.disarm()
      promise.resolve(nil)
    }.runOnQueue(.main)

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

    AsyncFunction("queryMotionHistory") { (fromTs: Double, toTs: Double, promise: Promise) in
      ActivitySource.history(fromTs: fromTs, toTs: toTs) { promise.resolve($0) }
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
        CaptureController.shared.enforceArmingPermissions()
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

    // Android S3's notification; iOS has none.
    AsyncFunction("setNotificationState") { (_: NotificationStateRecord, promise: Promise) in
      promise.resolve(nil)
    }

    // Android's ApplicationExitInfo has no iOS equivalent.
    AsyncFunction("getLastExitInfo") { (promise: Promise) in
      promise.resolve(nil)
    }

    // iOS has no per-app battery restriction for the user to lift (README §2).
    AsyncFunction("isIgnoringBatteryOptimizations") { (promise: Promise) in
      promise.resolve(true)
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

/// `setNotificationState`'s argument (ignored on iOS; declared so the bridge accepts it).
struct NotificationStateRecord: Record {
  @Field var stationary: Bool = false
  @Field var startedAt: Double?
}
