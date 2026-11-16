package expo.modules.drivesense.detect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The car link's rules on Android, mirrored from the iOS `CarLink.swift` and policy.ts: the outputs
 * as listed (one per uid, LE audio never), the drive's tally (more than half of 2 min or more of a
 * drive that reached driving speed), pairing (3 cars, each once, connected now or seen on a recent
 * drive), "Not my car" (the newest 20), the last 3 drives, the record's round trip and the state's
 * shape, and the address Android 14+ hides without Nearby devices.
 */
class CarLinkRecordTest {
  private val civic = CarOutput("00:11:22:33:44:55", "Civic", "bluetoothA2DP")
  private val civicHidden = CarOutput("XX:XX:XX:XX:44:55", "Civic", "bluetoothA2DP")
  private val volvo = CarOutput("66:77:88:99:AA:BB", "Volvo XC60", "bluetoothHFP")
  private val auto = CarOutput("android-auto", "Android Auto", "carAudio")
  private val id = { i: Int -> "0f8fad5b-d9cb-469f-a165-7086772895${i.toString().padStart(2, '0')}" }

  private fun drive(rows: Int, vararg withRows: Pair<CarOutput, Int>): CarTally {
    val t = CarTally()
    for (i in 0 until rows) t.count(withRows.filter { i < it.second }.map { it.first })
    return t
  }

  @Test
  fun outputs_onePerUid_A2dpWins_capped_unknownTypesDropped() {
    val sco = civic.copy(type = "bluetoothHFP", name = "")
    val listed = CarOutputs.normalize(listOf(sco, civic.copy(uid = "00:11:22:33:44:55".lowercase()), CarOutput("ble", "Buds", "bluetoothLE"), CarOutput("", "x", "bluetoothA2DP")))
    assertEquals(listOf(civic), listed)
    val long = "a".repeat(127) + "🚗"
    assertEquals(127, CarOutputs.capped(long, 128).length)
    assertEquals(CarOutputs.CURRENT_MAX, CarOutputs.normalize((0 until 20).map { CarOutput("u$it", "", "bluetoothA2DP") }).size)
  }

  @Test
  fun uids_aHiddenAddressIsTheFullOneEndingTheSame() {
    assertTrue(CarUids.same(civicHidden.uid, civic.uid))
    assertTrue(CarUids.same(civic.uid, civicHidden.uid))
    assertFalse(CarUids.same(civicHidden.uid, volvo.uid))
    assertFalse(CarUids.same("XX:XX:XX:XX:44:55", "XX:XX:XX:XX:44:55".replace("55", "56")))
    assertEquals("00:11:22:33:44:AA", CarUids.normalize("00:11:22:33:44:aa"))
    assertEquals("android-auto", CarUids.normalize("android-auto"))
  }

  @Test
  fun tally_mostOfTwoMinutesOrMore() {
    val t = drive(120, civic to 61, volvo to 60)
    assertEquals(listOf(civic), t.mostOfDrive())
    assertEquals(listOf(civic), CarLinkRules.endDrive(CarLinkRecord(), id(1), 1.0, t, drove = true)!!.drives.single().outputs)
    // Under 2 min, or never at driving speed ("Not driving?" too): nothing kept.
    assertNull(CarLinkRules.endDrive(CarLinkRecord(), id(1), 1.0, drive(119, civic to 119), drove = true))
    assertNull(CarLinkRules.endDrive(CarLinkRecord(), id(1), 1.0, drive(300, civic to 300), drove = false))
    // The newest 3 drives.
    var r = CarLinkRecord()
    for (i in 1..4) r = CarLinkRules.endDrive(r, id(i), i.toDouble(), drive(120, civic to 120), drove = true)!!
    assertEquals(listOf(id(2), id(3), id(4)), r.drives.map { it.driveId })
  }

  @Test
  fun pairing_connectedOrSeen_threeCarsEachOnce_leavesNotMine() {
    var r = CarLinkRules.notMine(CarLinkRecord(), civic.uid)
    r = CarLinkRules.pair(r, listOf(civic), civic.uid, 5.0)
    assertEquals(listOf(PairedCar(civic.uid, "Civic", "bluetoothA2DP", 5.0)), r.cars)
    assertEquals(emptyList<String>(), r.notMine)
    assertEquals(r, CarLinkRules.pair(r, listOf(civic), civic.uid, 6.0))
    // Not connected and never seen: nothing.
    assertEquals(r, CarLinkRules.pair(r, emptyList(), volvo.uid, 6.0))
    // Seen on a recent drive.
    r = r.copy(drives = listOf(CarDriveSeen(id(1), 1.0, listOf(volvo))))
    r = CarLinkRules.pair(r, emptyList(), volvo.uid, 7.0)
    assertEquals(listOf(civic.uid, volvo.uid), r.cars.map { it.uid })
    r = CarLinkRules.pair(r, listOf(auto), auto.uid, 8.0)
    assertEquals(3, r.cars.size)
    assertEquals(r, CarLinkRules.pair(r, listOf(CarOutput("u4", "Car 4", "bluetoothA2DP")), "u4", 9.0))
    assertEquals(listOf(volvo.uid, auto.uid), CarLinkRules.forget(r, civic.uid).cars.map { it.uid })
  }

  @Test
  fun notMine_newestTwentyEachOnce() {
    var r = CarLinkRecord()
    for (i in 0 until 25) r = CarLinkRules.notMine(r, "u$i")
    r = CarLinkRules.notMine(r, "u24")
    assertEquals((5 until 25).map { "u$it" }, r.notMine)
  }

  @Test
  fun hiddenAddresses_oneUidPerCar() {
    // A drive saw the car before Nearby devices was allowed; it is paired from that drive.
    var r = CarLinkRecord(drives = listOf(CarDriveSeen(id(1), 1.0, listOf(civicHidden)), CarDriveSeen(id(2), 2.0, listOf(civicHidden))), notMine = listOf(civicHidden.uid))
    r = CarLinkRules.pair(r, emptyList(), civicHidden.uid, 3.0)
    assertEquals(listOf(civicHidden.uid), r.cars.map { it.uid })
    assertEquals(emptyList<String>(), r.notMine)
    r = r.copy(notMine = listOf(civicHidden.uid))
    // Hidden still: it is linked as it is.
    val (hidden, same) = CarLinkRules.reconcile(listOf(civicHidden), r)
    assertEquals(r, same)
    assertTrue(CarLinkRules.linked(hidden, same))
    // Readable now: the full address replaces the hidden one everywhere.
    val (listed, upgraded) = CarLinkRules.reconcile(listOf(civic), r)
    assertEquals(listOf(civic), listed)
    assertEquals(listOf(civic.uid), upgraded.cars.map { it.uid })
    assertEquals(listOf(civic.uid, civic.uid), upgraded.drives.map { it.outputs.single().uid })
    assertEquals(listOf(civic.uid), upgraded.notMine)
    assertTrue(CarLinkRules.linked(listed, upgraded))
    // Hidden again (Nearby devices taken back): listed under the full address the record holds.
    val (back, kept) = CarLinkRules.reconcile(listOf(civicHidden), upgraded)
    assertEquals(listOf(civic), back)
    assertEquals(upgraded, kept)
    // Pairing by the hidden form while the full one is connected pairs the full one.
    val fresh = CarLinkRules.pair(CarLinkRecord(), listOf(civic), civicHidden.uid, 1.0)
    assertEquals(listOf(civic.uid), fresh.cars.map { it.uid })
  }

  @Test
  fun reconcile_aPairedCarTakesItsNewestName_linkedIsPairedOrAndroidAuto() {
    val r = CarLinkRecord(cars = listOf(PairedCar(civic.uid, "Civic", "bluetoothA2DP", 1.0)))
    val (listed, renamed) = CarLinkRules.reconcile(listOf(civic.copy(name = "Honda")), r)
    assertEquals("Honda", renamed.cars.single().name)
    assertTrue(CarLinkRules.linked(listed, renamed))
    assertFalse(CarLinkRules.linked(listOf(volvo), r))
    assertTrue(CarLinkRules.linked(listOf(auto), CarLinkRecord()))
  }

  @Test
  fun record_roundTrips_andADamagedOneReadsAsNone() {
    val r = CarLinkRecord(
      cars = listOf(PairedCar(civic.uid, "Civic", "bluetoothA2DP", 1_760_000_000_000.0)),
      notMine = listOf(volvo.uid),
      drives = listOf(CarDriveSeen(id(1), 1_760_000_000_500.0, listOf(civic, auto)))
    )
    assertEquals(r, CarLinkRecord.fromJson(r.toJson()))
    assertNull(CarLinkRecord.fromJson("{"))
    assertNull(CarLinkRecord.fromJson(null))
    assertEquals(CarLinkRecord(), CarLinkRecord.fromJson("""{"v":1,"cars":[{"uid":"x","type":"bluetoothLE","pairedAt":1}]}"""))
  }

  @Test
  fun state_hasTheContractsKeysAndIntegerTimes() {
    val r = CarLinkRecord(cars = listOf(PairedCar(civic.uid, "Civic", "bluetoothA2DP", 1.4)), drives = listOf(CarDriveSeen(id(1), 2.6, listOf(civic))))
    val s = CarLinkRules.state(listOf(civic), r, linked = true, goneSince = null)
    assertEquals(listOf("current", "cars", "linked", "goneSince", "drives", "notMine"), s.keys.toList())
    @Suppress("UNCHECKED_CAST")
    assertEquals(1L, (s["cars"] as List<Map<String, Any?>>).single()["pairedAt"])
    @Suppress("UNCHECKED_CAST")
    assertEquals(3L, (s["drives"] as List<Map<String, Any?>>).single()["endedAt"])
    assertNull(s["goneSince"])
    assertEquals(9L, CarLinkRules.state(emptyList(), r, false, 9.2)["goneSince"])
  }

  @Test
  fun wakeGate_aPairedCarConnectingSkipsTheRestButMeetsTheCap() {
    val ctx = WakeCtx(
      now = 1_000_000.0,
      reason = WakeReason.CAR,
      phase = DetectPhase.ARMED,
      armed = true,
      hasOwner = true,
      permissionsOk = true,
      candidateRestUntil = 2_000_000.0,
      candidateStarts = emptyList()
    )
    assertEquals(WakeGate.OK, DetectPolicy.wakeGate(ctx))
    assertEquals(WakeGate.RESTING, DetectPolicy.wakeGate(ctx.copy(reason = WakeReason.SLC)))
    assertEquals(WakeGate.CAPPED, DetectPolicy.wakeGate(ctx.copy(candidateStarts = (1..6).map { 1_000_000.0 - it * 60_000.0 })))
    assertEquals("car", WakeReason.CAR.wire)
  }
}
