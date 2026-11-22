package expo.modules.drivesense.detect

/**
 * The motion history on Android (iOS reads `CMMotionActivityManager`'s own history; Android keeps
 * none, so RoadWise keeps it): while automatic drives are armed, every activity transition Play
 * services delivers (IN_VEHICLE in and out, and the ENTERs of WALKING, RUNNING, ON_BICYCLE and
 * STILL) is written down with the time it happened (the transition's own boot-clock time, not its
 * arrival, which can be minutes later), for the last 3 h ([DetectPolicy.MOTION_LOOKBACK_MS]) and at
 * most [MAX_ENTRIES]. A wake's motion gate and a start's trace-back read it as the policy's
 * [ActivitySample]s ([samples]; a start's through [startSamples]), exactly as iOS reads its
 * history: so a drive the phone caught already moving (a geofence exit Android delivered minutes
 * late, a car that confirmed only in traffic) begins when the phone's in-a-vehicle report says the
 * car set off.
 *
 * Every transition is confident (Play services sends one only when it is sure). An IN_VEHICLE EXIT
 * is a sample that is no car motion and says nothing else, so the car stretch ends there. Pure: no
 * android.* (the detector stores [encode]'s string in its own preferences file).
 */
object ActivityHistory {
  /** Far more than 3 h of real transitions; a phone that flaps keeps the newest. */
  const val MAX_ENTRIES = 256

  enum class Kind(val code: Char) {
    VEHICLE('v'),
    VEHICLE_EXIT('x'),
    WALKING('w'),
    RUNNING('r'),
    CYCLING('b'),
    STILL('s');

    companion object {
      fun of(code: Char): Kind? = entries.firstOrNull { it.code == code }

      /** One transition as the capture's `activity` types name it ([FeedTransition]); null when the history keeps nothing of it. */
      fun of(type: String, enter: Boolean): Kind? = when {
        type == "automotive" -> if (enter) VEHICLE else VEHICLE_EXIT
        !enter -> null
        type == "walking" -> WALKING
        type == "running" -> RUNNING
        type == "cycling" -> CYCLING
        type == "stationary" -> STILL
        else -> null
      }
    }
  }

  data class Entry(val at: Double, val kind: Kind)

  /** [list] with [added], oldest first (a stable sort: entries at the same time keep their order), past 3 h and over the cap dropped. */
  fun add(list: List<Entry>, added: List<Entry>, now: Double): List<Entry> {
    val all = (list + added).filter { it.at.isFinite() && it.at > now - DetectPolicy.MOTION_LOOKBACK_MS }.sortedBy { it.at }
    return if (all.size > MAX_ENTRIES) all.takeLast(MAX_ENTRIES) else all
  }

  /** One entry as the policy's sample. */
  fun sample(e: Entry, start: Double = e.at): ActivitySample = when (e.kind) {
    Kind.VEHICLE -> ActivitySample(start, automotive = true, stationary = false, onFoot = false, confident = true)
    Kind.STILL -> ActivitySample(start, automotive = false, stationary = true, onFoot = false, confident = true)
    Kind.WALKING, Kind.RUNNING, Kind.CYCLING -> ActivitySample(start, automotive = false, stationary = false, onFoot = true, confident = true)
    Kind.VEHICLE_EXIT -> ActivitySample(start, automotive = false, stationary = false, onFoot = false, confident = false)
  }

  /**
   * The samples from [from] on, as a history query from [from] answers: the activity already under
   * way at [from] is included, dated [from] (so nothing starts before it: a trace-back never reaches
   * past the previous drive's end), then every later one.
   */
  fun samples(list: List<Entry>, from: Double): List<ActivitySample> {
    val sorted = list.sortedBy { it.at }
    val before = sorted.lastOrNull { it.at < from }
    val out = ArrayList<ActivitySample>()
    if (before != null) out.add(sample(before, from))
    for (e in sorted) if (e.at >= from) out.add(sample(e))
    return out
  }

  /**
   * The samples a drive's start reads from [from] (the last drive's end), as [samples] gives them,
   * but for an in-a-vehicle report still standing at [from] that a later transition ended (the walk
   * away, a stop, the vehicle's EXIT: Play services may date it after the end was decided). That
   * report was the last drive's, so the history is read from just after the transition that ended
   * it, and the old report never dates the new drive from the last end. A vehicle report with
   * nothing after it, or any other report standing at [from], reads as [samples] does.
   */
  fun startSamples(list: List<Entry>, from: Double): List<ActivitySample> {
    val sorted = list.sortedBy { it.at }
    if (sorted.lastOrNull { it.at < from }?.kind != Kind.VEHICLE) return samples(sorted, from)
    val ended = sorted.firstOrNull { it.at >= from && it.kind != Kind.VEHICLE } ?: return samples(sorted, from)
    // Just after it: read from its own time, the old report would stand again, dated then.
    return samples(sorted, Math.nextUp(ended.at))
  }

  /** "at:code;at:code" (whole ms). */
  fun encode(list: List<Entry>): String = list.joinToString(";") { "${Math.round(it.at)}:${it.kind.code}" }

  /** [encode]'s string back; anything unreadable is skipped. */
  fun decode(raw: String?): List<Entry> {
    if (raw.isNullOrEmpty()) return emptyList()
    return raw.split(';').mapNotNull { part ->
      val i = part.indexOf(':')
      if (i <= 0 || i != part.length - 2) return@mapNotNull null
      val at = part.substring(0, i).toLongOrNull() ?: return@mapNotNull null
      val kind = Kind.of(part[i + 1]) ?: return@mapNotNull null
      Entry(at.toDouble(), kind)
    }
  }
}
