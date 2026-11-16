package expo.modules.drivesense

import expo.modules.drivesense.detect.DetectPolicy
import expo.modules.drivesense.detect.DetectRow
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import org.json.JSONArray
import org.json.JSONObject

/** What a journal file holds, from its first line and its tail (the iOS `JournalSummary`). */
data class JournalSummary(
  val start: JSONObject,
  val lastSeq: Long = 0,
  /** The highest seq the file has handed out or reserved: its last row's, or a later resume's `gap`. */
  val topSeq: Long = 0,
  val lastRowTs: Double? = null,
  /** The last trusted fix (the parked spot after an orphan end). */
  val lastFixLat: Double? = null,
  val lastFixLng: Double? = null,
  val end: JSONObject? = null,
  val bytes: Long = 0,
  /** Where the complete lines end; a torn tail begins here (= [bytes] with none). */
  val cleanEnd: Long = 0
)

/** One `readRows` page: the row payloads (with `seq`), the last seq read, and whether the file holds no more. */
data class RowsPage(val rows: List<Map<String, Any?>>, val lastSeq: Long, val done: Boolean)

/**
 * Reading the row journal (the iOS `RowJournalRead.swift`; `src/detect/journal.ts` reads the same
 * way): a file's first line and its last complete lines (for `listDrives`, a resume and an orphan's
 * end), and its rows in order after a seq (for `readRows`). A torn last line (no newline, or not
 * JSON) is never read. Rows are taken in rising seq order: a row whose seq is not above the last one
 * is dropped (a resume's `gap` moves the last one to its `lastSeq`), and a hole (a row whose write
 * failed) is skipped. `readRows` keeps its place in each file ([RowJournal.cursors]), so draining a
 * long drive page by page reads it once. Every function here runs on the journal's executor; the
 * public entry points hop onto it themselves. Pure java.io and org.json, for the JVM unit tests.
 */
object RowJournalRead {
  const val HEAD_BYTES = 8_192
  const val TAIL_BYTES = 65_536L
  const val READ_CHUNK_BYTES = 131_072

  private fun obj(bytes: ByteArray, from: Int, to: Int): JSONObject? =
    try {
      JSONObject(String(bytes, from, to - from, Charsets.UTF_8))
    } catch (_: Exception) {
      null
    }

  /** A finite number at [key], else null (a JSON number only, never a string). */
  fun num(o: JSONObject, key: String): Double? {
    val v = o.opt(key)
    return if (v is Number && v.toDouble().isFinite()) v.toDouble() else null
  }

  /** A whole, non-negative number at [key] (journal.ts's `isInt`), else null. */
  fun long(o: JSONObject, key: String): Long? {
    val v = o.opt(key) as? Number ?: return null
    val d = v.toDouble()
    return if (d.isFinite() && d >= 0 && d == Math.floor(d)) v.toLong() else null
  }

  /** A row payload (or a journal row line) as the detector reads it; null when a field is missing. */
  fun detectRow(o: JSONObject): DetectRow? {
    val valid = o.opt("gnssValid") as? Boolean ?: return null
    return DetectRow(
      num(o, "ts") ?: return null,
      num(o, "lat") ?: return null,
      num(o, "lng") ?: return null,
      num(o, "hAcc") ?: return null,
      num(o, "speed") ?: return null,
      num(o, "speedAcc") ?: return null,
      valid
    )
  }

  /** A file's start, last row, last trusted fix and end, from its first 8 KB and last 64 KB. */
  fun summary(file: File): JournalSummary? {
    if (!file.isFile) return null
    return try {
      RandomAccessFile(file, "r").use { f ->
        val size = f.length()
        if (size <= 0) return null
        val head = ByteArray(minOf(HEAD_BYTES.toLong(), size).toInt())
        f.seek(0)
        f.readFully(head)
        val nl = head.indexOf('\n'.code.toByte())
        if (nl < 0) return null
        val start = obj(head, 0, nl) ?: return null
        if (start.optString("k") != "start") return null
        val from = if (size > TAIL_BYTES) size - TAIL_BYTES else 0L
        val tail = ByteArray((size - from).toInt())
        f.seek(from)
        f.readFully(tail)
        val lastNl = tail.lastIndexOf('\n'.code.toByte())
        if (lastNl < 0) return JournalSummary(start = start, bytes = size, cleanEnd = size)
        // The complete lines of the tail, newest last; a tail that begins mid-file begins mid-line.
        val lines = ArrayList<Pair<Int, Int>>()
        var at = 0
        for (i in 0..lastNl) {
          if (tail[i] == '\n'.code.toByte()) {
            if (i > at) lines.add(at to i)
            at = i + 1
          }
        }
        if (from > 0 && lines.isNotEmpty() && lines[0].first == 0) lines.removeAt(0)
        var lastSeq = 0L
        var topSeq = 0L
        var lastRowTs: Double? = null
        var fixLat: Double? = null
        var fixLng: Double? = null
        var end: JSONObject? = null
        for ((a, b) in lines.asReversed()) {
          val o = obj(tail, a, b) ?: continue
          val k = o.optString("k")
          if (k == "end" && end == null) end = o
          // A resume after the last row reserved the seqs up to its `lastSeq`.
          if (k == "gap" && lastRowTs == null) long(o, "lastSeq")?.let { topSeq = maxOf(topSeq, it) }
          if (k != "row") continue
          if (lastRowTs == null) {
            lastSeq = long(o, "seq") ?: 0L
            lastRowTs = num(o, "ts")
          }
          val r = detectRow(o)
          if (r != null && DetectPolicy.trusted(r)) {
            fixLat = r.lat
            fixLng = r.lng
            break
          }
        }
        end?.let { e -> long(e, "lastSeq")?.let { lastSeq = it } }
        JournalSummary(
          start = start,
          lastSeq = lastSeq,
          topSeq = maxOf(topSeq, lastSeq),
          lastRowTs = lastRowTs,
          lastFixLat = fixLat,
          lastFixLng = fixLng,
          end = end,
          bytes = size,
          cleanEnd = from + lastNl + 1
        )
      }
    } catch (_: Exception) {
      null
    }
  }

  /**
   * One file as a `JournaledDrive` (src/detect/types.ts). [orphan]: a file with no end that is not
   * the live drive is listed as ended, cause `orphan`, at its last row (else its start), for JS to
   * adopt and finish like any drive native ended.
   */
  fun listed(id: String, s: JournalSummary, orphan: Boolean): Map<String, Any?> {
    val st = s.start
    val e = s.end
    val ended: Map<String, Any?>? = when {
      e != null -> linkedMapOf("endedAt" to (long(e, "endedAt") ?: 0L), "cause" to e.optString("cause", "orphan"), "decidedAt" to (long(e, "decidedAt") ?: 0L))
      orphan -> {
        val at = jsMs(s.lastRowTs ?: num(st, "startedAt") ?: 0.0)
        linkedMapOf("endedAt" to at, "cause" to "orphan", "decidedAt" to at)
      }
      else -> null
    }
    return linkedMapOf(
      "driveId" to id,
      "origin" to st.optString("origin", "auto"),
      "startedAt" to (long(st, "startedAt") ?: 0L),
      "startSource" to st.optString("startSource", "wake"),
      "startLat" to num(st, "startLat"),
      "startLng" to num(st, "startLng"),
      "continues" to st.optBoolean("continues", false),
      "confirmedAt" to (long(st, "confirmedAt") ?: 0L),
      "firstSeq" to 1,
      "lastSeq" to s.lastSeq,
      "lastRowTs" to s.lastRowTs?.let { jsMs(it) },
      "bytes" to s.bytes,
      "ended" to ended
    )
  }

  /** `listDrives`: every readable journal file, on the journal's executor. */
  fun list(journal: RowJournal, liveId: String?, recordKnown: Boolean, done: (List<Map<String, Any?>>) -> Unit) {
    journal.onQueue {
      val out = ArrayList<Map<String, Any?>>()
      for ((id, f) in journal.files()) {
        summary(f)?.let { out.add(listed(id, it, orphan = recordKnown && id != liveId)) }
      }
      done(out)
    }
  }

  /** `readRows`: the rows after [afterSeq], in order, at most [limit], on the journal's executor. */
  fun read(journal: RowJournal, driveId: String, afterSeq: Long, limit: Int, done: (RowsPage) -> Unit) {
    journal.onQueue { done(readNow(journal, driveId, afterSeq, limit)) }
  }

  internal fun readNow(journal: RowJournal, driveId: String, afterSeq: Long, limit: Int): RowsPage {
    val file = journal.file(driveId)
    if (!file.isFile) return RowsPage(emptyList(), afterSeq, true)
    return try {
      RandomAccessFile(file, "r").use { f ->
        var last = 0L
        var offset = 0L
        journal.cursors[driveId]?.let { (seq, off) ->
          if (seq <= afterSeq) {
            last = seq
            offset = off
          }
        }
        f.seek(offset)
        val rows = ArrayList<Map<String, Any?>>()
        var lastSeq = afterSeq
        val buf = ByteArrayOutputStream()
        var bufAt = offset
        val chunk = ByteArray(READ_CHUNK_BYTES)
        while (true) {
          val n = f.read(chunk)
          if (n <= 0) break
          buf.write(chunk, 0, n)
          val bytes = buf.toByteArray()
          var lineStart = 0
          var i = 0
          while (i < bytes.size) {
            if (bytes[i] == '\n'.code.toByte()) {
              val lineEnd = bufAt + i + 1
              val o = obj(bytes, lineStart, i)
              val k = o?.optString("k")
              val gap = if (k == "gap") long(o, "lastSeq") else null
              val seq = if (k == "row") long(o, "seq") else null
              if (gap != null && gap > last) {
                // A resume: the rows go on after its seq.
                last = gap
              } else if (o != null && seq != null && seq > last) {
                last = seq
                if (seq > afterSeq) {
                  o.remove("k")
                  rows.add(toMap(o))
                  lastSeq = seq
                  if (rows.size >= limit) {
                    journal.cursors[driveId] = seq to lineEnd
                    return RowsPage(rows, lastSeq, false)
                  }
                }
              }
              lineStart = i + 1
            }
            i++
          }
          bufAt += lineStart
          buf.reset()
          buf.write(bytes, lineStart, bytes.size - lineStart)
        }
        journal.cursors[driveId] = last to bufAt
        RowsPage(rows, lastSeq, true)
      }
    } catch (_: Exception) {
      RowsPage(emptyList(), afterSeq, true)
    }
  }

  /** An epoch ms as JS's integer (`Math.round`, never negative). */
  fun jsMs(d: Double): Long = Math.round(maxOf(0.0, d))

  /** A JSON object as the bridge's map: JSON null becomes null; nested objects and arrays are converted. */
  fun toMap(o: JSONObject): Map<String, Any?> {
    val out = LinkedHashMap<String, Any?>()
    val keys = o.keys()
    while (keys.hasNext()) {
      val k = keys.next()
      out[k] = toValue(o.opt(k))
    }
    return out
  }

  private fun toValue(v: Any?): Any? = when (v) {
    null, JSONObject.NULL -> null
    is JSONObject -> toMap(v)
    is JSONArray -> (0 until v.length()).map { toValue(v.opt(it)) }
    else -> v
  }
}
