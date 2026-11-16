package expo.modules.drivesense.detect

/**
 * The "Not driving?" rest on Android (ruling 4): no GPS and no service. iOS rests on ten-metre GPS
 * until a 20 s walk, 5 min with nothing over 3 mph, or 3 h; Android reads the same three ends from
 * the activity transitions Play services keeps delivering while RoadWise is not running:
 * - a walk (WALKING or RUNNING ENTER) that has stood 20 s, dated when it began (the transition's own
 *   time: Play services often delivers it 30 s or more late, so a walk is usually over 20 s old when
 *   it arrives and ends the rest at once);
 * - 5 min without vehicle motion: the clock runs from the rest's start or from when the phone last
 *   left the vehicle (IN_VEHICLE EXIT, or any other ENTER after an IN_VEHICLE one), and holds while
 *   an IN_VEHICLE ENTER stands (a passenger still riding);
 * - 3 h after the tap.
 * The standing evidence is kept in the detector's record, so a rest survives RoadWise's process
 * coming and going between transitions (each delivery may start a new one). Pure.
 */
data class RestStanding(
  /** When the standing walk began (null: none). */
  val walkSince: Double? = null,
  /** An IN_VEHICLE ENTER stands (no EXIT or other ENTER since). */
  val carStanding: Boolean = false,
  /** When the phone last left the vehicle (null: not since the rest began). */
  val carLeftAt: Double? = null
)

/** One activity transition with the time it happened (epoch ms). `type` as the `activity` event names it. */
data class TimedTransition(val type: String, val enter: Boolean, val at: Double)

/** The rest's standing evidence after one delivered batch, in order. */
fun DetectPolicy.restAfter(s: RestStanding, batch: List<TimedTransition>): RestStanding {
  var walk = s.walkSince
  var car = s.carStanding
  var left = s.carLeftAt
  for (t in batch) {
    if (t.type == "automotive") {
      if (t.enter) {
        car = true
        walk = null
      } else if (car) {
        car = false
        left = t.at
      }
      continue
    }
    if (!t.enter) continue
    if (car) {
      car = false
      left = t.at
    }
    val onFoot = t.type == "walking" || t.type == "running"
    walk = if (onFoot) walk ?: t.at else null
  }
  return RestStanding(walk, car, left)
}

/**
 * Whether the rest is over at [now] ([suppressionDue] with the Android evidence): its 3 h cap, a
 * walk standing 20 s, or 5 min since the rest began or the phone left the vehicle, with no vehicle
 * standing now.
 */
fun DetectPolicy.restDue(since: Double, until: Double, s: RestStanding, now: Double): SuppressionCause? =
  suppressionDue(since, until, if (s.carStanding) now else s.carLeftAt, s.walkSince, now)

/** When to look again (epoch ms): the earliest moment [restDue] could answer with nothing new arriving. */
fun DetectPolicy.restNextCheck(since: Double, until: Double, s: RestStanding): Double {
  var next = until
  val walk = s.walkSince
  if (walk != null) next = minOf(next, walk + WALK_CONFIRM_MS)
  if (!s.carStanding) next = minOf(next, maxOf(since, s.carLeftAt ?: since) + SUPPRESS_STILL_MS)
  return next
}
