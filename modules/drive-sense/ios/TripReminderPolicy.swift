// The forgot-to-start reminder's policy on iOS: the Swift mirror of `src/reminder/policy.ts` (the
// shared rules and the claim; the wake, look and stop rules are in TripReminderWakePolicy.swift),
// under the same names with the same values (`__tests__/native-ios.test.ts` compares the
// constants). Pure: Foundation only, no clock, no I/O. `TripReminder` reads the phone and does
// what the result says.
//
// The rule is the session: a stretch of driving that ends 30 min after its last driving moment (an
// open drive counts as driving). At most one reminder a session, at a stop, after 10 mph with no
// drive open, never while a drive is open. iOS has no vehicle state: `inVehicle` stays false. Nothing
// here starts a capture: a tap's token is only ever claimed, and JS starts the drive.
import Foundation

struct ReminderSession: Codable, Equatable {
  var startedAt: Double
  var lastDrivingAt: Double
  /// Android's (the lost-exit rule); kept so the stored shape is the reference's.
  var lastNewsAt: Double
  /// Android's; always false on iOS.
  var inVehicle: Bool
  var vehicleExitAt: Double
  var drove: Bool
  var reminded: Bool
}

struct ReminderState: Codable, Equatable {
  var v: Int = 3
  var enabled = false
  var session: ReminderSession? = nil
  var lastDriveEndAt: Double = 0
  /// The one-use token of the note that is up; "" = no note.
  var token = ""
  var postedAt: Double = 0
  /// Android's; kept so the stored shape is the reference's.
  var tapSeen: [String] = []
  var tapAt: Double = 0
  /// No GPS look before this (after a look that ran its full 10 min).
  var lookRestUntil: Double = 0
}

/// What the phone says at the moment of a decision.
struct ReminderCtx {
  var permissionsOk = false
  var capturing = false
  var eventAgeMs: Double = 0
  var onFoot = false
  var automotiveAgeMs: Double = 0
}

enum TripReminderPolicy {
  static let STOP_MPS: Double = 1.34
  static let IOS_DRIVING_MPS: Double = 4.47
  static let SPEED_ACC_MAX_MPS: Double = 2
  static let STOP_HOLD_MS: Double = 12_000
  static let SESSION_GAP_MS: Double = 1_800_000
  static let IN_VEHICLE_NOTE_MS: Double = 10_800_000
  static let STILL_AFTER_VEHICLE_MS: Double = 120_000
  static let STALE_EVENT_MS: Double = 45_000
  static let AUTOMOTIVE_FRESH_MS: Double = 120_000
  static let IOS_MOTION_LOOKBACK_MS: Double = 10_800_000
  static let IOS_LOOK_MAX_MS: Double = 600_000
  static let IOS_LOOK_NO_DRIVE_MS: Double = 180_000
  static let IOS_LOOK_REST_MS: Double = 600_000
  static let TAP_FRESH_MS: Double = 120_000
  static let TAP_SEEN_MAX: Int = 8
  static let CLOCK_FUTURE_MS: Double = 86_400_000

  enum Phase { case wake, look, stop }

  static func newSession(_ startedAt: Double, _ lastDrivingAt: Double, inVehicle: Bool) -> ReminderSession {
    ReminderSession(
      startedAt: startedAt, lastDrivingAt: lastDrivingAt, lastNewsAt: lastDrivingAt,
      inVehicle: inVehicle, vehicleExitAt: 0, drove: false, reminded: false
    )
  }

  /// policy.ts `clampTimes`: a stored time more than a day ahead is a clock change.
  static func clampTimes(_ s0: ReminderState, _ now: Double) -> ReminderState {
    var s = s0
    func past(_ t: Double) -> Double { t > now + CLOCK_FUTURE_MS ? now : t }
    s.lastDriveEndAt = past(s.lastDriveEndAt)
    s.postedAt = past(s.postedAt)
    s.tapAt = past(s.tapAt)
    s.lookRestUntil = past(s.lookRestUntil)
    if var x = s.session {
      x.startedAt = past(x.startedAt)
      x.lastDrivingAt = past(x.lastDrivingAt)
      x.lastNewsAt = past(x.lastNewsAt)
      x.vehicleExitAt = past(x.vehicleExitAt)
      s.session = x
    }
    return s
  }

  /// policy.ts `endIfOver`: 30 min past the last driving moment, no drive open. The token goes with it.
  static func endIfOver(_ s0: ReminderState, _ t: Double, _ capturing: Bool) -> ReminderState {
    guard let x = s0.session, !capturing, !x.inVehicle, t - x.lastDrivingAt >= SESSION_GAP_MS else { return s0 }
    var s = s0
    s.session = nil
    s.token = ""
    s.tapAt = 0
    return s
  }

  /// policy.ts `settle`.
  static func settle(_ s0: ReminderState, _ now: Double, _ capturing: Bool) -> ReminderState {
    endIfOver(clampTimes(s0, now), now, capturing)
  }

  /// policy.ts `gate`: the first reason not to go on, or "ok".
  static func gate(_ s: ReminderState, _ ctx: ReminderCtx, _ now: Double, _ phase: Phase) -> String {
    if !s.enabled { return "off" }
    if !ctx.permissionsOk { return "permission" }
    if ctx.capturing { return "capturing" }
    if phase == .wake { return "ok" }
    guard let x = s.session else { return "no-session" }
    if x.reminded { return "reminded" }
    if phase == .look {
      if now < s.lookRestUntil { return "resting" }
      if ctx.automotiveAgeMs > AUTOMOTIVE_FRESH_MS || ctx.onFoot { return "not-fresh" }
      return "ok"
    }
    if !x.drove { return "not-driven" }
    if ctx.eventAgeMs > STALE_EVENT_MS { return "stale" }
    if ctx.onFoot { return "on-foot" }
    return "ok"
  }

  /// policy.ts `posted`.
  static func posted(_ s0: ReminderState, _ now: Double, _ token: String) -> ReminderState {
    var s = s0
    s.session?.reminded = true
    s.token = token
    s.postedAt = now
    s.tapAt = 0
    return s
  }

  /// policy.ts `unposted`: the note with `token` never showed.
  static func unposted(_ s0: ReminderState, _ token: String) -> ReminderState {
    guard !token.isEmpty, s0.token == token else { return s0 }
    var s = s0
    s.token = ""
    s.tapAt = 0
    s.session?.reminded = false
    return s
  }

  /// policy.ts `noteGone`: the note came down (a permission it needs went); the session stays reminded.
  static func noteGone(_ s0: ReminderState) -> ReminderState {
    var s = s0
    s.token = ""
    s.tapAt = 0
    return s
  }

  /// policy.ts `claim`: true once, for the note's token, in a live session, no drive open.
  static func claim(_ s0: ReminderState, _ token: String, _ now: Double, _ capturing: Bool, _ requireDelivery: Bool) -> (state: ReminderState, ok: Bool) {
    var s = settle(s0, now, capturing)
    let fresh = !requireDelivery || (s.tapAt > 0 && now - s.tapAt <= TAP_FRESH_MS)
    let ok = s.enabled && !token.isEmpty && token == s.token && s.session != nil && !capturing && fresh
    if !ok { return (s, false) }
    s.token = ""
    s.tapAt = 0
    return (s, true)
  }

  /// policy.ts `captureStarted`.
  static func captureStarted(_ s0: ReminderState, _ now: Double) -> ReminderState {
    var s = s0
    s.token = ""
    s.tapAt = 0
    if var x = s.session {
      x.drove = false
      x.lastDrivingAt = max(x.lastDrivingAt, now)
      x.lastNewsAt = max(x.lastNewsAt, now)
      s.session = x
    }
    return s
  }

  /// policy.ts `captureEnded`: the drive's driving end (never later than now) is the session's last
  /// driving moment; nil (a drive that was not kept) leaves the clock as it was. A caller with no
  /// driving end passes `now`. `drivingAtEnd`: the car was at driving speed as the drive ended, so
  /// the session (opened now if there is none) has driven; `vehicle` marks it in the vehicle
  /// (Android's; iOS's own calls pass false).
  static func captureEnded(
    _ s0: ReminderState, _ now: Double, _ drivingEndedAt: Double?, drivingAtEnd: Bool = false, vehicle: Bool = false
  ) -> ReminderState {
    var s = s0
    s.lastDriveEndAt = now
    if var x = s.session {
      x.drove = drivingAtEnd
      x.lastNewsAt = max(x.lastNewsAt, now)
      if let end = drivingEndedAt { x.lastDrivingAt = max(x.lastDrivingAt, min(now, end)) }
      if drivingAtEnd {
        x.lastDrivingAt = max(x.lastDrivingAt, now)
        x.inVehicle = x.inVehicle || vehicle
      }
      s.session = x
    } else if drivingAtEnd && s.enabled {
      var x = newSession(now, now, inVehicle: vehicle)
      x.drove = true
      s.session = x
    }
    return s
  }

  /// policy.ts `setEnabled`: on keeps the session; off forgets everything.
  static func setEnabled(_ s0: ReminderState, _ on: Bool) -> ReminderState {
    if !on { return ReminderState() }
    var s = s0
    s.enabled = true
    return s
  }

  private struct StoredVersion: Decodable {
    var v: Int?
    var enabled: Bool?
  }

  /// policy.ts `fromStored`: v3 as it is; v2 (the reminder before sessions) keeps only its switch;
  /// anything else is off.
  static func fromStored(_ data: Data) -> ReminderState {
    guard let probe = try? JSONDecoder().decode(StoredVersion.self, from: data) else { return ReminderState() }
    if probe.v == 2 {
      var s = ReminderState()
      s.enabled = probe.enabled ?? false
      return s
    }
    guard probe.v == 3, var s = try? JSONDecoder().decode(ReminderState.self, from: data), s.v == 3 else { return ReminderState() }
    if s.tapSeen.count > TAP_SEEN_MAX { s.tapSeen = Array(s.tapSeen.suffix(TAP_SEEN_MAX)) }
    return s
  }
}
