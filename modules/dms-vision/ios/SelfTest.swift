// The native half of the self-test (README §8.3). It runs the PRODUCTION classes (FeatureExtractor,
// Roi, HeadPose, RecordEncoder, Batcher, GazeInputAssembler, SubjectStatisticTracker, GazeNetFactory) over the
// golden vectors and returns their outputs; JS diffs them. It never carries a copy of any production
// logic. Foundation only.

import Foundation

enum SelfTest {
  static let platform = "ios"

  /// `vectorsJson`: a JSON array of vectors. Throws DmsError.badArgs if it is not parseable at all.
  static func run(_ vectorsJson: String) throws -> String {
    guard let data = vectorsJson.data(using: .utf8),
          let vectors = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      throw DmsError.badArgs("selfTest needs a JSON array of vectors")
    }
    var net: GazeNetRunner? = nil
    let results: [[String: Any]] = vectors.map { v in
      let name = v["name"] as? String ?? ""
      let kind = v["kind"] as? String ?? ""
      let inputs = v["inputs"] as? [String: Any] ?? [:]
      var result: [String: Any] = ["name": name, "kind": kind]
      do {
        switch kind {
        case "record": result["batch"] = try record(inputs)
        case "gazeInputs": result["frames"] = try gazeInputs(inputs)
        case "statsTracker": result["current"] = try statsTracker(inputs)
        case "headPose": result["poses"] = try headPose(inputs)
        case "batcher": result["cases"] = try batcher(inputs)
        case "onnx":
          if !GazeNetFactory.available {
            result["skipped"] = "gaze net not built"
          } else {
            if net == nil { net = try GazeNetFactory.make() }
            guard let runner = net else { throw DmsError.model("the gaze net could not be created") }
            result["cases"] = try onnx(inputs, runner)
          }
        default: throw DmsError.badArgs("unknown vector kind \(kind)")
        }
      } catch let e as DmsError {
        result = ["name": name, "kind": kind, "error": e.message]
      } catch {
        result = ["name": name, "kind": kind, "error": "\(error)"]
      }
      return result
    }
    net?.close()
    let out: [String: Any] = ["version": 1, "platform": platform, "gazeNetAvailable": GazeNetFactory.available, "results": results]
    let bytes = try JSONSerialization.data(withJSONObject: out)
    return String(data: bytes, encoding: .utf8) ?? "{}"
  }

  // MARK: - JSON helpers

  static func num(_ any: Any?) -> Double? {
    if let n = any as? NSNumber { return n.doubleValue }
    if let d = any as? Double { return d }
    if let i = any as? Int { return Double(i) }
    return nil
  }

  static func nums(_ any: Any?) throws -> [Double] {
    guard let arr = any as? [Any] else { throw DmsError.badArgs("expected an array of numbers") }
    return try arr.map { guard let d = num($0) else { throw DmsError.badArgs("expected a number") }; return d }
  }

  /// null → NaN.
  static func numsOrNaN(_ any: Any?) throws -> [Double] {
    guard let arr = any as? [Any] else { throw DmsError.badArgs("expected an array") }
    return arr.map { num($0) ?? .nan }
  }

  static func optionalNums(_ any: Any?) throws -> [Double]? {
    if any == nil || any is NSNull { return nil }
    return try nums(any)
  }

  // MARK: - Kinds

  static func record(_ inputs: [String: Any]) throws -> [String: Any] {
    guard let images = inputs["images"] as? [[String: Any]], let frames = inputs["frames"] as? [[String: Any]],
          let anchorEpochMs = num(inputs["anchorEpochMs"]) else { throw DmsError.badArgs("record inputs") }
    let pixels: [(w: Int, h: Int, stride: Int, bgra: Bool, bytes: [UInt8])] = try images.map { img in
      guard let w = num(img["w"]), let h = num(img["h"]), let stride = num(img["stride"]),
            let format = img["format"] as? String, let b64 = img["pixels"] as? String,
            let data = Data(base64Encoded: b64) else { throw DmsError.badArgs("record image") }
      guard data.count == Int(stride) * Int(h) else { throw DmsError.badArgs("image bytes ≠ stride·h") }
      return (Int(w), Int(h), Int(stride), format == "bgra", [UInt8](data))
    }
    var records: [[Double]] = []
    for f in frames {
      guard let t = num(f["tMs"]), let i = num(f["image"]), Int(i) < pixels.count,
            let rot = num(f["rotationDeg"]), let latL = num(f["latLandmarkMs"]), let latT = num(f["latTotalMs"]) else {
        throw DmsError.badArgs("record frame")
      }
      let img = pixels[Int(i)]
      let landmarks = try optionalNums(f["landmarks"])
      let matrix = try optionalNums(f["matrix"])
      let netGaze = try optionalNums(f["netGaze"])
      let record: [Double] = img.bytes.withUnsafeBufferPointer { buf in
        // The production reader, with the vector's own stride (Task 2 review I1).
        let src = LumaSource(bytes: buf.baseAddress!, width: img.w, height: img.h, rowBytes: img.stride, bgra: img.bgra)
        return FeatureExtractor.buildRecord(FrameInput(
          tMs: t, bufferW: img.w, bufferH: img.h, rotationDeg: Int(rot), luma: src,
          landmarks: landmarks, matrix: matrix, netGaze: netGaze, latLandmarkMs: latL, latTotalMs: latT))
      }
      records.append(record)
    }
    guard let batch = RecordEncoder.encode(records) else { throw DmsError.badArgs("record encoding") }
    return ["anchorTMs": batch.anchorTMs, "anchorEpochMs": anchorEpochMs, "n": batch.n, "data": batch.data.base64EncodedString()]
  }

  static func gazeInputs(_ inputs: [String: Any]) throws -> [[String: Any]] {
    guard let width = num(inputs["width"]), let height = num(inputs["height"]),
          let focal = num(inputs["focalScale"]), let frames = inputs["frames"] as? [[String: Any]] else {
      throw DmsError.badArgs("gazeInputs inputs")
    }
    let asm = GazeInputAssembler()
    return try frames.map { f in
      guard let tSec = num(f["tSec"]) else { throw DmsError.badArgs("gazeInputs frame") }
      let lm = try nums(f["landmarks"])
      guard let prepared = asm.prepare(lm, width, height, focal) else { throw DmsError.badArgs("degenerate face") }
      let g = FeatureExtractor.geometry(lm, Int(width), Int(height))
      let admitted = asm.admit(prepared.cloud64, tSec, earR: g.right?.ear ?? .nan, earL: g.left?.ear ?? .nan,
                               clippedR: g.right == nil, clippedL: g.left == nil)
      return [
        "cloud": prepared.cloud.map { Double($0) },
        "context": prepared.context.map { Double($0) },
        "validity": prepared.validity.map { Double($0) },
        "admitted": admitted,
      ]
    }
  }

  static func statsTracker(_ inputs: [String: Any]) throws -> [[Double]] {
    let mean = try nums(inputs["trainingMean"])
    guard let warmup = num(inputs["warmup"]), let windowS = num(inputs["windowS"]),
          let pushes = inputs["pushes"] as? [Any] else { throw DmsError.badArgs("statsTracker inputs") }
    let t = try nums(inputs["t"])
    let tracker = SubjectStatisticTracker(trainingMean: mean, warmup: Int(warmup), windowS: windowS)
    return try pushes.enumerated().map { i, p in tracker.push(try numsOrNaN(p), t[i]) }
  }

  static func headPose(_ inputs: [String: Any]) throws -> [Any] {
    guard let cases = inputs["cases"] as? [[String: Any]] else { throw DmsError.badArgs("headPose inputs") }
    return try cases.map { c -> Any in
      guard let rot = num(c["rotationDeg"]) else { throw DmsError.badArgs("headPose case") }
      // The production path: the layout rule, then the pose (Task 2 review I2).
      guard let p = HeadPose.fromAnyLayout(try nums(c["matrix"]), Int(rot)) else { return NSNull() }
      return [p.yaw, p.pitch, p.roll]
    }
  }

  /// The production Batcher over each case's appends; each flush reports which append triggered it.
  static func batcher(_ inputs: [String: Any]) throws -> [[String: Any]] {
    guard let cases = inputs["cases"] as? [[String: Any]] else { throw DmsError.badArgs("batcher inputs") }
    return try cases.map { c in
      guard let interval = num(c["intervalMs"]), let offset = num(c["epochOffsetMs"]),
            let frames = c["frames"] as? [[String: Any]] else { throw DmsError.badArgs("batcher case") }
      let b = Batcher()
      var flushes: [[String: Any]] = []
      for (i, f) in frames.enumerated() {
        guard let t = num(f["tMs"]), let now = num(f["nowMs"]) else { throw DmsError.badArgs("batcher frame") }
        b.append(FeatureExtractor.faceAbsentRecord(t, 0, 0, 0, 0), nowMs: now, epochNowMs: now + offset)
        if b.isDue(nowMs: now, intervalMs: interval) {
          let n = b.count
          guard let p = b.flush() else { throw DmsError.badArgs("batcher flush") }
          flushes.append(["after": i, "n": n, "anchorTMs": p["anchorTMs"] ?? NSNull(), "anchorEpochMs": p["anchorEpochMs"] ?? NSNull()])
        }
      }
      return ["flushes": flushes]
    }
  }

  static func onnx(_ inputs: [String: Any], _ runner: GazeNetRunner) throws -> [[String: Any]] {
    guard let cases = inputs["cases"] as? [[String: Any]] else { throw DmsError.badArgs("onnx inputs") }
    return try cases.map { c in
      let out = try runner.run(cloud: try nums(c["cloud"]).map { Float($0) },
                               context: try nums(c["context"]).map { Float($0) },
                               validity: try nums(c["validity"]).map { Float($0) })
      return ["gaze": out.gaze, "rotation": out.rotation]
    }
  }
}
