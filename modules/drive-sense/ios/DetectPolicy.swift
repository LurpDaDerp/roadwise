// The drive detector's rules (plan §3.3): the Swift mirror of `src/detect/policy.ts`, constant for
// constant (the native text test compares every name and value) and rule for rule. Pure: Foundation
// only, no clock, no platform. `DriveDetector` reads the phone and acts; this decides. The shared
// decision table (`src/detect/vectors.ts`) runs through these very functions on the phone
// (`DetectSelfTest`). The confirmation and the start are in DetectStartPolicy.swift, the safety stop
// and suppression in DetectEndPolicy.swift.
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

/// The confirmation in progress (policy.ts `ConfirmState`). The Start card's hold: when its run of
/// fast rows began, and when the current dip began. The auto evidence: how much has built (1
/// confirms), when the first interval that earned since the last forget began (`runStartTs`, where
/// the trace-back starts), the previous row's time and earning rate, the last trusted row over 3 mph.
struct ConfirmState: Equatable {
  var runStartTs: Double?
  var dipStartTs: Double?
  var evidence: Double = 0
  var prevTs: Double?
  var prevRate: Double = 0
  var lastMoveTs: Double?
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
  /// "slc" | "region" | "visit" | "app"
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
  static let AUTO_MIN_MPS: Double = 6.7056
  static let AUTO_HOLD_MS_15: Double = 25_000
  static let AUTO_MPS_20: Double = 8.9408
  static let AUTO_INSTANT_MPS: Double = 13.4112
  static let AUTO_HOLD_MIN_MS: Double = 900
  static let AUTO_ROW_GAP_MAX_MS: Double = 2_000
  static let AUTO_FORGET_MS: Double = 300_000
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
  static let CANDIDATE_BUFFER_MAX_ROWS: Int = 1_800
  static let PLAUSIBLE_MPS_MAX: Double = 40
  static let PLAUSIBLE_SLACK_M: Double = 300
  static let AUTOMOTIVE_FRESH_MS: Double = 120_000
  static let MOTION_LOOKBACK_MS: Double = 10_800_000
  static let MOTION_RUN_GAP_MS: Double = 1_800_000
  static let CANDIDATE_MAX_MS: Double = 180_000
  static let CANDIDATE_CAP_MS: Double = 1_800_000
  static let CANDIDATE_REST_MS: Double = 600_000
  static let CANDIDATES_PER_HOUR_MAX: Int = 6
  static let HOUR_MS: Double = 3_600_000
  static let PARKED_REGION_RADIUS_M: Double = 150
  static let SLC_STALE_MS: Double = 120_000
  static let VISIT_FRESH_MS: Double = 600_000
  static let WAKE_TASK_MAX_MS: Double = 25_000
  static let END_TASK_MAX_MS: Double = 25_000
  static let RESUME_MAX_GAP_MS: Double = 300_000
  static let RESUME_SEQ_GAP: Int = 1_000
  static let WAIT_MAX_MS: Double = 300_000
  static let CONTINUE_GAP_MS: Double = 300_000
  static let CONTINUE_DIST_M: Double = 150
  static let STILL_END_MS: Double = 300_000
  static let WALK_CONFIRM_MS: Double = 20_000
  static let WALK_END_MS: Double = 5_000
  static let WALK_STALE_FIX_MS: Double = 60_000
  static let END_CRAWL_MPS: Double = 1.34112
  static let SAFETY_SLACK_MS: Double = 60_000
  static let FIXLESS_HOLD_MAX_MS: Double = 3_600_000
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
  /// Trusted and at 5 mph or more: the car rolling before a stop (the trace-back).
  static func rolling(_ r: DetectRow) -> Bool { trusted(r) && r.speed >= MOVE_MPS }

  /// Great-circle metres (haversine), as policy.ts `distanceM`.
  static func distanceM(_ aLat: Double, _ aLng: Double, _ bLat: Double, _ bLng: Double) -> Double {
    let rad = Double.pi / 180
    let sLat = sin((bLat - aLat) * rad / 2)
    let sLng = sin((bLng - aLng) * rad / 2)
    let h = sLat * sLat + cos(aLat * rad) * cos(bLat * rad) * sLng * sLng
    return 2 * EARTH_RADIUS_M * asin(min(1, h.squareRoot()))
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

  /// policy.ts `wakeGate`, in its order: a region exit and RoadWise coming to the front ignore the rest.
  static func wakeGate(_ c: WakeCtx) -> String {
    if !c.armed { return "off" }
    if !c.hasOwner { return "noOwner" }
    if !c.permissionsOk { return "permission" }
    if c.phase != "armed" { return "busy" }
    if c.reason != "region" && c.reason != "app" && c.now < c.candidateRestUntil { return "resting" }
    if recentStarts(c.candidateStarts, c.now).count >= CANDIDATES_PER_HOUR_MAX { return "capped" }
    return "ok"
  }

  /// policy.ts `candidateDue`: "cap", "timeout", "walking", "waitTimeout" or nil. An auto candidate
  /// ends at 30 min; 3 min after its last vehicle sign (or after it opened, with none), 5 min once it
  /// holds evidence; or on a walk standing 20 s.
  static func candidateDue(_ kind: String, since: Double, waitUntil: Double?, walkSince: Double?, now: Double,
                           lastVehicleTs: Double? = nil, hasEvidence: Bool = false) -> String? {
    if kind == "manual" {
      guard let w = waitUntil else { return nil }
      return now >= w ? "waitTimeout" : nil
    }
    if now - since >= CANDIDATE_CAP_MS { return "cap" }
    if now - max(since, lastVehicleTs ?? since) >= (hasEvidence ? AUTO_FORGET_MS : CANDIDATE_MAX_MS) { return "timeout" }
    if let w = walkSince, now - w >= WALK_CONFIRM_MS { return "walking" }
    return nil
  }

  /// policy.ts `startsAfter`: a candidate that saw a vehicle leaves the hourly cap's record (its
  /// start, `since`, dropped); only empty ones count.
  static func startsAfter(_ starts: [Double], since: Double, sawVehicle: Bool) -> [Double] {
    sawVehicle ? starts.filter { $0 != since } : starts
  }

  /// policy.ts `resumeDecision`: "resume" or "orphan".
  static func resumeDecision(lastRowTs: Double?, startedAt: Double, now: Double) -> String {
    now - (lastRowTs ?? startedAt) <= RESUME_MAX_GAP_MS ? "resume" : "orphan"
  }

  /// policy.ts `resumeSeq`: a resumed drive's rows go on after the journal's highest seq plus the gap.
  static func resumeSeq(_ topSeq: Int) -> Int { topSeq + RESUME_SEQ_GAP }

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
