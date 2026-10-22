// A candidate's rolling row buffer (plan §3.3): the last `CANDIDATE_BUFFER_MAX_ROWS` rows (30 min
// at 1 Hz, the longest candidate), oldest first, each with its `row` payload. At a confirmation the trace-back reads it and
// the rows from the traced start become the drive's first journaled rows; rows before it (the
// parked car's) are dropped. Main thread only.
import Foundation

struct BufferedRow {
  let row: DetectRow
  /// The `row` event payload (FeatureRow keys + `mock`, `call`), without `seq`.
  let body: [String: Any]
}

struct RowBuffer {
  private(set) var items: [BufferedRow] = []
  let capacity: Int

  init(capacity: Int = DetectPolicy.CANDIDATE_BUFFER_MAX_ROWS) {
    self.capacity = capacity
  }

  var count: Int { items.count }
  var isEmpty: Bool { items.isEmpty }
  var rows: [DetectRow] { items.map { $0.row } }

  mutating func append(_ row: DetectRow, _ body: [String: Any]) {
    items.append(BufferedRow(row: row, body: body))
    if items.count > capacity { items.removeFirst(items.count - capacity) }
  }

  mutating func clear() {
    items.removeAll()
  }

  /// The index of the row stamped `ts` (rows are strictly increasing in time), nil when it has gone.
  func index(ofTs ts: Double) -> Int? {
    items.firstIndex { $0.row.ts == ts }
  }
}
