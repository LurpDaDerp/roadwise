// LiveDrive — the Live Activity / Dynamic Island bridge (plan §3.10). iOS 16.2+; below that every
// method is a no-op (`isSupported`/`isRunning`/`start` false). The widget that renders the activity
// is the `live-drive-widget` target (/targets, linked by @bacons/apple-targets). The push-to-start
// token (iOS 17.2+) reaches JS as the `pushToStartToken` event and through `getPushToStartToken`.
import ExpoModulesCore
import Foundation

public final class LiveDriveModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiveDrive")

    // Keep identical to LIVE_DRIVE_EVENTS in src/types.ts.
    Events("pushToStartToken")

    OnCreate {
      // Adopt a running activity while a drive is open (never end a pushed one); hand new tokens to JS.
      if #available(iOS 16.2, *) {
        DispatchQueue.main.async {
          let controller = LiveDriveController.shared
          controller.onToken = { [weak self] hex in
            self?.sendEvent("pushToStartToken", ["token": hex])
          }
          controller.adoptRunning()
        }
      }
    }

    AsyncFunction("isSupported") { () -> Bool in
      if #available(iOS 16.2, *) {
        return LiveDriveController.isSupported
      }
      return false
    }.runOnQueue(.main)

    AsyncFunction("isRunning") { () -> Bool in
      if #available(iOS 16.2, *) {
        return LiveDriveController.shared.isRunning()
      }
      return false
    }.runOnQueue(.main)

    AsyncFunction("getPushToStartToken") { () -> String? in
      if #available(iOS 16.2, *) {
        return LiveDriveController.pushToStartToken
      }
      return nil
    }.runOnQueue(.main)

    AsyncFunction("start") { (state: LiveDriveStateRecord) -> Bool in
      if #available(iOS 16.2, *) {
        return LiveDriveController.shared.start(state.contentState)
      }
      return false
    }.runOnQueue(.main)

    AsyncFunction("update") { (state: LiveDriveStateRecord) in
      if #available(iOS 16.2, *) {
        LiveDriveController.shared.update(state.contentState)
      }
    }.runOnQueue(.main)

    AsyncFunction("end") {
      if #available(iOS 16.2, *) {
        LiveDriveController.shared.end()
      }
    }.runOnQueue(.main)
  }
}

/// `LiveDriveState` (src/types.ts) as the bridge receives it.
struct LiveDriveStateRecord: Record {
  @Field var speed: Double?
  @Field var limit: Double?
  @Field var unit: String = "mph"
  @Field var speedTint: String?
  @Field var speeding: Bool = false
  @Field var notDrivingAvailable: Bool = false
  @Field var weatherKind: String?
  @Field var weatherText: String?
  @Field var skyTop: String?
  @Field var skyMid: String?
  @Field var skyLow: String?
  @Field var accent: String?

  @available(iOS 16.2, *)
  var contentState: LiveDriveAttributes.ContentState {
    LiveDriveAttributes.ContentState(
      speed: speed,
      limit: limit,
      unit: unit == "km/h" ? "km/h" : "mph",
      speedTint: speedTint,
      speeding: speeding,
      notDrivingAvailable: notDrivingAvailable,
      weatherKind: weatherKind,
      weatherText: weatherText,
      skyTop: skyTop,
      skyMid: skyMid,
      skyLow: skyLow,
      accent: accent
    )
  }
}
