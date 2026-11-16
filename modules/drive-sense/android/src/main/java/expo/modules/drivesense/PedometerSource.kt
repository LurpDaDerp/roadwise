package expo.modules.drivesense

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.SystemClock
import android.provider.Settings

/**
 * The step count while a drive records (README §4 `steps`): the phone's own pedometer, put on each
 * of the capture's rows as the bridge-only `steps` (`FeatureRow.steps`), which the engine's step
 * walk reads (`src/core/engine/motion.ts`: 20 steps or more within 20 s with nothing over 3 mph for
 * 15 s ends the drive, cut back before the first step). The Android half of iOS's PedometerSource.
 *
 * `TYPE_STEP_COUNTER` (the hardware count since boot, kept by the sensor hub even with the CPU
 * asleep) gives the steps since the drive's baseline: its first count after the capture began, or,
 * for a capture the system restarted after its process died, the baseline that capture took (same
 * capture, same boot), so its rows' counts keep growing past the gap as on iPhone. A count lower
 * than the baseline (the counter started again) takes a new baseline: the engine reads a lower
 * count as a pedometer that started again. A phone with no step counter but a `TYPE_STEP_DETECTOR`
 * counts one per detected step from the capture's start (a restart starts again from 0). With
 * neither, or without Physical activity (ACTIVITY_RECOGNITION, the permission the walking end's
 * transitions already need; both step sensors are behind it on API 29+), rows carry no count and the
 * step walk never applies.
 *
 * Battery: on-change sensors batched with [MAX_REPORT_LATENCY_US] in the hub's FIFO, so a walk wakes
 * the CPU about once a second, not twice a step (and not at all at `low` rate, where the CPU sleeps
 * between fixes: the counts wait in the FIFO, and the count itself never loses a step). Registered
 * only while a capture is open, at both rates. Capture thread only.
 */
class PedometerSource(context: Context, private val handler: Handler) : SensorEventListener {
  companion object {
    /** The hub batches step reports for up to this long (µs): the IMU's own flush interval. */
    const val MAX_REPORT_LATENCY_US = 1_000_000

    /** This boot's number, or -1 where the phone does not say. */
    fun bootCount(context: Context): Int = try {
      Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
    } catch (_: Exception) {
      -1
    }
  }

  private val app = context.applicationContext
  private val sensorManager = app.getSystemService(Context.SENSOR_SERVICE) as SensorManager?
  private var sensor: Sensor? = null
  private var count: StepCount? = null
  private var captureStartedAt = 0L

  /**
   * The steps counted since the drive's baseline, or null before the first count (and when stopped,
   * without a step sensor or without Physical activity). Only grows while one count runs, but for a
   * counter that started again.
   */
  var steps: Int? = null
    private set

  /** Counts steps for the capture that began at [startedAt]. Nothing when it cannot. */
  fun start(startedAt: Long) {
    if (sensor != null) return
    steps = null
    count = null
    captureStartedAt = startedAt
    if (!DriveSensePermissions.motionGranted(app)) return
    val sm = sensorManager ?: return
    val counter = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
    val s = counter ?: sm.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR) ?: return
    val registered = try {
      sm.registerListener(this, s, SensorManager.SENSOR_DELAY_NORMAL, MAX_REPORT_LATENCY_US, handler)
    } catch (_: Exception) {
      // A SecurityException (Physical activity revoked meanwhile) or a missing sensor service.
      false
    }
    if (!registered) return
    sensor = s
    if (counter != null) {
      count = StepCount(resumedBaseline(startedAt))
    } else {
      // The detector reports steps, not a total: the count starts at the capture's start.
      steps = 0
    }
  }

  /** The capture ended: the count stops and is forgotten (its baseline stays on file, keyed to its capture). */
  fun stop() {
    val s = sensor ?: return
    try {
      sensorManager?.unregisterListener(this, s)
    } catch (_: Exception) {
      // already unregistered
    }
    sensor = null
    count = null
    steps = null
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (sensor == null) return
    when (event.sensor.type) {
      Sensor.TYPE_STEP_COUNTER -> {
        val c = count ?: return
        val total = event.values.firstOrNull()?.toDouble() ?: return
        if (!total.isFinite() || total < 0) return
        val before = c.baseline
        steps = c.onTotal(total.toLong())
        val after = c.baseline
        if (after != null && after != before) saveBaseline(after)
      }
      Sensor.TYPE_STEP_DETECTOR -> steps = (steps ?: 0) + 1
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  /** The baseline this capture took before its process died, when it is from this boot. */
  private fun resumedBaseline(startedAt: Long): Long? {
    val saved = DriveSensePrefs.init(app).stepBaseline ?: return null
    return StepCount.resumable(saved, startedAt, SystemClock.elapsedRealtime(), bootCount(app))
  }

  private fun saveBaseline(baseline: Long) {
    DriveSensePrefs.init(app).stepBaseline =
      DriveSensePrefs.StepBaseline(captureStartedAt, baseline, SystemClock.elapsedRealtime(), bootCount(app))
  }
}

/**
 * The step counter's arithmetic (pure, JVM-tested): `TYPE_STEP_COUNTER` totals since boot become
 * the steps since the drive's [baseline]. The first total, with no baseline, is the baseline (0
 * steps); a total under the baseline (the counter started again) is a new baseline.
 */
class StepCount(baseline: Long?) {
  companion object {
    /**
     * [saved]'s baseline when it belongs to the capture that began at [startedAt] and was taken in
     * this boot: the same boot number where the phone gives one, and a stamp on the boot clock not
     * ahead of it (the boot clock restarts at a reboot). Else null: the next total is the baseline.
     */
    fun resumable(saved: DriveSensePrefs.StepBaseline, startedAt: Long, nowClockMs: Long, boot: Int): Long? {
      if (saved.captureStartedAt != startedAt || saved.baseline < 0) return null
      val thisBoot = saved.atClockMs in 1L..nowClockMs && (boot < 0 || saved.boot == boot)
      return if (thisBoot) saved.baseline else null
    }
  }

  var baseline: Long? = baseline
    private set

  /** The steps since the baseline for this counter [total]. */
  fun onTotal(total: Long): Int {
    val b = baseline
    if (b == null || total < b) {
      baseline = total
      return 0
    }
    return (total - b).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
  }
}
