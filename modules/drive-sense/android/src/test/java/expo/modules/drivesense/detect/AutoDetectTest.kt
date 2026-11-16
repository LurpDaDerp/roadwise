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
