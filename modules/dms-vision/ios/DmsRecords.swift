// The argument records of `start` and `setPolicy`. Their field names are EXACTLY the keys of
// src/wire.ts `startOptionsSchema` / `capturePolicySchema` (native-ios.test.ts compares them).
// Every field is optional here so a missing or mistyped value is refused by `validated()` with
// E_BAD_ARGS, never by the bridge with a generic error.

import CryptoKit
import ExpoModulesCore
import Foundation

struct StartOptionsRecord: Record {
  @Field var gateToken: String?
  @Field var fps: Double?
  @Field var gazeNet: Bool?
  @Field var gazeNetEvery: Double?
  @Field var delegate: String?
  @Field var rotationOffsetDegrees: Double?

  func validated() throws -> (token: String, fps: Int, gazeNet: Bool, every: Int, gpu: Bool, rotationOffset: Int) {
    guard let token = gateToken, !token.isEmpty else { throw DmsError.badArgs("a gate token is required") }
    guard let f = fps, DmsConstants.ALLOWED_FPS.map { Double($0) }.contains(f) else { throw DmsError.badArgs("fps") }
    guard let net = gazeNet else { throw DmsError.badArgs("gazeNet") }
    guard let e = gazeNetEvery, e == 1 || e == 2 else { throw DmsError.badArgs("gazeNetEvery") }
    guard let d = delegate, d == "cpu" || d == "gpu" else { throw DmsError.badArgs("delegate") }
    guard let r = rotationOffsetDegrees, DmsConstants.ALLOWED_ROTATIONS.map { Double($0) }.contains(r) else {
      throw DmsError.badArgs("rotationOffsetDegrees")
    }
    return (token, Int(f), net, Int(e), d == "gpu", Int(r))
  }
}

struct CapturePolicyRecord: Record {
  @Field var gateToken: String?
  @Field var capture: String?
  @Field var fps: Double?
  @Field var gazeNet: Bool?
  @Field var gazeNetEvery: Double?
  @Field var setupMode: Bool?
  @Field var previewAllowed: Bool?

  func validated() throws -> (token: String, capture: String, fps: Int, gazeNet: Bool, every: Int, setupMode: Bool, previewAllowed: Bool) {
    guard let token = gateToken, !token.isEmpty else { throw DmsError.badArgs("a gate token is required") }
    guard let c = capture, c == "run" || c == "pause" else { throw DmsError.badArgs("capture") }
    guard let f = fps, DmsConstants.ALLOWED_FPS.map { Double($0) }.contains(f) else { throw DmsError.badArgs("fps") }
    guard let net = gazeNet else { throw DmsError.badArgs("gazeNet") }
    guard let e = gazeNetEvery, e == 1 || e == 2 else { throw DmsError.badArgs("gazeNetEvery") }
    guard let setup = setupMode, let preview = previewAllowed else { throw DmsError.badArgs("setupMode / previewAllowed") }
    return (token, c, Int(f), net, Int(e), setup, preview)
  }
}

extension DmsVisionModule {
  /// sha256 of a bundled file (diagnostics only; computed on request, never per frame).
  static func sha256(path: String) -> String? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
