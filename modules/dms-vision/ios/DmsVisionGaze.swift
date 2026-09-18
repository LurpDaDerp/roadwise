// ONNX Runtime wrapper for the bundled gaze network (gaze_direct.onnx, 867,069 parameters).
//
// Mirrors deployment-stack/dms/gaze_model.py: batch 1, two intra-op threads, all graph
// optimizations, inputs `cloud` (1, 478, 3) / `context` (1, 7) / `validity` (1, 478) float32,
// outputs `gaze` (1, 3) and `rotation` (1, 3, 3). Mirror TTA is out of scope for this version.
//
// Pinned to onnxruntime-objc 1.30.0 (see DmsVision.podspec). Every API used here is verified
// against microsoft/onnxruntime v1.30.0 objectivec/include/{ort_env,ort_session,ort_value}.h.

import Foundation
import onnxruntime_objc

internal final class DmsVisionGaze {
  static let cloudFloats = kDmsNumLandmarks * 3     // 1434
  static let contextFloats = 7
  static let validityFloats = kDmsNumLandmarks      // 478
  static let outputFloats = 12                      // gaze[3] + rotation[9], row-major

  private let lock = NSLock()
  private var env: ORTEnv?
  private var session: ORTSession?
  private var metadata: [String: Any]?

  /// Loads and caches gaze_direct.meta.json. Independent of the ORT session.
  func loadMetadata() throws -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return try metadataLocked()
  }

  private func metadataLocked() throws -> [String: Any] {
    if let cached = metadata { return cached }
    let path = try DmsVisionBundle.require("gaze_direct.meta", "json")
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw DmsVisionException("gaze_direct.meta.json is not a JSON object")
    }
    metadata = json
    return json
  }

  /// Creates the inference session if it does not exist yet. Safe to call repeatedly.
  func prepare() throws {
    lock.lock()
    defer { lock.unlock() }
    try prepareLocked()
  }

  private func prepareLocked() throws {
    if session != nil { return }
    let modelPath = try DmsVisionBundle.require("gaze_direct", "onnx")
    do {
      let environment = try ORTEnv(loggingLevel: ORTLoggingLevel.warning)
      let options = try ORTSessionOptions()
      try options.setIntraOpNumThreads(2)
      try options.setGraphOptimizationLevel(ORTGraphOptimizationLevel.all)
      let created = try ORTSession(env: environment, modelPath: modelPath, sessionOptions: options)
      env = environment
      session = created
    } catch let error as DmsVisionException {
      throw error
    } catch {
      throw DmsVisionException("failed to create the ONNX session: \(error.localizedDescription)")
    }
  }

  func close() {
    lock.lock()
    defer { lock.unlock() }
    session = nil
    env = nil
  }

  /// One batch-1 forward pass. `cloud` / `context` / `validity` are little-endian float32 byte
  /// buffers; the result is 12 little-endian float32: gaze[3] then rotation[9] row-major.
  func predict(cloud: Data, context: Data, validity: Data) throws -> Data {
    try Self.checkLength(cloud, DmsVisionGaze.cloudFloats, "cloud")
    try Self.checkLength(context, DmsVisionGaze.contextFloats, "context")
    try Self.checkLength(validity, DmsVisionGaze.validityFloats, "validity")

    lock.lock()
    defer { lock.unlock() }
    try prepareLocked()
    guard let session = session else {
      throw DmsVisionException("the ONNX session is not available")
    }

    // ORTValue references the NSMutableData rather than copying it, so these locals must stay
    // alive until run() returns - which they do.
    let cloudData = NSMutableData(data: cloud)
    let contextData = NSMutableData(data: context)
    let validityData = NSMutableData(data: validity)

    let shapeCloud: [NSNumber] = [NSNumber(value: 1), NSNumber(value: kDmsNumLandmarks), NSNumber(value: 3)]
    let shapeContext: [NSNumber] = [NSNumber(value: 1), NSNumber(value: DmsVisionGaze.contextFloats)]
    let shapeValidity: [NSNumber] = [NSNumber(value: 1), NSNumber(value: kDmsNumLandmarks)]

    do {
      let cloudValue = try ORTValue(tensorData: cloudData,
                                    elementType: ORTTensorElementDataType.float,
                                    shape: shapeCloud)
      let contextValue = try ORTValue(tensorData: contextData,
                                      elementType: ORTTensorElementDataType.float,
                                      shape: shapeContext)
      let validityValue = try ORTValue(tensorData: validityData,
                                       elementType: ORTTensorElementDataType.float,
                                       shape: shapeValidity)
      let outputNames: Set<String> = ["gaze", "rotation"]
      let outputs = try session.run(withInputs: ["cloud": cloudValue,
                                                 "context": contextValue,
                                                 "validity": validityValue],
                                    outputNames: outputNames,
                                    runOptions: nil)
      guard let gaze = outputs["gaze"], let rotation = outputs["rotation"] else {
        throw DmsVisionException("the ONNX session did not return both outputs")
      }
      let gazeBytes = try gaze.tensorData() as Data
      let rotationBytes = try rotation.tensorData() as Data
      guard gazeBytes.count == 3 * 4, rotationBytes.count == 9 * 4 else {
        throw DmsVisionException("unexpected output sizes: gaze \(gazeBytes.count) B, rotation \(rotationBytes.count) B")
      }
      var out = Data(capacity: DmsVisionGaze.outputFloats * 4)
      out.append(gazeBytes)
      out.append(rotationBytes)
      return out
    } catch let error as DmsVisionException {
      throw error
    } catch {
      throw DmsVisionException("gaze inference failed: \(error.localizedDescription)")
    }
  }

  private static func checkLength(_ data: Data, _ floats: Int, _ name: String) throws {
    if data.count != floats * 4 {
      throw DmsVisionException("\(name) must be \(floats) float32 (\(floats * 4) bytes), got \(data.count)")
    }
  }
}
