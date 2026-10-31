// The car link (round 11): which Bluetooth or CarPlay outputs the phone's audio route has now, the
// cars the driver paired, and what each drive saw. Read-only: it reads `AVAudioSession.currentRoute`
// and observes the route-change notification, and never sets a category, activates the session,
// picks an input or changes an option, so nothing of the driver's audio, calls or connections moves;
// no CoreBluetooth, no Bluetooth prompt. Under the app's audio category a car that connects only for
// calls (HFP) may not show in the route at all. The record (UserDefaults "drivesense.carLink", JSON)
// holds at most CARS_MAX paired cars, the outputs current for most of each of the last
// CAR_DRIVES_KEPT drives that reached driving speed (JS's "Is <name> your car?"), and the uids the
// driver said are not their car: the detector reads it with no JS, a relaunch keeps it, and `wipe`
// (sign-out, account switch) empties it. Pairing happens only from the driver's tap in JS, never
// silently. Main thread only.
import AVFoundation
import Foundation

struct PairedCar: Codable, Equatable {
  var uid: String
  var name: String
  var type: String
  var pairedAt: Double
}

/// A drive that reached driving speed, and the outputs current for most of its rows.
struct CarDriveSeen: Codable, Equatable {
  var driveId: String
  var endedAt: Double
  var outputs: [CarOutput]
}

struct CarLinkRecord: Codable {
  var v = 1
  var cars: [PairedCar] = []
  var notMine: [String] = []
  /// Oldest first.
  var drives: [CarDriveSeen] = []

  static let key = "drivesense.carLink"

  /// The stored record; nil when nothing is stored or it cannot be read now (before the first unlock).
  static func load() -> CarLinkRecord? {
    guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(CarLinkRecord.self, from: data)
  }

  func save() {
    if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
  }
}

final class CarLink {
  static let shared = CarLink()

  /// The route's Bluetooth and CarPlay outputs as last read.
  private(set) var current: [CarOutput] = []
  private(set) var rec = CarLinkRecord()
  /// A paired car or CarPlay is current (`DetectPolicy.carLinked`).
  private(set) var linked = false
  /// When the link last went away; nil while it is up, and from each drive's start until it drops.
  private var unlinkedSince: Double?
  /// The live drive: its rows, how many of them each output was current for, and whether the link was up during it.
  private var driving = false
  private var rows = 0
  private var seen: [String: (output: CarOutput, rows: Int)] = [:]
  private var linkedThisDrive = false
  /// The route, the link or the record changed (the detector tells JS).
  var onChange: (() -> Void)?
  private var observer: NSObjectProtocol?

  private init() {
    reload()
    observer = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.refresh() }
  }

  /// The record read again (a relaunch, the first unlock after a reboot), then the route.
  func reload() {
    if let r = CarLinkRecord.load() { rec = r }
    refresh(force: true)
  }

  /// The audio route's Bluetooth and CarPlay outputs, read and nothing else.
  static func read() -> [CarOutput] {
    AVAudioSession.sharedInstance().currentRoute.outputs.compactMap { p -> CarOutput? in
      guard let type = portType(p.portType) else { return nil }
      return CarOutput(uid: capped(p.uid, 256), name: capped(p.portName, 128), type: type)
    }
  }

  /// At most `limit` UTF-16 units (what JS counts), cut between whole characters, never inside one.
  static func capped(_ s: String, _ limit: Int) -> String {
    guard s.utf16.count > limit else { return s }
    var out = ""
    var units = 0
    for c in s {
      let k = String(c).utf16.count
      if units + k > limit { break }
      out.append(c)
      units += k
    }
    return out
  }

  private static func portType(_ t: AVAudioSession.Port) -> String? {
    switch t {
    case .bluetoothA2DP: return "bluetoothA2DP"
    case .bluetoothHFP: return "bluetoothHFP"
    case .bluetoothLE: return "bluetoothLE"
    case .carAudio: return "carAudio"
    default: return nil
    }
  }

  /// Reads the route. A paired car is matched on its uid; its newest name is kept. The link going
  /// away dates `unlinkedSince`; coming back clears it (a flap leaves nothing behind).
  func refresh(force: Bool = false) {
    let next = Self.read()
    var changed = force || next != current
    current = next
    for o in next where !o.name.isEmpty {
      guard let i = rec.cars.firstIndex(where: { $0.uid == o.uid }), rec.cars[i].name != o.name else { continue }
      rec.cars[i].name = o.name
      rec.save()
      changed = true
    }
    let was = linked
    linked = DetectPolicy.carLinked(next, paired: rec.cars.map { $0.uid })
    if linked {
      unlinkedSince = nil
      if driving { linkedThisDrive = true }
    } else if was {
      unlinkedSince = DriveDetector.now()
    }
    if changed || was != linked { onChange?() }
  }

  /// For the car-link end (round 11 E): since when the link has been gone, continuously, during a
  /// drive that had it; nil while a paired car or CarPlay is current, outside a drive, or when the
  /// link was never up during this one. A flap (gone, back within seconds) clears it, so an end rule
  /// that waits on it (15 s, no fix over 3 mph) never fires on one.
  var goneSince: Double? { driving && linkedThisDrive && !linked ? unlinkedSince : nil }

  // MARK: - Drives

  /// A drive begins (or resumes after a relaunch): its tally starts empty.
  func beginDrive() {
    refresh()
    driving = true
    rows = 0
    seen = [:]
    linkedThisDrive = linked
    unlinkedSince = nil
  }

  /// One row of the live drive: each current output counts it.
  func countRow() {
    guard driving else { return }
    rows += 1
    for o in current { seen[o.uid] = (o, (seen[o.uid]?.rows ?? 0) + 1) }
  }

  /// The drive ended. One that reached driving speed (`drove`) keeps the outputs current for most of
  /// its rows (`DetectPolicy.carMostOfDrive`), the newest CAR_DRIVES_KEPT; "Not driving?" keeps nothing.
  func endDrive(driveId: String, endedAt: Double, drove: Bool) {
    let total = rows
    let outputs = seen.values.filter { DetectPolicy.carMostOfDrive($0.rows, total) }.map { $0.output }.sorted { $0.uid < $1.uid }
    let keep = driving && drove && total >= DetectPolicy.CAR_DRIVE_MIN_ROWS
    driving = false
    rows = 0
    seen = [:]
    linkedThisDrive = false
    unlinkedSince = nil
    guard keep else { return }
    if let r = CarLinkRecord.load() { rec = r }
    rec.drives = Array((rec.drives + [CarDriveSeen(driveId: driveId, endedAt: endedAt, outputs: outputs)]).suffix(DetectPolicy.CAR_DRIVES_KEPT))
    rec.save()
    onChange?()
  }

  // MARK: - JS (the driver's taps)

  /// Pairs `uid`: an output current now, else one a recent drive saw; at most CARS_MAX, each once.
  /// It leaves the "not my car" list. Anything else changes nothing.
  func pair(_ uid: String) -> [String: Any] {
    if let r = CarLinkRecord.load() { rec = r }
    refresh()
    var known = current.first { $0.uid == uid }
    for d in rec.drives.reversed() where known == nil { known = d.outputs.first { $0.uid == uid } }
    if let o = known, !rec.cars.contains(where: { $0.uid == uid }), rec.cars.count < DetectPolicy.CARS_MAX {
      rec.cars.append(PairedCar(uid: o.uid, name: o.name, type: o.type, pairedAt: DriveDetector.now()))
      rec.notMine.removeAll { $0 == uid }
      rec.save()
      refresh(force: true)
    }
    return json()
  }

  func forget(_ uid: String) -> [String: Any] {
    if let r = CarLinkRecord.load() { rec = r }
    rec.cars.removeAll { $0.uid == uid }
    rec.save()
    refresh(force: true)
    return json()
  }

  /// "Not my car": never suggested again (the newest CAR_NOT_MINE_MAX are kept).
  func notMine(_ uid: String) -> [String: Any] {
    if let r = CarLinkRecord.load() { rec = r }
    if !rec.notMine.contains(uid) { rec.notMine = Array((rec.notMine + [uid]).suffix(DetectPolicy.CAR_NOT_MINE_MAX)) }
    rec.save()
    refresh(force: true)
    return json()
  }

  /// The sign-out and account-switch wipe: no paired car, drive seen or "not my car" stays.
  func wipe() {
    rec = CarLinkRecord()
    UserDefaults.standard.removeObject(forKey: CarLinkRecord.key)
    driving = false
    rows = 0
    seen = [:]
    linkedThisDrive = false
    unlinkedSince = nil
    refresh(force: true)
  }

  /// The route read now, then the state.
  func state() -> [String: Any] {
    refresh()
    return json()
  }

  /// `CarLinkState` (src/detect/types.ts).
  func json() -> [String: Any] {
    let out = { (o: CarOutput) -> [String: Any] in ["uid": o.uid, "name": o.name, "type": o.type] }
    let cars: [[String: Any]] = rec.cars.map { ["uid": $0.uid, "name": $0.name, "type": $0.type, "pairedAt": DetectStateRecord.ms($0.pairedAt)] }
    let drives: [[String: Any]] = rec.drives.map { ["driveId": $0.driveId, "endedAt": DetectStateRecord.ms($0.endedAt), "outputs": $0.outputs.map(out)] }
    return [
      "current": current.map(out),
      "cars": cars,
      "linked": linked,
      "goneSince": DetectStateRecord.ms(goneSince),
      "drives": drives,
      "notMine": rec.notMine,
    ]
  }
}
