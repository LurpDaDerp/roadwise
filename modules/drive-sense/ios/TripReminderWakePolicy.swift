// The forgot-to-start reminder's iOS-only rules: the wake (motion check), the GPS session's fixes,
// the stop and the watch. The Swift mirror of the iOS half of `src/reminder/policy.ts`; pure.
import Foundation

extension TripReminderPolicy {
  // MARK: - The wake (significant-location change, then the motion check)

  static func motionSince(_ s: ReminderState, _ now: Double) -> Double {
    let lastVehicleAt = s.trip?.lastVehicleAt ?? now
    return max(now - IOS_MOTION_MAX_LOOKBACK_MS, min(now - IOS_MOTION_MIN_LOOKBACK_MS, lastVehicleAt))
  }

  static func summarize(_ list: [ActivitySample], _ now: Double) -> MotionSummary {
    let sorted = list.sorted { $0.start < $1.start }
    var out = MotionSummary(lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false)
    for (i, a) in sorted.enumerated() {
      let end = i + 1 < sorted.count ? sorted[i + 1].start : now
      out.onFootNow = a.onFoot && a.confident
      if a.automotive && a.confident {
        if out.automotiveSince == 0 || (out.lastAutomotiveAt > 0 && a.start - out.lastAutomotiveAt >= TRIP_GAP_MS) {
          out.automotiveSince = a.start
        }
        out.lastAutomotiveAt = end
      } else if a.onFoot && a.confident {
        out.automotiveSince = 0
      }
    }
    return out
  }

  static func onWake(_ s0: ReminderState, _ now: Double, _ m: MotionSummary, _ ctx: ReminderCtx) -> (state: ReminderState, startSession: Bool, reason: String) {
    var s = settle(s0, now)
    let pre = gate(s, ctx, now, .wake)
    if pre != "ok" { return (s, false, pre) }
    let a = m.lastAutomotiveAt
    let fresh = a > 0 && now - a <= AUTOMOTIVE_FRESH_MS && !m.onFootNow
    if var t = s.trip {
      if now - max(t.lastVehicleAt, a) >= TRIP_GAP_MS || m.automotiveSince - t.lastVehicleAt >= TRIP_GAP_MS {
        s.trip = nil
      } else {
        t.lastVehicleAt = max(t.lastVehicleAt, a)
        if fresh { t.inVehicle = true }
        s.trip = t
      }
    }
    if s.trip == nil && fresh { s.trip = newTrip(m.automotiveSince > 0 ? m.automotiveSince : a, a) }
    var c = ctx
    c.automotiveAgeMs = a > 0 ? now - a : Double.infinity
    let reason = gate(s, c, now, .session)
    if reason != "ok" || s.trip == nil { return (s, false, reason) }
    s.trip?.sessions += 1
    return (s, true, reason)
  }

  // MARK: - The GPS session

  static func newTracker(_ now: Double) -> SessionTracker { SessionTracker(startedAt: now, seekSince: now) }

  static func seekAgain(_ tr: SessionTracker, _ now: Double) -> SessionTracker {
    var t = tr
    t.seekSince = now
    t.sawDriving = false
    t.stopStart = 0
    t.watching = false
    t.postedAt = 0
    return t
  }

  static func watchFrom(_ tr: SessionTracker, _ now: Double) -> SessionTracker {
    var t = tr
    t.watching = true
    t.postedAt = now
    return t
  }

  /// "none", "ttl" (watching 5 min), "session-max" (looking 10 min), "no-drive" (3 min without 10 mph).
  static func sessionClock(_ tr: SessionTracker, _ now: Double) -> String {
    if tr.watching { return now - tr.postedAt >= TTL_MS ? "ttl" : "none" }
    if now - tr.startedAt >= IOS_SESSION_MAX_MS { return "session-max" }
    if !tr.sawDriving && now - tr.seekSince >= IOS_SESSION_NO_DRIVE_MS { return "no-drive" }
    return "none"
  }

  static func metres(_ lat1: Double, _ lng1: Double, _ lat2: Double, _ lng2: Double) -> Double {
    let rad = Double.pi / 180
    let x = (lng2 - lng1) * rad * cos((lat1 + lat2) / 2 * rad)
    let y = (lat2 - lat1) * rad
    return (x * x + y * y).squareRoot() * 6_371_008.8
  }

  /// policy.ts `onFix`: "none", "stopped", "driving", "moved" or a `sessionClock` verdict.
  static func onFix(_ tr0: SessionTracker, _ fix: ReminderFix, _ now: Double) -> (tracker: SessionTracker, verdict: String) {
    var tr = tr0
    let clock = sessionClock(tr, now)
    if clock != "none" { return (tr, clock) }
    let valid = fix.speed >= 0 && fix.speedAcc >= 0 && fix.speedAcc <= SPEED_ACC_MAX_MPS
    if tr.watching {
      if valid && fix.speed > MOVE_MPS { return (tr, "driving") }
      let placed = fix.hAcc >= 0 && fix.hAcc <= FIX_ACC_MAX_M
      if placed && metres(tr.stopLat, tr.stopLng, fix.lat, fix.lng) > MOVED_AWAY_M { return (tr, "moved") }
      return (tr, "none")
    }
    if !valid { return (tr, "none") }
    if fix.speed >= IOS_DRIVING_MPS {
      tr.sawDriving = true
      tr.stopStart = 0
      return (tr, "none")
    }
    if !tr.sawDriving { return (tr, "none") }
    if fix.speed >= STOP_MPS {
      tr.stopStart = 0
      return (tr, "none")
    }
    if tr.stopStart == 0 {
      tr.stopStart = fix.t
      tr.stopLat = fix.lat
      tr.stopLng = fix.lng
    }
    return (tr, fix.t - tr.stopStart >= STOP_HOLD_MS ? "stopped" : "none")
  }

  /// policy.ts `onStop`: effect "post", "arrival", "seek" (the next stop may remind) or "end".
  static func onStop(_ s0: ReminderState, _ ctx: ReminderCtx, _ now: Double, walked: Bool) -> (state: ReminderState, effect: String, reason: String) {
    var s = s0
    if walked {
      s.trip?.inVehicle = false
      s.trip?.lastVehicleAt = now
      return (s, "arrival", "on-foot")
    }
    var c = ctx
    c.eventAgeMs = 0
    c.onFoot = false
    let reason = gate(s, c, now, .stop)
    if reason == "ok" {
      postedIn(&s, now)
      return (s, "post", reason)
    }
    return (s, reason == "too-soon" || reason == "in-call" ? "seek" : "end", reason)
  }

  /// policy.ts `onWatchEnd` for "driving", "arrival", "ttl" or "ended": whether the session looks for the next stop.
  static func onWatchEnd(_ s0: ReminderState, _ how: String, _ now: Double) -> (state: ReminderState, seek: Bool) {
    var s = s0
    s.showing = false
    if how == "driving" && now - s.postedAt < UNSEEN_MS {
      resolveIn(&s, .unseen, now)
      return (s, s.trip != nil && s.trip?.reminded == false)
    }
    if how == "arrival" {
      s.trip?.inVehicle = false
      s.trip?.lastVehicleAt = now
    }
    return (s, false)
  }

  static func sessionEnded(_ s0: ReminderState, _ now: Double) -> ReminderState {
    var s = s0
    s.trip?.lastSessionEndAt = now
    return s
  }
}
