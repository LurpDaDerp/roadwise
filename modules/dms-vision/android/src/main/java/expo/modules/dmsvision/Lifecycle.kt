// The native-owned lifecycle rules (README §5–§6), pure so they compile and run anywhere. The fake in
// src/fake.ts implements the same rules, and CaptureController applies them on its 1 Hz tick and on
// each thermal callback. The iOS twin is ios/Lifecycle.swift. JVM only.

package expo.modules.dmsvision

import kotlin.math.abs
import kotlin.math.min

/**
 * The thermal floor with its dwells. Hotter levels 2 and 3 apply at once; level 1 applies only after
 * `fair` has held THERMAL_L1_ENTRY_DWELL_MS; a cooler state applies after THERMAL_COOL_DWELL_MS.
 */
class ThermalFloor {
  var level = 0
    private set
  private var raw = 0
  private var rawSinceMs = 0.0

  /** Report the OS state (on every callback, and on each tick). Returns true if the floor moved. */
  fun observe(name: String, nowMs: Double): Boolean {
    val r = levelOf(name)
    if (r != raw) {
      raw = r
      rawSinceMs = nowMs
    }
    val before = level
    if (raw > level) {
      if (raw >= 2 || nowMs - rawSinceMs >= DmsConstants.THERMAL_L1_ENTRY_DWELL_MS) level = raw
    } else if (raw < level) {
      if (nowMs - rawSinceMs >= DmsConstants.THERMAL_COOL_DWELL_MS) level = raw
    }
    return level != before
  }

  /**
   * Forget the floor (final review round 3): at start and at teardown, so a session never inherits
   * the last one's floor; the next observe applies the OS state as a fresh floor would.
   */
  fun reset() {
    level = 0
    raw = 0
    rawSinceMs = 0.0
  }

  val fpsCap: Int get() = DmsConstants.THERMAL_FPS_CAP[level]
  val allowsGazeNet: Boolean get() = DmsConstants.THERMAL_GAZE_NET[level]
  val allowsCamera: Boolean get() = level < 3

  companion object {
    /** `name` is "nominal" | "fair" | "serious" | "critical" | "unknown". */
    fun levelOf(name: String): Int = when (name) {
      "fair" -> 1
      "serious" -> 2
      "critical" -> 3
      else -> 0
    }
  }
}

enum class LifecycleAction { NONE, PAUSE_WATCHDOG, STOP_WATCHDOG, RELEASE }

/** The watchdog and release timers, decided from times alone (ms on one monotonic clock). */
object LifecycleRules {
  /**
   * `running`/`paused`: the current state. `lastHeartbeatMs`: the last start/setPolicy.
   * `pausedSinceMs`: when the current pause began (null when not paused).
   */
  fun decide(nowMs: Double, running: Boolean, paused: Boolean, lastHeartbeatMs: Double, pausedSinceMs: Double?): LifecycleAction {
    val silent = nowMs - lastHeartbeatMs
    if ((running || paused) && silent >= (DmsConstants.WATCHDOG_PAUSE_MS + DmsConstants.WATCHDOG_STOP_MS)) {
      return LifecycleAction.STOP_WATCHDOG
    }
    if (running && silent >= DmsConstants.WATCHDOG_PAUSE_MS) return LifecycleAction.PAUSE_WATCHDOG
    if (paused && pausedSinceMs != null && nowMs - pausedSinceMs >= DmsConstants.MODEL_RELEASE_AFTER_PAUSE_MS) {
      return LifecycleAction.RELEASE
    }
    return LifecycleAction.NONE
  }
}

/** Rolling latency percentiles over the last second's samples (reported once per second). */
class LatencyWindow {
  private val samples = ArrayList<Double>(64)

  fun add(ms: Double) {
    if (samples.size < 240) samples.add(ms)
  }

  /** [p50, p95] and reset; nulls when empty. */
  fun take(): Array<Double?> {
    if (samples.isEmpty()) return arrayOf(null, null)
    val s = samples.sorted()
    samples.clear()
    fun q(p: Double): Double = s[min(s.size - 1, Math.round(p * (s.size - 1)).toInt())]
    return arrayOf(q(0.5), q(0.95))
  }
}

/**
 * The record clock (README §5, plan §M1). `ImageInfo.timestamp` is rebased at the session's first
 * frame onto whichever of `elapsedRealtimeNanos` or the uptime clock (`System.nanoTime()`,
 * CLOCK_MONOTONIC; `uptimeNanos` needs API 33) lies within 1 s of it (elapsed first). When neither
 * does (a sensor clock with another origin), the frame clock is shifted onto elapsedRealtime by the
 * offset measured at that first frame. `baseNowMs` reads the SAME base, so
 * `anchorEpochMs = epochNow − (baseNow − tMs)` is exact (Task 3 review, Android flag 4).
 */
class FrameClock {
  enum class Base { ELAPSED, UPTIME, REBASED }

  var base: Base? = null
    private set
  private var offsetNs = 0L

  fun reset() {
    base = null
    offsetNs = 0L
  }

  /**
   * Called with every frame; only the session's first frame chooses. The base is then fixed for
   * the session (`reset` at every start), so it can never change mid-session.
   */
  fun calibrate(frameNs: Long, elapsedNs: Long, uptimeNs: Long) {
    if (base != null) return
    when {
      abs(elapsedNs - frameNs) <= WITHIN_NS -> { base = Base.ELAPSED; offsetNs = 0L }
      abs(uptimeNs - frameNs) <= WITHIN_NS -> { base = Base.UPTIME; offsetNs = 0L }
      else -> { base = Base.REBASED; offsetNs = elapsedNs - frameNs }
    }
  }

  /** The record time of a frame, in ms (Double: a boot clock does not fit a float32). */
  fun tMs(frameNs: Long): Double = (frameNs + offsetNs) / 1e6

  /** "Now" on the record clock, in ms, from the two system clocks read together. */
  fun baseNowMs(elapsedNs: Long, uptimeNs: Long): Double =
    (if (base == Base.UPTIME) uptimeNs else elapsedNs) / 1e6

  companion object {
    const val WITHIN_NS = 1_000_000_000L
  }
}
