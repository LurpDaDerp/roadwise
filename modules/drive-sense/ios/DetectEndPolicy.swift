// The native safety stop and the "Not driving?" rest (plan §3.4, §3.6): the Swift mirror of the end
// half of `src/detect/policy.ts`. JS decides a drive's end and its cut (R1); native stops sensing
// on its own only when JS has not, 10 s after the JS walking end or a minute after another JS rule
// would have fired, and never computes a cut. Pure: Foundation only.
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
  /// The last row was a trusted one at 10 mph or more.
  var prevDrive: Bool = false
  /// The second of the last two trusted rows in a row at 10 mph or more (JS's `lastDroveAt`).
  var lastDroveTs: Double?
}

extension DetectPolicy {
  static func endClockAt(_ ts: Double) -> EndClock { EndClock(lastMoveTs: ts) }

  /// policy.ts `endOnRow`: two trusted rows over 5 mph in a row, or a trusted fix 100 m from where
  /// the car went still, is movement; a row with no valid fix while the phone reports car motion
  /// adds a second to the hold, up to an hour. Two trusted rows at 10 mph or more in a row are
  /// driving (`lastDroveTs` at the second), which voids a walk that arrived at or before it.
  static func endOnRow(_ c0: EndClock, _ r: DetectRow, automotiveNow: Bool) -> EndClock {
    var c = c0
    if trusted(r) {
      c.paceRun = r.speed > MOVE_MPS ? c0.paceRun + 1 : 0
      c.prevDrive = r.speed >= MOVING_MPS
      if c.prevDrive && c0.prevDrive { c.lastDroveTs = r.ts }
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
    c.prevDrive = false
    if !r.gnssValid && automotiveNow { c.holdMs = min(FIXLESS_HOLD_MAX_MS, c0.holdMs + ROW_MS) }
    return c
  }

  /// policy.ts `walkStanding`: the standing walk's arrival, or nil once the car has driven at or
  /// after it; as JS voids a walk the car drove after, only a walk that arrived after the car was
  /// last at driving speed counts toward the walking end or the linger.
  static func walkStanding(_ c: EndClock, _ walkSince: Double?) -> Double? {
    guard let w = walkSince else { return nil }
    if let d = c.lastDroveTs, d >= w { return nil }
    return w
  }

  /// policy.ts `endDue`: `overdue` = a JS rule would have ended the drive by now (a walk standing 10 s
  /// that the car has not driven since, with no fix over 3 mph in the last 15 s, 5 min still, 12 h);
  /// `due` = the same plus the slack (10 s on the walk, a minute on the others). Each "limit",
  /// "walking", "still" or nil, in that order of precedence.
  /// `waitUntil`: a Start-card drive still waiting for driving speed: no walking end, and the still
  /// end only once that deadline has passed too.
  static func endDue(_ c: EndClock, startedAt: Double, now: Double, walkSince: Double?, waitUntil: Double? = nil) -> (due: String?, overdue: String?) {
    var carDriving = false
    if let mps = c.lastFixMps, let ts = c.lastFixTs { carDriving = mps > END_CRAWL_MPS && now - ts <= WALK_STALE_FIX_MS }
    let age = now - startedAt
    var walked: Double = -1
    if let w = walkStanding(c, walkSince), !carDriving, waitUntil == nil { walked = now - w }
    let still = now - c.lastMoveTs - c.holdMs
    func pick(_ slack: Double, _ walkSlack: Double) -> String? {
      if age >= MAX_DRIVE_MS + slack { return "limit" }
      if walked >= WALK_END_MS + walkSlack { return "walking" }
      if still >= STILL_END_MS + slack, waitUntil.map({ now >= $0 + slack }) ?? true { return "still" }
      return nil
    }
    return (pick(SAFETY_SLACK_MS, WALK_SAFETY_SLACK_MS), pick(0, 0))
  }

  /// policy.ts `lingerAfterJsEnd`: JS's end was an automatic one (the linger watches on) when a JS
  /// rule would have made it by now (`endDue` overdue "still" or "walking"), or a walk the car has
  /// not driven since (`walkStanding`) has stood `WALK_STAND_MIN_MS` less a row (JS's row clock
  /// runs a row ahead of this one) with the last trusted fix at a walker's pace or under, more than
  /// `WALK_STALE_FIX_MS` old, or missing. JS's
  /// walking end comes 10 s after the walk began as the phone dates it, so as soon as 3 s after the
  /// report arrived, and it lets a carried phone at 5 mph or under end the drive; native counts from
  /// the arrival and keeps no carried state, and a spare linger is harmless.
  /// Never on a walk while a Start-card drive still waits for driving speed.
  static func lingerAfterJsEnd(_ c: EndClock, startedAt: Double, now: Double, walkSince: Double?, waitUntil: Double? = nil) -> Bool {
    let o = endDue(c, startedAt: startedAt, now: now, walkSince: walkSince, waitUntil: waitUntil).overdue
    if o == "still" || o == "walking" { return true }
    guard waitUntil == nil, let w = walkStanding(c, walkSince), now - w >= WALK_STAND_MIN_MS - ROW_MS else { return false }
    guard let mps = c.lastFixMps, let ts = c.lastFixTs else { return true }
    return mps <= WALKER_PACE_MAX_MPS || now - ts > WALK_STALE_FIX_MS
  }

  /// policy.ts `suppressionDue`: "cap", "walking", "still" or nil.
  static func suppressionDue(since: Double, until: Double, lastOverStopTs: Double?, walkSince: Double?, now: Double) -> String? {
    if now >= until { return "cap" }
    if let w = walkSince, now - w >= WALK_CONFIRM_MS { return "walking" }
    if now - max(since, lastOverStopTs ?? since) >= SUPPRESS_STILL_MS { return "still" }
    return nil
  }

  /// policy.ts `suppressionResume`: a relaunch while detection rests keeps the rest until its cap
  /// (from when it began) and restarts its still clock at the relaunch; nil when the rest is over.
  static func suppressionResume(until: Double?, now: Double) -> Double? {
    guard let u = until, now < u else { return nil }
    return now
  }
}
