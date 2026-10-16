// DriveSense — the RoadWise drive-capture module (iOS). README.md is the binding contract;
// `src/types.ts` the typed half of it.
//
// v3 (plan §1 decision 4): a capture starts only from a JS `startCapture` (a user's tap in the
// foreground) and runs in the background on While Using through the `location` background mode.
// No arming and nothing that starts a capture by itself. The one thing that runs with no drive open
// is the optional forgot-to-start reminder (`TripReminder`, off by default): it wakes on
// significant-location changes and posts at most one note a session, with a one-use token. A tap
// reaches JS through expo-notifications; JS claims the token here (`claimReminderTap`) and only then
// starts the drive itself. It is the only user of "Always", asked for only when the driver turns the
// reminder on.
//
// The module is a thin bridge: the capture core (`CaptureController`) and the event hub exist for
// the whole process, and every method below runs on the main queue, where they live. Rejections
// carry only the contract's `CodedError` codes.
import AVFoundation
import ExpoModulesCore
import Foundation

public final class DriveSenseModule: Module, DriveSenseEventSink {
  public func definition() -> ModuleDefinition {
    Name("DriveSense")

    // Keep this list identical to DRIVE_SENSE_EVENTS in src/types.ts and to DriveSenseModule.kt.
    Events("activity", "row", "screen", "thermal", "notificationAction", "call", "reminderTap", "dashpalLinkTick")

    OnCreate {
      EventHub.shared.attach(self)
      // The screen-switch lock proof (README §5): observes leaving, the lock report and returning.
      LockProbe.shared.start()
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
    // Android's: iOS hands a reminder tap to JS through expo-notifications and never emits it.
    OnStartObserving("reminderTap") { EventHub.shared.startObserving("reminderTap") }
    OnStopObserving("reminderTap") { EventHub.shared.stopObserving("reminderTap") }
    // Android's (the DashPal link service's tick): iOS never emits it.
    OnStartObserving("dashpalLinkTick") { EventHub.shared.startObserving("dashpalLinkTick") }
    OnStopObserving("dashpalLinkTick") { EventHub.shared.stopObserving("dashpalLinkTick") }

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

    // The optional forgot-to-start reminder (README "Forgot-to-start reminder"). It never starts a
    // capture: JS claims a tap's token and starts the drive itself.
    AsyncFunction("setTripReminder") { (enabled: Bool, promise: Promise) in
      TripReminder.shared.setEnabled(enabled) { promise.resolve($0) }
    }.runOnQueue(.main)

    AsyncFunction("getTripReminderStatus") { (promise: Promise) in
      TripReminder.shared.status { promise.resolve($0) }
    }.runOnQueue(.main)

    // The one "Always" request, from the driver's tap that turns the reminder on.
    AsyncFunction("requestReminderLocation") { (promise: Promise) in
      TripReminder.shared.requestAlways { promise.resolve($0) }
    }.runOnQueue(.main)

    // True once, for the note's token, while its session lasts (motion folded in) and no drive is open.
    AsyncFunction("claimReminderTap") { (token: String, promise: Promise) in
      TripReminder.shared.claim(token) { promise.resolve($0) }
    }.runOnQueue(.main)

    // iOS hands a reminder tap to JS through expo-notifications: nothing is ever held here.
    AsyncFunction("takeReminderTap") { (promise: Promise) in
      promise.resolve(nil)
    }

    // An in-drive lock proof (README §5): a lock reported within 15 s of RoadWise leaving the screen.
    AsyncFunction("markLockProof") { (delayMs: Double, promise: Promise) in
      LockProbe.shared.mark(delayMs: delayMs)
      promise.resolve(nil)
    }.runOnQueue(.main)

    // Android's (the navigation button): iOS finds and opens navigation apps by URL scheme from JS.
    AsyncFunction("listInstalledApps") { (_: [String], promise: Promise) in
      promise.resolve([[String: Any]]())
    }

    AsyncFunction("launchApp") { (_: String, promise: Promise) in
      promise.resolve(false)
    }

    // DashPal alerts on the phone (README §2). What an alert would play into now, read fresh: a call
    // (CXCallObserver), the output volume, and wired headphones as the route. Sync: the ALERT is
    // answered in the same JS turn. Bluetooth (A2DP, LE), hearing aids and CarPlay are not headphones.
    Function("audioOutputState") { () -> [String: Any] in
      let session = AVAudioSession.sharedInstance()
      let volume = min(max(Double(session.outputVolume), 0), 1)
      let headphones = session.currentRoute.outputs.contains { $0.portType == .headphones }
      return ["callActive": CallObserver.anyCallActiveNow(), "volume": volume, "headphones": headphones]
    }

    // Android's: an iOS app woken by a Bluetooth notification runs while it handles it.
    Function("holdAwake") { (_: Int) -> Bool in
      false
    }

    // Android's: iOS keeps no service for the DashPal link (bluetooth-central wakes the app).
    Function("dashpalLinkRunning") { () -> Bool in
      false
    }

    AsyncFunction("setDashpalLink") { (_: String, promise: Promise) in
      promise.resolve("unsupported")
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
