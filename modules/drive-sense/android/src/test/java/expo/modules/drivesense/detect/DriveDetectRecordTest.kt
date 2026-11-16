package expo.modules.drivesense.detect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The detector's record and the `DetectState` it answers (src/detect.ts holds that to a strict
 * shape): the record round-trips through its JSON, a damaged one reads as none, and the state has
 * exactly the contract's keys, integer times, the drive's fields only while one records and the
 * Android statuses (no wakes yet: armed reads `unavailable`, never `needs`).
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
}
