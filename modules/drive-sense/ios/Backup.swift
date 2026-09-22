// `excludeFromBackup(uri)` (ruling R4; README §2).
//
// A driver's local record — the SQLite database and the raw per-drive traces — would otherwise be
// copied into iCloud and Finder backups, which on a family phone are often the parent's and which
// survive the uninstall and in-app delete that are meant to be final. Nothing stored locally is
// worth restoring: synced drives come back from the server on the next sign-in.
import Foundation

enum Backup {
  enum Failure: Error {
    /// nothing exists at the URI
    case notFound(String)
    /// the file exists but the flag could not be set
    case failed(String)
  }

  /// A `file://` URI or a plain path → a file URL; nil when it is neither.
  static func fileURL(_ uri: String) -> URL? {
    if uri.hasPrefix("file://") {
      guard let url = URL(string: uri), url.isFileURL else { return nil }
      return url
    }
    guard uri.hasPrefix("/") else { return nil }
    return URL(fileURLWithPath: uri)
  }

  /// Sets `isExcludedFromBackup` on the file or directory (a directory's contents follow it).
  static func exclude(_ uri: String) throws {
    guard var url = fileURL(uri), FileManager.default.fileExists(atPath: url.path) else {
      throw Failure.notFound("nothing exists at \(uri)")
    }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
      try url.setResourceValues(values)
    } catch {
      throw Failure.failed("could not exclude \(uri) from backup: \(error.localizedDescription)")
    }
  }
}
