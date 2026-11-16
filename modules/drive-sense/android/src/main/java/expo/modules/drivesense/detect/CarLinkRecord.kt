package expo.modules.drivesense.detect

import org.json.JSONArray
import org.json.JSONObject

// The car link's record and rules on Android (the record and the taps of the iOS `CarLink.swift`;
// the JS contract is `CarLinkState` in `src/detect/types.ts`). Pure org.json, no android.*, so the
// JVM tests hold every rule: the outputs as the link lists them, the drive's tally ("most of the
// drive"), pairing (at most 3 cars, each once, only an output connected now or one a recent drive
// saw), forgetting, "Not my car" (the newest 20), the last 3 drives, the record's round trip, and
// the one thing Android adds: a Bluetooth address Android hides.
//
// Android 14 and later hide a Bluetooth output's address from an app without Nearby devices
// (BLUETOOTH_CONNECT): it reads "XX:XX:XX:XX:AB:CD", only its last two bytes real. RoadWise asks for
// Nearby devices before "Use this car" (ruling 14), but a drive can see the car before that. So an
// address in that hidden form and a full one with the same last two bytes are the same output here
// ([CarUids.same]): once the full address is readable it replaces the hidden form wherever the
// record holds it, and while it is not, an output whose hidden form matches a full address the
// record holds is listed under that full address. JS, which matches uids exactly, only ever sees one
// uid for one car. Two of the driver's devices sharing their last two bytes (1 in 65,536) are told
// apart only once their full addresses are readable.

/** One Bluetooth or Android Auto output (types.ts `CarOutput`; `carAudio` is Android Auto, iOS's CarPlay). */
data class CarOutput(val uid: String, val name: String, val type: String)

data class PairedCar(val uid: String, val name: String, val type: String, val pairedAt: Double)

/** A drive that reached driving speed, and the outputs connected for most of its rows. */
data class CarDriveSeen(val driveId: String, val endedAt: Double, val outputs: List<CarOutput>)

/** The car link's stored record: the paired cars, the "Not my car" uids and the last drives (oldest first). */
data class CarLinkRecord(
  val cars: List<PairedCar> = emptyList(),
  val notMine: List<String> = emptyList(),
  val drives: List<CarDriveSeen> = emptyList()
) {
  fun toJson(): String =
    JSONObject()
      .put("v", 1)
      .put("cars", JSONArray().also { a -> cars.forEach { a.put(JSONObject().put("uid", it.uid).put("name", it.name).put("type", it.type).put("pairedAt", it.pairedAt)) } })
      .put("notMine", JSONArray().also { a -> notMine.forEach { a.put(it) } })
      .put("drives", JSONArray().also { a -> drives.forEach { d -> a.put(JSONObject().put("driveId", d.driveId).put("endedAt", d.endedAt).put("outputs", outputsJson(d.outputs))) } })
      .toString()

  companion object {
    /** The stored record; null when nothing is stored or it cannot be read (it starts again empty). Entries that cannot be read are skipped. */
    fun fromJson(s: String?): CarLinkRecord? {
      if (s.isNullOrEmpty()) return null
      return try {
        val o = JSONObject(s)
        val cars = mutableListOf<PairedCar>()
        o.optJSONArray("cars")?.let { a ->
          for (i in 0 until a.length()) {
            val c = a.optJSONObject(i) ?: continue
            val out = outputOf(c) ?: continue
            val at = c.opt("pairedAt") as? Number ?: continue
            if (cars.none { it.uid == out.uid }) cars.add(PairedCar(out.uid, out.name, out.type, at.toDouble()))
          }
        }
        val notMine = mutableListOf<String>()
        o.optJSONArray("notMine")?.let { a ->
          for (i in 0 until a.length()) {
            val u = a.opt(i) as? String ?: continue
            if (u.isNotEmpty() && u !in notMine) notMine.add(u)
          }
        }
        val drives = mutableListOf<CarDriveSeen>()
        o.optJSONArray("drives")?.let { a ->
          for (i in 0 until a.length()) {
            val d = a.optJSONObject(i) ?: continue
            val id = d.opt("driveId") as? String ?: continue
            val at = d.opt("endedAt") as? Number ?: continue
            val outs = mutableListOf<CarOutput>()
            d.optJSONArray("outputs")?.let { oa -> for (k in 0 until oa.length()) oa.optJSONObject(k)?.let(::outputOf)?.let(outs::add) }
            drives.add(CarDriveSeen(id, at.toDouble(), outs))
          }
        }
        CarLinkRecord(
          cars.take(DetectPolicy.CARS_MAX),
          notMine.takeLast(DetectPolicy.CAR_NOT_MINE_MAX),
          drives.takeLast(DetectPolicy.CAR_DRIVES_KEPT)
        )
      } catch (_: Exception) {
        null
      }
    }

    private fun outputsJson(outputs: List<CarOutput>): JSONArray =
      JSONArray().also { a -> outputs.forEach { a.put(JSONObject().put("uid", it.uid).put("name", it.name).put("type", it.type)) } }

    private fun outputOf(o: JSONObject): CarOutput? {
      val uid = o.opt("uid") as? String ?: return null
      val name = o.opt("name") as? String ?: ""
      val type = o.opt("type") as? String ?: return null
      if (uid.isEmpty() || type !in CarOutputs.TYPES) return null
      return CarOutput(uid, name, type)
    }
  }
}

/** Bluetooth addresses as uids, and the hidden form Android 14+ gives an app without Nearby devices. */
object CarUids {
  private val ADDRESS = Regex("^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")
  private val HIDDEN = Regex("^XX:XX:XX:XX:[0-9A-F]{2}:[0-9A-F]{2}$")

  /** A Bluetooth address as the link keeps it: upper case (Android reports both cases). Anything else as it is. */
  fun normalize(uid: String): String {
    val up = uid.trim().uppercase()
    return if (ADDRESS.matches(up) || HIDDEN.matches(up)) up else uid
  }

  /** Android's hidden form of an address ("XX:XX:XX:XX:AB:CD"). */
  fun hidden(uid: String): Boolean = HIDDEN.matches(uid)

  /** A full Bluetooth address. */
  fun address(uid: String): Boolean = ADDRESS.matches(uid)

  /** The same output: the same uid, or a hidden address and a full one ending in the same two bytes. */
  fun same(a: String, b: String): Boolean {
    if (a == b) return true
    val (h, full) = when {
      hidden(a) && address(b) -> a to b
      hidden(b) && address(a) -> b to a
      else -> return false
    }
    return h.takeLast(5) == full.takeLast(5)
  }
}

/** What the link lists as connected now, from the raw outputs the phone reports. */
object CarOutputs {
  /** types.ts `CAR_PORT_TYPES`: A2DP, HFP (Android's SCO output) and Android Auto. Never LE audio or a hearing aid. */
  val TYPES = listOf("bluetoothA2DP", "bluetoothHFP", "carAudio")
  /** src/detect.ts `CAR_UID_MAX` / `CAR_NAME_MAX`, and the most outputs it reads at once. */
  const val UID_MAX = 256
  const val NAME_MAX = 128
  const val CURRENT_MAX = 16

  /**
   * One entry per uid, in the order reported: a device connected for media (A2DP) and calls (SCO)
   * is one output, its type A2DP; its newest non-empty name. Uids and names capped as JS reads them,
   * an empty uid or an unknown type dropped, at most [CURRENT_MAX].
   */
  fun normalize(raw: List<CarOutput>): List<CarOutput> {
    val out = LinkedHashMap<String, CarOutput>()
    for (o in raw) {
      if (o.type !in TYPES) continue
      val uid = capped(CarUids.normalize(o.uid), UID_MAX)
      if (uid.isEmpty()) continue
      val name = capped(o.name.trim(), NAME_MAX)
      val was = out[uid]
      out[uid] =
        if (was == null) {
          CarOutput(uid, name, o.type)
        } else {
          CarOutput(uid, name.ifEmpty { was.name }, if (was.type == "bluetoothA2DP" || o.type == "bluetoothA2DP") "bluetoothA2DP" else was.type)
        }
    }
    return out.values.take(CURRENT_MAX)
  }

  /** At most [limit] UTF-16 units (what JS counts), cut between whole characters, never inside a surrogate pair. */
  fun capped(s: String, limit: Int): String {
    if (s.length <= limit) return s
    var end = limit
    if (end > 0 && Character.isHighSurrogate(s[end - 1])) end -= 1
    return s.substring(0, end)
  }
}

/** The live drive's tally: its rows, and how many of them each output was connected for. */
class CarTally {
  var rows = 0
    private set
  private val seen = LinkedHashMap<String, Pair<CarOutput, Int>>()

  /** One row: each output connected now counts it. */
  fun count(current: List<CarOutput>) {
    rows += 1
    for (o in current) seen[o.uid] = o to ((seen[o.uid]?.second ?: 0) + 1)
  }

  /** The outputs connected for most of the drive (`DetectPolicy.carMostOfDrive`), by uid. */
  fun mostOfDrive(): List<CarOutput> =
    seen.values.filter { DetectPolicy.carMostOfDrive(it.second, rows) }.map { it.first }.sortedBy { it.uid }
}

/** The record's rules (the iOS `CarLink` taps and its drive's end). Pure: each answers the new record. */
object CarLinkRules {
  /** As policy.ts reads them. */
  fun ports(current: List<CarOutput>): List<CarPort> = current.map { CarPort(it.uid, it.type) }

  /** policy.ts `carLinked`: a paired car (by uid, whatever its name now) or Android Auto is connected. */
  fun linked(current: List<CarOutput>, rec: CarLinkRecord): Boolean = DetectPolicy.carLinked(ports(current), rec.cars.map { it.uid })

  /**
   * The outputs read now against the record. A full address that the record holds in its hidden
   * form replaces it everywhere (paired cars, drives, "Not my car"); an output read in its hidden
   * form takes the full address the record holds for it, when exactly one matches. A paired car
   * connected now takes its newest name. Answers the outputs to list and the record to keep.
   */
  fun reconcile(current: List<CarOutput>, rec: CarLinkRecord): Pair<List<CarOutput>, CarLinkRecord> {
    val full = current.map { it.uid }.filter { CarUids.address(it) }
    val upgrade = { uid: String ->
      if (!CarUids.hidden(uid)) uid else full.filter { CarUids.same(uid, it) }.singleOrNull() ?: uid
    }
    var r = rec
    if (full.isNotEmpty()) {
      r = CarLinkRecord(
        cars = r.cars.map { it.copy(uid = upgrade(it.uid)) }.distinctBy { it.uid },
        notMine = r.notMine.map(upgrade).distinct(),
        drives = r.drives.map { d -> d.copy(outputs = d.outputs.map { it.copy(uid = upgrade(it.uid)) }.distinctBy { it.uid }) }
      )
    }
    val known = (r.cars.map { it.uid } + r.drives.flatMap { d -> d.outputs.map { it.uid } } + r.notMine).filter { CarUids.address(it) }.distinct()
    val listed = CarOutputs.normalize(
      current.map { o -> if (CarUids.hidden(o.uid)) o.copy(uid = known.filter { CarUids.same(o.uid, it) }.singleOrNull() ?: o.uid) else o }
    )
    val named = r.cars.map { c -> listed.firstOrNull { it.uid == c.uid && it.name.isNotEmpty() && it.name != c.name }?.let { c.copy(name = it.name) } ?: c }
    if (named != r.cars) r = r.copy(cars = named)
    return listed to r
  }

  /**
   * Pairs [uid]: an output connected now, else one a recent drive saw (newest first); at most
   * CARS_MAX, each once; it leaves "Not my car". Anything else changes nothing.
   */
  fun pair(rec: CarLinkRecord, current: List<CarOutput>, uid: String, now: Double): CarLinkRecord {
    val known = current.firstOrNull { CarUids.same(it.uid, uid) }
      ?: rec.drives.asReversed().firstNotNullOfOrNull { d -> d.outputs.firstOrNull { CarUids.same(it.uid, uid) } }
      ?: return rec
    if (rec.cars.any { CarUids.same(it.uid, known.uid) } || rec.cars.size >= DetectPolicy.CARS_MAX) return rec
    return rec.copy(
      cars = rec.cars + PairedCar(known.uid, known.name, known.type, now),
      notMine = rec.notMine.filter { it != uid && !CarUids.same(it, known.uid) }
    )
  }

  fun forget(rec: CarLinkRecord, uid: String): CarLinkRecord = rec.copy(cars = rec.cars.filter { !CarUids.same(it.uid, uid) })

  /** "Not my car": never suggested again (the newest CAR_NOT_MINE_MAX kept). */
  fun notMine(rec: CarLinkRecord, uid: String): CarLinkRecord =
    if (rec.notMine.contains(uid)) rec else rec.copy(notMine = (rec.notMine + uid).takeLast(DetectPolicy.CAR_NOT_MINE_MAX))

  /** A drive that reached driving speed and ran 2 min or more keeps the outputs of most of it (the newest CAR_DRIVES_KEPT). */
  fun endDrive(rec: CarLinkRecord, driveId: String, endedAt: Double, tally: CarTally, drove: Boolean): CarLinkRecord? {
    if (!drove || tally.rows < DetectPolicy.CAR_DRIVE_MIN_ROWS) return null
    return rec.copy(drives = (rec.drives + CarDriveSeen(driveId, endedAt, tally.mostOfDrive())).takeLast(DetectPolicy.CAR_DRIVES_KEPT))
  }

  /** `CarLinkState` (src/detect/types.ts), times as integer epoch ms. */
  fun state(current: List<CarOutput>, rec: CarLinkRecord, linked: Boolean, goneSince: Double?): Map<String, Any?> {
    val out = { o: CarOutput -> linkedMapOf<String, Any?>("uid" to o.uid, "name" to o.name, "type" to o.type) }
    return linkedMapOf(
      "current" to current.map(out),
      "cars" to rec.cars.map { linkedMapOf<String, Any?>("uid" to it.uid, "name" to it.name, "type" to it.type, "pairedAt" to DriveDetectRecord.ms(it.pairedAt)) },
      "linked" to linked,
      "goneSince" to DriveDetectRecord.ms(goneSince),
      "drives" to rec.drives.map { d -> linkedMapOf<String, Any?>("driveId" to d.driveId, "endedAt" to DriveDetectRecord.ms(d.endedAt), "outputs" to d.outputs.map(out)) },
      "notMine" to rec.notMine
    )
  }
}
