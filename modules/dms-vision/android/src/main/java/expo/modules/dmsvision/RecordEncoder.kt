// The frames-batch encoder (README §3–§5; port of wire.ts `buildFrameBatch`) and the batcher
// (src/reference/batcher.ts). `anchorTMs` is the FIRST record's clock value, kept as a Double. Each
// record's field 0 becomes `tOffMs = tMs − anchorTMs`, computed in Double before the Float store
// (Task 1 review C1). Everything is written as little-endian float32. JVM only.

package expo.modules.dmsvision

import java.nio.ByteBuffer
import java.nio.ByteOrder

class EncodedBatch(val anchorTMs: Double, val n: Int, val data: ByteArray)

object RecordEncoder {
  /** `records` are absolute-form (index 0 = tMs), 38 values each, NaN where not computed. */
  fun encode(records: List<DoubleArray>): EncodedBatch? {
    val first = records.firstOrNull() ?: return null
    if (first.size != DmsConstants.FRAME_STRIDE) return null
    val anchorTMs = first[F.tOffMs]
    val out = ByteBuffer.allocate(records.size * DmsConstants.FRAME_BYTES).order(ByteOrder.LITTLE_ENDIAN)
    for (record in records) {
      if (record.size != DmsConstants.FRAME_STRIDE) return null
      for (i in record.indices) {
        val value = record[i]
        out.putFloat(if (i == F.tOffMs) (value - anchorTMs).toFloat() else value.toFloat())
      }
    }
    return EncodedBatch(anchorTMs, records.size, out.array())
  }
}

/**
 * Collects records and hands out `frames` payloads. There is no timer: after each append the batch is
 * flushed when the NEXT frame could not arrive before it turns BATCH_MS old (Task 3 review I1;
 * src/reference/batcher.ts, pinned by the `batcher-flush` vector). Pure: the caller supplies the clock
 * the records are on (the rebased frame clock, `FrameClock`) and the wall clock read together with it.
 */
class Batcher {
  private val records = ArrayList<DoubleArray>(4)
  private var anchorEpochMs = 0.0
  private var startedAtMs = 0.0

  val isEmpty: Boolean get() = records.isEmpty()
  val count: Int get() = records.size

  /** The anchor's epoch is derived at the batch's first record: epochNow − (baseNow − tMs). */
  fun append(record: DoubleArray, nowMs: Double, epochNowMs: Double) {
    if (records.isEmpty()) {
      startedAtMs = nowMs
      anchorEpochMs = epochNowMs - (nowMs - record[F.tOffMs])
    }
    records.add(record)
  }

  /**
   * `intervalMs` = 1000 / the capture cap. At ≤ 10 fps every record flushes as it is appended; at
   * 15 fps a batch holds two. The subtraction comes first, so it is exactly 0 at the first record.
   */
  fun isDue(nowMs: Double, intervalMs: Double): Boolean =
    records.isNotEmpty() && nowMs - startedAtMs + intervalMs >= DmsConstants.BATCH_MS.toDouble()

  /** The `frames` event payload, and resets. Null when empty. */
  fun flush(): Map<String, Any>? {
    val batch = RecordEncoder.encode(records)
    records.clear()
    batch ?: return null
    return mapOf(
      "v" to DmsConstants.FRAME_WIRE_VERSION,
      "anchorTMs" to batch.anchorTMs,
      "anchorEpochMs" to anchorEpochMs,
      "n" to batch.n,
      "data" to batch.data
    )
  }

  fun clear() {
    records.clear()
  }
}
