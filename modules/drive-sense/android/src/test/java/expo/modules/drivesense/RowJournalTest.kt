package expo.modules.drivesense

import expo.modules.drivesense.detect.DetectPolicy
import java.io.File
import java.nio.file.Files
import java.util.concurrent.Executor
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The row journal on the JVM (RowJournal.kt, RowJournalRead.kt), with the cases of
 * `__tests__/journal.test.ts` (journal.ts is the format both phones write): the lines a drive
 * writes, a torn last line, a seq out of order and a hole, a resume's gap, paging, rotation at 4
 * files, and what `listDrives` reports (an orphan's end). A direct executor runs every operation at
 * once, in order, as the journal's one thread does.
 */
class RowJournalTest {
  private lateinit var dir: File
  private lateinit var journal: RowJournal
  private val direct = Executor { it.run() }

  private val id = "0f8fad5b-d9cb-469f-a165-70867728950e"
  private val t0 = 1_760_000_000_000L

  @Before
  fun setUp() {
    dir = File(Files.createTempDirectory("journal").toFile(), "drivesense/journal")
    journal = RowJournal(dir, direct)
  }

  @After
  fun tearDown() {
    dir.parentFile?.parentFile?.deleteRecursively()
  }

  private fun start(driveId: String = id, startedAt: Long = t0): JSONObject =
    JSONObject()
      .put("k", "start").put("v", 1).put("driveId", driveId).put("origin", "auto").put("startedAt", startedAt)
      .put("startSource", "trace").put("startLat", 47.6).put("startLng", -122.33).put("continues", false)
      .put("confirmedAt", startedAt + 45_000).put("nativeBuild", "412")

  private fun row(seq: Long, speed: Double = 9.0, hAcc: Double = 5.0): JSONObject =
    JSONObject()
      .put("seq", seq).put("ts", t0 + seq * 1000).put("lat", 47.6).put("lng", -122.33).put("hAcc", hAcc)
      .put("speed", speed).put("speedAcc", 0.5).put("gnssValid", true).put("mock", false)

  private fun end(lastSeq: Long, cause: String = "still"): JSONObject =
    JSONObject().put("k", "end").put("endedAt", t0 + 900_000).put("cause", cause).put("decidedAt", t0 + 960_000)
      .put("lastRowTs", t0 + 959_000).put("lastSeq", lastSeq)

  private fun gap(lastSeq: Long): JSONObject = JSONObject().put("k", "gap").put("from", t0 + 3_000).put("to", t0 + 100_000).put("lastSeq", lastSeq)

  /** A file written as text, line by line (`k` added to rows), then `tail` as it is. */
  private fun writeRaw(driveId: String, lines: List<JSONObject>, tail: String = "") {
    dir.mkdirs()
    val text = lines.joinToString("") { it.toString() + "\n" } + tail
    File(dir, "$driveId.ndjson").writeText(text)
  }

  private fun asRow(o: JSONObject): JSONObject = JSONObject(o.toString()).put("k", "row")

  private fun read(driveId: String = id, after: Long = 0, limit: Int = 600): RowsPage {
    var page: RowsPage? = null
    RowJournalRead.read(journal, driveId, after, limit) { page = it }
    return page!!
  }

  private fun list(liveId: String?, recordKnown: Boolean = true): List<Map<String, Any?>> {
    var out: List<Map<String, Any?>>? = null
    RowJournalRead.list(journal, liveId, recordKnown) { out = it }
    return out!!
  }

  private fun seqs(p: RowsPage): List<Long> = p.rows.map { (it["seq"] as Number).toLong() }

  @Test
  fun aWholeDrive_startRowsGapEnd_readInOrderWithoutTheirKind() {
    var dropped = -1
    journal.open(id, start()) { dropped = it }
    assertEquals(0, dropped)
    for (s in 1L..3L) journal.appendRow(id, row(s))
    journal.appendMarker(id, end(3), close = true)
    val lines = File(dir, "$id.ndjson").readLines()
    assertEquals(5, lines.size)
    assertEquals("start", JSONObject(lines[0]).getString("k"))
    assertEquals("row", JSONObject(lines[1]).getString("k"))
    assertEquals(1L, JSONObject(lines[1]).getLong("seq"))
    assertEquals("end", JSONObject(lines[4]).getString("k"))
    val page = read()
    assertEquals(listOf(1L, 2L, 3L), seqs(page))
    assertTrue(page.done)
    assertEquals(3L, page.lastSeq)
    assertFalse(page.rows[0].containsKey("k"))
    assertEquals(t0 + 1000, (page.rows[0]["ts"] as Number).toLong())
    val listed = list(liveId = null).single()
    assertEquals(id, listed["driveId"])
    assertEquals(3L, (listed["lastSeq"] as Number).toLong())
    assertEquals(mapOf("endedAt" to t0 + 900_000, "cause" to "still", "decidedAt" to t0 + 960_000), listed["ended"])
  }

  @Test
  fun aTornLastLine_isNeverRead_andAResumeCutsIt() {
    writeRaw(id, listOf(start(), asRow(row(1)), asRow(row(2))), tail = "{\"k\":\"row\",\"seq\":3,\"ts\":17600")
    val s = RowJournalRead.summary(File(dir, "$id.ndjson"))!!
    assertTrue(s.cleanEnd < s.bytes)
    assertEquals(2L, s.lastSeq)
    assertEquals(listOf(1L, 2L), seqs(read()))
    var resumed: JournalSummary? = null
    journal.reopen(id) { resumed = it }
    assertEquals(2L, resumed!!.lastSeq)
    assertEquals(resumed!!.cleanEnd, File(dir, "$id.ndjson").length())
    journal.appendRow(id, row(1003))
    assertEquals(listOf(1L, 2L, 1003L), seqs(read()))
  }

  @Test
  fun aSeqNotAboveTheLast_isDropped_andAHoleSkipped() {
    writeRaw(id, listOf(start(), asRow(row(1)), asRow(row(3)), asRow(row(2)), asRow(row(3)), asRow(row(4))))
    assertEquals(listOf(1L, 3L, 4L), seqs(read()))
  }

  @Test
  fun anUnreadableLineInTheMiddle_isDropped_andAWholeNumberSeqOnly() {
    writeRaw(id, listOf(start(), asRow(row(1))))
    File(dir, "$id.ndjson").appendText("garbage\n" + asRow(row(2)).put("seq", 2.5).toString() + "\n" + asRow(row(3)).toString() + "\n")
    assertEquals(listOf(1L, 3L), seqs(read()))
  }

  @Test
  fun aResume_rowsGoOnAfterTheGapSeq_andASeqTheGapReservedIsNeverRead() {
    writeRaw(id, listOf(start(), asRow(row(1)), asRow(row(2)), asRow(row(3)), gap(1003), asRow(row(4)), asRow(row(1004)), asRow(row(1005))))
    assertEquals(listOf(1L, 2L, 3L, 1004L, 1005L), seqs(read()))
    // A file ending at its gap reserved the seqs up to it: the next resume goes on after them.
    writeRaw(id, listOf(start(), asRow(row(1)), asRow(row(2)), asRow(row(3)), gap(1003)))
    val s = RowJournalRead.summary(File(dir, "$id.ndjson"))!!
    assertEquals(3L, s.lastSeq)
    assertEquals(1003L, s.topSeq)
    assertEquals(2003L, DetectPolicy.resumeSeq(s.topSeq))
  }

  @Test
  fun pages_keepTheirPlace() {
    journal.open(id, start())
    for (s in 1L..5L) journal.appendRow(id, row(s))
    val a = read(after = 0, limit = 2)
    assertEquals(listOf(1L, 2L), seqs(a))
    assertFalse(a.done)
    val b = read(after = a.lastSeq, limit = 2)
    assertEquals(listOf(3L, 4L), seqs(b))
    val c = read(after = b.lastSeq, limit = 2)
    assertEquals(listOf(5L), seqs(c))
    assertTrue(c.done)
    // Read again from the start: the cursor is past it, so the file is read afresh.
    assertEquals(listOf(1L, 2L, 3L, 4L, 5L), seqs(read(after = 0)))
    assertEquals(RowsPage(emptyList(), 7, true), read(after = 7).copy(rows = emptyList()))
  }

  @Test
  fun aSummary_findsTheLastTrustedFix_behindUntrustedRows() {
    writeRaw(id, listOf(start(), asRow(row(1)), asRow(row(2, hAcc = 80.0)), asRow(row(3, hAcc = 80.0))))
    val s = RowJournalRead.summary(File(dir, "$id.ndjson"))!!
    assertEquals(3L, s.lastSeq)
    assertEquals((t0 + 3000).toDouble(), s.lastRowTs!!, 0.0)
    assertEquals(47.6, s.lastFixLat!!, 0.0)
    assertNull(s.end)
  }

  @Test
  fun listDrives_anOrphanEndsAtItsLastRow_theLiveDriveHasNoEnd_andNothingIsAnOrphanWithTheRecordUnknown() {
    writeRaw(id, listOf(start(), asRow(row(1)), asRow(row(2))))
    val orphan = list(liveId = null).single()
    assertEquals(mapOf("endedAt" to t0 + 2000, "cause" to "orphan", "decidedAt" to t0 + 2000), orphan["ended"])
    assertNull(list(liveId = id).single()["ended"])
    assertNull(list(liveId = null, recordKnown = false).single()["ended"])
    // With no row, the orphan ends at its start.
    writeRaw(id, listOf(start()))
    assertEquals(mapOf("endedAt" to t0, "cause" to "orphan", "decidedAt" to t0), list(liveId = null).single()["ended"])
    // A file with no start line is never listed.
    writeRaw(id, listOf(asRow(row(1))))
    assertTrue(list(liveId = null).isEmpty())
  }

  @Test
  fun aFifthDrive_rotatesTheOldestAway() {
    val ids = (1..4).map { "0f8fad5b-d9cb-469f-a165-7086772895${it}0" }
    for ((i, d) in ids.withIndex()) {
      journal.open(d, start(d, startedAt = t0 + (4 - i) * 60_000L))
      journal.appendMarker(d, end(0), close = true)
    }
    var dropped = -1
    val fifth = "0f8fad5b-d9cb-469f-a165-708677289550"
    journal.open(fifth, start(fifth, startedAt = t0 + 600_000)) { dropped = it }
    assertEquals(1, dropped)
    // The oldest by its start (the last opened here) went.
    val left = journal.files().map { it.first }.toSet()
    assertEquals(DetectPolicy.JOURNAL_MAX_DRIVES, left.size)
    assertFalse(left.contains(ids[3]))
    assertTrue(left.contains(fifth))
  }

  @Test
  fun anEndForAFileNotOpenHere_opensIt_andCutsItsTornTail() {
    writeRaw(id, listOf(start(), asRow(row(1))), tail = "{\"k\":\"row\",\"se")
    journal.appendMarker(id, end(1, cause = "js"), close = true)
    val s = RowJournalRead.summary(File(dir, "$id.ndjson"))!!
    assertNotNull(s.end)
    assertEquals("js", s.end!!.getString("cause"))
    assertEquals(s.bytes, s.cleanEnd)
    assertEquals(listOf(1L), seqs(read()))
  }

  @Test
  fun rowsForAnotherDrive_orAfterTheEnd_areNotWritten() {
    journal.open(id, start())
    journal.appendRow(id, row(1))
    journal.appendRow("11111111-1111-4111-8111-111111111111", row(2))
    journal.appendMarker(id, end(1), close = true)
    journal.appendRow(id, row(2))
    assertEquals(listOf(1L), seqs(read()))
  }

  @Test
  fun deleteAndWipe() {
    journal.open(id, start())
    journal.appendRow(id, row(1))
    var deleted = false
    journal.delete(id) { deleted = true }
    assertTrue(deleted)
    assertFalse(File(dir, "$id.ndjson").exists())
    assertTrue(read().done)
    journal.open(id, start())
    var wiped = false
    journal.wipe { wiped = true }
    assertTrue(wiped)
    assertFalse(dir.exists())
    assertTrue(list(liveId = null).isEmpty())
  }

  @Test
  fun aLine_isTheJsonAndANewline_andANaNNeverReachesDisk() {
    val line = RowJournal.encode(JSONObject().put("k", "gap").put("from", 1).put("to", 2))!!
    assertEquals("\n", String(line).takeLast(1))
    assertEquals(JSONObject("{\"k\":\"gap\",\"from\":1,\"to\":2}").toString(), String(line).dropLast(1))
    assertEquals(1L, RowJournalRead.long(JSONObject(String(line)), "from"))
    assertNull(RowJournalRead.long(JSONObject().put("x", 1.5), "x"))
    assertNull(RowJournalRead.long(JSONObject().put("x", -1), "x"))
  }
}
