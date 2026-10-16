// The forgot-to-start reminder's iOS-only rules: the motion history, the wake, the GPS look's fixes,
// the held stop and a look's end. The Swift mirror of the iOS half of `src/reminder/policy.ts`;
// pure. No step here ever sets `inVehicle`: iOS has no vehicle state, so a session ends by time.
import Foundation

struct MotionSummary {
  var lastAutomotiveAt: Double
  var automotiveSince: Double
  var onFootNow: Bool
}

struct ActivitySample {
  var start: Double
  var automotive: Bool
  /// A car standing still (automotive + stationary) is not driving.
  var stationary: Bool
  /// walking, running or cycling (the look gate's "on foot now")
  var onFoot: Bool
  /// walking or running only (the stop hold's "walked off")
  var walking: Bool
  var confident: Bool
}

struct ReminderFix {
  var t: Double
  var speed: Double
  var speedAcc: Double
}

struct LookTracker {
  var startedAt: Double
  var seekSince: Double
  var sawDriving = false
  var lastFastAt: Double = 0
  var stopStart: Double = 0
}

extension TripReminderPolicy {
  // MARK: - The motion history

  /// policy.ts `summarizeActivities`: each activity lasts until the next starts (the newest until
  /// now); only 30 min without moving car motion starts a new run.
  static func summarize(_ list: [ActivitySample], _ now: Double) -> MotionSummary {
    let sorted = list.sorted { $0.start < $1.start }
    var out = MotionSummary(lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false)
    for (i, a) in sorted.enumerated() {
      let end = i + 1 < sorted.count ? sorted[i + 1].start : now
      out.onFootNow = a.onFoot && a.confident
      if a.automotive && !a.stationary && a.confident {
        if out.automotiveSince == 0 || a.start - out.lastAutomotiveAt >= SESSION_GAP_MS { out.automotiveSince = a.start }
        out.lastAutomotiveAt = end
      }
    }
    return out
  }

  /// policy.ts `foldMotion`: a car run that began 30 min or more after the last driving moment ends
  /// the session; otherwise the newest car motion is a driving moment. Then the time rule.
  static func foldMotion(_ s0: ReminderState, _ now: Double, _ m: MotionSummary, _ capturing: Bool) -> ReminderState {
    var s = s0
    if let x = s.session {
      if !capturing && m.automotiveSince > 0 && m.automotiveSince - x.lastDrivingAt >= SESSION_GAP_MS {
        s.session = nil
        s.token = ""
        s.tapAt = 0
      } else if m.lastAutomotiveAt > x.lastDrivingAt {
        s.session?.lastDrivingAt = m.lastAutomotiveAt
      }
    }
    return endIfOver(s, now, capturing)
  }

  // MARK: - The wake

  /// policy.ts `onWake`: a session opens only on car motion from the last 2 min with the driver not
  /// on foot; a look starts only through the look gate. `dropped`: the note's token went.
  static func onWake(_ s0: ReminderState, _ now: Double, _ m: MotionSummary, _ ctx: ReminderCtx) -> (state: ReminderState, startLook: Bool, reason: String, dropped: Bool) {
    let c0 = clampTimes(s0, now)
    let pre = gate(c0, ctx, now, .wake)
    if pre != "ok" {
      let s = endIfOver(c0, now, ctx.capturing)
      return (s, false, pre, !c0.token.isEmpty && s.token.isEmpty)
    }
    var s = foldMotion(c0, now, m, ctx.capturing)
    let a = m.lastAutomotiveAt
    let fresh = a > 0 && now - a <= AUTOMOTIVE_FRESH_MS && !m.onFootNow
    if s.session == nil && fresh {
      s.session = newSession(m.automotiveSince > 0 ? m.automotiveSince : a, a, inVehicle: false)
      s.lookRestUntil = 0
    }
    var c = ctx
    c.automotiveAgeMs = a > 0 ? now - a : Double.infinity
    c.onFoot = m.onFootNow
    let reason = gate(s, c, now, .look)
    return (s, reason == "ok", reason, !c0.token.isEmpty && s.token.isEmpty)
  }

  // MARK: - The GPS look

  static func newLook(_ now: Double) -> LookTracker { LookTracker(startedAt: now, seekSince: now) }

  /// Back to looking for the next stop: 10 mph must be seen again first.
  static func seekAgain(_ tr: LookTracker, _ now: Double) -> LookTracker {
    var t = tr
    t.seekSince = now
    t.sawDriving = false
    t.stopStart = 0
    return t
  }

  /// "none", "look-max" (10 min), "no-drive" (3 min without 10 mph).
  static func lookClock(_ tr: LookTracker, _ now: Double) -> String {
    if now - tr.startedAt >= IOS_LOOK_MAX_MS { return "look-max" }
    if !tr.sawDriving && now - tr.seekSince >= IOS_LOOK_NO_DRIVE_MS { return "no-drive" }
    return "none"
  }

  /// policy.ts `onFix`: "none", "stopped" or a `lookClock` verdict.
  static func onFix(_ tr0: LookTracker, _ fix: ReminderFix, _ now: Double) -> (tracker: LookTracker, verdict: String) {
    var tr = tr0
    let clock = lookClock(tr, now)
    if clock != "none" { return (tr, clock) }
    let valid = fix.speed >= 0 && fix.speedAcc >= 0 && fix.speedAcc <= SPEED_ACC_MAX_MPS
    if !valid { return (tr, "none") }
    if fix.speed >= IOS_DRIVING_MPS {
      tr.sawDriving = true
      tr.stopStart = 0
      tr.lastFastAt = max(tr.lastFastAt, fix.t)
      return (tr, "none")
    }
    if !tr.sawDriving { return (tr, "none") }
    if fix.speed >= STOP_MPS {
      tr.stopStart = 0
      return (tr, "none")
    }
    if tr.stopStart == 0 { tr.stopStart = fix.t }
    return (tr, fix.t - tr.stopStart >= STOP_HOLD_MS ? "stopped" : "none")
  }

  /// A look's last 10 mph fix is a driving moment.
  private static func foldFast(_ s0: ReminderState, _ lastFastAt: Double) -> ReminderState {
    var s = s0
    if let x = s.session, lastFastAt > x.lastDrivingAt { s.session?.lastDrivingAt = lastFastAt }
    return s
  }

  /// policy.ts `onStop`: "post", "arrival" (walked off: no post, the session goes on) or "end".
  /// The look saw 10 mph with no drive open: driving speed.
  static func onStop(_ s0: ReminderState, _ ctx: ReminderCtx, _ now: Double, walked: Bool, token: String, lastFastAt: Double) -> (state: ReminderState, effect: String, reason: String) {
    var s = endIfOver(foldFast(s0, lastFastAt), now, ctx.capturing)
    if walked { return (s, "arrival", "on-foot") }
    if s.session != nil && lastFastAt > s.lastDriveEndAt && !ctx.capturing { s.session?.drove = true }
    var c = ctx
    c.eventAgeMs = 0
    c.onFoot = false
    let reason = gate(s, c, now, .stop)
    if reason == "ok" { return (posted(s, now, token), "post", reason) }
    return (s, "end", reason)
  }

  /// policy.ts `lookEnded`: the last 10 mph fix folds in; a look that ran its full 10 min rests the
  /// next for 10 min.
  static func lookEnded(_ s0: ReminderState, _ now: Double, _ lastFastAt: Double, _ verdict: String) -> ReminderState {
    var s = foldFast(s0, lastFastAt)
    if verdict == "look-max" { s.lookRestUntil = now + IOS_LOOK_REST_MS }
    return s
  }
}
