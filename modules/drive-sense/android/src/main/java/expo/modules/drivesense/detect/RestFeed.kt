package expo.modules.drivesense.detect

/**
 * The "Not driving?" rest on Android (ruling 4): no GPS and no service. iOS rests on ten-metre GPS
 * until a 20 s walk, 5 min with nothing over 3 mph, or 3 h; Android reads the same three ends from
 * the activity transitions Play services keeps delivering while RoadWise is not running:
 * - a walk (WALKING or RUNNING ENTER) that has stood 20 s, dated when it began (the transition's own
 *   time, never before the rest: Play services often delivers it 30 s or more late, so a walk is
 *   usually over 20 s old when it arrives and ends the rest at once; one a later transition of the
 *   same batch ended counts too, [restOnBatch]);
 * - 5 min without vehicle motion: the clock runs from the rest's start or from when the phone last
 *   left the vehicle (IN_VEHICLE EXIT, or any other ENTER after an IN_VEHICLE one), and holds while
 *   an IN_VEHICLE ENTER stands (a passenger still riding; [restSeed] reads the one standing at the tap);
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

/**
 * The rest's evidence as "Not driving?" begins it. The motion history's newest transition decides
 * when there is one: an IN_VEHICLE ENTER still standing holds the rest (Play services' transition
 * state is in the vehicle: it sends nothing more while the ride goes on, and its EXIT or another
 * ENTER is what tells the rest the ride is over), as iOS's rest holds on ten-metre GPS while the car
 * moves; anything newer than the vehicle (an EXIT, still, a walk) starts the 5 min clock at the tap,
 * whatever the live feed saw in its last 2 min, since from that state Play services sends nothing
 * until the activity changes and a hold would last the 3 h: if the car is in fact still moving (a
 * passenger tapping while Play services' state lags, or still in a queue), its next IN_VEHICLE ENTER
 * holds the rest again, and a car that does not move for 5 min ends it, as on iOS. With no history
 * (none in the last 3 h), car motion in the live feed's last 2 min holds it ([carFresh]: a passenger
 * who picks the phone up to tap makes the newest live report a tilt, or still at a light).
 */
fun DetectPolicy.restSeed(carFresh: Boolean, history: List<ActivityHistory.Entry>): RestStanding {
  val newest = history.maxByOrNull { it.at } ?: return RestStanding(carStanding = carFresh)
  return RestStanding(carStanding = newest.kind == ActivityHistory.Kind.VEHICLE)
}

/**
 * One transition into the rest's evidence. [since]: the rest's start; a transition dated before it
 * (Play services delivering late) counts from the start, as iOS dates its rest's walk only from
 * reports after the rest began.
 */
private fun restStep(s: RestStanding, t: TimedTransition, since: Double): RestStanding {
  val at = maxOf(t.at, since)
  if (t.type == "automotive") {
    if (t.enter) return RestStanding(walkSince = null, carStanding = true, carLeftAt = s.carLeftAt)
    return if (s.carStanding) s.copy(carStanding = false, carLeftAt = at) else s
  }
  if (!t.enter) return s
  val left = if (s.carStanding) at else s.carLeftAt
  val onFoot = t.type == "walking" || t.type == "running"
  return RestStanding(walkSince = if (onFoot) s.walkSince ?: at else null, carStanding = false, carLeftAt = left)
}

/** The rest's standing evidence after one delivered batch, in order (transitions before [since] count from it). */
fun DetectPolicy.restAfter(s: RestStanding, batch: List<TimedTransition>, since: Double = Double.NEGATIVE_INFINITY): RestStanding =
  batch.fold(s) { acc, t -> restStep(acc, t, since) }

/** One batch during the rest: the evidence after it, and the end it reached on the way (null: none). */
data class RestBatch(val standing: RestStanding, val due: SuppressionCause?)

/**
 * One delivered batch during the rest (Play services often batches and delivers late): before each
 * transition, what stood until then is checked at that transition's time, so a walk of 20 s or more
 * that a later transition in the same batch ended (out of the car, a minute's walk to the door, then
 * still) still ends the rest, as iOS's rest ends on any 20 s walk. Times are clamped to the rest's
 * start and the batch's [arrival]. What stands after the batch is checked at the detector's next look.
 */
fun DetectPolicy.restOnBatch(since: Double, until: Double, s: RestStanding, batch: List<TimedTransition>, arrival: Double): RestBatch {
  var cur = s
  for (t in batch) {
    val at = minOf(maxOf(t.at, since), arrival)
    val due = restDue(since, until, cur, at)
    if (due != null) return RestBatch(cur, due)
    cur = restStep(cur, t, since)
  }
  return RestBatch(cur, null)
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
