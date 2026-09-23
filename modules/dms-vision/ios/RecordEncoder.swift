// The frames-batch encoder (README §3–§5; port of wire.ts `buildFrameBatch`). `anchorTMs` is the FIRST
// record's clock value, kept as a Double. Each record's field 0 becomes `tOffMs = tMs − anchorTMs`,
// computed in Double before the Float store (Task 1 review C1). Everything is written as
// little-endian float32. Foundation only.

import Foundation

struct EncodedBatch {
  let anchorTMs: Double
  let n: Int
  let data: Data
}

enum RecordEncoder {
  /// `records` are absolute-form (index 0 = tMs), 38 values each, NaN where not computed.
  static func encode(_ records: [[Double]]) -> EncodedBatch? {
    guard let first = records.first, first.count == DmsConstants.FRAME_STRIDE else { return nil }
    let anchorTMs = first[F.tOffMs]
    var data = Data(capacity: records.count * DmsConstants.FRAME_BYTES)
    for record in records {
      if record.count != DmsConstants.FRAME_STRIDE { return nil }
      for (i, value) in record.enumerated() {
        let v: Float = i == F.tOffMs ? Float(value - anchorTMs) : Float(value)
        var bits = v.bitPattern.littleEndian
        withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
      }
    }
    return EncodedBatch(anchorTMs: anchorTMs, n: records.count, data: data)
  }
}

/// Collects records and hands out a `frames` payload once the batch is BATCH_MS old. Pure: the
/// caller supplies the clock (host-time ms) and the wall clock.
final class Batcher {
  private var records: [[Double]] = []
  private var anchorEpochMs: Double = 0
  private var startedAtMs: Double = 0

  var isEmpty: Bool { return records.isEmpty }

  /// Adds a record. `nowMs` is the host clock the records are on; `epochNowMs` the wall clock read
  /// together with it. The anchor's epoch is derived at the batch's first record.
  func append(_ record: [Double], nowMs: Double, epochNowMs: Double) {
    if records.isEmpty {
      startedAtMs = nowMs
      anchorEpochMs = epochNowMs - (nowMs - record[F.tOffMs])
    }
    records.append(record)
  }

  func isDue(nowMs: Double) -> Bool {
    return !records.isEmpty && nowMs - startedAtMs >= Double(DmsConstants.BATCH_MS)
  }

  /// The `frames` event payload, and resets. nil when empty.
  func flush() -> [String: Any]? {
    defer { records.removeAll(keepingCapacity: true) }
    guard let batch = RecordEncoder.encode(records) else { return nil }
    return [
      "v": DmsConstants.FRAME_WIRE_VERSION,
      "anchorTMs": batch.anchorTMs,
      "anchorEpochMs": anchorEpochMs,
      "n": batch.n,
      "data": batch.data,
    ]
  }

  func clear() {
    records.removeAll(keepingCapacity: true)
  }
}
