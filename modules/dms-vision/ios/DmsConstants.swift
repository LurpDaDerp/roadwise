// The DmsVision wire and lifecycle constants. Every value mirrors modules/dms-vision/src/constants.ts,
// the single source (plan rev1: m1); __tests__/native-ios.test.ts compares them. Foundation only.

import Foundation

enum DmsConstants {
  static let FRAME_WIRE_VERSION = 1
  static let FRAME_STRIDE = 38
  static let FRAME_BYTES = 152
  static let BATCH_MS = 100
  static let WATCHDOG_PAUSE_MS = 10000
  static let WATCHDOG_STOP_MS = 60000
  static let MODEL_RELEASE_AFTER_PAUSE_MS = 300000
  static let THERMAL_L1_ENTRY_DWELL_MS = 60000
  static let THERMAL_COOL_DWELL_MS = 60000
  static let MAX_T_OFF_MS = 10000

  static let ALLOWED_FPS: [Int] = [5, 8, 10, 15]
  static let ALLOWED_ROTATIONS: [Int] = [0, 90, 180, 270]

  /// Thermal floor per level 0...3 (design §3.5: 15 → 8 → landmarks only → off).
  static let THERMAL_FPS_CAP: [Int] = [15, 8, 8, 0]
  static let THERMAL_GAZE_NET: [Bool] = [true, true, false, false]

  static let FLAG_NET_RAN = 1
  static let FLAG_EYE_CLIPPED_R = 2
  static let FLAG_EYE_CLIPPED_L = 4
  static let FLAG_MOUTH_CLIPPED = 8
  static let FLAG_POSE_MISSING = 16

  /// FRAME_FIELDS, in wire order.
  static let FIELD_NAMES: [String] = [
    "tOffMs", "face", "boxCx", "boxCy", "boxW", "boxH", "iod", "headYaw", "headPitch", "headRoll",
    "netYaw", "netPitch", "earR", "earL", "eyeWR", "eyeWL", "eyeLumaR", "eyeLumaL", "irisContrastR",
    "irisContrastL", "eyeSatR", "eyeSatL", "irisOxR", "irisOyR", "irisOxL", "irisOyL", "irisInR",
    "irisInL", "faceLuma", "blur", "mar", "mouthW", "frameLuma", "rotationDeg", "latLandmarkMs",
    "latTotalMs", "flags", "reserved",
  ]
}

/// Record field indices (FRAME_FIELDS order).
enum F {
  static let tOffMs = 0, face = 1, boxCx = 2, boxCy = 3, boxW = 4, boxH = 5, iod = 6
  static let headYaw = 7, headPitch = 8, headRoll = 9, netYaw = 10, netPitch = 11
  static let earR = 12, earL = 13, eyeWR = 14, eyeWL = 15, eyeLumaR = 16, eyeLumaL = 17
  static let irisContrastR = 18, irisContrastL = 19, eyeSatR = 20, eyeSatL = 21
  static let irisOxR = 22, irisOyR = 23, irisOxL = 24, irisOyL = 25, irisInR = 26, irisInL = 27
  static let faceLuma = 28, blur = 29, mar = 30, mouthW = 31, frameLuma = 32, rotationDeg = 33
  static let latLandmarkMs = 34, latTotalMs = 35, flags = 36, reserved = 37
}
