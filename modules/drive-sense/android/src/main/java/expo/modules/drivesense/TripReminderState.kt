package expo.modules.drivesense

import org.json.JSONArray
import org.json.JSONObject

/**
 * The reminder's [ReminderState] as the JSON kept in [DriveSensePrefs.tripReminderJson], with the
 * field names of `ReminderState` in `src/reminder/policy.ts` (`v: 3`). A stored v2 (the reminder
 * before sessions) keeps only its switch. Anything unreadable is null, read as the initial state
 * (off): the reminder never guesses itself on.
 */
object TripReminderState {
  fun toJson(s: ReminderState): String {
    val o = JSONObject()
      .put("v", 3)
      .put("enabled", s.enabled)
      .put("lastDriveEndAt", s.lastDriveEndAt)
      .put("token", s.token)
      .put("postedAt", s.postedAt)
      .put("tapSeen", JSONArray().also { a -> s.tapSeen.forEach { a.put(it) } })
      .put("tapAt", s.tapAt)
      .put("lookRestUntil", s.lookRestUntil)
    val x = s.session
    if (x == null) {
      o.put("session", JSONObject.NULL)
    } else {
      o.put(
        "session",
        JSONObject()
          .put("startedAt", x.startedAt)
          .put("lastDrivingAt", x.lastDrivingAt)
          .put("lastNewsAt", x.lastNewsAt)
          .put("inVehicle", x.inVehicle)
          .put("vehicleExitAt", x.vehicleExitAt)
          .put("drove", x.drove)
          .put("reminded", x.reminded)
      )
    }
    return o.toString()
  }

  /** null for nothing stored, another version, or anything unreadable. */
  fun fromJson(json: String?): ReminderState? {
    if (json.isNullOrEmpty()) return null
    return try {
      val o = JSONObject(json)
      when (o.optInt("v", 0)) {
        // The reminder before sessions: only whether it was on is kept (a paused one is on).
        2 -> ReminderState(enabled = o.optBoolean("enabled", false))
        3 -> v3(o)
        else -> null
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun v3(o: JSONObject): ReminderState {
    val session = if (o.isNull("session")) {
      null
    } else {
      val x = o.getJSONObject("session")
      ReminderSession(
        startedAt = x.getLong("startedAt"),
        lastDrivingAt = x.getLong("lastDrivingAt"),
        lastNewsAt = x.getLong("lastNewsAt"),
        inVehicle = x.getBoolean("inVehicle"),
        vehicleExitAt = x.getLong("vehicleExitAt"),
        drove = x.getBoolean("drove"),
        reminded = x.getBoolean("reminded")
      )
    }
    val seen = o.getJSONArray("tapSeen")
    val tapSeen = MutableList(seen.length()) { seen.getString(it) }
    while (tapSeen.size > TripReminderPolicy.TAP_SEEN_MAX) tapSeen.removeAt(0)
    return ReminderState(
      enabled = o.getBoolean("enabled"),
      session = session,
      lastDriveEndAt = o.getLong("lastDriveEndAt"),
      token = o.getString("token"),
      postedAt = o.getLong("postedAt"),
      tapSeen = tapSeen,
      tapAt = o.getLong("tapAt"),
      lookRestUntil = o.getLong("lookRestUntil")
    )
  }
}
