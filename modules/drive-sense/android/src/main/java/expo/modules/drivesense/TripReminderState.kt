package expo.modules.drivesense

import org.json.JSONArray
import org.json.JSONObject

/**
 * The reminder's [ReminderState] as the JSON kept in [DriveSensePrefs.tripReminderJson], with the
 * field names of `ReminderState` in `src/reminder/policy.ts` (`v: 2`). Anything unreadable is the
 * initial state (off): the reminder never guesses itself on.
 */
object TripReminderState {
  fun toJson(s: ReminderState): String {
    val o = JSONObject()
      .put("v", 2)
      .put("enabled", s.enabled)
      .put("autoOff", s.autoOff)
      .put("lastCaptureEndAt", s.lastCaptureEndAt)
      .put("posts", JSONArray().also { a -> s.posts.forEach { a.put(it) } })
      .put("pendingAt", s.pendingAt)
      .put("postedAt", s.postedAt)
      .put("showing", s.showing)
      .put("missStreak", s.missStreak)
      .put("pauseLevel", s.pauseLevel)
      .put("pausedUntil", s.pausedUntil)
      .put("quietUntil", s.quietUntil)
      .put("notDrivingUntil", s.notDrivingUntil)
    val t = s.trip
    if (t == null) {
      o.put("trip", JSONObject.NULL)
    } else {
      o.put(
        "trip",
        JSONObject()
          .put("startedAt", t.startedAt)
          .put("lastVehicleAt", t.lastVehicleAt)
          .put("inVehicle", t.inVehicle)
          .put("vehicleExitAt", t.vehicleExitAt)
          .put("recorded", t.recorded)
          .put("reminded", t.reminded)
          .put("retries", t.retries)
          .put("sessions", t.sessions)
          .put("lastSessionEndAt", t.lastSessionEndAt)
      )
    }
    return o.toString()
  }

  /** null for nothing stored, another version, or anything unreadable. */
  fun fromJson(json: String?): ReminderState? {
    if (json.isNullOrEmpty()) return null
    return try {
      val o = JSONObject(json)
      if (o.optInt("v", 0) != 2) return null
      val postsJson = o.optJSONArray("posts") ?: JSONArray()
      val posts = MutableList(postsJson.length()) { postsJson.getLong(it) }
      val tj = o.optJSONObject("trip")
      val trip = if (tj == null) {
        null
      } else {
        ReminderTrip(
          startedAt = tj.getLong("startedAt"),
          lastVehicleAt = tj.getLong("lastVehicleAt"),
          inVehicle = tj.getBoolean("inVehicle"),
          vehicleExitAt = tj.getLong("vehicleExitAt"),
          recorded = tj.getBoolean("recorded"),
          reminded = tj.getBoolean("reminded"),
          retries = tj.getInt("retries"),
          sessions = tj.getInt("sessions"),
          lastSessionEndAt = tj.getLong("lastSessionEndAt")
        )
      }
      ReminderState(
        enabled = o.getBoolean("enabled"),
        autoOff = o.getBoolean("autoOff"),
        trip = trip,
        lastCaptureEndAt = o.getLong("lastCaptureEndAt"),
        posts = posts,
        pendingAt = o.getLong("pendingAt"),
        postedAt = o.getLong("postedAt"),
        showing = o.getBoolean("showing"),
        missStreak = o.getInt("missStreak"),
        pauseLevel = o.getInt("pauseLevel"),
        pausedUntil = o.getLong("pausedUntil"),
        quietUntil = o.getLong("quietUntil"),
        notDrivingUntil = o.getLong("notDrivingUntil")
      )
    } catch (_: Exception) {
      null
    }
  }
}
