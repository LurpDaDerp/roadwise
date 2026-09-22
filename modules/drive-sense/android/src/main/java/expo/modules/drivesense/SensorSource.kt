package expo.modules.drivesense

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.SystemClock
import kotlin.math.abs

/**
 * 25 Hz IMU from the hardware accelerometer and gyroscope only (README §7 "Frames", rev1: O8) —
 * no rotation vector, no magnetometer, so a magnetic phone mount cannot bend the frame. Registered
 * at 40 000 µs with 1 s of FIFO batching, so the sensor hub buffers samples and the CPU wakes about
 * once a second rather than 50 times. Registered only while capturing at `full` rate.
 *
 * Each accelerometer sample is paired with the gyroscope sample nearest in time (sensor stamps,
 * within [PAIR_MAX_GAP_MS]), converted through the capture's [ClockAnchor], converted to the
 * reference sign with [androidAccelToReference], and run through [GravityFilter] (state carried) —
 * the same functions `selfTest` runs. The resulting [ImuSample]s go to [onSample] on the capture
 * thread.
 *
 * Pairing waits on ARRIVAL time, not sensor time (review N2N3 I3): a hub may flush the two FIFOs
 * separately, the whole accelerometer batch landing before the matching gyroscope batch. An
 * accelerometer sample is held until a gyroscope sample stamped at or after it has arrived, or
 * until [PAIR_WAIT_ARRIVAL_MS] of arrival time (boot clock at delivery) has passed — enough to
 * cover a batch skew. A sample released without a partner is counted ([takeUnpaired]).
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

    /** How long (arrival time, ms) an accelerometer sample waits for its gyroscope partner. */
    const val PAIR_WAIT_ARRIVAL_MS = 1_200.0

    /** A gyroscope sample further than this from the accelerometer sample is not a partner (ms). */
    const val PAIR_MAX_GAP_MS = 60.0

    /** About four seconds at 25 Hz: more than a batch skew ever needs. */
    private const val MAX_BUFFERED = 100

    /**
     * Android `TYPE_ACCELEROMETER` values (m/s², face-up ≈ [0, 0, +9.81]) → the reference sign, in g
     * (`androidAccelToReference` in `gravityFilter.ts`): `a = −values / G_MPS2`. The capture path and
     * `selfTest`'s `android-raw` vector both call this one function.
     */
    fun androidAccelToReference(x: Double, y: Double, z: Double): Vec3 =
      Vec3((0.0 - x) / G_MPS2, (0.0 - y) / G_MPS2, (0.0 - z) / G_MPS2)
  }

  /** A sensor sample: its stamp and its delivery time, both on the boot clock (ms). */
  private class Timed(val clockMs: Double, val arrivalClockMs: Double, val x: Double, val y: Double, val z: Double)

  private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager?
  private val accelerometer: Sensor? = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
  private val gyroscope: Sensor? = sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

  private val pendingAccel = ArrayList<Timed>()
  private val gyro = ArrayList<Timed>()
  private var gravity = GravityFilter.initialState()
  private var running = false

  private var fallbacks = 0
  private var unpaired = 0

  /** Timestamps that fell back to their arrival time since the last read (README §7). */
  fun takeFallbacks(): Int = fallbacks.also { fallbacks = 0 }

  /** Accelerometer samples emitted with no gyroscope partner (`w = 0`) since the last read. */
  fun takeUnpaired(): Int = unpaired.also { unpaired = 0 }

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
      arrivalClockMs = SystemClock.elapsedRealtimeNanos() / 1e6,
      x = event.values[0].toDouble(),
      y = event.values[1].toDouble(),
      z = event.values[2].toDouble()
    )
    when (event.sensor.type) {
      Sensor.TYPE_ACCELEROMETER -> {
        pendingAccel.add(sample)
        if (pendingAccel.size > MAX_BUFFERED) emitOne(pendingAccel.removeAt(0), anchor())
      }
      Sensor.TYPE_GYROSCOPE -> {
        gyro.add(sample)
        if (gyro.size > MAX_BUFFERED) gyro.removeAt(0) // an accelerometer that stopped reporting
      }
      else -> return
    }
    drain(sample.arrivalClockMs)
  }

  /** Pair and emit every accelerometer sample whose partner is known, or will not come. */
  private fun drain(nowArrivalMs: Double) {
    if (pendingAccel.isEmpty()) return
    val latestGyro = gyro.lastOrNull()?.clockMs
    val a = anchor()
    val iter = pendingAccel.iterator()
    while (iter.hasNext()) {
      val s = iter.next()
      val ready = gyroscope == null ||
        (latestGyro != null && latestGyro >= s.clockMs) ||
        nowArrivalMs - s.arrivalClockMs > PAIR_WAIT_ARRIVAL_MS
      if (!ready) break
      iter.remove()
      emitOne(s, a)
    }
    // Keep only the gyroscope samples a waiting accelerometer sample could still pair with.
    val oldestPending = pendingAccel.firstOrNull()?.clockMs ?: return
    while (gyro.size > 1 && gyro[1].clockMs <= oldestPending - PAIR_MAX_GAP_MS) gyro.removeAt(0)
  }

  private fun emitOne(s: Timed, a: ClockAnchor) {
    val w = partner(s.clockMs)
    if (w == null) {
      if (gyroscope != null) unpaired++
    }
    // Arrival on the capture's anchored boot clock, so a wall-clock step cannot trip the fallback.
    val converted = TimeBase.toEpochMs(s.clockMs, a, TimeBase.anchoredNow(a, s.arrivalClockMs))
    if (converted.fellBack) fallbacks++
    val raw = RawImuSample(converted.t, androidAccelToReference(s.x, s.y, s.z), w ?: Vec3.ZERO)
    val out = GravityFilter.filter(listOf(raw), gravity)
    gravity = out.state
    for (imu in out.imu) onSample(imu)
  }

  private fun partner(clockMs: Double): Vec3? {
    var best: Timed? = null
    for (g in gyro) {
      if (best == null || abs(g.clockMs - clockMs) < abs(best.clockMs - clockMs)) best = g
    }
    val b = best ?: return null
    return if (abs(b.clockMs - clockMs) <= PAIR_MAX_GAP_MS) Vec3(b.x, b.y, b.z) else null
  }
}
