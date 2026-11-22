package expo.modules.drivesense.detect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Android's automatic drives, the pure half (WP03b): the motion history kept from Play services'
 * transitions and what the wake's motion gate and the start's trace-back read from it, the live
 * report mapping, the candidate's row buffer, the "Not driving?" rest without GPS, the record's
 * Android fields, and the status the UI reads. Pure JVM.
 */
class AutoDetectTest {
  private val t0 = 1_760_000_000_000.0
  private val min = 60_000.0

  private fun e(at: Double, kind: ActivityHistory.Kind) = ActivityHistory.Entry(at, kind)

  // ——— the motion history ———

  @Test
  fun `the history keeps 3 h and at most 256 entries, oldest first, and round-trips through its string`() {
    val old = e(t0 - DetectPolicy.MOTION_LOOKBACK_MS - 1, ActivityHistory.Kind.VEHICLE)
    val list = ActivityHistory.add(emptyList(), listOf(e(t0 - 1_000, ActivityHistory.Kind.STILL), old, e(t0 - 2_000, ActivityHistory.Kind.VEHICLE)), t0)
    assertEquals(listOf(t0 - 2_000, t0 - 1_000), list.map { it.at })
    val many = ActivityHistory.add(emptyList(), (0 until 300).map { e(t0 - 300_000 + it * 1_000.0, ActivityHistory.Kind.WALKING) }, t0)
    assertEquals(ActivityHistory.MAX_ENTRIES, many.size)
    assertEquals(t0 - 1_000, many.last().at, 0.0)
    assertEquals(list, ActivityHistory.decode(ActivityHistory.encode(list)))
    assertEquals(emptyList<ActivityHistory.Entry>(), ActivityHistory.decode("x;1:q;:v;12"))
    assertEquals(listOf(e(5.0, ActivityHistory.Kind.VEHICLE_EXIT)), ActivityHistory.decode("garbage;5:x"))
  }

  @Test
  fun `transitions map to history kinds, only the vehicle's EXIT is kept`() {
    assertEquals(ActivityHistory.Kind.VEHICLE, ActivityHistory.Kind.of("automotive", true))
    assertEquals(ActivityHistory.Kind.VEHICLE_EXIT, ActivityHistory.Kind.of("automotive", false))
    assertEquals(ActivityHistory.Kind.WALKING, ActivityHistory.Kind.of("walking", true))
    assertEquals(ActivityHistory.Kind.RUNNING, ActivityHistory.Kind.of("running", true))
    assertEquals(ActivityHistory.Kind.CYCLING, ActivityHistory.Kind.of("cycling", true))
    assertEquals(ActivityHistory.Kind.STILL, ActivityHistory.Kind.of("stationary", true))
    assertNull(ActivityHistory.Kind.of("walking", false))
    assertNull(ActivityHistory.Kind.of("unknown", true))
  }

  @Test
  fun `an in-a-vehicle report still standing passes the motion gate, a walk since, or one 2 min old, does not`() {
    val inCar = listOf(e(t0 - 10 * min, ActivityHistory.Kind.STILL), e(t0 - 30_000, ActivityHistory.Kind.VEHICLE))
    val m = DetectPolicy.summarize(ActivityHistory.samples(inCar, t0 - DetectPolicy.MOTION_LOOKBACK_MS), t0)
    assertEquals(MotionGate.OK, DetectPolicy.motionGate(m, t0))
    assertEquals(t0 - 30_000, m.automotiveSince, 0.0)
    val walkedOff = inCar + e(t0 - 5_000, ActivityHistory.Kind.WALKING)
    assertEquals(MotionGate.ON_FOOT, DetectPolicy.motionGate(DetectPolicy.summarize(ActivityHistory.samples(walkedOff, 0.0), t0), t0))
    val exited = listOf(e(t0 - 10 * min, ActivityHistory.Kind.STILL), e(t0 - 5 * min, ActivityHistory.Kind.VEHICLE), e(t0 - 3 * min, ActivityHistory.Kind.VEHICLE_EXIT))
    assertEquals(MotionGate.NOT_FRESH, DetectPolicy.motionGate(DetectPolicy.summarize(ActivityHistory.samples(exited, 0.0), t0), t0))
    assertEquals(MotionGate.NOT_FRESH, DetectPolicy.motionGate(DetectPolicy.summarize(emptyList(), t0), t0))
  }

  @Test
  fun `the trace-back reads the car run's start, never before the last drive's end`() {
    val list = listOf(
      e(t0 - 90 * min, ActivityHistory.Kind.VEHICLE),
      e(t0 - 60 * min, ActivityHistory.Kind.STILL),
      e(t0 - 4 * min, ActivityHistory.Kind.VEHICLE)
    )
    // A late geofence exit: the drive starts when the phone said the car set off (4 min ago; a stop
    // of 30 min or more before it began a new run).
    assertEquals(t0 - 4 * min, DetectPolicy.summarize(ActivityHistory.samples(list, t0 - 3 * 60 * min), t0).automotiveSince, 0.0)
    // A car still moving at the last end's decision: the run is dated from the end, not before it.
    val drove = listOf(e(t0 - 20 * min, ActivityHistory.Kind.VEHICLE))
    val samples = ActivityHistory.samples(drove, t0 - 10 * min)
    assertEquals(t0 - 10 * min, samples.first().start, 0.0)
    assertEquals(t0 - 10 * min, DetectPolicy.summarize(samples, t0).automotiveSince, 0.0)
  }

  @Test
  fun `a start never dates from the last drive's own in-a-vehicle report, ended after the end was decided`() {
    val end = t0 - 15 * min
    // The last drive's car report, still standing at its end; Play services dated the walk away 20 s after it.
    val last = listOf(e(end - 20 * min, ActivityHistory.Kind.VEHICLE), e(end + 20_000, ActivityHistory.Kind.WALKING))
    fun since(list: List<ActivityHistory.Entry>) = DetectPolicy.summarize(ActivityHistory.startSamples(list, end), t0).automotiveSince
    // Driving home 15 min later: the run begins at the new IN_VEHICLE ENTER, not at the last end.
    assertEquals(end, DetectPolicy.summarize(ActivityHistory.samples(last + e(t0 - 1 * min, ActivityHistory.Kind.VEHICLE), end), t0).automotiveSince, 0.0)
    assertEquals(t0 - 1 * min, since(last + e(t0 - 1 * min, ActivityHistory.Kind.VEHICLE)), 0.0)
    // Confirmed before the new ENTER is delivered: no car run (the drive starts at its first row).
    assertEquals(0.0, since(last), 0.0)
    // The vehicle's EXIT ends it too, and a stop inside the new run still merges into it.
    val exited = listOf(e(end - 20 * min, ActivityHistory.Kind.VEHICLE), e(end + 5_000, ActivityHistory.Kind.VEHICLE_EXIT))
    val stopped = exited + e(t0 - 8 * min, ActivityHistory.Kind.VEHICLE) + e(t0 - 5 * min, ActivityHistory.Kind.STILL) + e(t0 - 4 * min, ActivityHistory.Kind.VEHICLE)
    assertEquals(t0 - 8 * min, since(stopped), 0.0)
  }

  @Test
  fun `a start reads the history as before when no car report of the last drive stands at its end`() {
    val end = t0 - 15 * min
    // The walk was dated before the end: the new run's own stop does not cut its start.
    val walked = listOf(
      e(end - 20 * min, ActivityHistory.Kind.VEHICLE),
      e(end - 10_000, ActivityHistory.Kind.WALKING),
      e(t0 - 8 * min, ActivityHistory.Kind.VEHICLE),
      e(t0 - 5 * min, ActivityHistory.Kind.STILL),
      e(t0 - 4 * min, ActivityHistory.Kind.VEHICLE)
    )
    assertEquals(ActivityHistory.samples(walked, end), ActivityHistory.startSamples(walked, end))
    assertEquals(t0 - 8 * min, DetectPolicy.summarize(ActivityHistory.startSamples(walked, end), t0).automotiveSince, 0.0)
    // A car report still standing with nothing after it: dated from the end, as the trace-back always read it.
    val riding = listOf(e(end - 20 * min, ActivityHistory.Kind.VEHICLE))
    assertEquals(ActivityHistory.samples(riding, end), ActivityHistory.startSamples(riding, end))
    assertEquals(end, DetectPolicy.summarize(ActivityHistory.startSamples(riding, end), t0).automotiveSince, 0.0)
    assertEquals(emptyList<ActivitySample>(), ActivityHistory.startSamples(emptyList(), end))
  }

  @Test
  fun `the wake gate - 6 empty watches an hour, 10 min rest after an empty one except the geofence and the app`() {
    val starts = List(5) { t0 - it * 5 * min }
    val ctx = WakeCtx(t0, WakeReason.SLC, DetectPhase.ARMED, armed = true, hasOwner = true, permissionsOk = true, candidateRestUntil = 0.0, candidateStarts = starts)
    assertEquals(WakeGate.OK, DetectPolicy.wakeGate(ctx))
    assertEquals(WakeGate.CAPPED, DetectPolicy.wakeGate(ctx.copy(candidateStarts = starts + (t0 - 59 * min))))
    assertEquals(WakeGate.OK, DetectPolicy.wakeGate(ctx.copy(candidateStarts = starts + (t0 - 61 * min))))
    val resting = ctx.copy(candidateRestUntil = t0 + DetectPolicy.CANDIDATE_REST_MS)
    assertEquals(WakeGate.RESTING, DetectPolicy.wakeGate(resting))
    assertEquals(WakeGate.OK, DetectPolicy.wakeGate(resting.copy(reason = WakeReason.REGION)))
    assertEquals(WakeGate.OK, DetectPolicy.wakeGate(resting.copy(reason = WakeReason.APP)))
    assertEquals(WakeGate.BUSY, DetectPolicy.wakeGate(ctx.copy(phase = DetectPhase.SUPPRESSED)))
    assertEquals(WakeGate.PERMISSION, DetectPolicy.wakeGate(ctx.copy(permissionsOk = false)))
  }

  @Test
  fun `the watch - 3 min with no vehicle sign, 5 with evidence, 30 at most, the linger counts from its own start`() {
    val since = t0
    assertNull(DetectPolicy.candidateDue(TriggerKind.AUTO, since, null, null, since + 3 * min - 1))
    assertEquals(CandidateCause.TIMEOUT, DetectPolicy.candidateDue(TriggerKind.AUTO, since, null, null, since + 3 * min))
    assertNull(DetectPolicy.candidateDue(TriggerKind.AUTO, since, null, null, since + 4 * min, hasEvidence = true))
    assertEquals(CandidateCause.TIMEOUT, DetectPolicy.candidateDue(TriggerKind.AUTO, since, null, null, since + 5 * min, hasEvidence = true))
    assertNull(DetectPolicy.candidateDue(TriggerKind.AUTO, since, null, null, since + 29 * min, lastVehicleTs = since + 28 * min))
    assertEquals(CandidateCause.CAP, DetectPolicy.candidateDue(TriggerKind.AUTO, since, null, null, since + 30 * min, lastVehicleTs = since + 29 * min))
    assertEquals(CandidateCause.WALKING, DetectPolicy.candidateDue(TriggerKind.AUTO, since, null, since + 10_000, since + 30_000))
    // Only an empty watch stays in the hourly cap's record.
    assertEquals(listOf(1.0), DetectPolicy.startsAfter(listOf(1.0, since), since, sawVehicle = true))
    assertEquals(listOf(1.0, since), DetectPolicy.startsAfter(listOf(1.0, since), since, sawVehicle = false))
  }

  // ——— the live reports ———

  @Test
  fun `a live report is its most probable activity, bucketed low under 50, medium to 74, high from 75`() {
    fun of(vararg a: Pair<Int, Int>) = LiveActivity.of(a.map { LiveActivity.Rated(it.first, it.second) })
    assertEquals(LiveActivity.Report("automotive", "high"), of(LiveActivity.IN_VEHICLE to 80, LiveActivity.STILL to 20))
    assertEquals(LiveActivity.Report("stationary", "medium"), of(LiveActivity.STILL to 74, LiveActivity.IN_VEHICLE to 26))
    assertEquals(LiveActivity.Report("cycling", "low"), of(LiveActivity.ON_BICYCLE to 49))
    assertEquals(LiveActivity.Report("running", "high"), of(LiveActivity.ON_FOOT to 90, LiveActivity.WALKING to 10, LiveActivity.RUNNING to 80))
    assertEquals(LiveActivity.Report("walking", "medium"), of(LiveActivity.ON_FOOT to 60))
    assertEquals(LiveActivity.Report("unknown", "medium"), of(LiveActivity.TILTING to 55))
    assertEquals(LiveActivity.Report("unknown", "high"), of(LiveActivity.UNKNOWN to 100))
    assertNull(of())
    val m = LiveActivity.Report("running", "medium").motion(t0)
    assertEquals(MotionReport(walking = true, cycling = false, automotive = false, stationary = false, confident = true, at = t0), m)
    assertFalse(LiveActivity.Report("automotive", "low").confident)
  }

  // ——— the buffer ———

  @Test
  fun `the candidate buffer holds the last 1,800 rows and finds a row by its ts`() {
    val b = RowBuffer<Int>()
    for (i in 0 until 1_805) b.append(DetectRow(i * 1_000.0, 0.0, 0.0, 5.0, 0.0, 0.5, true), i)
    assertEquals(DetectPolicy.CANDIDATE_BUFFER_MAX_ROWS, b.size)
    assertEquals(5, b.items.first().body)
    assertEquals(0, b.index(5_000.0))
    assertNull(b.index(4_000.0))
    b.clear()
    assertEquals(0, b.rows.size)
  }

  // ——— the rest ———

  private fun tt(type: String, enter: Boolean, at: Double) = TimedTransition(type, enter, at)

  @Test
  fun `the rest ends on a walk that has stood 20 s, dated when it began`() {
    val since = t0
    val until = since + DetectPolicy.SUPPRESS_MAX_MS
    val riding = RestStanding(carStanding = true)
    // The passenger gets out and walks off; Play services tells RoadWise 40 s later.
    val s = DetectPolicy.restAfter(riding, listOf(tt("automotive", false, since + 20 * min), tt("walking", true, since + 20 * min + 5_000)))
    assertEquals(RestStanding(walkSince = since + 20 * min + 5_000, carStanding = false, carLeftAt = since + 20 * min), s)
    assertEquals(SuppressionCause.WALKING, DetectPolicy.restDue(since, until, s, since + 20 * min + 45_000))
    assertNull(DetectPolicy.restDue(since, until, s, since + 20 * min + 24_000))
    // A walk turning into a run keeps its start; any other report ends it.
    assertEquals(since + 20 * min + 5_000, DetectPolicy.restAfter(s, listOf(tt("running", true, since + 21 * min))).walkSince)
    assertNull(DetectPolicy.restAfter(s, listOf(tt("stationary", true, since + 21 * min))).walkSince)
  }

  @Test
  fun `the rest ends 5 min after the phone left the vehicle, holds while a vehicle stands, and ends at 3 h`() {
    val since = t0
    val until = since + DetectPolicy.SUPPRESS_MAX_MS
    val riding = RestStanding(carStanding = true)
    assertNull(DetectPolicy.restDue(since, until, riding, since + 2 * 60 * min))
    assertEquals(until, DetectPolicy.restNextCheck(since, until, riding), 0.0)
    assertEquals(SuppressionCause.CAP, DetectPolicy.restDue(since, until, riding, until))
    val parked = DetectPolicy.restAfter(riding, listOf(tt("stationary", true, since + 30 * min)))
    assertFalse(parked.carStanding)
    assertNull(DetectPolicy.restDue(since, until, parked, since + 34 * min))
    assertEquals(SuppressionCause.STILL, DetectPolicy.restDue(since, until, parked, since + 35 * min))
    assertEquals(since + 35 * min, DetectPolicy.restNextCheck(since, until, parked), 0.0)
    // No vehicle when it began: 5 min from the tap.
    assertEquals(SuppressionCause.STILL, DetectPolicy.restDue(since, until, RestStanding(), since + 5 * min))
    // A vehicle again holds it once more.
    val again = DetectPolicy.restAfter(parked, listOf(tt("automotive", true, since + 33 * min)))
    assertTrue(again.carStanding)
    assertNull(again.walkSince)
    assertNull(DetectPolicy.restDue(since, until, again, since + 50 * min))
  }

  @Test
  fun `a rest begun mid-ride holds while the history is in the vehicle, whatever the one live report at the tap said`() {
    val since = t0
    val until = since + DetectPolicy.SUPPRESS_MAX_MS
    // Play services' transition state is in the vehicle (no EXIT or other ENTER since): the live
    // report at the tap was a tilt or still at a light (not car motion, nothing fresh).
    val riding = listOf(e(since - 30 * min, ActivityHistory.Kind.STILL), e(since - 20 * min, ActivityHistory.Kind.VEHICLE))
    val seeded = DetectPolicy.restSeed(carFresh = false, history = riding)
    assertTrue(seeded.carStanding)
    assertNull(DetectPolicy.restDue(since, until, seeded, since + 5 * min))
    assertNull(DetectPolicy.restDue(since, until, seeded, since + 60 * min))
    assertEquals(until, DetectPolicy.restNextCheck(since, until, seeded), 0.0)
    // Car motion in the live feed's last 2 min holds it too, with no history.
    assertTrue(DetectPolicy.restSeed(carFresh = true, history = emptyList()).carStanding)
    // Out of the vehicle (an EXIT, or another ENTER since): 5 min from the tap, whether or not the
    // live feed saw car motion in its last 2 min (Play services sends nothing more from that state,
    // so holding on the live feed would last the 3 h).
    for (fresh in listOf(false, true)) {
      for (after in listOf(ActivityHistory.Kind.VEHICLE_EXIT, ActivityHistory.Kind.STILL, ActivityHistory.Kind.WALKING)) {
        val out = DetectPolicy.restSeed(carFresh = fresh, history = riding + e(since - 20_000.0, after))
        assertFalse(out.carStanding)
        assertNull(DetectPolicy.restDue(since, until, out, since + 5 * min - 1))
        assertEquals(SuppressionCause.STILL, DetectPolicy.restDue(since, until, out, since + 5 * min))
        assertEquals(since + 5 * min, DetectPolicy.restNextCheck(since, until, out), 0.0)
      }
    }
    // Still in the car after all (Play services lagging, or a queue that moves on): its next
    // IN_VEHICLE ENTER holds the rest again.
    val parkedSeed = DetectPolicy.restSeed(carFresh = true, history = riding + e(since - 20_000.0, ActivityHistory.Kind.STILL))
    val movingOn = DetectPolicy.restOnBatch(since, until, parkedSeed, listOf(tt("automotive", true, since + 2 * min)), since + 3 * min)
    assertNull(movingOn.due)
    assertTrue(movingOn.standing.carStanding)
    assertNull(DetectPolicy.restDue(since, until, movingOn.standing, since + 60 * min))
    assertFalse(DetectPolicy.restSeed(carFresh = false, history = emptyList()).carStanding)
  }

  @Test
  fun `a walk of 20 s inside one late batch ends the rest, though a later transition of the batch ended it`() {
    val since = t0
    val until = since + DetectPolicy.SUPPRESS_MAX_MS
    val riding = RestStanding(carStanding = true)
    val t = since + 20 * min
    // Out of the car, a minute's walk to the door, then still: delivered together, later.
    val batch = listOf(tt("automotive", false, t), tt("walking", true, t + 5_000), tt("stationary", true, t + 65_000))
    assertEquals(SuppressionCause.WALKING, DetectPolicy.restOnBatch(since, until, riding, batch, t + 90_000).due)
    // A walk under 20 s before the still does not; the still clock then runs from leaving the car.
    val short = listOf(tt("automotive", false, t), tt("walking", true, t + 5_000), tt("stationary", true, t + 15_000))
    val step = DetectPolicy.restOnBatch(since, until, riding, short, t + 30_000)
    assertNull(step.due)
    assertEquals(RestStanding(walkSince = null, carStanding = false, carLeftAt = t), step.standing)
    // What stood before the batch is checked first (a walk that stood 20 s before the car came).
    val walking = RestStanding(walkSince = t, carStanding = false, carLeftAt = t)
    assertEquals(SuppressionCause.WALKING, DetectPolicy.restOnBatch(since, until, walking, listOf(tt("automotive", true, t + 30_000)), t + 40_000).due)
    // The still clock reached inside the batch ends it as well.
    val parked = RestStanding(carStanding = false, carLeftAt = t)
    assertEquals(SuppressionCause.STILL, DetectPolicy.restOnBatch(since, until, parked, listOf(tt("automotive", true, t + 6 * min)), t + 7 * min).due)
  }

  @Test
  fun `a transition dated before the rest counts from the rest's start`() {
    val since = t0
    val until = since + DetectPolicy.SUPPRESS_MAX_MS
    // A walk from before the tap, delivered late: dated at the tap, not ending the rest at once.
    val step = DetectPolicy.restOnBatch(since, until, RestStanding(carStanding = true), listOf(tt("walking", true, since - 2 * min)), since + 5_000)
    assertNull(step.due)
    assertEquals(RestStanding(walkSince = since, carStanding = false, carLeftAt = since), step.standing)
    assertNull(DetectPolicy.restDue(since, until, step.standing, since + 10_000))
    // Still walking 20 s after the tap: over, as iOS's rest would be.
    assertEquals(SuppressionCause.WALKING, DetectPolicy.restDue(since, until, step.standing, since + 20_000))
    // restAfter clamps the same way.
    assertEquals(since, DetectPolicy.restAfter(RestStanding(), listOf(tt("walking", true, since - 60_000)), since).walkSince)
  }

  @Test
  fun `the parked geofence is set again only when owed or its PendingIntent is gone, never while off or with no spot`() {
    var asked = 0
    val alive = { asked++; true }
    val gone = { asked++; false }
    assertFalse(WakeFile.parkedOwed(off = false, parked = true, owed = false, intentAlive = alive))
    assertTrue(WakeFile.parkedOwed(off = false, parked = true, owed = false, intentAlive = gone))
    assertTrue(WakeFile.parkedOwed(off = false, parked = true, owed = true, intentAlive = alive))
    assertEquals(2, asked)
    assertFalse(WakeFile.parkedOwed(off = true, parked = true, owed = true, intentAlive = gone))
    assertFalse(WakeFile.parkedOwed(off = false, parked = false, owed = true, intentAlive = gone))
    // The system is asked only when nothing else decides.
    assertEquals(2, asked)
  }

  // ——— the record and the status ———

  @Test
  fun `the record keeps the rest's evidence and the parked spot, never in the state JS reads`() {
    val r = DriveDetectRecord(
      armed = true,
      ownerId = "user-1",
      state = "suppressed",
      suppressedSince = t0,
      suppressedUntil = t0 + DetectPolicy.SUPPRESS_MAX_MS,
      rest = RestStanding(walkSince = t0 + 1, carStanding = false, carLeftAt = t0 + 2),
      parked = LatLng(47.6, -122.3)
    )
    assertEquals(r, DriveDetectRecord.fromJson(r.toJson()))
    val access = DetectAccess(LocationAccess.ALWAYS, true, MotionAccess.GRANTED, BackgroundRefresh.AVAILABLE, true, false, hardware = true)
    val keys = r.state(access).keys
    assertFalse(keys.contains("rest"))
    assertFalse(keys.contains("parked"))
  }

  @Test
  fun `armed with Allow all the time, Precise, Physical activity and Play services - on, While Using - needs Always`() {
    val always = DetectAccess(LocationAccess.ALWAYS, true, MotionAccess.GRANTED, BackgroundRefresh.AVAILABLE, true, false, hardware = true)
    val armed = DriveDetectRecord(armed = true, ownerId = "user-1", state = "armed")
    assertEquals("on", armed.state(always)["status"])
    assertTrue(always.requiredOk)
    val whileUsing = always.copy(location = LocationAccess.WHEN_IN_USE, canAskAlways = true)
    assertEquals("needs", armed.state(whileUsing)["status"])
    assertEquals(listOf("locationAlways"), armed.state(whileUsing)["missing"])
    assertFalse(whileUsing.requiredOk)
    // Battery Restricted: on, but it needs the battery allowance (detection still runs).
    val restricted = always.copy(backgroundRefresh = BackgroundRefresh.DENIED)
    assertEquals(listOf("backgroundRefresh"), armed.state(restricted)["missing"])
    assertTrue(restricted.requiredOk)
  }
}
