// The native safety stop and the "Not driving?" rest (plan §3.4, §3.6): the Swift mirror of the end
// half of `src/detect/policy.ts`. JS decides a drive's end and its cut (R1); native stops sensing
// on its own only when JS has not, 10 s after the JS walking end or step walk or a minute after
// another JS rule would have fired, and never computes a cut. Pure: Foundation only.
import Foundation

/// One row's pedometer count (policy.ts `EndClock.steps`).
struct StepMark: Equatable {
  var ts: Double
  var steps: Int
}

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
  /// The last trusted row over 3 mph (`END_CRAWL_MPS`).
  var lastFastTs: Double?
  /// The rows' pedometer counts in the last `STEP_WINDOW_MS`, oldest first (`endOnSteps`).
  var steps: [StepMark] = []
  /// When the step walk was first due (JS's row clock: the row's end), until the car next goes over 3 mph.
  var stepWalkTs: Double?
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
      // Over 3 mph the car may be moving: a step walk due before it is void.
      if r.speed > END_CRAWL_MPS {
        c.lastFastTs = r.ts
        c.stepWalkTs = nil
      }
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

  /// policy.ts `endOnSteps`: a row's pedometer count (after `endOnRow` for the same row), as JS's
  /// step walk reads it: the counts of the last `STEP_WINDOW_MS` (a lower count is a pedometer that
  /// started again, and starts the log again), and the step walk due at the row's end once they span
  /// `STEP_WALK_MIN` steps or more with no trusted fix over 3 mph in the `STEP_CALM_MS` before it.
  /// Once due it stays due (`stepWalkTs`) until the car goes over 3 mph.
  static func endOnSteps(_ c0: EndClock, ts: Double, steps: Int) -> EndClock {
    var c = c0
    if let last = c0.steps.last, steps < last.steps {
      c.steps = [StepMark(ts: ts, steps: steps)]
    } else if let last = c0.steps.last, ts <= last.ts {
      c.steps = c0.steps
    } else {
      c.steps = c0.steps.filter { $0.ts >= ts - STEP_WINDOW_MS } + [StepMark(ts: ts, steps: steps)]
    }
    let t = ts + ROW_MS
    let calm = c.lastFastTs.map { t - $0 > STEP_CALM_MS } ?? true
    var walked = false
    if let first = c.steps.first, let newest = c.steps.last { walked = newest.steps - first.steps >= STEP_WALK_MIN }
    if c.stepWalkTs == nil, walked, calm { c.stepWalkTs = t }
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
  /// that the car has not driven since, with no fix over 3 mph in the last 15 s; a step walk
  /// (`endOnSteps`); 5 min still; the paired car or CarPlay gone `CAR_GONE_MS` with no trusted fix
  /// over 3 mph since, `carGoneSince` being the car link's debounced "gone since"; 12 h);
  /// `due` = the same plus the slack (10 s on either walk, a minute on the others). Each "limit",
  /// "walking", "still" or nil, in that order of precedence (the car link's end is a still one).
  /// `waitUntil`: a Start-card drive still waiting for driving speed: no walking or car-link end,
  /// and the still end only once that deadline has passed too.
  static func endDue(_ c: EndClock, startedAt: Double, now: Double, walkSince: Double?, waitUntil: Double? = nil, carGoneSince: Double? = nil) -> (due: String?, overdue: String?) {
    var carDriving = false
    if let mps = c.lastFixMps, let ts = c.lastFixTs { carDriving = mps > END_CRAWL_MPS && now - ts <= WALK_STALE_FIX_MS }
    let age = now - startedAt
    var walked: Double = -1
    if let w = walkStanding(c, walkSince), !carDriving, waitUntil == nil { walked = now - w }
    var stepped: Double = -1
    if let s = c.stepWalkTs, waitUntil == nil { stepped = now - s }
    let still = now - c.lastMoveTs - c.holdMs
    var gone: Double = -1
    if let g = carGoneSince, waitUntil == nil, c.lastFastTs.map({ $0 < g }) ?? true { gone = now - g }
    func pick(_ slack: Double, _ walkSlack: Double) -> String? {
      if age >= MAX_DRIVE_MS + slack { return "limit" }
      if walked >= WALK_END_MS + walkSlack || stepped >= walkSlack { return "walking" }
      if still >= STILL_END_MS + slack, waitUntil.map({ now >= $0 + slack }) ?? true { return "still" }
      if gone >= CAR_GONE_MS + slack { return "still" }
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
  /// A step walk due (`stepWalkTs`) is one too: JS ended it on the row native just recorded.
  /// Never on a walk while a Start-card drive still waits for driving speed.
  static func lingerAfterJsEnd(_ c: EndClock, startedAt: Double, now: Double, walkSince: Double?, waitUntil: Double? = nil, carGoneSince: Double? = nil) -> Bool {
    let o = endDue(c, startedAt: startedAt, now: now, walkSince: walkSince, waitUntil: waitUntil, carGoneSince: carGoneSince).overdue
    if o == "still" || o == "walking" { return true }
    if waitUntil == nil, c.stepWalkTs != nil { return true }
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
