// The row journal (plan §3.2): one append-only NDJSON file per drive,
// <Application Support>/drivesense/journal/<driveId>.ndjson, excluded from backup and protected
// only until the first unlock, so rows keep landing with the phone locked. A `start` line, every row
// with its `seq` (1 and up), a `gap` line where a relaunch resumed the drive, an `end` line. fsync on
// `start`, `gap`, `end` and every `JOURNAL_SYNC_EVERY_ROWS` rows: a crash loses nothing, a power
// loss at most 30 s. At most `JOURNAL_MAX_DRIVES` files: opening one more deletes the oldest ended
// file JS never drained (counted for `journalDropped`). A file is deleted only by `discardDrive` (JS,
// once the trip is finalized) or a cancelled drive. No file timestamps, sizes from attributes or
// disk-space reads (the privacy manifest declares none). Reading is in RowJournalRead.swift.
//
// Every file operation runs on one serial queue, in the order called; completions run on main.
import Foundation

final class RowJournal {
  static let shared = RowJournal()

  let queue = DispatchQueue(label: "drivesense.journal", qos: .utility)
  /// Journal queue only.
  private var handle: FileHandle?
  private var openId: String?
  private var bytes = 0
  private var rowsSinceSync = 0
  /// Rows not written: the size cap, or a write that failed (diagnostics).
  private(set) var droppedRows = 0
  /// `readRows`' place in each file: the last seq read and the byte offset after its line.
  var cursors: [String: (seq: Int, offset: UInt64)] = [:]

  private init() {}

  static var directory: URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("drivesense", isDirectory: true)
      .appendingPathComponent("journal", isDirectory: true)
  }

  static func url(_ driveId: String) -> URL? {
    directory?.appendingPathComponent("\(driveId).ndjson")
  }

  /// The JSON of `obj` and a newline; nil for anything JSON cannot hold (a NaN never reaches disk).
  static func encode(_ obj: [String: Any]) -> Data? {
    guard JSONSerialization.isValidJSONObject(obj), var d = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return nil }
    d.append(0x0A)
    return d
  }

  /// The directory, created excluded from backup and protected until the first unlock. Journal queue.
  private func ensureDirectory() -> Bool {
    guard var dir = Self.directory else { return false }
    let fm = FileManager.default
    if !fm.fileExists(atPath: dir.path) {
      let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
      guard (try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: protection)) != nil else { return false }
    }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? dir.setResourceValues(values)
    return true
  }

  /// Every journal file: (driveId, url). Journal queue.
  func files() -> [(id: String, url: URL)] {
    guard let dir = Self.directory, let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
    return names.filter { $0.hasSuffix(".ndjson") }.map { (id: String($0.dropLast(7)), url: dir.appendingPathComponent($0)) }
  }

  // MARK: - Writing

  /// A new drive's file with its `start` line, fsynced, and open for rows. When `JOURNAL_MAX_DRIVES`
  /// files are already there the oldest ended one goes first. `done(dropped)` on main.
  func open(_ driveId: String, start: [String: Any], done: @escaping (Int) -> Void) {
    queue.async {
      self.closeHandle()
      let dropped = self.rotate(keepingRoomFor: driveId)
      if self.ensureDirectory(), let url = Self.url(driveId), let line = Self.encode(start) {
        let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        if FileManager.default.createFile(atPath: url.path, contents: line, attributes: protection) {
          self.attach(driveId, url)
          self.sync()
        }
      }
      DispatchQueue.main.async { done(dropped) }
    }
  }

  /// A relaunch resumes `driveId`: a torn last line is cut off, the file opens for rows again, and
  /// `done` gets what the file holds (nil when there is none), on main.
  func reopen(_ driveId: String, done: @escaping (JournalSummary?) -> Void) {
    queue.async {
      self.closeHandle()
      guard let url = Self.url(driveId), let s = self.summary(url) else {
        DispatchQueue.main.async { done(nil) }
        return
      }
      if s.cleanEnd < s.bytes, let w = try? FileHandle(forWritingTo: url) {
        try? w.truncate(atOffset: s.cleanEnd)
        try? w.close()
      }
      self.attach(driveId, url)
      DispatchQueue.main.async { done(s) }
    }
  }

  /// One row line: the `row` payload with its `seq`. fsynced every `JOURNAL_SYNC_EVERY_ROWS` rows.
  func appendRow(_ driveId: String, _ body: [String: Any]) {
    queue.async {
      guard self.openId == driveId, let h = self.handle else { return }
      var line = body
      line["k"] = "row"
      guard let data = Self.encode(line), self.bytes + data.count <= DetectPolicy.JOURNAL_MAX_BYTES_PER_DRIVE else {
        self.droppedRows += 1
        return
      }
      do {
        try h.write(contentsOf: data)
        self.bytes += data.count
      } catch {
        self.droppedRows += 1
        return
      }
      self.rowsSinceSync += 1
      if self.rowsSinceSync >= DetectPolicy.JOURNAL_SYNC_EVERY_ROWS { self.sync() }
    }
  }

  /// A `gap` or `end` line, fsynced; `close` closes the file after it (the `end`).
  func appendMarker(_ driveId: String, _ line: [String: Any], close: Bool, done: (() -> Void)? = nil) {
    queue.async {
      if self.openId == driveId, let h = self.handle, let data = Self.encode(line) {
        try? h.write(contentsOf: data)
        self.bytes += data.count
        self.sync()
      }
      if close && self.openId == driveId { self.closeHandle() }
      if let done = done { DispatchQueue.main.async(execute: done) }
    }
  }

  /// Deletes the file (a cancelled drive, or JS done with it). Resolves on main even when none exists.
  func delete(_ driveId: String, done: (() -> Void)? = nil) {
    queue.async {
      if self.openId == driveId { self.closeHandle() }
      self.cursors[driveId] = nil
      if let url = Self.url(driveId) { try? FileManager.default.removeItem(at: url) }
      if let done = done { DispatchQueue.main.async(execute: done) }
    }
  }

  private func attach(_ driveId: String, _ url: URL) {
    guard let h = try? FileHandle(forWritingTo: url) else { return }
    let end = (try? h.seekToEnd()) ?? 0
    handle = h
    openId = driveId
    bytes = Int(end)
    rowsSinceSync = 0
  }

  private func sync() {
    try? handle?.synchronize()
    rowsSinceSync = 0
  }

  private func closeHandle() {
    if let h = handle {
      try? h.synchronize()
      try? h.close()
    }
    handle = nil
    openId = nil
    bytes = 0
    rowsSinceSync = 0
  }

  /// At `JOURNAL_MAX_DRIVES` files the oldest ended one (by its start) goes. Returns how many went.
  private func rotate(keepingRoomFor driveId: String) -> Int {
    var list = files().filter { $0.id != driveId }
    var dropped = 0
    while list.count >= DetectPolicy.JOURNAL_MAX_DRIVES {
      let ended = list.compactMap { f -> (id: String, url: URL, startedAt: Double)? in
        guard let s = summary(f.url), s.end != nil else { return nil }
        return (id: f.id, url: f.url, startedAt: jsonNumber(s.start["startedAt"]) ?? 0)
      }
      guard let oldest = ended.min(by: { $0.startedAt < $1.startedAt }) else { break }
      try? FileManager.default.removeItem(at: oldest.url)
      cursors[oldest.id] = nil
      list.removeAll { $0.id == oldest.id }
      dropped += 1
    }
    return dropped
  }
}
