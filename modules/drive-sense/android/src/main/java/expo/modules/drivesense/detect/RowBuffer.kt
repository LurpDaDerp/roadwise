package expo.modules.drivesense.detect

/**
 * A candidate's rows (the iOS `RowBuffer.swift`): the last [DetectPolicy.CANDIDATE_BUFFER_MAX_ROWS]
 * rows of a watch (30 min at 1 Hz), each with the payload JS would get, so a confirmed drive's start
 * can be traced back over everything the watch saw and its kept rows journaled and handed to JS.
 * Never reaches JS while the watch runs. Detector thread only. Pure: the JVM tests hold it.
 */
class RowBuffer<B>(private val max: Int = DetectPolicy.CANDIDATE_BUFFER_MAX_ROWS) {
  data class Item<B>(val row: DetectRow, val body: B)

  private val list = ArrayDeque<Item<B>>()

  val size: Int get() = list.size

  /** Oldest first. */
  val items: List<Item<B>> get() = list.toList()

  /** The rows alone, oldest first (what the policy traces back over). */
  val rows: List<DetectRow> get() = list.map { it.row }

  /** One more row; the oldest goes past the cap. */
  fun append(row: DetectRow, body: B) {
    list.addLast(Item(row, body))
    while (list.size > max) list.removeFirst()
  }

  /** The index of the row at [ts], or null when it is no longer (or never was) held. */
  fun index(ts: Double): Int? {
    val i = list.indexOfFirst { it.row.ts == ts }
    return if (i < 0) null else i
  }

  fun clear() {
    list.clear()
  }
}
