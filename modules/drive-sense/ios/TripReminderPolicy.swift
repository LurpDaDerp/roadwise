// The forgot-to-start reminder's policy on iOS: the Swift mirror of `src/reminder/policy.ts` (the
// shared rules and the wake, fix and stop rules), under the same names with the same values
// (`__tests__/native-ios.test.ts` compares the constants). Pure: Foundation only, no clock, no I/O.
// `TripReminder` reads the phone and does what the result says. Nothing here starts a capture.
// The wake, fix and stop rules are in TripReminderWakePolicy.swift.
import Foundation

struct ReminderTrip: Codable, Equatable {
  var startedAt: Double
  var lastVehicleAt: Double
  var inVehicle: Bool = true
  var vehicleExitAt: Double = 0
  var recorded: Bool = false
  var reminded: Bool = false
  var retries: Int = 0
  var sessions: Int = 0
  var lastSessionEndAt: Double = 0
}

struct ReminderState: Codable, Equatable {
  var v: Int = 2
  var enabled: Bool = false
  var autoOff: Bool = false
  var trip: ReminderTrip? = nil
  var lastCaptureEndAt: Double = 0
  var posts: [Double] = []
  var pendingAt: Double = 0
  var postedAt: Double = 0
  var showing: Bool = false
  var missStreak: Int = 0
  var pauseLevel: Int = 0
  var pausedUntil: Double = 0
  var quietUntil: Double = 0
  var notDrivingUntil: Double = 0
}

/// What the phone says at the moment of a decision.
struct ReminderCtx {
  var permissionsOk = false
  var capturing = false
  var appForeground = false
  var inCall = false
  var lowPower = false
  var eventAgeMs: Double = 0
  var onFoot = false
  var automotiveAgeMs: Double = 0
}

struct MotionSummary {
  var lastAutomotiveAt: Double
  var automotiveSince: Double
  var onFootNow: Bool
}

struct ActivitySample {
  var start: Double
  var automotive: Bool
  /// walking, running or cycling (the wake's "on foot now")
  var onFoot: Bool
  /// walking or running only (the stop hold's and the watch's "walked off")
  var walking: Bool
  var confident: Bool
}

struct ReminderFix {
  var t: Double
  var speed: Double
  var speedAcc: Double
  /// horizontal accuracy, m; negative = unknown
  var hAcc: Double
  var lat: Double
  var lng: Double
}

struct SessionTracker {
  var startedAt: Double
  var seekSince: Double
  var sawDriving = false
  var stopStart: Double = 0
  var stopLat: Double = 0
  var stopLng: Double = 0
  var watching = false
  var postedAt: Double = 0
}

enum TripReminderPolicy {
  static let STOP_MPS: Double = 1.34
  static let MOVE_MPS: Double = 2.24
  static let IOS_DRIVING_MPS: Double = 4.47
  static let SPEED_ACC_MAX_MPS: Double = 2
  static let STOP_HOLD_MS: Double = 12_000
  static let MOVED_AWAY_M: Double = 30
  static let FIX_ACC_MAX_M: Double = 20
  static let WALK_CHECK_MS: Double = 30_000
  static let UNSEEN_MS: Double = 20_000
  static let MAX_RETRIES_PER_TRIP: Int = 1
  static let STILL_AFTER_VEHICLE_MS: Double = 120_000
  static let STALE_EVENT_MS: Double = 45_000
  static let MIN_IN_VEHICLE_MS: Double = 90_000
  static let TRIP_GAP_MS: Double = 600_000
  static let MAX_TRIP_IDLE_MS: Double = 10_800_000
  static let AFTER_DRIVE_MS: Double = 600_000
  static let UNUSED_QUIET_MS: Double = 14_400_000
  static let DAY_MS: Double = 86_400_000
  static let DAILY_CAP: Int = 2
  static let POST_SPACING_MS: Double = 3_600_000
  static let TTL_MS: Double = 300_000
  static let CONVERT_WINDOW_MS: Double = 1_800_000
  static let MISS_LIMIT: Int = 3
  static let NOT_DRIVING_QUIET_MS: Double = 43_200_000
  static let AUTOMOTIVE_FRESH_MS: Double = 120_000
  static let IOS_MOTION_MIN_LOOKBACK_MS: Double = 600_000
  static let IOS_MOTION_MAX_LOOKBACK_MS: Double = 10_800_000
  static let IOS_SESSION_MAX_MS: Double = 600_000
  static let IOS_SESSION_NO_DRIVE_MS: Double = 180_000
  static let IOS_SESSIONS_PER_TRIP: Int = 2
  static let IOS_SESSION_SPACING_MS: Double = 600_000
  static let CLOCK_FUTURE_MS: Double = 86_400_000
  /// The back-off pauses, in days; the step after the last turns the reminder off.
  static let PAUSE_DAYS: [Double] = [7, 28]
  private static let maxPauseMs: Double = 28 * DAY_MS

  enum Outcome { case converted, unseen, notDriving, missed }
  enum Phase { case wake, session, stop }

  static func newTrip(_ startedAt: Double, _ lastVehicleAt: Double) -> ReminderTrip {
    ReminderTrip(startedAt: startedAt, lastVehicleAt: lastVehicleAt)
  }

  static func recentPosts(_ s: ReminderState, _ now: Double) -> Int { s.posts.filter { now - $0 < DAY_MS }.count }

  /// policy.ts `tooSoonAfterPost`: a post went up less than an hour before `now`, whatever became of it.
  static func tooSoonAfterPost(_ s: ReminderState, _ now: Double) -> Bool { s.posts.contains { now - $0 < POST_SPACING_MS } }

  /// policy.ts `settle`.
  static func settle(_ s0: ReminderState, _ now: Double) -> ReminderState {
    var s = s0
    func past(_ t: Double) -> Double { t > now + CLOCK_FUTURE_MS ? now : t }
    s.lastCaptureEndAt = past(s.lastCaptureEndAt)
    s.pendingAt = past(s.pendingAt)
    s.postedAt = past(s.postedAt)
    s.posts = s.posts.map(past).filter { now - $0 < DAY_MS }
    s.pausedUntil = min(s.pausedUntil, now + maxPauseMs)
    s.quietUntil = min(s.quietUntil, now + UNUSED_QUIET_MS)
    s.notDrivingUntil = min(s.notDrivingUntil, now + NOT_DRIVING_QUIET_MS)
    if s.pausedUntil != 0 && now >= s.pausedUntil { s.pausedUntil = 0 }
    if s.quietUntil != 0 && now >= s.quietUntil { s.quietUntil = 0 }
    if s.notDrivingUntil != 0 && now >= s.notDrivingUntil { s.notDrivingUntil = 0 }
    if var t = s.trip {
      t.startedAt = past(t.startedAt)
      t.lastVehicleAt = past(t.lastVehicleAt)
      t.vehicleExitAt = past(t.vehicleExitAt)
      t.lastSessionEndAt = past(t.lastSessionEndAt)
      let idle = now - t.lastVehicleAt
      s.trip = (!t.inVehicle && idle >= TRIP_GAP_MS) || idle >= MAX_TRIP_IDLE_MS ? nil : t
    }
    if s.showing && now - s.postedAt >= TTL_MS { s.showing = false }
    if s.pendingAt > 0 && now - s.pendingAt >= CONVERT_WINDOW_MS { resolveIn(&s, .missed, now) }
    return s
  }

  /// policy.ts `gate`: the first reason not to remind now, or "ok".
  static func gate(_ s: ReminderState, _ ctx: ReminderCtx, _ now: Double, _ phase: Phase) -> String {
    if !s.enabled { return "off" }
    if now < s.pausedUntil { return "paused" }
    if now < max(s.quietUntil, s.notDrivingUntil) { return "quiet" }
    if !ctx.permissionsOk { return "permission" }
    if ctx.capturing { return "capturing" }
    if phase != .wake {
      guard let t = s.trip else { return "no-trip" }
      if t.recorded { return "recorded" }
      if t.reminded { return "reminded" }
    }
    if s.lastCaptureEndAt > 0 && now - s.lastCaptureEndAt < AFTER_DRIVE_MS { return "after-drive" }
    if recentPosts(s, now) >= DAILY_CAP { return "daily-cap" }
    if tooSoonAfterPost(s, now) { return "spacing" }
    if phase == .wake {
      if ctx.lowPower { return "low-power" }
      if ctx.appForeground { return "foreground" }
      return "ok"
    }
    guard let t = s.trip else { return "no-trip" }
    if phase == .session {
      if ctx.lowPower { return "low-power" }
      if t.sessions >= IOS_SESSIONS_PER_TRIP { return "sessions" }
      if t.lastSessionEndAt > 0 && now - t.lastSessionEndAt < IOS_SESSION_SPACING_MS { return "sessions" }
      if ctx.appForeground { return "foreground" }
      if ctx.automotiveAgeMs > AUTOMOTIVE_FRESH_MS { return "not-fresh" }
      return "ok"
    }
    if now - t.startedAt < MIN_IN_VEHICLE_MS { return "too-soon" }
    if ctx.appForeground { return "foreground" }
    if ctx.inCall { return "in-call" }
    if ctx.eventAgeMs > STALE_EVENT_MS { return "stale" }
    if ctx.onFoot { return "on-foot" }
    return "ok"
  }

  static func postedIn(_ s: inout ReminderState, _ now: Double) {
    s.posts.append(now)
    s.trip?.reminded = true
    s.pendingAt = now
    s.postedAt = now
    s.showing = true
    s.quietUntil = now + UNUSED_QUIET_MS
  }

  private static func missIn(_ s: inout ReminderState, _ now: Double) {
    s.missStreak += 1
    if s.missStreak < MISS_LIMIT { return }
    s.missStreak = 0
    // A stored level out of range reads as the nearest real one.
    s.pauseLevel = min(max(s.pauseLevel, 0), PAUSE_DAYS.count)
    if s.pauseLevel < PAUSE_DAYS.count {
      s.pausedUntil = now + PAUSE_DAYS[s.pauseLevel] * DAY_MS
      s.pauseLevel += 1
    } else {
      s.enabled = false
      s.autoOff = true
      s.pausedUntil = 0
    }
  }

  static func resolveIn(_ s: inout ReminderState, _ outcome: Outcome, _ now: Double) {
    let pending = s.pendingAt > 0
    s.showing = false
    s.pendingAt = 0
    switch outcome {
    case .converted:
      s.missStreak = 0
      s.pauseLevel = 0
      s.quietUntil = 0
    case .unseen:
      s.quietUntil = 0
      if let t = s.trip, t.retries < MAX_RETRIES_PER_TRIP {
        s.trip?.retries += 1
        s.trip?.reminded = false
      }
    case .notDriving:
      // A note whose outcome is already counted (or none waiting) gets the quiet, not a second miss.
      s.notDrivingUntil = now + NOT_DRIVING_QUIET_MS
      if pending { missIn(&s, now) }
    case .missed:
      missIn(&s, now)
    }
  }

  static func resolve(_ s0: ReminderState, _ outcome: Outcome, _ now: Double) -> ReminderState {
    var s = s0
    resolveIn(&s, outcome, now)
    return s
  }

  static func captureStarted(_ s0: ReminderState, _ now: Double) -> ReminderState {
    var s = s0
    if s.trip == nil { s.trip = newTrip(now, now) }
    s.trip?.recorded = true
    if s.pendingAt > 0 && now - s.pendingAt <= CONVERT_WINDOW_MS { resolveIn(&s, .converted, now) }
    s.showing = false
    return s
  }

  static func captureEnded(_ s0: ReminderState, _ now: Double) -> ReminderState {
    var s = s0
    s.lastCaptureEndAt = now
    s.trip?.inVehicle = false
    s.trip?.lastVehicleAt = now
    return s
  }

  static func appForeground(_ s0: ReminderState) -> ReminderState {
    var s = s0
    s.showing = false
    return s
  }

  static func setEnabled(_ s0: ReminderState, _ on: Bool) -> ReminderState {
    if !on { return ReminderState() }
    var s = s0
    s.enabled = true
    s.autoOff = false
    s.pausedUntil = 0
    s.missStreak = 0
    s.pauseLevel = 0
    s.quietUntil = 0
    s.notDrivingUntil = 0
    return s
  }
}
