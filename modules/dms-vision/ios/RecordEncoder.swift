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

/// Collects records and hands out `frames` payloads. There is no timer: after each append the batch
/// is flushed when the NEXT frame could not arrive before it turns BATCH_MS old (Task 3 review I1;
/// src/reference/batcher.ts, pinned by the `batcher-flush` vector). Pure: the caller supplies the
/// clock the records are on (host-time ms) and the wall clock read together with it.
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

  /// `intervalMs` = 1000 / the capture cap. At ≤ 10 fps every record flushes as it is appended; at
  /// 15 fps a batch holds two. The subtraction comes first, so it is exactly 0 at the first record.
  func isDue(nowMs: Double, intervalMs: Double) -> Bool {
    return !records.isEmpty && nowMs - startedAtMs + intervalMs >= Double(DmsConstants.BATCH_MS)
  }

  var count: Int { return records.count }

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
