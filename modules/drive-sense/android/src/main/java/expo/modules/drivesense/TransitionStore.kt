package expo.modules.drivesense

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The mapped activity transitions of the last 24 h (ENTER only, README §3), persisted so
 * `queryMotionHistory` answers across process deaths. Written only when a transition arrives —
 * nothing runs while armed and idle.
 */
object TransitionStore {
  private const val FILE = "expo.modules.drivesense.transitions"
  private const val KEY = "entries"
  private const val WINDOW_MS = 24L * 60 * 60 * 1000
  private const val MAX_ENTRIES = 500

  data class Entry(val type: String, val confidence: String, val ts: Long) {
    fun toMap(): Map<String, Any> = linkedMapOf("type" to type, "confidence" to confidence, "ts" to ts)
  }

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  private fun load(context: Context): MutableList<Entry> {
    val raw = prefs(context).getString(KEY, null) ?: return ArrayList()
    return try {
      val a = JSONArray(raw)
      (0 until a.length()).map {
        val o = a.getJSONObject(it)
        Entry(o.getString("type"), o.getString("confidence"), o.getLong("ts"))
      }.toMutableList()
    } catch (_: Exception) {
      ArrayList()
    }
  }

  private fun prune(entries: List<Entry>, now: Long): List<Entry> =
    entries.filter { it.ts >= now - WINDOW_MS }.sortedBy { it.ts }.takeLast(MAX_ENTRIES)

  @Synchronized
  fun append(context: Context, entries: List<Entry>) {
    if (entries.isEmpty()) return
    val all = prune(load(context) + entries, System.currentTimeMillis())
    val a = JSONArray()
    for (e in all) a.put(JSONObject().put("type", e.type).put("confidence", e.confidence).put("ts", e.ts))
    prefs(context).edit().putString(KEY, a.toString()).apply()
  }

  /** Entries with `fromTs ≤ ts ≤ toTs`, oldest first. */
  @Synchronized
  fun query(context: Context, fromTs: Double, toTs: Double): List<Entry> =
    prune(load(context), System.currentTimeMillis()).filter { it.ts >= fromTs && it.ts <= toTs }
}
