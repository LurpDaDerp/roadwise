package expo.modules.drivesense.detect

import expo.modules.drivesense.FeatureRow
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The policy's API as the Android detector runtime calls it, beside the decision table
 * ([DetectPolicyVectorsTest]): the shapes the runtime builds (a capture row, the enums' wire names),
 * the numbers the UI quotes, and the self-test's answer to a malformed row. Pure JVM.
 */
class DetectPolicyTest {
  private val t0 = 1_760_000_000_000.0

  private fun row(sec: Double, mph: Double, hAcc: Double = 5.0) =
    DetectRow(t0 + sec * 1000, 47.6, -122.33, hAcc, mph * DetectPolicy.MPS_PER_MPH, 0.5, true)

  @Test
  fun `the auto hold is (5 over 3) times (30 minus mph) seconds over 15 mph, floored at 0_9 s, infinite at 15 and under`() {
    val p = DetectPolicy
    assertEquals(Double.POSITIVE_INFINITY, p.autoHoldMs(15 * p.MPS_PER_MPH), 0.0)
    assertEquals(20_000.0, p.autoHoldMs(18 * p.MPS_PER_MPH), 1e-6)
    assertEquals(10_000.0, p.autoHoldMs(24 * p.MPS_PER_MPH), 1e-6)
    assertEquals(900.0, p.autoHoldMs(40 * p.MPS_PER_MPH), 0.0)
  }

  @Test
  fun `a capture row becomes a detect row with its integer ts as epoch ms`() {
    val f = FeatureRow(
      ts = 1_760_000_000_123L, lat = 47.6, lng = -122.33, hAcc = 4.0, speed = 9.0, speedAcc = 0.4, course = 90.0, alt = 10.0,
      gnssValid = true, aLonMax = 0.0, aLonMin = 0.0, aLatMax = 0.0, aLatMin = 0.0, yawRateMax = 0.0, jerkMax = 0.0,
      gravityStability = 0.0, orientationDelta = 0.0, handlingScore = 0.0, locked = false, screenOn = true, appForeground = true
    )
    assertEquals(DetectRow(1_760_000_000_123.0, 47.6, -122.33, 4.0, 9.0, 0.4, true), DetectRow.of(f))
  }

  @Test
  fun `a 24 mph run from the kerb confirms after 10 s and traces back to the kerb`() {
    val rows = (0..30).map { row(it.toDouble(), 0.0) } + (31..60).map { row(it.toDouble(), 24.0) }
    var s = ConfirmState()
    var at = -1
    for ((i, r) in rows.withIndex()) {
      val step = DetectPolicy.confirmStep(s, r, TriggerKind.AUTO)
      s = step.state
      if (step.confirmed) {
        at = i
        break
      }
    }
    assertEquals(41, at)
    val buffer = rows.subList(0, at + 1)
    val start = DetectPolicy.startOf(buffer, buffer.indexOfFirst { it.ts == s.runStartTs }, TriggerKind.AUTO, 0.0, null)
    assertEquals(StartSource.TRACE, start.startSource)
    assertEquals(30, start.index)
    assertEquals(t0 + 30_000, start.startedAt, 0.0)
  }

  @Test
  fun `an untrusted fix (over 30 m) never earns`() {
    assertFalse(DetectPolicy.trusted(row(0.0, 40.0, hAcc = 31.0)))
    assertTrue(DetectPolicy.trusted(row(0.0, 40.0, hAcc = 30.0)))
  }

  @Test
  fun `the wake gate honours the rest except for a region exit and the app`() {
    val ctx = WakeCtx(t0, WakeReason.SLC, DetectPhase.ARMED, true, true, true, t0 + 1, emptyList())
    assertEquals(WakeGate.RESTING, DetectPolicy.wakeGate(ctx))
    assertEquals(WakeGate.OK, DetectPolicy.wakeGate(ctx.copy(reason = WakeReason.REGION)))
    assertEquals(WakeGate.OK, DetectPolicy.wakeGate(ctx.copy(reason = WakeReason.APP)))
    assertEquals(WakeGate.CAPPED, DetectPolicy.wakeGate(ctx.copy(candidateRestUntil = 0.0, candidateStarts = List(6) { t0 - it * 1000 })))
  }

  @Test
  fun `the enums carry the reference's spellings`() {
    assertEquals(listOf("off", "noOwner", "permission", "busy", "resting", "capped"), WakeGate.entries.drop(1).map { it.wire })
    assertEquals(listOf("locationAlways", "locationPrecise", "motion", "backgroundRefresh", "liveActivities"), DetectMissing.entries.map { it.wire })
    assertEquals(TriggerKind.MANUAL, TriggerKind.of("manual"))
    assertNull(TriggerKind.of("Manual"))
  }

  @Test
  fun `a malformed or unknown row answers an error, never throws`() {
    val missing = DetectSelfTest.result("r1", JSONObject().put("kind", "resume").put("now", 1))
    assertTrue(missing.has("error"))
    assertEquals("detect", missing.getString("kind"))
    val unknown = DetectSelfTest.result("r2", JSONObject().put("kind", "nope"))
    assertEquals("unknown detect row kind 'nope'", unknown.getString("error"))
    val wrongType = DetectSelfTest.result("r3", JSONObject().put("kind", "resume").put("startedAt", "x").put("now", 1).put("lastRowTs", JSONObject.NULL))
    assertTrue(wrongType.has("error"))
    val ok = DetectSelfTest.result("r4", JSONObject().put("kind", "resume").put("startedAt", 0).put("now", 300_000).put("lastRowTs", JSONObject.NULL))
    assertEquals("resume", ok.getJSONObject("actual").getString("decision"))
  }

  private fun feed(s: FeedStanding, at: Double, vararg ts: Pair<String, Boolean>) =
    DetectPolicy.feedAfter(s, ts.map { (type, enter) -> FeedTransition(type, enter) }, at)

  @Test
  fun `a walk is walking or running, as iOS counts it, and keeps its clock across both`() {
    val none = FeedStanding(null, false)
    // A RUNNING ENTER starts the walk clock.
    assertEquals(FeedStanding(t0, false), feed(none, t0, "running" to true))
    // A walk turning into a run (EXIT WALKING, ENTER RUNNING in one batch) keeps its start, and back again.
    val walking = feed(none, t0, "walking" to true)
    val running = feed(walking, t0 + 8_000, "walking" to false, "running" to true)
    assertEquals(FeedStanding(t0, false), running)
    assertEquals(FeedStanding(t0, false), feed(running, t0 + 15_000, "running" to false, "walking" to true))
    // An on-foot EXIT with no on-foot ENTER after it ends the walk; so does any other ENTER.
    assertEquals(FeedStanding(null, false), feed(walking, t0 + 5_000, "walking" to false))
    assertEquals(FeedStanding(null, false), feed(running, t0 + 5_000, "running" to true, "running" to false))
    assertEquals(FeedStanding(null, false), feed(walking, t0 + 5_000, "stationary" to true))
    assertEquals(FeedStanding(null, true), feed(walking, t0 + 5_000, "walking" to false, "automotive" to true))
    // Car motion stands from IN_VEHICLE's ENTER until its EXIT or another ENTER.
    val car = feed(none, t0, "automotive" to true)
    assertEquals(FeedStanding(null, true), car)
    assertEquals(FeedStanding(null, false), feed(car, t0 + 1_000, "automotive" to false))
    assertEquals(FeedStanding(t0 + 1_000, false), feed(car, t0 + 1_000, "automotive" to false, "running" to true))
    assertEquals(car, DetectPolicy.feedAfter(car, emptyList(), t0 + 1_000))
  }
}
