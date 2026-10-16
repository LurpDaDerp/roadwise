package expo.modules.drivesense

/**
 * The forgot-to-start reminder's policy on Android: the Kotlin mirror of `src/reminder/policy.ts`
 * (the shared rules, the tap's hand-over and claim, and the activity-transition batch), under the
 * same names with the same values (`__tests__/native-android.test.ts` compares the constants). Pure:
 * no android.*, androidx.* or org.json, no clock, no I/O. [TripReminder] reads the phone and does
 * what the result says.
 *
 * The rule is the session: a stretch of driving that ends 30 min after its last driving moment (an
 * open drive counts as driving). At most one reminder a session, at a stop, after driving speed with
 * no drive open, never while a drive is open. Nothing here starts a capture: a tap's token is only
 * ever claimed, and JS starts the drive.
 */

/** One stretch of driving. `inVehicle`, `vehicleExitAt` and `lastNewsAt` are Android's. */
data class ReminderSession(
  var startedAt: Long,
  var lastDrivingAt: Long,
  var lastNewsAt: Long,
  var inVehicle: Boolean,
  var vehicleExitAt: Long = 0L,
  var drove: Boolean = false,
  var reminded: Boolean = false
)

data class ReminderState(
  var enabled: Boolean = false,
  var session: ReminderSession? = null,
  var lastDriveEndAt: Long = 0L,
  /** The one-use token of the note that is up; "" = no note. */
  var token: String = "",
  var postedAt: Long = 0L,
  /** The tokens last handed to JS from a tap, newest last. */
  var tapSeen: MutableList<String> = mutableListOf(),
  /** When the live token's tap was handed over; 0 = not yet. */
  var tapAt: Long = 0L,
  /** iOS only; kept so the stored shape is the reference's. */
  var lookRestUntil: Long = 0L
) {
  /** A copy that shares nothing mutable with this one. */
  fun deepCopy(): ReminderState = copy(session = session?.copy(), tapSeen = tapSeen.toMutableList())
}

/** What the phone says at the moment of a stop. */
data class ReminderCtx(
  val permissionsOk: Boolean,
  val capturing: Boolean,
  val eventAgeMs: Long = 0L,
  val onFoot: Boolean = false
)

enum class TransitionKind { VEHICLE_ENTER, VEHICLE_EXIT, STILL_ENTER, WALKING_ENTER, RUNNING_ENTER }

data class Transition(val kind: TransitionKind, val ts: Long)

object TripReminderPolicy {
  const val STOP_MPS = 1.34
  const val IOS_DRIVING_MPS = 4.47
  const val SPEED_ACC_MAX_MPS = 2.0
  const val STOP_HOLD_MS = 12_000L
  const val SESSION_GAP_MS = 1_800_000L
  const val IN_VEHICLE_NOTE_MS = 10_800_000L
  const val STILL_AFTER_VEHICLE_MS = 120_000L
  const val STALE_EVENT_MS = 45_000L
  const val AUTOMOTIVE_FRESH_MS = 120_000L
  const val IOS_MOTION_LOOKBACK_MS = 10_800_000L
  const val IOS_LOOK_MAX_MS = 600_000L
  const val IOS_LOOK_NO_DRIVE_MS = 180_000L
  const val IOS_LOOK_REST_MS = 600_000L
  const val TAP_FRESH_MS = 120_000L
  const val TAP_SEEN_MAX = 8
  const val CLOCK_FUTURE_MS = 86_400_000L

  enum class Tier { NONE, CAPTURE, IDLE, SESSION }
  enum class Effect { NONE, POST, REFRESH, WITHDRAW }

  class TransitionResult(val state: ReminderState, val effect: Effect, val reason: String?, val expiresAt: Long)
  class TapResult(val state: ReminderState, val delivered: Boolean)
  class ClaimResult(val state: ReminderState, val ok: Boolean)

  fun newSession(startedAt: Long, lastDrivingAt: Long, inVehicle: Boolean): ReminderSession =
    ReminderSession(startedAt, lastDrivingAt, lastDrivingAt, inVehicle)

  /** policy.ts `clampTimes`: a stored time more than a day ahead is a clock change. */
  fun clampTimes(s0: ReminderState, now: Long): ReminderState {
    val s = s0.deepCopy()
    fun past(t: Long): Long = if (t > now + CLOCK_FUTURE_MS) now else t
    s.lastDriveEndAt = past(s.lastDriveEndAt)
    s.postedAt = past(s.postedAt)
    s.tapAt = past(s.tapAt)
    s.lookRestUntil = past(s.lookRestUntil)
    val x = s.session
    if (x != null) {
      x.startedAt = past(x.startedAt)
      x.lastDrivingAt = past(x.lastDrivingAt)
      x.lastNewsAt = past(x.lastNewsAt)
      x.vehicleExitAt = past(x.vehicleExitAt)
    }
    return s
  }

  /** policy.ts `endIfOver`: 30 min past the last driving moment, out of the vehicle, no drive open. */
  fun endIfOver(s0: ReminderState, t: Long, capturing: Boolean): ReminderState {
    val x = s0.session ?: return s0
    if (capturing || x.inVehicle || t - x.lastDrivingAt < SESSION_GAP_MS) return s0
    val s = s0.deepCopy()
    s.session = null
    s.token = ""
    s.tapAt = 0L
    return s
  }

  /** policy.ts `settle`. */
  fun settle(s0: ReminderState, now: Long, capturing: Boolean): ReminderState = endIfOver(clampTimes(s0, now), now, capturing)

  /** policy.ts `gate(…, 'stop')`: the first reason not to remind at this stop, or "ok". */
  fun gateStop(s: ReminderState, ctx: ReminderCtx, now: Long): String {
    if (!s.enabled) return "off"
    if (!ctx.permissionsOk) return "permission"
    if (ctx.capturing) return "capturing"
    val x = s.session ?: return "no-session"
    if (x.reminded) return "reminded"
    if (!x.drove) return "not-driven"
    if (ctx.eventAgeMs > STALE_EVENT_MS) return "stale"
    if (ctx.onFoot) return "on-foot"
    return "ok"
  }

  /** policy.ts `posted`. */
  fun posted(s0: ReminderState, now: Long, token: String): ReminderState {
    val s = s0.deepCopy()
    s.session?.reminded = true
    s.token = token
    s.postedAt = now
    s.tapAt = 0L
    return s
  }

  /** policy.ts `unposted`: the note with [token] never showed. */
  fun unposted(s0: ReminderState, token: String): ReminderState {
    if (token.isEmpty() || s0.token != token) return s0
    val s = s0.deepCopy()
    s.token = ""
    s.tapAt = 0L
    s.session?.reminded = false
    return s
  }

  /** policy.ts `noteGone`. */
  fun noteGone(s0: ReminderState): ReminderState {
    val s = s0.deepCopy()
    s.token = ""
    s.tapAt = 0L
    return s
  }

  /** policy.ts `tapDelivered`: a token handed over before is never handed over again. */
  fun tapDelivered(s0: ReminderState, token: String, now: Long): TapResult {
    if (s0.tapSeen.contains(token)) return TapResult(s0, false)
    val s = s0.deepCopy()
    s.tapSeen.add(token)
    while (s.tapSeen.size > TAP_SEEN_MAX) s.tapSeen.removeAt(0)
    if (token.isNotEmpty() && token == s.token) s.tapAt = now
    return TapResult(s, true)
  }

  /** policy.ts `claim`: true once, for the note's token, in a live session, no drive open, handed over within 2 min. */
  fun claim(s0: ReminderState, token: String, now: Long, capturing: Boolean, requireDelivery: Boolean): ClaimResult {
    val s = settle(s0, now, capturing)
    val fresh = !requireDelivery || (s.tapAt > 0L && now - s.tapAt <= TAP_FRESH_MS)
    val ok = s.enabled && token.isNotEmpty() && token == s.token && s.session != null && !capturing && fresh
    if (!ok) return ClaimResult(s, false)
    val c = s.deepCopy()
    c.token = ""
    c.tapAt = 0L
    return ClaimResult(c, true)
  }

  /** policy.ts `captureStarted`. */
  fun captureStarted(s0: ReminderState, now: Long): ReminderState {
    val s = s0.deepCopy()
    s.token = ""
    s.tapAt = 0L
    val x = s.session
    if (x != null) {
      x.drove = false
      x.lastDrivingAt = maxOf(x.lastDrivingAt, now)
      x.lastNewsAt = maxOf(x.lastNewsAt, now)
    }
    return s
  }

  /**
   * policy.ts `captureEnded`: the drive's driving end is the session's last driving moment; null (a
   * drive that was not kept) leaves the clock as it was; left out, it is now. [drivingAtEnd]: the
   * car was at driving speed as the drive ended, so the session (opened now if there is none) has
   * driven; [vehicle] (Android's own calls) marks it in the vehicle.
   */
  fun captureEnded(s0: ReminderState, now: Long, drivingEndedAt: Long? = now, drivingAtEnd: Boolean = false, vehicle: Boolean = false): ReminderState {
    val s = s0.deepCopy()
    s.lastDriveEndAt = now
    val x = s.session
    if (x != null) {
      x.drove = drivingAtEnd
      x.lastNewsAt = maxOf(x.lastNewsAt, now)
      if (drivingEndedAt != null) x.lastDrivingAt = maxOf(x.lastDrivingAt, minOf(now, drivingEndedAt))
      if (drivingAtEnd) {
        x.lastDrivingAt = maxOf(x.lastDrivingAt, now)
        x.inVehicle = x.inVehicle || vehicle
      }
    } else if (drivingAtEnd && s.enabled) {
      s.session = newSession(now, now, vehicle).also { it.drove = true }
    }
    return s
  }

  /** policy.ts `setEnabled`: on keeps the session; off forgets everything. */
  fun setEnabled(s0: ReminderState, on: Boolean): ReminderState {
    if (!on) return ReminderState()
    val s = s0.deepCopy()
    s.enabled = true
    return s
  }

  fun tier(s: ReminderState, capturing: Boolean, transitionsOk: Boolean): Tier {
    if (!transitionsOk) return Tier.NONE
    if (capturing) return Tier.CAPTURE
    if (!s.enabled) return Tier.NONE
    return if (s.session != null) Tier.SESSION else Tier.IDLE
  }

  /** policy.ts `noteExpiresAt`: 3 h on while in the vehicle, else the session's end; 0 with no session. */
  fun noteExpiresAt(s: ReminderState, now: Long): Long {
    val x = s.session ?: return 0L
    return if (x.inVehicle) now + IN_VEHICLE_NOTE_MS else x.lastDrivingAt + SESSION_GAP_MS
  }

  private val BY_TIME = compareBy<Transition>({ it.ts }, { if (it.kind == TransitionKind.VEHICLE_EXIT) 0 else 1 })

  /** The replayed current activity, read as the state at [subscribedAt]: never a stop, never driving speed. */
  private fun applyReplay(s: ReminderState, e: Transition, subscribedAt: Long) {
    val x = s.session ?: return
    x.lastNewsAt = maxOf(x.lastNewsAt, subscribedAt)
    if (e.kind == TransitionKind.VEHICLE_ENTER) {
      x.inVehicle = true
      x.lastDrivingAt = maxOf(x.lastDrivingAt, subscribedAt)
    } else if (x.inVehicle) {
      x.inVehicle = false
    }
  }

  private fun newestReplay(events: List<Transition>, subscribedAt: Long): Transition? =
    events.filter { it.ts < subscribedAt }.sortedWith(BY_TIME).lastOrNull()

  /** policy.ts `onTransitions`: one batch with no drive open, each live event after the session's end is decided on its own time. */
  fun onTransitions(
    s0: ReminderState,
    events: List<Transition>,
    arrival: Long,
    subscribedAt: Long,
    ctx: ReminderCtx,
    newToken: String
  ): TransitionResult {
    var s = clampTimes(s0, arrival)
    val tokenBefore = s.token
    val cap = ctx.capturing
    val replay = newestReplay(events, subscribedAt)
    if (replay != null) {
      s = endIfOver(s, subscribedAt, cap)
      applyReplay(s, replay, subscribedAt)
    }
    var stop: Transition? = null
    var stopSession = 0L
    var afterStop = false
    for (e in events.filter { it.ts >= subscribedAt }.sortedWith(BY_TIME)) {
      s = endIfOver(s, e.ts, cap)
      val x = s.session
      when (e.kind) {
        TransitionKind.VEHICLE_ENTER -> {
          val drove = e.ts > s.lastDriveEndAt
          if (x == null) {
            s.session = newSession(e.ts, e.ts, true).also { it.drove = drove }
          } else if (x.inVehicle && e.ts - x.lastNewsAt >= SESSION_GAP_MS) {
            // A lost EXIT: the old session ends here and a new one opens.
            s.session = newSession(e.ts, e.ts, true).also { it.drove = drove }
            s.token = ""
            s.tapAt = 0L
          } else {
            x.inVehicle = true
            x.lastDrivingAt = maxOf(x.lastDrivingAt, e.ts)
            x.lastNewsAt = maxOf(x.lastNewsAt, e.ts)
            x.drove = x.drove || drove
          }
          if (stop != null) afterStop = true
        }
        TransitionKind.VEHICLE_EXIT -> {
          if (x != null) {
            x.inVehicle = false
            x.lastDrivingAt = maxOf(x.lastDrivingAt, e.ts)
            x.lastNewsAt = maxOf(x.lastNewsAt, e.ts)
            x.vehicleExitAt = e.ts
          }
        }
        TransitionKind.WALKING_ENTER, TransitionKind.RUNNING_ENTER -> {
          if (x != null) {
            if (x.inVehicle) {
              x.inVehicle = false
              x.lastDrivingAt = maxOf(x.lastDrivingAt, e.ts)
            }
            x.lastNewsAt = maxOf(x.lastNewsAt, e.ts)
          }
          if (stop != null) afterStop = true
        }
        TransitionKind.STILL_ENTER -> {
          if (x != null) {
            x.lastNewsAt = maxOf(x.lastNewsAt, e.ts)
            if (!x.inVehicle && x.vehicleExitAt > 0L && e.ts >= x.vehicleExitAt && e.ts - x.vehicleExitAt <= STILL_AFTER_VEHICLE_MS) {
              stop = e
              stopSession = x.startedAt
              afterStop = false
            }
          }
        }
      }
    }
    s = endIfOver(s, arrival, cap)
    var effect = when {
      tokenBefore.isNotEmpty() && s.token.isEmpty() -> Effect.WITHDRAW
      s.token.isNotEmpty() -> Effect.REFRESH
      else -> Effect.NONE
    }
    var reason: String? = null
    val st = stop
    val open = s.session
    if (st != null && open != null && open.startedAt == stopSession) {
      reason = gateStop(s, ctx.copy(eventAgeMs = arrival - st.ts, onFoot = afterStop), arrival)
      if (reason == "ok") {
        s = posted(s, arrival, newToken)
        effect = Effect.POST
      }
    }
    return TransitionResult(s, effect, reason, noteExpiresAt(s, arrival))
  }

  /** policy.ts `foldCaptureTransitions`: a capture batch is the vehicle state only; it never ends, posts or marks driving speed. */
  fun foldCaptureTransitions(s0: ReminderState, events: List<Transition>, subscribedAt: Long): ReminderState {
    if (s0.session == null) return s0
    val s = s0.deepCopy()
    val x = s.session ?: return s
    val replay = newestReplay(events, subscribedAt)
    if (replay != null) applyReplay(s, replay, subscribedAt)
    for (e in events.filter { it.ts >= subscribedAt }.sortedWith(BY_TIME)) {
      x.lastNewsAt = maxOf(x.lastNewsAt, e.ts)
      when (e.kind) {
        TransitionKind.VEHICLE_ENTER -> x.inVehicle = true
        TransitionKind.VEHICLE_EXIT, TransitionKind.WALKING_ENTER, TransitionKind.RUNNING_ENTER -> x.inVehicle = false
        TransitionKind.STILL_ENTER -> {}
      }
    }
    return s
  }
}
