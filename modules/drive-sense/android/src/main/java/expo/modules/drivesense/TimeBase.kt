package expo.modules.drivesense

import android.os.SystemClock
import kotlin.math.abs

/**
 * Time base and second windows — a port of `src/extract/timebase.ts` (README §7 "Time base",
 * "Windows"). Sensor events and fixes are stamped on the boot clock (`elapsedRealtimeNanos`) and
 * converted through ONE anchor per capture, so a wall-clock change mid-drive cannot reorder them.
 */
data class ClockAnchor(val epochMs: Double, val clockMs: Double) {
  companion object {
    /** Both clocks read back to back (README §7): `currentTimeMillis` and `elapsedRealtimeNanos / 1e6`. */
    fun now(): ClockAnchor =
      ClockAnchor(System.currentTimeMillis().toDouble(), SystemClock.elapsedRealtimeNanos() / 1e6)
  }
}

object TimeBase {
  data class Converted(val t: Double, val fellBack: Boolean)

  /**
   * A boot-clock instant on the capture's epoch base: `anchor.epochMs + (clockMs − anchor.clockMs)`.
   * Android measures an item's ARRIVAL with this (the boot clock at delivery), not with
   * `currentTimeMillis()` (README §7, review N2N3 I2): row `ts` is on the same base, so a wall-clock
   * step mid-drive cannot trip the sanity fallback and push samples and fixes off their windows.
   */
  fun anchoredNow(anchor: ClockAnchor, clockNowMs: Double): Double = anchor.epochMs + (clockNowMs - anchor.clockMs)

  /** [anchoredNow] at this instant. */
  fun anchoredNow(anchor: ClockAnchor): Double = anchoredNow(anchor, SystemClock.elapsedRealtimeNanos() / 1e6)

  /** Boot-clock ms → epoch ms; more than TIMEBASE_MAX_SKEW_MS from the arrival time falls back to it. */
  fun toEpochMs(clockMs: Double, anchor: ClockAnchor, arrivalEpochMs: Double): Converted {
    val t = anchor.epochMs + (clockMs - anchor.clockMs)
    return if (abs(t - arrivalEpochMs) > TIMEBASE_MAX_SKEW_MS) Converted(arrivalEpochMs, true) else Converted(t, false)
  }

  /** Exclusive start of the window closing at [ts]. */
  fun windowStart(prevTs: Long?, ts: Long): Long =
    if (prevTs == null || ts - prevTs > MAX_ROW_GAP_MS) ts - FIRST_WINDOW_MS else prevTs

  data class Window<T>(val inWindow: List<T>, val rest: MutableList<T>, val dropped: Int)

  /**
   * Split [buffer] (any order) into `(start, ts]` sorted oldest first (stable, like the reference's
   * `Array.prototype.sort`), what waits for later windows (`t > ts`), and a count of what belonged to
   * an already closed window.
   */
  fun <T> takeWindow(buffer: List<T>, start: Long, ts: Long, timeOf: (T) -> Double): Window<T> {
    val inWindow = ArrayList<T>()
    val rest = ArrayList<T>()
    var dropped = 0
    val s = start.toDouble()
    val e = ts.toDouble()
    for (item in buffer) {
      val t = timeOf(item)
      if (t > e) rest.add(item) else if (t > s) inWindow.add(item) else dropped++
    }
    return Window(inWindow.sortedBy(timeOf), rest, dropped)
  }

  /** The window's fix: the latest fix timestamp in `(start, ts]`, whatever the arrival order. */
  fun pickFix(fixes: List<FixSample>, start: Long, ts: Long): FixSample? {
    var best: FixSample? = null
    for (f in fixes) {
      if (f.t > start && f.t <= ts && (best == null || f.t > best.t)) best = f
    }
    return best
  }
}
