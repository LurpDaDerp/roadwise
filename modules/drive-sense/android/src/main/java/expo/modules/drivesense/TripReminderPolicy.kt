package expo.modules.drivesense

/**
 * The forgot-to-start reminder's policy on Android: the Kotlin mirror of `src/reminder/policy.ts`
 * (the shared rules and the activity-transition batch), under the same names with the same values
 * (`__tests__/native-android.test.ts` compares the constants). Pure: no android.*, androidx.* or
 * org.json, no clock, no I/O. [TripReminder] reads the phone and does what the result says.
 *
 * The reminder only ever notifies. Nothing here starts a capture.
 */

data class ReminderTrip(
  var startedAt: Long,
  var lastVehicleAt: Long,
  var inVehicle: Boolean = true,
  var vehicleExitAt: Long = 0L,
  var recorded: Boolean = false,
  var reminded: Boolean = false,
  var retries: Int = 0,
  var sessions: Int = 0,
  var lastSessionEndAt: Long = 0L
)

data class ReminderState(
  var enabled: Boolean = false,
  var autoOff: Boolean = false,
  var trip: ReminderTrip? = null,
  var lastCaptureEndAt: Long = 0L,
  var posts: MutableList<Long> = mutableListOf(),
  var pendingAt: Long = 0L,
  var postedAt: Long = 0L,
  var showing: Boolean = false,
  var missStreak: Int = 0,
  var pauseLevel: Int = 0,
  var pausedUntil: Long = 0L,
  var quietUntil: Long = 0L,
  var notDrivingUntil: Long = 0L
) {
  /** A copy that shares nothing mutable with this one. */
  fun deepCopy(): ReminderState = copy(trip = trip?.copy(), posts = posts.toMutableList())
}

/** What the phone says at the moment of a stop. */
data class ReminderCtx(
  val permissionsOk: Boolean,
  val capturing: Boolean,
  val appForeground: Boolean,
  val inCall: Boolean,
  val eventAgeMs: Long = 0L,
  val onFoot: Boolean = false
)

enum class TransitionKind { VEHICLE_ENTER, VEHICLE_EXIT, STILL_ENTER, WALKING_ENTER, RUNNING_ENTER }

data class Transition(val kind: TransitionKind, val ts: Long)

object TripReminderPolicy {
  const val STOP_MPS = 1.34
  const val MOVE_MPS = 2.24
  const val IOS_DRIVING_MPS = 4.47
  const val SPEED_ACC_MAX_MPS = 2.0
  const val STOP_HOLD_MS = 12_000L
  const val MOVED_AWAY_M = 30.0
  const val WALK_CHECK_MS = 30_000L
  const val UNSEEN_MS = 20_000L
  const val MAX_RETRIES_PER_TRIP = 1
  const val STILL_AFTER_VEHICLE_MS = 120_000L
  const val STALE_EVENT_MS = 45_000L
  const val MIN_IN_VEHICLE_MS = 90_000L
  const val TRIP_GAP_MS = 600_000L
  const val MAX_TRIP_IDLE_MS = 10_800_000L
  const val AFTER_DRIVE_MS = 600_000L
  const val UNUSED_QUIET_MS = 14_400_000L
  const val DAY_MS = 86_400_000L
  const val DAILY_CAP = 2
  const val TTL_MS = 300_000L
  const val CONVERT_WINDOW_MS = 1_800_000L
  const val MISS_LIMIT = 3
  const val NOT_DRIVING_QUIET_MS = 43_200_000L
  const val AUTOMOTIVE_FRESH_MS = 120_000L
  const val IOS_MOTION_MIN_LOOKBACK_MS = 600_000L
  const val IOS_MOTION_MAX_LOOKBACK_MS = 10_800_000L
  const val IOS_SESSION_MAX_MS = 600_000L
  const val IOS_SESSION_NO_DRIVE_MS = 180_000L
  const val IOS_SESSIONS_PER_TRIP = 2
  const val IOS_SESSION_SPACING_MS = 600_000L
  const val CLOCK_FUTURE_MS = 86_400_000L

  /** The back-off pauses, in days; the step after the last turns the reminder off. */
  val PAUSE_DAYS = longArrayOf(7L, 28L)
  private const val MAX_PAUSE_MS = 28L * DAY_MS

  enum class Tier { NONE, CAPTURE, IDLE, TRIP }
  enum class Outcome { CONVERTED, UNSEEN, ARRIVAL, NOT_DRIVING, MISSED }
  enum class Effect { NONE, POST, WITHDRAW }

  class TransitionResult(val state: ReminderState, val effect: Effect, val reason: String?)

  fun newTrip(startedAt: Long, lastVehicleAt: Long = startedAt): ReminderTrip = ReminderTrip(startedAt, lastVehicleAt)

  fun recentPosts(s: ReminderState, now: Long): Int = s.posts.count { now - it < DAY_MS }

  /** policy.ts `settle`. */
  fun settle(s0: ReminderState, now: Long): ReminderState {
    val s = s0.deepCopy()
    fun past(t: Long): Long = if (t > now + CLOCK_FUTURE_MS) now else t
    s.lastCaptureEndAt = past(s.lastCaptureEndAt)
    s.pendingAt = past(s.pendingAt)
    s.postedAt = past(s.postedAt)
    s.posts = s.posts.map { past(it) }.filter { now - it < DAY_MS }.toMutableList()
    s.pausedUntil = minOf(s.pausedUntil, now + MAX_PAUSE_MS)
    s.quietUntil = minOf(s.quietUntil, now + UNUSED_QUIET_MS)
    s.notDrivingUntil = minOf(s.notDrivingUntil, now + NOT_DRIVING_QUIET_MS)
    if (s.pausedUntil != 0L && now >= s.pausedUntil) s.pausedUntil = 0L
    if (s.quietUntil != 0L && now >= s.quietUntil) s.quietUntil = 0L
    if (s.notDrivingUntil != 0L && now >= s.notDrivingUntil) s.notDrivingUntil = 0L
    val t = s.trip
    if (t != null) {
      t.startedAt = past(t.startedAt)
      t.lastVehicleAt = past(t.lastVehicleAt)
      t.vehicleExitAt = past(t.vehicleExitAt)
      t.lastSessionEndAt = past(t.lastSessionEndAt)
      val idle = now - t.lastVehicleAt
      if ((!t.inVehicle && idle >= TRIP_GAP_MS) || idle >= MAX_TRIP_IDLE_MS) s.trip = null
    }
    if (s.showing && now - s.postedAt >= TTL_MS) s.showing = false
    if (s.pendingAt > 0L && now - s.pendingAt >= CONVERT_WINDOW_MS) resolveIn(s, Outcome.MISSED, now)
    return s
  }

  /** policy.ts `gate(…, 'stop')`: the first reason not to remind at this stop, or "ok". */
  fun gateStop(s: ReminderState, ctx: ReminderCtx, now: Long): String {
    if (!s.enabled) return "off"
    if (now < s.pausedUntil) return "paused"
    if (now < maxOf(s.quietUntil, s.notDrivingUntil)) return "quiet"
    if (!ctx.permissionsOk) return "permission"
    if (ctx.capturing) return "capturing"
    val t = s.trip ?: return "no-trip"
    if (t.recorded) return "recorded"
    if (t.reminded) return "reminded"
    if (s.lastCaptureEndAt > 0L && now - s.lastCaptureEndAt < AFTER_DRIVE_MS) return "after-drive"
    if (recentPosts(s, now) >= DAILY_CAP) return "daily-cap"
    if (now - t.startedAt < MIN_IN_VEHICLE_MS) return "too-soon"
    if (ctx.appForeground) return "foreground"
    if (ctx.inCall) return "in-call"
    if (ctx.eventAgeMs > STALE_EVENT_MS) return "stale"
    if (ctx.onFoot) return "on-foot"
    return "ok"
  }

  private fun postedIn(s: ReminderState, now: Long) {
    s.posts.add(now)
    s.trip?.reminded = true
    s.pendingAt = now
    s.postedAt = now
    s.showing = true
    s.quietUntil = now + UNUSED_QUIET_MS
  }

  private fun missIn(s: ReminderState, now: Long) {
    s.missStreak += 1
    if (s.missStreak < MISS_LIMIT) return
    s.missStreak = 0
    if (s.pauseLevel < PAUSE_DAYS.size) {
      s.pausedUntil = now + PAUSE_DAYS[s.pauseLevel] * DAY_MS
      s.pauseLevel += 1
    } else {
      s.enabled = false
      s.autoOff = true
      s.pausedUntil = 0L
    }
  }

  private fun resolveIn(s: ReminderState, outcome: Outcome, now: Long) {
    s.showing = false
    s.pendingAt = 0L
    when (outcome) {
      Outcome.CONVERTED -> {
        s.missStreak = 0
        s.pauseLevel = 0
        s.quietUntil = 0L
      }
      Outcome.UNSEEN -> {
        s.quietUntil = 0L
        val t = s.trip
        if (t != null && t.retries < MAX_RETRIES_PER_TRIP) {
          t.retries += 1
          t.reminded = false
        }
      }
      Outcome.ARRIVAL -> Unit
      Outcome.NOT_DRIVING -> {
        s.notDrivingUntil = now + NOT_DRIVING_QUIET_MS
        missIn(s, now)
      }
      Outcome.MISSED -> missIn(s, now)
    }
  }

  fun resolve(s0: ReminderState, outcome: Outcome, now: Long): ReminderState {
    val s = s0.deepCopy()
    resolveIn(s, outcome, now)
    return s
  }

  fun captureStarted(s0: ReminderState, now: Long): ReminderState {
    val s = s0.deepCopy()
    val t = s.trip ?: newTrip(now).also { s.trip = it }
    t.recorded = true
    if (s.pendingAt > 0L && now - s.pendingAt <= CONVERT_WINDOW_MS) resolveIn(s, Outcome.CONVERTED, now)
    s.showing = false
    return s
  }

  fun captureEnded(s0: ReminderState, now: Long): ReminderState {
    val s = s0.deepCopy()
    s.lastCaptureEndAt = now
    val t = s.trip
    if (t != null) {
      t.inVehicle = false
      t.lastVehicleAt = now
    }
    return s
  }

  fun appForeground(s0: ReminderState): ReminderState {
    val s = s0.deepCopy()
    s.showing = false
    return s
  }

  fun setEnabled(s0: ReminderState, on: Boolean): ReminderState {
    if (!on) return ReminderState()
    val s = s0.deepCopy()
    s.enabled = true
    s.autoOff = false
    s.pausedUntil = 0L
    s.missStreak = 0
    s.pauseLevel = 0
    s.quietUntil = 0L
    s.notDrivingUntil = 0L
    return s
  }

  fun tier(s: ReminderState, capturing: Boolean, transitionsOk: Boolean): Tier {
    if (!transitionsOk) return Tier.NONE
    if (capturing) return Tier.CAPTURE
    if (!s.enabled) return Tier.NONE
    return if (s.trip != null) Tier.TRIP else Tier.IDLE
  }

  /** policy.ts `onTransitions`: one delivered batch, read whole before acting. */
  fun onTransitions(s0: ReminderState, events: List<Transition>, arrival: Long, subscribedAt: Long, ctx: ReminderCtx): TransitionResult {
    val s = settle(s0, arrival)
    var withdrew = false
    var stop: Transition? = null
    var afterStop = false
    for (e in events.filter { it.ts >= subscribedAt }.sortedBy { it.ts }) {
      val t = s.trip
      when (e.kind) {
        TransitionKind.VEHICLE_ENTER -> {
          if (s.showing) {
            s.showing = false
            withdrew = true
          }
          if (t == null) {
            s.trip = newTrip(e.ts)
          } else {
            t.inVehicle = true
            t.lastVehicleAt = maxOf(t.lastVehicleAt, e.ts)
          }
          if (stop != null) afterStop = true
        }
        TransitionKind.VEHICLE_EXIT -> {
          if (t != null) {
            if (t.inVehicle) {
              t.inVehicle = false
              t.lastVehicleAt = maxOf(t.lastVehicleAt, e.ts)
            }
            t.vehicleExitAt = e.ts
          }
        }
        TransitionKind.WALKING_ENTER, TransitionKind.RUNNING_ENTER -> {
          if (s.showing) {
            resolveIn(s, Outcome.ARRIVAL, arrival)
            withdrew = true
          }
          if (t != null && t.inVehicle) {
            t.inVehicle = false
            t.lastVehicleAt = maxOf(t.lastVehicleAt, e.ts)
          }
          if (stop != null) afterStop = true
        }
        TransitionKind.STILL_ENTER -> {
          if (t != null && !t.inVehicle && t.vehicleExitAt > 0L && e.ts >= t.vehicleExitAt &&
            e.ts - t.vehicleExitAt <= STILL_AFTER_VEHICLE_MS
          ) {
            stop = e
            afterStop = false
          }
        }
      }
    }
    val effect = if (withdrew) Effect.WITHDRAW else Effect.NONE
    val st = stop ?: return TransitionResult(s, effect, null)
    val reason = gateStop(s, ctx.copy(eventAgeMs = arrival - st.ts, onFoot = afterStop), arrival)
    if (reason != "ok") return TransitionResult(s, effect, reason)
    postedIn(s, arrival)
    return TransitionResult(s, Effect.POST, reason)
  }
}
