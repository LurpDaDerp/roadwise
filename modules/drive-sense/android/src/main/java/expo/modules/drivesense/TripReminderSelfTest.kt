package expo.modules.drivesense

import org.json.JSONArray
import org.json.JSONObject

/**
 * The forgot-to-start reminder's half of the on-device self-test (README §10 "Self-test"). Each
 * `reminder` vector carries one row of `src/reminder/vectors.ts` without its `expected`; this runs
 * it through the PRODUCTION [TripReminderPolicy] and [TripReminderState] — never a copy — and
 * answers the row's `actual`, which `src/reminder/selfTest.ts` matches against the row's `expected`.
 * Rows of the iOS-only rules (the wake and look gates, the motion history, the look's fixes, the
 * held stop, a look's end, a claim without the hand-over check) are answered `skipped`. Pure:
 * nothing here touches the phone, the stored state or a notification.
 */
object TripReminderSelfTest {
  private const val KIND = "reminder"

  /** The result object for one vector: `actual`, `skipped`, or `error` for a malformed row. */
  fun result(name: String, inputs: JSONObject): JSONObject {
    val out = JSONObject().put("name", name).put("kind", KIND)
    return try {
      val skip = skipReason(inputs)
      if (skip != null) out.put("skipped", skip) else out.put("actual", actual(inputs))
    } catch (e: Exception) {
      out.put("error", e.message ?: e.javaClass.simpleName)
    }
  }

  private fun skipReason(row: JSONObject): String? = when (row.getString("kind")) {
    "gate" -> if (row.getString("phase") == "stop") null else "the wake and look gates are iOS rules"
    "ops" -> {
      val ops = row.getJSONArray("ops")
      if ((0 until ops.length()).any { ops.getJSONObject(it).getString("op") == "lookEnded" }) "a GPS look is an iOS rule" else null
    }
    "claim" -> if (row.getBoolean("requireDelivery") && row.isNull("motion")) null else "a claim without the hand-over check is iOS's"
    "tap", "transitions", "expires", "stored" -> null
    // the wake, the motion history, the fixes and the stop (the JS diff fails a skip of any row Android has)
    else -> "an iOS rule"
  }

  private fun actual(row: JSONObject): JSONObject = when (row.getString("kind")) {
    "gate" -> JSONObject().put(
      "reason",
      TripReminderPolicy.gateStop(state(row.getJSONObject("state")), ctx(row.getJSONObject("ctx")), row.getLong("now"))
    )
    "ops" -> JSONObject().put("state", stateJson(ops(state(row.getJSONObject("state")), row.getJSONArray("ops"))))
    "tap" -> {
      var s = state(row.getJSONObject("state"))
      val delivered = JSONArray()
      val taps = row.getJSONArray("taps")
      for (i in 0 until taps.length()) {
        val t = taps.getJSONObject(i)
        val r = TripReminderPolicy.tapDelivered(s, t.getString("token"), t.getLong("now"))
        s = r.state
        delivered.put(r.delivered)
      }
      JSONObject().put("delivered", delivered).put("state", stateJson(s))
    }
    "claim" -> {
      val r = TripReminderPolicy.claim(
        state(row.getJSONObject("state")),
        row.getString("token"),
        row.getLong("now"),
        row.getBoolean("capturing"),
        row.getBoolean("requireDelivery")
      )
      JSONObject().put("ok", r.ok).put("state", stateJson(r.state))
    }
    "transitions" -> {
      val r = TripReminderPolicy.onTransitions(
        state(row.getJSONObject("state")),
        transitions(row.getJSONArray("events")),
        row.getLong("arrival"),
        row.getLong("subscribedAt"),
        ctx(row.getJSONObject("ctx")),
        row.getString("newToken")
      )
      JSONObject()
        .put("effect", effect(r.effect))
        .put("reason", r.reason ?: JSONObject.NULL)
        .put("expiresAt", r.expiresAt)
        .put("state", stateJson(r.state))
    }
    "expires" -> JSONObject().put("expiresAt", TripReminderPolicy.noteExpiresAt(state(row.getJSONObject("state")), row.getLong("now")))
    "stored" -> {
      // Read as the stored state is: a JSON object's text, anything else unreadable.
      val raw = row.opt("stored")
      val text = if (raw is JSONObject) raw.toString() else (raw?.toString() ?: "")
      JSONObject().put("state", stateJson(TripReminderState.fromJson(text) ?: ReminderState()))
    }
    else -> throw IllegalArgumentException("not an Android row")
  }

  private fun ops(s0: ReminderState, ops: JSONArray): ReminderState {
    var s = s0
    for (i in 0 until ops.length()) {
      val o = ops.getJSONObject(i)
      s = when (val op = o.getString("op")) {
        "settle" -> TripReminderPolicy.settle(s, o.getLong("now"), o.getBoolean("capturing"))
        "posted" -> TripReminderPolicy.posted(s, o.getLong("now"), o.getString("token"))
        "unposted" -> TripReminderPolicy.unposted(s, o.getString("token"))
        "noteGone" -> TripReminderPolicy.noteGone(s)
        "captureStarted" -> TripReminderPolicy.captureStarted(s, o.getLong("now"))
        // Left out = now; null = a drive that was not kept. drivingAtEnd and vehicle left out = false.
        "captureEnded" -> {
          val now = o.getLong("now")
          val end: Long? = when {
            !o.has("drivingEndedAt") -> now
            o.isNull("drivingEndedAt") -> null
            else -> o.getLong("drivingEndedAt")
          }
          TripReminderPolicy.captureEnded(s, now, end, o.optBoolean("drivingAtEnd", false), o.optBoolean("vehicle", false))
        }
        "captureTransitions" -> TripReminderPolicy.foldCaptureTransitions(s, transitions(o.getJSONArray("events")), o.getLong("subscribedAt"))
        "setEnabled" -> TripReminderPolicy.setEnabled(s, o.getBoolean("on"))
        else -> throw IllegalArgumentException("unknown op '$op'")
      }
    }
    return s
  }

  /** A row's state, read by the same code that reads the stored one. */
  private fun state(o: JSONObject): ReminderState =
    TripReminderState.fromJson(o.toString()) ?: throw IllegalArgumentException("the row's state is not a v3 ReminderState")

  private fun stateJson(s: ReminderState): JSONObject = JSONObject(TripReminderState.toJson(s))

  private fun ctx(o: JSONObject): ReminderCtx = ReminderCtx(
    permissionsOk = o.getBoolean("permissionsOk"),
    capturing = o.getBoolean("capturing"),
    eventAgeMs = o.getLong("eventAgeMs"),
    onFoot = o.getBoolean("onFoot")
  )

  private fun transitions(a: JSONArray): List<Transition> = (0 until a.length()).map { i ->
    val e = a.getJSONObject(i)
    val kind = when (val k = e.getString("kind")) {
      "vehicle-enter" -> TransitionKind.VEHICLE_ENTER
      "vehicle-exit" -> TransitionKind.VEHICLE_EXIT
      "still-enter" -> TransitionKind.STILL_ENTER
      "walking-enter" -> TransitionKind.WALKING_ENTER
      "running-enter" -> TransitionKind.RUNNING_ENTER
      else -> throw IllegalArgumentException("unknown transition '$k'")
    }
    Transition(kind, e.getLong("ts"))
  }

  private fun effect(e: TripReminderPolicy.Effect): String = when (e) {
    TripReminderPolicy.Effect.NONE -> "none"
    TripReminderPolicy.Effect.POST -> "post"
    TripReminderPolicy.Effect.REFRESH -> "refresh"
    TripReminderPolicy.Effect.WITHDRAW -> "withdraw"
  }
}
