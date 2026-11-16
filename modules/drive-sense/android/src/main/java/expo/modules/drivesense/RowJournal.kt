package expo.modules.drivesense

import expo.modules.drivesense.detect.DetectPolicy
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executor
import org.json.JSONObject

/**
 * The row journal on Android (the iOS `RowJournal.swift`; `src/detect/journal.ts` is the format):
 * one append-only NDJSON file per drive, `<noBackupFilesDir>/drivesense/journal/<driveId>.ndjson`,
 * a directory Android never backs up (Auto Backup and device transfer both skip it). A `start` line,
 * every row with its `seq` (1 and up), a `gap` line where a relaunch resumed the drive, an `end`
 * line. fsync on `start`, `gap`, `end` and every `JOURNAL_SYNC_EVERY_ROWS` rows: a process death
 * loses nothing (the bytes are in the kernel's cache), a power loss at most 30 s. At most
 * `JOURNAL_MAX_DRIVES` files: opening one more deletes the oldest file JS never drained, ended or
 * orphaned (counted for `journalDropped`). A file is deleted only by `discardDrive` (JS, once the
 * trip is finalized), a cancelled drive or a wipe. Each drive's file stops taking rows at
 * `JOURNAL_MAX_BYTES_PER_DRIVE` (32 MiB, about 40 hours of rows). Reading is in RowJournalRead.kt.
 *
 * Every file operation runs on [io], one thread (the detector's journal executor), in the order
 * called, so the 1 Hz row write never touches the detector's thread or the main thread; completions
 * run on [io] too and the caller posts them where it needs them. No android.* here: the JVM unit
 * tests run it on a temporary directory with a direct executor.
 */
class RowJournal(val directory: File, private val io: Executor) {
  /** [io] only. */
  private var out: FileOutputStream? = null
  private var openId: String? = null
  private var bytes = 0L
  private var rowsSinceSync = 0

  /** Rows not written: the size cap, or a write that failed (diagnostics). */
  @Volatile
  var droppedRows = 0
    private set

  /** `readRows`' place in each file: the last seq read and the byte offset after its line. [io] only. */
  internal val cursors = HashMap<String, Pair<Long, Long>>()

  fun file(driveId: String): File = File(directory, "$driveId.ndjson")

  /** Every journal file: (driveId, file). [io] only. */
  internal fun files(): List<Pair<String, File>> =
    (directory.listFiles() ?: emptyArray())
      .filter { it.isFile && it.name.endsWith(SUFFIX) }
      .map { it.name.dropLast(SUFFIX.length) to it }

  // ——— writing ———

  /**
   * A new drive's file with its `start` line, fsynced, and open for rows. With `JOURNAL_MAX_DRIVES`
   * files already there the oldest goes first. [done] gets how many went.
   */
  fun open(driveId: String, start: JSONObject, done: (Int) -> Unit = {}) {
    io.execute {
      closeHandle()
      val dropped = rotate(keepingRoomFor = driveId)
      try {
        if (directory.isDirectory || directory.mkdirs()) {
          val f = file(driveId)
          val line = encode(start)
          if (line != null) {
            FileOutputStream(f, false).use { s ->
              s.write(line)
              s.fd.sync()
            }
            attach(driveId, f)
          }
        }
      } catch (_: Exception) {
        // No file: rows are not journaled (JS still has them live); the drive records on.
        closeHandle()
      }
      done(dropped)
    }
  }

  /**
   * A relaunch resumes [driveId]: a torn last line is cut off, the file opens for rows again, and
   * [done] gets what the file holds (null when there is none).
   */
  fun reopen(driveId: String, done: (JournalSummary?) -> Unit) {
    io.execute {
      closeHandle()
      val f = file(driveId)
      val s = RowJournalRead.summary(f)
      if (s == null) {
        done(null)
        return@execute
      }
      if (s.cleanEnd < s.bytes) {
        try {
          FileOutputStream(f, true).use { it.channel.truncate(s.cleanEnd) }
        } catch (_: Exception) {
          // left torn: a reader drops the torn line, and the next line starts after it
        }
      }
      attach(driveId, f)
      done(s)
    }
  }

  /** One row line: the `row` payload with its `seq`. fsynced every `JOURNAL_SYNC_EVERY_ROWS` rows. */
  fun appendRow(driveId: String, body: JSONObject) {
    io.execute {
      val s = out
      if (openId != driveId || s == null) return@execute
      val data = encode(body.put("k", "row"))
      if (data == null || bytes + data.size > DetectPolicy.JOURNAL_MAX_BYTES_PER_DRIVE) {
        droppedRows += 1
        return@execute
      }
      if (!write(s, data)) {
        droppedRows += 1
        return@execute
      }
      rowsSinceSync += 1
      if (rowsSinceSync >= DetectPolicy.JOURNAL_SYNC_EVERY_ROWS) sync()
    }
  }

  /**
   * A `gap` or `end` line, fsynced; [close] closes the file after it (the `end`). A file not open in
   * this process (a drive ended before its resume reopened it) is opened for it, its torn tail cut.
   */
  fun appendMarker(driveId: String, line: JSONObject, close: Boolean, done: (() -> Unit)? = null) {
    io.execute {
      if (openId != driveId) {
        val f = file(driveId)
        RowJournalRead.summary(f)?.let { s ->
          closeHandle()
          if (s.cleanEnd < s.bytes) {
            try {
              FileOutputStream(f, true).use { it.channel.truncate(s.cleanEnd) }
            } catch (_: Exception) {
              // left torn: the marker's line is then unreadable, and the file reads as an orphan
            }
          }
          attach(driveId, f)
        }
      }
      val s = out
      if (openId == driveId && s != null) {
        encode(line)?.let { write(s, it) }
        sync()
      }
      if (close && openId == driveId) closeHandle()
      done?.invoke()
    }
  }

  /** Deletes the file (a cancelled drive, or JS done with it). [done] runs even when none exists. */
  fun delete(driveId: String, done: (() -> Unit)? = null) {
    io.execute {
      if (openId == driveId) closeHandle()
      cursors.remove(driveId)
      try {
        file(driveId).delete()
      } catch (_: Exception) {
        // nothing to delete
      }
      done?.invoke()
    }
  }

  /** A wipe: the open file closed, every place forgotten, every file deleted, ended or not. */
  fun wipe(done: () -> Unit) {
    io.execute {
      closeHandle()
      cursors.clear()
      try {
        directory.deleteRecursively()
      } catch (_: Exception) {
        // what is left is deleted by the next wipe; nothing reads it meanwhile but listDrives
      }
      done()
    }
  }

  /** Runs [block] on [io], after every operation already called (the readers in RowJournalRead.kt). */
  fun onQueue(block: () -> Unit) = io.execute(block)

  /** Writes [data] at the end; on a failure the torn bytes are cut so the next line starts clean. */
  private fun write(s: FileOutputStream, data: ByteArray): Boolean =
    try {
      s.write(data)
      bytes += data.size
      true
    } catch (_: Exception) {
      try {
        s.channel.truncate(bytes)
      } catch (_: Exception) {
        // a reader drops the torn line
      }
      false
    }

  private fun attach(driveId: String, f: File) {
    try {
      out = FileOutputStream(f, true)
      openId = driveId
      bytes = f.length()
      rowsSinceSync = 0
    } catch (_: Exception) {
      closeHandle()
    }
  }

  private fun sync() {
    try {
      out?.fd?.sync()
    } catch (_: Exception) {
      // the bytes are written; only a power loss could lose them
    }
    rowsSinceSync = 0
  }

  private fun closeHandle() {
    out?.let {
      try {
        it.fd.sync()
      } catch (_: Exception) {
        // closing anyway
      }
      try {
        it.close()
      } catch (_: Exception) {
        // closed
      }
    }
    out = null
    openId = null
    bytes = 0
    rowsSinceSync = 0
  }

  /**
   * At `JOURNAL_MAX_DRIVES` files the oldest (by its start) goes: an ended file JS never drained, or
   * an orphan. Only a new drive opens a file, and none other records then, so every other file is
   * one or the other. Returns how many went.
   */
  private fun rotate(keepingRoomFor: String): Int {
    val list = files().filter { it.first != keepingRoomFor }.toMutableList()
    var dropped = 0
    while (list.size >= DetectPolicy.JOURNAL_MAX_DRIVES) {
      val oldest = list.minByOrNull { (_, f) -> RowJournalRead.summary(f)?.start?.optDouble("startedAt", 0.0) ?: 0.0 } ?: break
      try {
        oldest.second.delete()
      } catch (_: Exception) {
        // counted as gone: it is never listed again unless it is still there
      }
      cursors.remove(oldest.first)
      list.remove(oldest)
      dropped += 1
    }
    return dropped
  }

  companion object {
    const val SUFFIX = ".ndjson"

    /** The JSON of [obj] and a newline; null for anything JSON cannot hold (a NaN never reaches disk). */
    fun encode(obj: JSONObject): ByteArray? =
      try {
        (obj.toString() + "\n").toByteArray(Charsets.UTF_8)
      } catch (_: Exception) {
        null
      }
  }
}
