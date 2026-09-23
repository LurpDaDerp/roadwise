// The gaze network (gaze_direct.onnx, 867,069 parameters), compiled ONLY with DMS_GAZE_NET=1: the
// release gate keeps it and ONNX Runtime out of production builds (README §7, THIRD_PARTY.md).
// Session: CPU, one intra-op thread, spinning off, all graph optimisations. Every API used here
// was verified against onnxruntime-objc 1.30.0 in V1.

import Foundation
import CryptoKit
import onnxruntime_objc

protocol GazeNetRunner: AnyObject {
  func run(cloud: [Float], context: [Float], validity: [Float]) throws -> (gaze: [Double], rotation: [Double])
  func close()
}

enum GazeNetFactory {
  static let available = true
  static let onnxRuntimeVersion: String? = "1.30.0"

  static func modelSha256() -> String? {
    guard let path = DmsBundle.path("gaze_direct", "onnx"),
          let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  static func make() throws -> GazeNetRunner? {
    return try OrtGazeNet()
  }
}

final class OrtGazeNet: GazeNetRunner {
  private let lock = NSLock()
  private var env: ORTEnv?
  private var session: ORTSession?

  init() throws {
    guard let modelPath = DmsBundle.path("gaze_direct", "onnx") else {
      throw DmsError.model("gaze_direct.onnx is not in the bundle")
    }
    let environment = try ORTEnv(loggingLevel: ORTLoggingLevel.warning)
    let options = try ORTSessionOptions()
    try options.setIntraOpNumThreads(1)
    try options.setGraphOptimizationLevel(ORTGraphOptimizationLevel.all)
    // A spinning worker between frames is a permanently hot core; this model's wake-up cost is tiny.
    try? options.addConfigEntry(withKey: "session.intra_op.allow_spinning", value: "0")
    try? options.addConfigEntry(withKey: "session.inter_op.allow_spinning", value: "0")
    session = try ORTSession(env: environment, modelPath: modelPath, sessionOptions: options)
    env = environment
  }

  func close() {
    lock.lock()
    session = nil
    env = nil
    lock.unlock()
  }

  func run(cloud: [Float], context: [Float], validity: [Float]) throws -> (gaze: [Double], rotation: [Double]) {
    guard cloud.count == 1434, context.count == 7, validity.count == 478 else {
      throw DmsError.badArgs("gaze inputs have the wrong sizes")
    }
    lock.lock()
    defer { lock.unlock() }
    guard let session = session else { throw DmsError.model("the gaze session is closed") }
    let c = NSMutableData(bytes: cloud, length: cloud.count * 4)
    let x = NSMutableData(bytes: context, length: context.count * 4)
    let v = NSMutableData(bytes: validity, length: validity.count * 4)
    let cloudValue = try ORTValue(tensorData: c, elementType: ORTTensorElementDataType.float,
                                  shape: [1, 478, 3].map { NSNumber(value: $0) })
    let contextValue = try ORTValue(tensorData: x, elementType: ORTTensorElementDataType.float,
                                    shape: [1, 7].map { NSNumber(value: $0) })
    let validityValue = try ORTValue(tensorData: v, elementType: ORTTensorElementDataType.float,
                                     shape: [1, 478].map { NSNumber(value: $0) })
    let outputs = try session.run(withInputs: ["cloud": cloudValue, "context": contextValue, "validity": validityValue],
                                  outputNames: ["gaze", "rotation"], runOptions: nil)
    guard let gaze = outputs["gaze"], let rotation = outputs["rotation"] else {
      throw DmsError.model("the gaze session did not return both outputs")
    }
    let g = try OrtGazeNet.floats(gaze.tensorData() as Data)
    let r = try OrtGazeNet.floats(rotation.tensorData() as Data)
    guard g.count == 3, r.count == 9 else { throw DmsError.model("unexpected gaze output sizes") }
    return (g, r)
  }

  private static func floats(_ data: Data) throws -> [Double] {
    var out: [Double] = []
    out.reserveCapacity(data.count / 4)
    data.withUnsafeBytes { raw in
      for i in 0..<(raw.count / 4) {
        out.append(Double(Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self)))))
      }
    }
    return out
  }
}
