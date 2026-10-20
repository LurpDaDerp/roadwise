// LiveDrive — the Live Activity / Dynamic Island bridge (plan §6). iOS 16.2+; below that every
// method is a no-op (`isSupported` false, `start` false). The widget that renders the activity is
// the `live-drive-widget` target (/targets, linked by @bacons/apple-targets).
import ExpoModulesCore
import Foundation

public final class LiveDriveModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiveDrive")

    OnCreate {
      // A Live Activity never outlives its drive: whatever an earlier process left, end it now.
      // (Also installs the controller's observer for drive-sense's `setDriveDisplay`.)
      if #available(iOS 16.2, *) {
        DispatchQueue.main.async { LiveDriveController.shared.endAll() }
      }
    }

    AsyncFunction("isSupported") { () -> Bool in
      if #available(iOS 16.2, *) {
        return LiveDriveController.isSupported
      }
      return false
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
  @Field var points: Double?
  @Field var pointsDelta: Double?
  @Field var stopped: Bool = false
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
      points: points,
      pointsDelta: pointsDelta,
      stopped: stopped,
      skyTop: skyTop,
      skyMid: skyMid,
      skyLow: skyLow,
      accent: accent
    )
  }
}
