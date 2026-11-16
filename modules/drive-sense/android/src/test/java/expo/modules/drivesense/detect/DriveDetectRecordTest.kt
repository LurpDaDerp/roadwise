package expo.modules.drivesense.detect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The detector's record and the `DetectState` it answers (src/detect.ts holds that to a strict
 * shape): the record round-trips through its JSON, a damaged one reads as none, and the state has
 * exactly the contract's keys, integer times, the drive's fields only while one records and the
 * Android statuses (no Play services, so no wakes: armed reads `unavailable`, never `needs`).
 */
class DriveDetectRecordTest {
  private val access = DetectAccess(
    location = LocationAccess.WHEN_IN_USE,
    precise = true,
    motion = MotionAccess.GRANTED,
    backgroundRefresh = BackgroundRefresh.AVAILABLE,
    liveActivities = true,
    canAskAlways = false,
    hardware = false
  )

  private val id = "0f8fad5b-d9cb-469f-a165-70867728950e"

  @Test
  fun roundTrips_andADamagedRecordReadsAsNone() {
    val r = DriveDetectRecord(
      armed = true,
      ownerId = "user-1",
      state = "recording",
      origin = "manual",
      since = 1_760_000_000_000.4,
      driveId = id,
      startedAt = 1_760_000_000_000.0,
      startSource = "wake",
      waitUntil = 1_760_000_300_000.0,
      candidateStarts = listOf(1.0, 2.0),
      lastEnd = DetectLastEnd(1.0, 2.0, 47.6, -122.3, id),
      journalDropped = 2
    )
    assertEquals(r, DriveDetectRecord.fromJson(r.toJson()))
    assertEquals(DriveDetectRecord(), DriveDetectRecord.fromJson(DriveDetectRecord().toJson()))
    assertNull(DriveDetectRecord.fromJson(null))
    assertNull(DriveDetectRecord.fromJson("{not json"))
    assertEquals("off", DriveDetectRecord.fromJson("{\"state\":\"flying\"}")!!.state)
  }

  @Test
  fun theState_hasExactlyTheContractKeys() {
    val keys = listOf("armed", "ownerId", "state", "origin", "driveId", "startedAt", "since", "waitUntil", "lastEnd", "suppressedUntil", "status", "missing", "permissions", "journalDropped")
    assertEquals(keys, DriveDetectRecord().state(access).keys.toList())
    assertEquals(keys + "reason", DriveDetectRecord().state(access, "armed").keys.toList())
    assertEquals(listOf("location", "precise", "motion", "backgroundRefresh", "liveActivities", "canAskAlways"), access.json().keys.toList())
  }

  @Test
  fun armedWithNoWakes_readsUnavailable_andStaysOff() {
    val s = DriveDetectRecord(armed = true, ownerId = "user-1").state(access)
    assertEquals("unavailable", s["status"])
    assertEquals(emptyList<String>(), s["missing"])
    assertEquals(false, s["armed"])
    assertEquals("off", s["state"])
    assertEquals("off", DriveDetectRecord().state(access)["status"])
    assertEquals(false, access.requiredOk)
  }

  @Test
  fun theDrivesFields_onlyWhileOneRecords_asIntegers() {
    val rec = DriveDetectRecord(state = "recording", origin = "manual", since = 10.6, driveId = id, startedAt = 5.4, waitUntil = 99.0)
    val s = rec.state(access)
    assertEquals(id, s["driveId"])
    assertEquals(5L, s["startedAt"])
    assertEquals(11L, s["since"])
    // The wait is reported while a candidate waits (as iOS answers); the Start card's answer carries it.
    assertNull(s["waitUntil"])
    val settled = rec.copy(state = "armed").state(access)
    assertNull(settled["driveId"])
    assertNull(settled["startedAt"])
    val rest = DriveDetectRecord(state = "suppressed", suppressedSince = 1.0, suppressedUntil = 10_800_001.0).state(access)
    assertEquals(10_800_001L, rest["suppressedUntil"])
  }

  @Test
  fun theAndroidMeanings_reachTheStatusInputs() {
    val restricted = access.copy(backgroundRefresh = BackgroundRefresh.DENIED, liveActivities = false)
    assertEquals("denied", restricted.json()["backgroundRefresh"])
    assertEquals(false, restricted.json()["liveActivities"])
    assertEquals(StatusInputs(true, false, LocationAccess.WHEN_IN_USE, true, MotionAccess.GRANTED, BackgroundRefresh.DENIED, false), restricted.inputs(true))
  }

  @Test
  fun aCaptureRowIsSensedWaitedOnStoppedOrTakesItsDriveBack() {
    assertEquals(CaptureRowFate.SENSED, captureRowFate(sensing = true, starting = false, resuming = false, recording = true))
    // A start or a resume under way, or sensing ending: the row is dropped, the capture left alone.
    assertEquals(CaptureRowFate.WAIT, captureRowFate(sensing = false, starting = true, resuming = false, recording = false))
    assertEquals(CaptureRowFate.WAIT, captureRowFate(sensing = false, starting = false, resuming = true, recording = true))
    assertEquals(CaptureRowFate.WAIT, captureRowFate(sensing = true, starting = false, resuming = false, recording = false))
    // A start that answered after its refusal, with no drive recording: the capture stops.
    assertEquals(CaptureRowFate.STOP, captureRowFate(sensing = false, starting = false, resuming = false, recording = false))
    // A resume counted as refused (resumePending) whose capture began after all: the drive is taken
    // back, never left running unsensed with no safety stop or 12 h cap.
    assertEquals(CaptureRowFate.TAKE_BACK, captureRowFate(sensing = false, starting = false, resuming = false, recording = true))
  }

  @Test
  fun batterySaver_isReportedAsRestricted_butNeverANeed() {
    val auto = access.copy(location = LocationAccess.ALWAYS, hardware = true)
    val armed = DriveDetectRecord(armed = true, ownerId = "user-1", state = "armed")
    // Battery Saver limiting location: JS reads `restricted`, the status stays on with nothing missing.
    val saver = armed.state(auto.copy(batterySaver = true))
    assertEquals("restricted", (saver["permissions"] as Map<*, *>)["backgroundRefresh"])
    assertEquals("on", saver["status"])
    assertEquals(emptyList<String>(), saver["missing"])
    assertEquals(true, auto.copy(batterySaver = true).requiredOk)
    // Restricted battery use comes first and stays the need (ruling 5).
    val restricted = armed.state(auto.copy(backgroundRefresh = BackgroundRefresh.DENIED, batterySaver = true))
    assertEquals("denied", (restricted["permissions"] as Map<*, *>)["backgroundRefresh"])
    assertEquals("needs", restricted["status"])
    assertEquals(listOf("backgroundRefresh"), restricted["missing"])
    // Neither: available.
    assertEquals("available", (armed.state(auto)["permissions"] as Map<*, *>)["backgroundRefresh"])
  }

  @Test
  fun batterySaver_countsOnlyTheLocationModesThatStopBackgroundFixes() {
    val p = 28
    assertEquals(false, BatterySaver.limitsLocation(false, p, android.os.PowerManager.LOCATION_MODE_ALL_DISABLED_WHEN_SCREEN_OFF))
    assertEquals(true, BatterySaver.limitsLocation(true, p, android.os.PowerManager.LOCATION_MODE_GPS_DISABLED_WHEN_SCREEN_OFF))
    assertEquals(true, BatterySaver.limitsLocation(true, p, android.os.PowerManager.LOCATION_MODE_ALL_DISABLED_WHEN_SCREEN_OFF))
    assertEquals(true, BatterySaver.limitsLocation(true, p, android.os.PowerManager.LOCATION_MODE_FOREGROUND_ONLY))
    assertEquals(false, BatterySaver.limitsLocation(true, p, android.os.PowerManager.LOCATION_MODE_NO_CHANGE))
    assertEquals(false, BatterySaver.limitsLocation(true, 34, android.os.PowerManager.LOCATION_MODE_THROTTLE_REQUESTS_WHEN_SCREEN_OFF))
    // Below Android 9 the mode can't be read: Battery Saver on counts.
    assertEquals(true, BatterySaver.limitsLocation(true, 27, null))
    assertEquals(false, BatterySaver.limitsLocation(false, 27, null))
  }

  @Test
  fun wakesHeldThroughAResumeAreReplayedInOrder_andAStickyOrphanGetsAnAppWake() {
    // An activity ENTER and a car connecting land while the journal is read: both kept, in order.
    val h = HeldWakes<String>()
    h.hold(WakeReason.SLC, "slc")
    h.hold(WakeReason.CAR, "car")
    assertEquals(listOf(WakeReason.SLC to "slc", WakeReason.CAR to "car"), h.drain(ended = true, sticky = false, noop = "noop"))
    // Drained once: a second settle replays nothing.
    assertEquals(emptyList<Pair<WakeReason, String>>(), h.drain(ended = false, sticky = false, noop = "noop"))
    // A drive resumed: the held wake is replayed (the gate answers it busy and calls its done).
    h.hold(WakeReason.REGION, "region")
    assertEquals(listOf(WakeReason.REGION to "region"), h.drain(ended = false, sticky = true, noop = "noop"))
    // The sticky restart's drive ended as an orphan with nothing held: one app wake before the service goes.
    assertEquals(listOf(WakeReason.APP to "noop"), h.drain(ended = true, sticky = true, noop = "noop"))
    // Not sticky, or the drive resumed: nothing to replay.
    assertEquals(emptyList<Pair<WakeReason, String>>(), h.drain(ended = true, sticky = false, noop = "noop"))
    assertEquals(emptyList<Pair<WakeReason, String>>(), h.drain(ended = false, sticky = true, noop = "noop"))
  }
}
