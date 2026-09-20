import ExpoModulesCore

public class DriveSenseModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DriveSense")

    // Keep this list identical to DriveSenseModule.kt and to DRIVE_SENSE_EVENTS in src/index.ts.
    Events("wake", "activity", "row", "screen", "thermal", "notificationAction")

    AsyncFunction("getState") { () -> [String: Any] in
      return ["armed": false, "capturing": false, "platform": "ios"]
    }
  }
}
