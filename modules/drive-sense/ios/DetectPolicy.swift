// The drive detector's rules (plan §3.3): the Swift mirror of `src/detect/policy.ts`, constant for
// constant (the native text test compares every name and value) and rule for rule. Pure: Foundation
// only, no clock, no platform. `DriveDetector` reads the phone and acts; this decides. The shared
// decision table (`src/detect/vectors.ts`) runs through these very functions on the phone
// (`DetectSelfTest`). The safety stop and suppression are in DetectEndPolicy.swift.
import Foundation

/// The row fields the detector reads (`DetectRow` in policy.ts).
struct DetectRow {
  var ts: Double
  var lat: Double
  var lng: Double
  var hAcc: Double
  var speed: Double
  var speedAcc: Double
  var gnssValid: Bool
}

/// The hold in progress: when its run of fast rows began, and when the current dip began.
struct ConfirmState: Equatable {
  var runStartTs: Double?
  var dipStartTs: Double?
}

/// Where a confirmed drive begins, and the first kept row (an index into the rows given).
struct TracedStart: Equatable {
  var index: Int
  var startedAt: Double
  /// "trace" | "motion" | "wake"
  var startSource: String
  var startLat: Double?
  var startLng: Double?
}

/// The last committed end: when it was decided, the cut, the place.
struct DetectLastEnd: Codable, Equatable {
  var decidedAt: Double
  var cut: Double
  var lat: Double
  var lng: Double
  var driveId: String
}

/// One motion-history sample as the wake reads it.
struct DetectActivity {
  var start: Double
  var automotive: Bool
  /// A car standing still is no car motion.
  var stationary: Bool
  /// walking, running or cycling
  var onFoot: Bool
  var confident: Bool
}

struct DetectMotion: Equatable {
  var lastAutomotiveAt: Double
  var automotiveSince: Double
  var onFootNow: Bool
}

struct WakeCtx {
  var now: Double
  /// "slc" | "region" | "visit"
  var reason: String
  var phase: String
  var armed: Bool
  var hasOwner: Bool
  var permissionsOk: Bool
  var candidateRestUntil: Double
  var candidateStarts: [Double]
}

struct StatusInputs {
  var armed: Bool
  var hardware: Bool
  /// "none" | "whenInUse" | "always"
  var location: String
  var precise: Bool
  var motion: String
  var backgroundRefresh: String
  var liveActivities: Bool
}

enum DetectPolicy {
  static let CONFIRM_MPS_AUTO: Double = 6.7056
  static let CONFIRM_HOLD_MS_AUTO: Double = 30_000
  static let CONFIRM_MPS_MANUAL: Double = 4.4704
  static let CONFIRM_HOLD_MS_MANUAL: Double = 15_000
  static let CONFIRM_DIP_MAX_MS: Double = 5_000
  static let VETO_FRESH_MS: Double = 30_000
  static let TRUSTED_HACC_M: Double = 30
  static let TRUSTED_SPEED_ACC_MPS: Double = 2
  static let STOP_MPS: Double = 1.34112
  static let MOVING_MPS: Double = 4.4704
  static let MOVE_MPS: Double = 2.2352
  static let MOVE_PACE_ROWS: Int = 2
  static let MOVE_DISPLACEMENT_M: Double = 100
  static let TRACE_STOP_SPLIT_MS: Double = 300_000
  static let CANDIDATE_BUFFER_MAX_ROWS: Int = 600
  static let PLAUSIBLE_MPS_MAX: Double = 40
  static let PLAUSIBLE_SLACK_M: Double = 300
  static let AUTOMOTIVE_FRESH_MS: Double = 120_000
  static let MOTION_LOOKBACK_MS: Double = 10_800_000
  static let MOTION_RUN_GAP_MS: Double = 1_800_000
  static let CANDIDATE_MAX_MS: Double = 180_000
  static let CANDIDATE_REST_MS: Double = 600_000
  static let CANDIDATES_PER_HOUR_MAX: Int = 6
  static let HOUR_MS: Double = 3_600_000
  static let PARKED_REGION_RADIUS_M: Double = 150
  static let SLC_STALE_MS: Double = 120_000
  static let VISIT_FRESH_MS: Double = 600_000
  static let WAKE_TASK_MAX_MS: Double = 25_000
  static let RESUME_MAX_GAP_MS: Double = 300_000
  static let WAIT_MAX_MS: Double = 300_000
  static let CONTINUE_GAP_MS: Double = 300_000
  static let CONTINUE_DIST_M: Double = 150
  static let STILL_END_MS: Double = 300_000
  static let WALK_CONFIRM_MS: Double = 20_000
  static let WALK_STALE_FIX_MS: Double = 60_000
  static let END_CRAWL_MPS: Double = 1.34112
  static let SAFETY_SLACK_MS: Double = 60_000
  static let FIXLESS_HOLD_MAX_MS: Double = 3_600_000
  static let ACTIVITY_FRESH_MS: Double = 60_000
  static let ROW_MS: Double = 1_000
  static let MAX_DRIVE_MS: Double = 43_200_000
  static let SUPPRESS_MAX_MS: Double = 10_800_000
  static let SUPPRESS_STILL_MS: Double = 300_000
  static let JOURNAL_SYNC_EVERY_ROWS: Int = 30
  static let JOURNAL_MAX_BYTES_PER_DRIVE: Int = 16_777_216
  static let JOURNAL_MAX_DRIVES: Int = 4
  static let READ_ROWS_MAX: Int = 600
  static let TICK_MS: Double = 5_000
  static let FALLBACK_NOTE_DELAY_MS: Double = 20_000
  static let EARTH_RADIUS_M: Double = 6_371_000

  // MARK: - Rows

  /// Valid, within 30 m, speed rated 2 m/s or better (or unrated), speed known.
  static func trusted(_ r: DetectRow) -> Bool {
    r.gnssValid && r.hAcc >= 0 && r.hAcc <= TRUSTED_HACC_M && (r.speedAcc < 0 || r.speedAcc <= TRUSTED_SPEED_ACC_MPS) && r.speed >= 0
  }

  static func slow(_ r: DetectRow) -> Bool { trusted(r) && r.speed <= STOP_MPS }
  static func moving(_ r: DetectRow) -> Bool { trusted(r) && r.speed >= MOVING_MPS }

  /// Great-circle metres (haversine), as policy.ts `distanceM`.
  static func distanceM(_ aLat: Double, _ aLng: Double, _ bLat: Double, _ bLng: Double) -> Double {
    let rad = Double.pi / 180
    let sLat = sin((bLat - aLat) * rad / 2)
    let sLng = sin((bLng - aLng) * rad / 2)
    let h = sLat * sLat + cos(aLat * rad) * cos(bLat * rad) * sLng * sLng
    return 2 * EARTH_RADIUS_M * asin(min(1, h.squareRoot()))
  }

  // MARK: - Confirmation

  static func confirmMps(_ kind: String) -> Double { kind == "auto" ? CONFIRM_MPS_AUTO : CONFIRM_MPS_MANUAL }
  static func confirmHoldMs(_ kind: String) -> Double { kind == "auto" ? CONFIRM_HOLD_MS_AUTO : CONFIRM_HOLD_MS_MANUAL }

  /// policy.ts `confirmStep`: a fast row extends the run and confirms once it spans the hold (unless
  /// vetoed); a slow or untrusted row starts or extends a dip, which breaks the run past 5 s.
  static func confirmStep(_ s: ConfirmState, _ r: DetectRow, _ kind: String, veto: Bool = false) -> (state: ConfirmState, confirmed: Bool) {
    if trusted(r) && r.speed >= confirmMps(kind) {
      let run = s.runStartTs ?? r.ts
      return (ConfirmState(runStartTs: run, dipStartTs: nil), r.ts - run >= confirmHoldMs(kind) && !veto)
    }
    guard let run = s.runStartTs else { return (ConfirmState(), false) }
    let dip = s.dipStartTs ?? r.ts
    if r.ts - dip > CONFIRM_DIP_MAX_MS { return (ConfirmState(), false) }
    return (ConfirmState(runStartTs: run, dipStartTs: dip), false)
  }

  // MARK: - The start

  /// policy.ts `traceStart`: the last trusted row at or under 3 mph before the run, going on back
  /// past a stop shorter than 5 min that had driving before it. Nil when the rows begin moving.
  static func traceStart(_ rows: [DetectRow], _ h: Int) -> Int? {
    var k = min(max(h, 0), rows.count)
    // k falls on every pass, so this ends within rows.count + 1 passes.
    for _ in 0...rows.count {
      guard let s = (0..<k).reversed().first(where: { slow(rows[$0]) }) else { return nil }
      guard let j = (0..<s).reversed().first(where: { moving(rows[$0]) }) else { return s }
      if rows[s].ts - rows[j].ts >= TRACE_STOP_SPLIT_MS { return s }
      k = j
    }
    return nil
  }

  /// policy.ts `startOf`: the traced start, else (auto only) the car motion's start placed at the
  /// last end when reachable, else the first row. `rows` is never empty.
  static func startOf(_ rows: [DetectRow], _ h: Int, _ kind: String, _ automotiveSince: Double, _ lastEnd: DetectLastEnd?) -> TracedStart {
    if let s = traceStart(rows, h) {
      let r = rows[s]
      return TracedStart(index: s, startedAt: r.ts, startSource: "trace", startLat: r.lat, startLng: r.lng)
    }
    let first = rows[0]
    if kind == "auto" && automotiveSince > 0 && automotiveSince < first.ts {
      var plausible = false
      if let e = lastEnd, let ref = rows.first(where: { trusted($0) }) {
        plausible = distanceM(e.lat, e.lng, ref.lat, ref.lng) <= PLAUSIBLE_MPS_MAX * (ref.ts - automotiveSince) / 1000 + PLAUSIBLE_SLACK_M
      }
      return TracedStart(index: 0, startedAt: automotiveSince, startSource: "motion", startLat: plausible ? lastEnd?.lat : nil, startLng: plausible ? lastEnd?.lng : nil)
    }
    let ok = trusted(first)
    return TracedStart(index: 0, startedAt: first.ts, startSource: "wake", startLat: ok ? first.lat : nil, startLng: ok ? first.lng : nil)
  }

  /// policy.ts `continuesFrom`: within 5 min of the last end's decision and 150 m of its place.
  static func continuesFrom(_ e: DetectLastEnd?, _ startedAt: Double, _ lat: Double?, _ lng: Double?) -> Bool {
    guard let e = e, let lat = lat, let lng = lng else { return false }
    return startedAt - e.decidedAt <= CONTINUE_GAP_MS && distanceM(e.lat, e.lng, lat, lng) <= CONTINUE_DIST_M
  }

  // MARK: - Wakes

  /// policy.ts `summarize`: each sample lasts until the next; 30 min without car motion starts a new run.
  static func summarize(_ list: [DetectActivity], _ now: Double) -> DetectMotion {
    let sorted = list.sorted { $0.start < $1.start }
    var out = DetectMotion(lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false)
    for (i, a) in sorted.enumerated() {
      let end = i + 1 < sorted.count ? sorted[i + 1].start : now
      out.onFootNow = a.onFoot && a.confident
      if a.automotive && !a.stationary && a.confident {
        if out.automotiveSince == 0 || a.start - out.lastAutomotiveAt >= MOTION_RUN_GAP_MS { out.automotiveSince = a.start }
        out.lastAutomotiveAt = end
      }
    }
    return out
  }

  /// "ok", "notFresh" or "onFoot".
  static func motionGate(_ m: DetectMotion, _ now: Double) -> String {
    if m.lastAutomotiveAt <= 0 || now - m.lastAutomotiveAt > AUTOMOTIVE_FRESH_MS { return "notFresh" }
    if m.onFootNow { return "onFoot" }
    return "ok"
  }

  static func recentStarts(_ starts: [Double], _ now: Double) -> [Double] {
    starts.filter { $0 <= now && now - $0 < HOUR_MS }
  }

  /// policy.ts `wakeGate`, in its order.
  static func wakeGate(_ c: WakeCtx) -> String {
    if !c.armed { return "off" }
    if !c.hasOwner { return "noOwner" }
    if !c.permissionsOk { return "permission" }
    if c.phase != "armed" { return "busy" }
    if c.reason != "region" && c.now < c.candidateRestUntil { return "resting" }
    if recentStarts(c.candidateStarts, c.now).count >= CANDIDATES_PER_HOUR_MAX { return "capped" }
    return "ok"
  }

  /// policy.ts `candidateDue`: "timeout", "walking", "waitTimeout" or nil.
  static func candidateDue(_ kind: String, since: Double, waitUntil: Double?, walkSince: Double?, now: Double) -> String? {
    if kind == "manual" {
      guard let w = waitUntil else { return nil }
      return now >= w ? "waitTimeout" : nil
    }
    if now - since >= CANDIDATE_MAX_MS { return "timeout" }
    if let w = walkSince, now - w >= WALK_CONFIRM_MS { return "walking" }
    return nil
  }

  /// policy.ts `resumeDecision`: "resume" or "orphan".
  static func resumeDecision(lastRowTs: Double?, startedAt: Double, now: Double) -> String {
    now - (lastRowTs ?? startedAt) <= RESUME_MAX_GAP_MS ? "resume" : "orphan"
  }

  /// policy.ts `statusOf`.
  static func statusOf(_ p: StatusInputs) -> (status: String, missing: [String], requiredOk: Bool) {
    var required: [String] = []
    if p.location != "always" { required.append("locationAlways") }
    if !p.precise { required.append("locationPrecise") }
    if p.motion != "granted" { required.append("motion") }
    let requiredOk = p.hardware && required.isEmpty
    if !p.armed { return ("off", [], requiredOk) }
    if !p.hardware { return ("unavailable", [], requiredOk) }
    let refreshOff = p.backgroundRefresh != "available"
    if required.isEmpty && !refreshOff { return ("on", [], requiredOk) }
    var missing = required
    if refreshOff { missing.append("backgroundRefresh") }
    if !p.liveActivities { missing.append("liveActivities") }
    return ("needs", missing, requiredOk)
  }
}
