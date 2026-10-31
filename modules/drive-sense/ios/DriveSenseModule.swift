// DriveSense — the RoadWise drive-capture module (iOS). README.md is the binding contract;
// `src/types.ts` the typed half of it.
//
// iOS drives start on their own: the drive detector (`DriveDetector`, bridged as the second module
// `DriveDetect`) confirms a drive, journals its rows and emits each here as a `row` with its `seq`.
// This module keeps the shared contract (the same events and methods as Android's): `startCapture`
// re-modes a recording drive or starts a plain capture with nothing open (tests and dev tools);
// `stopCapture` ends the recording drive with JS's cut. Phone use is not tracked: the lock and
// reminder methods are fixed answers.
//
// The module is a thin bridge: the capture core (`CaptureController`), the detector and the event
// hubs exist for the whole process, and every method below runs on the main queue, where they live.
// Rejections carry only the contract's `CodedError` codes.
import AVFoundation
import ExpoModulesCore
import Foundation

public final class DriveSenseModule: Module, DriveSenseEventSink {
  public func definition() -> ModuleDefinition {
    Name("DriveSense")

    // Keep this list identical to DRIVE_SENSE_EVENTS in src/types.ts and to DriveSenseModule.kt.
    Events("activity", "row", "speed", "screen", "thermal", "notificationAction", "call", "reminderTap", "dashpalLinkTick")

    OnCreate {
      EventHub.shared.attach(self)
    }

    OnDestroy {
      EventHub.shared.detach(self)
    }

    // Buffering (README §3) keys on which events have a JS listener.
    OnStartObserving("activity") { EventHub.shared.startObserving("activity") }
    OnStopObserving("activity") { EventHub.shared.stopObserving("activity") }
    OnStartObserving("row") { EventHub.shared.startObserving("row") }
    OnStopObserving("row") { EventHub.shared.stopObserving("row") }
    // Live only (never buffered): `emitLive` delivers it only while a listener is attached.
    OnStartObserving("speed") { EventHub.shared.startObserving("speed") }
    OnStopObserving("speed") { EventHub.shared.stopObserving("speed") }
    // Android's: iOS reads no screen state and never emits it.
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

    // The drive's end from JS (README §2): kind "now" (nothing known), "dropped" (not kept), "at"
    // (its driving ended at endedAt, the cut) or "auto" (the same, ended by a JS automatic rule: the
    // linger watches on). A recording drive's end is journaled with cause "js".
    AsyncFunction("stopCapture") { (kind: String, endedAt: Double, drivingAtEnd: Bool, promise: Promise) in
      DriveDetector.shared.stopCapture(end: CaptureEnd.of(kind, endedAt, drivingAtEnd))
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

    // The forgot-to-start reminder is Android's: on iOS (where drives start on their own) the shared
    // methods answer fixed values. The "Always" request is DriveDetect's `requestAlways`.
    AsyncFunction("setTripReminder") { (_: Bool, promise: Promise) in
      promise.resolve(DriveSenseModule.reminderOff())
    }

    AsyncFunction("getTripReminderStatus") { (promise: Promise) in
      promise.resolve(DriveSenseModule.reminderOff())
    }

    // The current location answer, without prompting.
    AsyncFunction("requestReminderLocation") { (promise: Promise) in
      let a = CaptureController.shared.locationAuthorization
      promise.resolve(a == "none" ? "denied" : a)
    }.runOnQueue(.main)

    AsyncFunction("claimReminderTap") { (_: String, promise: Promise) in
      promise.resolve(false)
    }

    AsyncFunction("takeReminderTap") { (promise: Promise) in
      promise.resolve(nil)
    }

    // Phone use is not tracked: no lock proof is kept.
    AsyncFunction("markLockProof") { (_: Double, promise: Promise) in
      promise.resolve(nil)
    }

    // Android's (the navigation button): iOS finds and opens navigation apps by URL scheme from JS.
    AsyncFunction("listInstalledApps") { (_: [String], promise: Promise) in
      promise.resolve([[String: Any]]())
    }

    AsyncFunction("launchApp") { (_: String, promise: Promise) in
      promise.resolve(false)
    }

    // DashPal alerts on the phone (README §2). What an alert would play into now, read fresh: a call
    // (CXCallObserver), the output volume, and wired or USB headphones as the route. Sync: the ALERT
    // is answered in the same JS turn. Bluetooth (A2DP, LE: on iPhone an LE output is a hearing
    // aid), hearing aids and CarPlay are not headphones.
    Function("audioOutputState") { () -> [String: Any] in
      let session = AVAudioSession.sharedInstance()
      let volume = min(max(Double(session.outputVolume), 0), 1)
      let headphones = session.currentRoute.outputs.contains { $0.portType == .headphones || $0.portType == .usbAudio }
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

  /// iOS's fixed reminder status (`tripReminderStatusSchema`): off, nothing missing.
  static func reminderOff() -> [String: Any] {
    ["enabled": false, "state": "off", "missing": [String]()]
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
  @Field var skyTop: String?
  @Field var skyMid: String?
  @Field var skyLow: String?
  @Field var accent: String?
  // The Live Activity's (plan §3.10): the speed's tint, over the limit, the hint, the weather line.
  @Field var speedTint: String?
  @Field var speeding: Bool = false
  @Field var notDrivingAvailable: Bool = false
  @Field var weatherKind: String?
  @Field var weatherText: String?
}

/// The hand-off to the Live Activity module. `modules/live-drive` observes `name` on main and
/// updates its activity if one is running; with no observer (Android, or no activity) the post is
/// a no-op. Keys mirror `DriveDisplayState`; a nil number or colour is left out of `userInfo`.
enum DriveDisplayBridge {
  static let name = Notification.Name("roadwise.driveDisplay")

  static func post(_ s: DriveDisplayRecord) {
    var info: [String: Any] = [
      "unit": s.unit, "stopped": s.stopped, "ended": s.ended,
      "speeding": s.speeding, "notDrivingAvailable": s.notDrivingAvailable,
    ]
    if let v = s.speed { info["speed"] = v }
    if let v = s.limit { info["limit"] = v }
    if let v = s.points { info["points"] = v }
    if let v = s.pointsDelta { info["pointsDelta"] = v }
    if let v = s.skyTop { info["skyTop"] = v }
    if let v = s.skyMid { info["skyMid"] = v }
    if let v = s.skyLow { info["skyLow"] = v }
    if let v = s.accent { info["accent"] = v }
    if let v = s.speedTint { info["speedTint"] = v }
    if let v = s.weatherKind { info["weatherKind"] = v }
    if let v = s.weatherText { info["weatherText"] = v }
    NotificationCenter.default.post(name: name, object: nil, userInfo: info)
  }

  /// The drive ended or was cancelled (any way): the Live Activity must not outlive it.
  static func postEnded() {
    NotificationCenter.default.post(name: name, object: nil, userInfo: ["unit": "mph", "stopped": true, "ended": true])
  }
}
