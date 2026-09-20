package expo.modules.drivesense

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DriveSenseModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DriveSense")

    // Keep this list identical to DriveSenseModule.swift and to DRIVE_SENSE_EVENTS in src/index.ts.
    Events("wake", "activity", "row", "screen", "thermal", "notificationAction")

    AsyncFunction("getState") {
      mapOf("armed" to false, "capturing" to false, "platform" to "android")
    }
  }
}
