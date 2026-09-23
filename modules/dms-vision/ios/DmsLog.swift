// The module's ONLY logging (privacy rule, README §1): static event codes, never a value, never
// frame content. __tests__/native-ios.test.ts forbids every other logging call in ios/.

import Foundation
import os

enum DmsLogCode: String {
  case sessionStarted
  case sessionStopped
  case sessionPaused
  case sessionResumed
  case cameraConfigFailed
  case cameraInterrupted
  case cameraRuntimeError
  case landmarkerFailed
  case gazeNetFailed
  case watchdogPaused
  case watchdogStopped
  case modelsReleased
  case thermalPaused
  case backgroundStopped
}

enum DmsLog {
  private static let log = OSLog(subsystem: "com.roadwise.dmsvision", category: "dms")

  static func code(_ c: DmsLogCode) {
    os_log("%{public}@", log: log, type: .info, c.rawValue)
  }
}
