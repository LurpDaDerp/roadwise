// The gaze network on a build WITHOUT DMS_GAZE_NET=1 (every production build): it does not exist.
// The podspec compiles this file only when the switch is off, and GazeNet/GazeNet.swift otherwise.
// Foundation only.

import Foundation

protocol GazeNetRunner: AnyObject {
  /// One batch-1 pass: cloud (1434), context (7), validity (478) → gaze (3), rotation (9).
  func run(cloud: [Float], context: [Float], validity: [Float]) throws -> (gaze: [Double], rotation: [Double])
  func close()
}

enum GazeNetFactory {
  static let available = false
  static let onnxRuntimeVersion: String? = nil

  /// The model's sha256 (diagnostics); nil without the net.
  static func modelSha256() -> String? { return nil }

  static func make() throws -> GazeNetRunner? { return nil }
}
