// The drive detector's persisted state (plan §3.1.1): UserDefaults "drivesense.detect", JSON, written
// before each transition's side effects and read at every launch. A missing read (the defaults are
// unreadable before the first unlock after a reboot) decides nothing and saves nothing; only JS
// arming or a Start-card wait writes a first record. Also the `DetectState` JS reads.
import Foundation

struct DetectStateRecord: Codable {
  var v = 1
  /// JS armed it (signed in, onboarded) for `ownerId`.
  var armed = false
  var ownerId: String?
  /// off | armed | candidate | recording | ending | suppressed
  var state = "off"
  /// auto | manual, fixed when a candidate opens
  var origin: String?
  /// When the state was entered, epoch ms.
  var since: Double = 0
  /// The live drive: its id (= the JS client_trip_id), traced start and its source.
  var driveId: String?
  var startedAt: Double?
  var startSource: String?
  /// A Start-card wait's deadline.
  var waitUntil: Double?
  var candidateRestUntil: Double = 0
  /// The last hour's candidate starts (the cap).
  var candidateStarts: [Double] = []
  var lastEnd: DetectLastEnd?
  var suppressedSince: Double?
  var suppressedUntil: Double?
  /// Journal files rotated away undrained since the last `getState`.
  var journalDropped = 0

  static let key = "drivesense.detect"

  /// The stored record; nil when nothing is stored or it cannot be read now.
  static func load() -> DetectStateRecord? {
    guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(DetectStateRecord.self, from: data)
  }

  func save() {
    if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
  }

  /// The `DetectState` (src/detect/types.ts), with the permissions now and, for an event, its reason.
  func json(_ p: DetectPermissions, reason: String? = nil) -> [String: Any] {
    let status = DetectPolicy.statusOf(p.inputs(armed: armed))
    var out: [String: Any] = [
      "armed": armed && ownerId != nil && state != "off",
      "ownerId": Self.text(ownerId),
      "state": state,
      "origin": Self.text(origin),
      "driveId": Self.text(state == "recording" || state == "ending" ? driveId : nil),
      "startedAt": Self.ms(state == "recording" || state == "ending" ? startedAt : nil),
      "since": Self.ms(since),
      "waitUntil": Self.ms(state == "candidate" ? waitUntil : nil),
      "lastEnd": lastEnd.map { e -> Any in
        let place: [String: Any] = ["decidedAt": Self.ms(e.decidedAt), "cut": Self.ms(e.cut), "lat": e.lat, "lng": e.lng, "driveId": e.driveId]
        return place
      } ?? NSNull(),
      "suppressedUntil": Self.ms(state == "suppressed" ? suppressedUntil : nil),
      "status": status.status,
      "missing": status.missing,
      "permissions": p.json,
      "journalDropped": journalDropped,
    ]
    if let r = reason { out["reason"] = r }
    return out
  }

  /// An epoch ms as an integer for JS, or null.
  static func ms(_ d: Double?) -> Any {
    guard let d = d, d.isFinite else { return NSNull() }
    return NSNumber(value: Int64(jsRound(Swift.max(0, d))))
  }

  static func text(_ s: String?) -> Any {
    s.map { $0 as Any } ?? NSNull()
  }
}
