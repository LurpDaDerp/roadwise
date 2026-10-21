// The native safety stop and the "Not driving?" rest (plan §3.4, §3.6): the Swift mirror of the end
// half of `src/detect/policy.ts`. JS decides a drive's end and its cut (R1); native stops sensing
// on its own only when JS has not, a minute after a JS rule would have fired, and never computes a
// cut. Pure: Foundation only.
import Foundation

/// What the still clock and the walking veto know, row by row (policy.ts `EndClock`).
struct EndClock: Equatable {
  /// The last movement (the confirmation to begin with).
  var lastMoveTs: Double
  /// Fix-less car time since then, which the still clock does not count.
  var holdMs: Double = 0
  /// Trusted rows over 5 mph in a row.
  var paceRun: Int = 0
  /// Where the car went still.
  var anchorLat: Double?
  var anchorLng: Double?
  /// The last trusted fix.
  var lastFixTs: Double?
  var lastFixMps: Double?
  var lastFixLat: Double?
  var lastFixLng: Double?
}

extension DetectPolicy {
  static func endClockAt(_ ts: Double) -> EndClock { EndClock(lastMoveTs: ts) }

  /// policy.ts `endOnRow`: two trusted rows over 5 mph in a row, or a trusted fix 100 m from where
  /// the car went still, is movement; a row with no valid fix while the phone reports car motion
  /// adds a second to the hold, up to an hour.
  static func endOnRow(_ c0: EndClock, _ r: DetectRow, automotiveNow: Bool) -> EndClock {
    var c = c0
    if trusted(r) {
      c.paceRun = r.speed > MOVE_MPS ? c0.paceRun + 1 : 0
      var far = false
      if let aLat = c0.anchorLat, let aLng = c0.anchorLng {
        far = distanceM(aLat, aLng, r.lat, r.lng) >= MOVE_DISPLACEMENT_M
      }
      c.lastFixTs = r.ts
      c.lastFixMps = r.speed
      c.lastFixLat = r.lat
      c.lastFixLng = r.lng
      if c.paceRun >= MOVE_PACE_ROWS || far {
        c.lastMoveTs = r.ts
        c.holdMs = 0
        c.anchorLat = r.lat
        c.anchorLng = r.lng
      } else if c0.anchorLat == nil {
        c.anchorLat = r.lat
        c.anchorLng = r.lng
      }
      return c
    }
    c.paceRun = 0
    if !r.gnssValid && automotiveNow { c.holdMs = min(FIXLESS_HOLD_MAX_MS, c0.holdMs + ROW_MS) }
    return c
  }

  /// policy.ts `endDue`: `overdue` = a JS rule would have ended the drive by now; `due` = the same
  /// plus the slack. Each "limit", "walking", "still" or nil, in that order of precedence.
  static func endDue(_ c: EndClock, startedAt: Double, now: Double, walkSince: Double?) -> (due: String?, overdue: String?) {
    var carDriving = false
    if let mps = c.lastFixMps, let ts = c.lastFixTs { carDriving = mps > END_CRAWL_MPS && now - ts <= WALK_STALE_FIX_MS }
    let age = now - startedAt
    var walked: Double = -1
    if let w = walkSince, !carDriving { walked = now - w }
    let still = now - c.lastMoveTs - c.holdMs
    func pick(_ slack: Double) -> String? {
      if age >= MAX_DRIVE_MS + slack { return "limit" }
      if walked >= WALK_CONFIRM_MS + slack { return "walking" }
      if still >= STILL_END_MS + slack { return "still" }
      return nil
    }
    return (pick(SAFETY_SLACK_MS), pick(0))
  }

  /// policy.ts `suppressionDue`: "cap", "walking", "still" or nil.
  static func suppressionDue(since: Double, until: Double, lastOverStopTs: Double?, walkSince: Double?, now: Double) -> String? {
    if now >= until { return "cap" }
    if let w = walkSince, now - w >= WALK_CONFIRM_MS { return "walking" }
    if now - max(since, lastOverStopTs ?? since) >= SUPPRESS_STILL_MS { return "still" }
    return nil
  }
}
