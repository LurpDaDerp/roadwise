package expo.modules.drivesense

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import kotlin.math.abs

/**
 * 25 Hz IMU from the hardware accelerometer and gyroscope only (README §7 "Frames", rev1: O8) —
 * no rotation vector, no magnetometer, so a magnetic phone mount cannot bend the frame. Registered
 * at 40 000 µs with 1 s of FIFO batching, so the sensor hub buffers samples and the CPU wakes about
 * once a second rather than 50 times. Registered only while capturing at `full` rate.
 *
 * Each accelerometer sample is paired with the gyroscope sample nearest in time, timed on the boot
 * clock and converted through the capture's [ClockAnchor], converted to the reference sign with
 * [androidAccelToReference], and run through [GravityFilter] (state carried) — the same functions
 * `selfTest` runs. The resulting [ImuSample]s go to [onSample] on the capture thread.
 */
class SensorSource(
  context: Context,
  private val handler: Handler,
  private val anchor: () -> ClockAnchor,
  private val onSample: (ImuSample) -> Unit
) : SensorEventListener {
  companion object {
    const val SAMPLING_PERIOD_US = 40_000
    const val MAX_REPORT_LATENCY_US = 1_000_000

    /** How long an accelerometer sample waits for a gyroscope sample at or after it (ms, boot clock). */
    private const val PAIR_WAIT_MS = 250.0

    /** A gyroscope sample further than this from the accelerometer sample is not a partner (ms). */
    private const val PAIR_MAX_GAP_MS = 60.0

    /** Two seconds of gyroscope at 25 Hz — never more waits for pairing. */
    private const val MAX_GYRO_BUFFERED = 50

    /**
     * Android `TYPE_ACCELEROMETER` values (m/s², face-up ≈ [0, 0, +9.81]) → the reference sign, in g
     * (`androidAccelToReference` in `gravityFilter.ts`): `a = −values / G_MPS2`. The capture path and
     * `selfTest`'s `android-raw` vector both call this one function.
     */
    fun androidAccelToReference(x: Double, y: Double, z: Double): Vec3 =
      Vec3((0.0 - x) / G_MPS2, (0.0 - y) / G_MPS2, (0.0 - z) / G_MPS2)
  }

  private class Timed(val clockMs: Double, val arrival: Double, val x: Double, val y: Double, val z: Double)

  private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager?
  private val accelerometer: Sensor? = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
  private val gyroscope: Sensor? = sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

  private val pendingAccel = ArrayList<Timed>()
  private val gyro = ArrayList<Timed>()
  private var gravity = GravityFilter.initialState()
  private var running = false

  /** Timestamps that fell back to their arrival time since the last read (README §7). */
  var fallbacks = 0
    private set

  fun takeFallbacks(): Int = fallbacks.also { fallbacks = 0 }

  /** @return false when there is no accelerometer (every row is then IMU-absent). */
  fun start(): Boolean {
    if (running) return true
    val sm = sensorManager ?: return false
    val accel = accelerometer ?: return false
    running = true
    gravity = GravityFilter.initialState()
    pendingAccel.clear()
    gyro.clear()
    try {
      sm.registerListener(this, accel, SAMPLING_PERIOD_US, MAX_REPORT_LATENCY_US, handler)
      gyroscope?.let { sm.registerListener(this, it, SAMPLING_PERIOD_US, MAX_REPORT_LATENCY_US, handler) }
    } catch (_: Exception) {
      stop()
      return false
    }
    return true
  }

  fun stop() {
    if (!running) return
    running = false
    try {
      sensorManager?.unregisterListener(this)
    } catch (_: Exception) {
      // already gone
    }
    pendingAccel.clear()
    gyro.clear()
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  override fun onSensorChanged(event: SensorEvent) {
    if (!running || event.values.size < 3) return
    val sample = Timed(
      clockMs = event.timestamp / 1e6,
      arrival = System.currentTimeMillis().toDouble(),
      x = event.values[0].toDouble(),
      y = event.values[1].toDouble(),
      z = event.values[2].toDouble()
    )
    when (event.sensor.type) {
      Sensor.TYPE_ACCELEROMETER -> pendingAccel.add(sample)
      Sensor.TYPE_GYROSCOPE -> {
        gyro.add(sample)
        if (gyro.size > MAX_GYRO_BUFFERED) gyro.removeAt(0) // an accelerometer that stopped reporting
      }
      else -> return
    }
    drain()
  }

  /** Pair and emit every accelerometer sample whose gyroscope partner is known (or will not come). */
  private fun drain() {
    val latestGyro = gyro.lastOrNull()?.clockMs
    val latestAccel = pendingAccel.lastOrNull()?.clockMs ?: return
    val a = anchor()
    val iter = pendingAccel.iterator()
    while (iter.hasNext()) {
      val s = iter.next()
      val ready = gyroscope == null ||
        (latestGyro != null && latestGyro >= s.clockMs) ||
        latestAccel - s.clockMs > PAIR_WAIT_MS
      if (!ready) break
      iter.remove()
      emit(s, partner(s.clockMs), a)
    }
    // Keep only the gyroscope samples a future accelerometer sample could still pair with.
    val oldestPending = pendingAccel.firstOrNull()?.clockMs ?: latestAccel
    while (gyro.size > 1 && gyro[1].clockMs <= oldestPending) gyro.removeAt(0)
  }

  private fun partner(clockMs: Double): Vec3 {
    var best: Timed? = null
    for (g in gyro) {
      if (best == null || abs(g.clockMs - clockMs) < abs(best.clockMs - clockMs)) best = g
    }
    val b = best ?: return Vec3.ZERO
    return if (abs(b.clockMs - clockMs) <= PAIR_MAX_GAP_MS) Vec3(b.x, b.y, b.z) else Vec3.ZERO
  }

  private fun emit(s: Timed, w: Vec3, a: ClockAnchor) {
    val converted = TimeBase.toEpochMs(s.clockMs, a, s.arrival)
    if (converted.fellBack) fallbacks++
    val raw = RawImuSample(converted.t, androidAccelToReference(s.x, s.y, s.z), w)
    val out = GravityFilter.filter(listOf(raw), gravity)
    gravity = out.state
    for (imu in out.imu) onSample(imu)
  }
}
