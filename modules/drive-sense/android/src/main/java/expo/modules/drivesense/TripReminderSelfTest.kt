package expo.modules.drivesense

import org.json.JSONArray
import org.json.JSONObject

/**
 * The forgot-to-start reminder's half of the on-device self-test (README §10 "Self-test"). Each
 * `reminder` vector carries one row of `src/reminder/vectors.ts` without its `expected`; this runs
 * it through the PRODUCTION [TripReminderPolicy] — never a copy — and answers the row's `actual`,
 * which `src/reminder/selfTest.ts` matches against the row's `expected`. Rows of the iOS-only rules
 * (the wake, the fixes, the stop, the watch, the wake and session gates, a session's end) are
 * answered `skipped`. Pure: nothing here touches the phone, the stored state or a notification.
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
    "gate" -> if (row.getString("phase") == "stop") null else "the wake and session gates are iOS rules"
    "ops" -> {
      val ops = row.getJSONArray("ops")
      if ((0 until ops.length()).any { ops.getJSONObject(it).getString("op") == "sessionEnded" }) "a GPS session is an iOS rule" else null
    }
    "transitions" -> null
    // the wake, the fixes, the stop and the watch (the JS diff fails a skip of any row Android has)
    else -> "an iOS rule"
  }

  private fun actual(row: JSONObject): JSONObject = when (row.getString("kind")) {
    "gate" -> JSONObject().put(
      "reason",
      TripReminderPolicy.gateStop(state(row.getJSONObject("state")), ctx(row.getJSONObject("ctx")), row.getLong("now"))
    )
    "ops" -> JSONObject().put("state", stateJson(ops(state(row.getJSONObject("state")), row.getJSONArray("ops"))))
    "transitions" -> {
      val r = TripReminderPolicy.onTransitions(
        state(row.getJSONObject("state")),
        transitions(row.getJSONArray("events")),
        row.getLong("arrival"),
        row.getLong("subscribedAt"),
        ctx(row.getJSONObject("ctx"))
      )
      JSONObject()
        .put("effect", effect(r.effect))
        .put("reason", r.reason ?: JSONObject.NULL)
        .put("state", stateJson(r.state))
    }
    else -> throw IllegalArgumentException("not an Android row")
  }

  private fun ops(s0: ReminderState, ops: JSONArray): ReminderState {
    var s = s0
    for (i in 0 until ops.length()) {
      val o = ops.getJSONObject(i)
      s = when (val op = o.getString("op")) {
        "settle" -> TripReminderPolicy.settle(s, o.getLong("now"))
        "posted" -> TripReminderPolicy.posted(s, o.getLong("now"))
        "resolve" -> TripReminderPolicy.resolve(s, outcome(o.getString("outcome")), o.getLong("now"))
        "captureStarted" -> TripReminderPolicy.captureStarted(s, o.getLong("now"))
        "captureEnded" -> TripReminderPolicy.captureEnded(s, o.getLong("now"))
        "appForeground" -> TripReminderPolicy.appForeground(s)
        "setEnabled" -> TripReminderPolicy.setEnabled(s, o.getBoolean("on"))
        else -> throw IllegalArgumentException("unknown op '$op'")
      }
    }
    return s
  }

  /** A row's state, read by the same code that reads the stored one. */
  private fun state(o: JSONObject): ReminderState =
    TripReminderState.fromJson(o.toString()) ?: throw IllegalArgumentException("the row's state is not a v2 ReminderState")

  private fun stateJson(s: ReminderState): JSONObject = JSONObject(TripReminderState.toJson(s))

  private fun ctx(o: JSONObject): ReminderCtx = ReminderCtx(
    permissionsOk = o.getBoolean("permissionsOk"),
    capturing = o.getBoolean("capturing"),
    appForeground = o.getBoolean("appForeground"),
    inCall = o.getBoolean("inCall"),
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

  private fun outcome(o: String): TripReminderPolicy.Outcome = when (o) {
    "converted" -> TripReminderPolicy.Outcome.CONVERTED
    "unseen" -> TripReminderPolicy.Outcome.UNSEEN
    "notDriving" -> TripReminderPolicy.Outcome.NOT_DRIVING
    "missed" -> TripReminderPolicy.Outcome.MISSED
    else -> throw IllegalArgumentException("unknown outcome '$o'")
  }

  private fun effect(e: TripReminderPolicy.Effect): String = when (e) {
    TripReminderPolicy.Effect.NONE -> "none"
    TripReminderPolicy.Effect.POST -> "post"
    TripReminderPolicy.Effect.WITHDRAW -> "withdraw"
  }
}
