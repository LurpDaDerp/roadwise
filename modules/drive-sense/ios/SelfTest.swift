// `selfTest(vectorsJson)` (README §8 "Self-test protocol").
//
// Runs the PRODUCTION extractor — the same `FeatureExtractor` class and the same `ExtractedRow`
// payload encoding the capture path emits — over each golden vector's inputs, exactly as
// `runVector` in `src/extract/vectors.ts` does (fresh state per vector). JS diffs the output with
// `diffSelfTest`. iOS has no gravity filter and no raw-accelerometer path (CoreMotion supplies
// gravity and user acceleration), so `gravityFilter` and `androidRaw` vectors get `skipped`.
import Foundation

enum SelfTest {
  struct InvalidInput: Error {
    let message: String
  }

  private struct VectorError: Error {
    let message: String
  }

  private static let skipReason =
    "iOS has no gravity filter or raw-accelerometer path: CoreMotion supplies gravity and user acceleration"

  /// The output JSON string. Throws `InvalidInput` only when `json` is not a JSON array at all.
  static func run(_ json: String) throws -> String {
    guard let data = json.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data, options: []),
          let vectors = parsed as? [Any] else {
      throw InvalidInput(message: "the vectors JSON is not a JSON array")
    }
    var results: [[String: Any]] = []
    for (i, raw) in vectors.enumerated() {
      let v = raw as? [String: Any]
      let name = (v?["name"] as? String) ?? "vector \(i)"
      let kind = (v?["kind"] as? String) ?? "unknown"
      switch kind {
      case "extract":
        do {
          results.append(["name": name, "kind": kind, "rows": try runExtract(v?["inputs"])])
        } catch let e as VectorError {
          results.append(["name": name, "kind": kind, "error": e.message])
        }
      case "gravityFilter", "androidRaw":
        results.append(["name": name, "kind": kind, "skipped": skipReason])
      default:
        results.append(["name": name, "kind": kind, "error": "unknown vector kind \(kind)"])
      }
    }
    let output: [String: Any] = ["version": 1, "platform": "ios", "results": results]
    let out = try JSONSerialization.data(withJSONObject: output, options: [])
    return String(data: out, encoding: .utf8) ?? "{}"
  }

  /// Feeds `inputs.seconds` in order to one fresh `FeatureExtractor`.
  private static func runExtract(_ inputs: Any?) throws -> [[String: Any]] {
    guard let seconds = (inputs as? [String: Any])?["seconds"] as? [Any] else {
      throw VectorError(message: "inputs.seconds is missing")
    }
    let extractor = FeatureExtractor()
    var rows: [[String: Any]] = []
    for (i, rawSecond) in seconds.enumerated() {
      guard let s = rawSecond as? [String: Any],
            let tsMs = jsonNumber(s["tsMs"]), tsMs.isFinite, abs(tsMs) <= 9_007_199_254_740_991,
            let imuRaw = s["imu"] as? [Any],
            let phone = parsePhone(s["phone"]) else {
        throw VectorError(message: "seconds[\(i)] is malformed")
      }
      var imu: [ImuSample] = []
      imu.reserveCapacity(imuRaw.count)
      for (j, r) in imuRaw.enumerated() {
        guard let o = r as? [String: Any], let t = jsonNumber(o["t"]),
              let ua = Vec3(json: o["ua"]), let g = Vec3(json: o["g"]), let w = Vec3(json: o["w"]) else {
          throw VectorError(message: "seconds[\(i)].imu[\(j)] is malformed")
        }
        imu.append(ImuSample(t: t, ua: ua, g: g, w: w))
      }
      var fix: FixSample?
      if let f = s["fix"], !(f is NSNull) {
        guard let parsed = parseFix(f) else { throw VectorError(message: "seconds[\(i)].fix is malformed") }
        fix = parsed
      }
      let row = extractor.extractSecond(imu: imu, fix: fix, phone: phone, tsMs: tsMs)
      if let bad = row.firstNonFiniteField {
        throw VectorError(message: "rows[\(i)].\(bad) is not finite")
      }
      rows.append(row.payload)
    }
    return rows
  }

  private static func parsePhone(_ v: Any?) -> PhoneSample? {
    guard let o = v as? [String: Any], let locked = jsonBool(o["locked"]),
          let screenOn = jsonBool(o["screenOn"]), let fg = jsonBool(o["appForeground"]) else { return nil }
    return PhoneSample(locked: locked, screenOn: screenOn, appForeground: fg)
  }

  private static func parseFix(_ v: Any) -> FixSample? {
    guard let o = v as? [String: Any] else { return nil }
    let keys = ["t", "lat", "lng", "hAcc", "speed", "speedAcc", "course", "alt"]
    let n = keys.map { jsonNumber(o[$0]) }
    guard n.allSatisfy({ $0 != nil }) else { return nil }
    return FixSample(t: n[0]!, lat: n[1]!, lng: n[2]!, hAcc: n[3]!, speed: n[4]!, speedAcc: n[5]!, course: n[6]!, alt: n[7]!)
  }
}
