// Reading the row journal (plan §3.2): a file's first line and its last complete lines (for
// `listDrives`, a resume and an orphan's end), and its rows in order after a seq (for `readRows`).
// A torn last line (no newline, or not JSON) is never read, and a row whose seq is not the last one
// plus one is dropped. `readRows` keeps its place in each file, so draining a long drive page by
// page reads it once. Journal queue only, except `list` and `read`, which hop onto it and answer on
// main.
import Foundation

/// What a journal file holds, from its first line and its tail.
struct JournalSummary {
  var start: [String: Any]
  var lastSeq = 0
  var lastRowTs: Double?
  /// The last trusted fix (the parked spot after an orphan end).
  var lastFixLat: Double?
  var lastFixLng: Double?
  var end: [String: Any]?
  var bytes: UInt64 = 0
  /// Where the complete lines end; a torn tail begins here (= `bytes` with none).
  var cleanEnd: UInt64 = 0
}

extension DetectRow {
  /// A `row` payload (or a journal row line) as the detector reads it; nil when a field is missing.
  init?(json value: Any?) {
    guard let o = value as? [String: Any], let ts = jsonNumber(o["ts"]), let lat = jsonNumber(o["lat"]), let lng = jsonNumber(o["lng"]),
          let hAcc = jsonNumber(o["hAcc"]), let speed = jsonNumber(o["speed"]), let speedAcc = jsonNumber(o["speedAcc"]),
          let valid = jsonBool(o["gnssValid"]) else { return nil }
    self.init(ts: ts, lat: lat, lng: lng, hAcc: hAcc, speed: speed, speedAcc: speedAcc, gnssValid: valid)
  }
}

extension RowJournal {
  static let HEAD_BYTES = 8_192
  static let TAIL_BYTES: UInt64 = 65_536
  static let READ_CHUNK_BYTES = 131_072

  static func object(_ data: Data) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
  }

  /// A file's start, last row, last trusted fix and end, from its first 8 KB and last 64 KB. Journal queue.
  func summary(_ url: URL) -> JournalSummary? {
    guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? h.close() }
    guard let size = try? h.seekToEnd(), size > 0, (try? h.seek(toOffset: 0)) != nil,
          let head = try? h.read(upToCount: Self.HEAD_BYTES), let nl = head.firstIndex(of: 0x0A),
          let start = Self.object(head[head.startIndex..<nl]), start["k"] as? String == "start" else { return nil }
    var s = JournalSummary(start: start)
    s.bytes = size
    s.cleanEnd = size
    let from = size > Self.TAIL_BYTES ? size - Self.TAIL_BYTES : 0
    guard (try? h.seek(toOffset: from)) != nil, let tail = try? h.read(upToCount: Int(size - from)), let lastNl = tail.lastIndex(of: 0x0A) else {
      return s
    }
    s.cleanEnd = from + UInt64(tail.distance(from: tail.startIndex, to: lastNl) + 1)
    var lines = tail[tail.startIndex..<lastNl].split(separator: 0x0A)
    // A tail that begins mid-file begins mid-line.
    if from > 0, !lines.isEmpty { lines.removeFirst() }
    for line in lines.reversed() {
      guard let o = Self.object(line), let k = o["k"] as? String else { continue }
      if k == "end" && s.end == nil { s.end = o }
      guard k == "row" else { continue }
      if s.lastRowTs == nil {
        s.lastSeq = (o["seq"] as? NSNumber)?.intValue ?? 0
        s.lastRowTs = jsonNumber(o["ts"])
      }
      if let r = DetectRow(json: o), DetectPolicy.trusted(r) {
        s.lastFixLat = r.lat
        s.lastFixLng = r.lng
        break
      }
    }
    if let n = (s.end?["lastSeq"] as? NSNumber)?.intValue { s.lastSeq = n }
    return s
  }

  /// `listDrives`: every journal file as a `JournaledDrive` (src/detect/types.ts), on main.
  func list(_ done: @escaping ([[String: Any]]) -> Void) {
    queue.async {
      var out: [[String: Any]] = []
      for f in self.files() {
        if let s = self.summary(f.url) { out.append(Self.listed(f.id, s)) }
      }
      let drives = out
      DispatchQueue.main.async { done(drives) }
    }
  }

  static func listed(_ id: String, _ s: JournalSummary) -> [String: Any] {
    let st = s.start
    var ended: Any = NSNull()
    if let e = s.end {
      let endInfo: [String: Any] = ["endedAt": e["endedAt"] ?? 0, "cause": e["cause"] ?? "orphan", "decidedAt": e["decidedAt"] ?? 0]
      ended = endInfo
    }
    return [
      "driveId": id,
      "origin": st["origin"] ?? "auto",
      "startedAt": st["startedAt"] ?? 0,
      "startSource": st["startSource"] ?? "wake",
      "startLat": st["startLat"] ?? NSNull(),
      "startLng": st["startLng"] ?? NSNull(),
      "continues": st["continues"] ?? false,
      "confirmedAt": st["confirmedAt"] ?? 0,
      "firstSeq": 1,
      "lastSeq": s.lastSeq,
      "lastRowTs": s.lastRowTs.map { NSNumber(value: Int64($0)) as Any } ?? NSNull(),
      "bytes": NSNumber(value: Int64(s.bytes)),
      "ended": ended,
    ]
  }

  /// `readRows`: the rows after `afterSeq`, in order, at most `limit`, and whether the file holds no
  /// more. On main.
  func read(_ driveId: String, afterSeq: Int, limit: Int, done: @escaping ([[String: Any]], Int, Bool) -> Void) {
    queue.async {
      let r = self.readNow(driveId, afterSeq: afterSeq, limit: limit)
      DispatchQueue.main.async { done(r.rows, r.lastSeq, r.done) }
    }
  }

  private func readNow(_ driveId: String, afterSeq: Int, limit: Int) -> (rows: [[String: Any]], lastSeq: Int, done: Bool) {
    guard let url = Self.url(driveId), let h = try? FileHandle(forReadingFrom: url) else { return ([], afterSeq, true) }
    defer { try? h.close() }
    var last = 0
    var offset: UInt64 = 0
    if let c = cursors[driveId], c.seq <= afterSeq {
      last = c.seq
      offset = c.offset
    }
    guard (try? h.seek(toOffset: offset)) != nil else { return ([], afterSeq, true) }
    var rows: [[String: Any]] = []
    var lastSeq = afterSeq
    var buf = Data()
    var bufAt = offset
    while let chunk = try? h.read(upToCount: Self.READ_CHUNK_BYTES), !chunk.isEmpty {
      buf.append(chunk)
      var lineStart = buf.startIndex
      while let nl = buf[lineStart...].firstIndex(of: 0x0A) {
        let lineEnd = bufAt + UInt64(buf.distance(from: buf.startIndex, to: nl) + 1)
        if let o = Self.object(buf[lineStart..<nl]), o["k"] as? String == "row", let seq = (o["seq"] as? NSNumber)?.intValue, seq == last + 1 {
          last = seq
          if seq > afterSeq {
            var row = o
            row.removeValue(forKey: "k")
            rows.append(row)
            lastSeq = seq
            if rows.count >= limit {
              cursors[driveId] = (seq: seq, offset: lineEnd)
              return (rows, lastSeq, false)
            }
          }
        }
        lineStart = buf.index(after: nl)
      }
      bufAt += UInt64(buf.distance(from: buf.startIndex, to: lineStart))
      buf = Data(buf[lineStart...])
    }
    cursors[driveId] = (seq: last, offset: bufAt)
    return (rows, lastSeq, true)
  }
}
