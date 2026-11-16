package expo.modules.drivesense

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.GeomagneticField
import android.hardware.display.DisplayManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.Display
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.sqrt

/**
 * The phone's compass heading for the driving screen (`PhoneHeading`, README §12): what iOS's
 * CLHeading gives the compass before a drive's first direction of travel (PRODUCT "The driving
 * screen"), measured the Android way. Registered only while JS asks (`PhoneHeading.start`, while the
 * driving screen is in front in portrait with no track bearing yet) and unregistered at its `stop`.
 * Nothing else reads it: drive capture and scoring never use the magnetometer (SensorSource's frame
 * stays accelerometer + gyroscope, so a magnetic mount cannot bend it).
 *
 * `TYPE_ROTATION_VECTOR` (the OS's fusion of accelerometer, gyroscope and magnetometer, so steadier
 * than the raw magnetometer and right for an upright phone, unlike expo-location's Android
 * heading) at [SAMPLING_PERIOD_US], live (no batching: the card follows the phone), handed to JS at
 * most every [EMIT_MIN_INTERVAL_MS] on its own thread. Each reading is the heading of the phone's
 * forward direction ([HeadingMath.heading]): magnetic, and true north too once a location is known
 * (`GeomagneticField`'s declination at the last known fix, read from the location service's cache:
 * no fix is asked for). A reading taken while the magnetometer rates its calibration unreliable, or
 * one the rotation vector's own error estimate puts more than 50° out, is sent with accuracy 0 (JS
 * ignores it), as iOS's uncalibrated compass is.
 *
 * The calibration comes from `TYPE_MAGNETIC_FIELD`, registered beside the rotation vector at
 * [MAGNETOMETER_PERIOD_US] only for its status: Android's event dispatch passes a real status only
 * for the raw sensor types (magnetic field among them) and sends every rotation-vector event as
 * `SENSOR_STATUS_ACCURACY_HIGH`, so the rotation vector's own `accuracy` says nothing. The rotation
 * vector already runs the magnetometer, so this adds only its events. Until the magnetometer's first
 * report (a fraction of a second), or on a phone without one, the rotation vector's status stands.
 *
 * "The top" is the top of the screen, not of the device: the display's rotation (read at start and
 * again whenever the display changes, through a `DisplayManager.DisplayListener` on the heading
 * thread, so a turn of 180° with no configuration change is seen too) is handed to the arithmetic.
 * A phone in portrait is at rotation 0 and reads as before; a tablet whose natural orientation is
 * landscape stands in portrait at rotation 90 or 270, where the device's own +Y lies sideways.
 */
class HeadingSource(context: Context, private val emit: (Map<String, Any?>) -> Unit) : SensorEventListener {
  companion object {
    /** 10 Hz from the sensor… */
    const val SAMPLING_PERIOD_US = 100_000

    /** …and at most 5 a second to JS, whose compass steps toward the newest reading 4 times a second. */
    const val EMIT_MIN_INTERVAL_MS = 200L

    /** The magnetometer, read only for its calibration status, 5 times a second. */
    const val MAGNETOMETER_PERIOD_US = 200_000

    /** With no declination yet, the location cache is read again this often (the drive's GPS fills it). */
    private const val DECLINATION_RETRY_MS = 10_000L

    fun sensor(context: Context): Sensor? =
      (context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager?)
        ?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
  }

  private val app = context.applicationContext
  private val sensorManager = app.getSystemService(Context.SENSOR_SERVICE) as SensorManager?
  private val displayManager = app.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager?
  private var thread: HandlerThread? = null
  private var running: Sensor? = null
  private var magnetometer: Sensor? = null

  /** The magnetometer's newest `SENSOR_STATUS_*`, or null before its first report (or without one). */
  @Volatile private var magnetStatus: Int? = null

  // The heading thread's, reset by start before the thread exists.
  private var lastEmitAt = 0L
  private var declination: Double? = null
  private var declinationTriedAt = 0L

  /** The default display's `Surface.ROTATION_*` (0-3), set at start and by [displayListener]. */
  @Volatile private var rotation = 0

  private val displayListener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) {}

    override fun onDisplayRemoved(displayId: Int) {}

    override fun onDisplayChanged(displayId: Int) {
      if (displayId == Display.DEFAULT_DISPLAY) rotation = readRotation()
    }
  }

  /** @return false when the phone has no rotation-vector sensor (or it could not be registered). */
  @Synchronized
  fun start(): Boolean {
    if (running != null) return true
    val sm = sensorManager ?: return false
    val s = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) ?: return false
    lastEmitAt = 0L
    declination = null
    declinationTriedAt = 0L
    magnetStatus = null
    rotation = readRotation()
    val t = HandlerThread("drive-sense-heading").also { it.start() }
    val handler = Handler(t.looper)
    val ok = try {
      sm.registerListener(this, s, SAMPLING_PERIOD_US, handler)
    } catch (_: Exception) {
      false
    }
    if (!ok) {
      t.quitSafely()
      return false
    }
    magnetometer = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)?.takeIf { m ->
      try {
        sm.registerListener(this, m, MAGNETOMETER_PERIOD_US, handler)
      } catch (_: Exception) {
        false
      }
    }
    try {
      displayManager?.registerDisplayListener(displayListener, handler)
    } catch (_: Exception) {
      // No display updates: the rotation read above stands.
    }
    thread = t
    running = s
    return true
  }

  @Synchronized
  fun stop() {
    val s = running ?: return
    try {
      sensorManager?.unregisterListener(this, s)
    } catch (_: Exception) {
      // already unregistered
    }
    magnetometer?.let { m ->
      try {
        sensorManager?.unregisterListener(this, m)
      } catch (_: Exception) {
        // already unregistered
      }
    }
    magnetometer = null
    magnetStatus = null
    try {
      displayManager?.unregisterDisplayListener(displayListener)
    } catch (_: Exception) {
      // never registered
    }
    running = null
    thread?.quitSafely()
    thread = null
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (event.sensor.type == Sensor.TYPE_MAGNETIC_FIELD) {
      magnetStatus = event.accuracy
      return
    }
    if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR) return
    val now = SystemClock.elapsedRealtime()
    if (lastEmitAt != 0L && now - lastEmitAt < EMIT_MIN_INTERVAL_MS) return
    val v = event.values
    if (v.size < 3) return
    val mag = HeadingMath.heading(HeadingMath.rotationMatrix(v[0].toDouble(), v[1].toDouble(), v[2].toDouble(), v.getOrNull(3)?.toDouble()), rotation) ?: return
    lastEmitAt = now
    if (declination == null && (declinationTriedAt == 0L || now - declinationTriedAt >= DECLINATION_RETRY_MS)) {
      declinationTriedAt = now
      declination = lastKnownDeclination()
    }
    val estimate = v.getOrNull(4)?.toDouble()
    emit(
      linkedMapOf(
        "trueHeading" to (declination?.let { HeadingMath.norm(mag + it) } ?: -1.0),
        "magHeading" to mag,
        "accuracy" to HeadingMath.accuracyLevel(HeadingMath.status(event.accuracy, magnetStatus), estimate)
      )
    )
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
    if (sensor?.type == Sensor.TYPE_MAGNETIC_FIELD) magnetStatus = accuracy
  }

  /** The default display's rotation from its natural orientation (`Surface.ROTATION_*`), 0 if unknown. */
  private fun readRotation(): Int =
    try {
      displayManager?.getDisplay(Display.DEFAULT_DISPLAY)?.rotation ?: 0
    } catch (_: Exception) {
      0
    }

  /** The declination (degrees east) at the newest location the location service has cached, or null. */
  @SuppressLint("MissingPermission")
  private fun lastKnownDeclination(): Double? {
    if (!DriveSensePermissions.hasForegroundLocation(app)) return null
    return try {
      val lm = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager? ?: return null
      val providers = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(LocationManager.FUSED_PROVIDER)
        add(LocationManager.GPS_PROVIDER)
        add(LocationManager.NETWORK_PROVIDER)
        add(LocationManager.PASSIVE_PROVIDER)
      }
      var best: Location? = null
      for (p in providers) {
        val l = try {
          lm.getLastKnownLocation(p)
        } catch (_: Exception) {
          null
        } ?: continue
        if (best == null || l.elapsedRealtimeNanos > best.elapsedRealtimeNanos) best = l
      }
      val l = best ?: return null
      GeomagneticField(l.latitude.toFloat(), l.longitude.toFloat(), (if (l.hasAltitude()) l.altitude else 0.0).toFloat(), System.currentTimeMillis())
        .declination.toDouble()
        .takeIf { it.isFinite() }
    } catch (_: Exception) {
      // No permission after all, or no location service.
      null
    }
  }
}

/** The heading arithmetic (pure, JVM-tested). */
object HeadingMath {
  /** A heading's forward direction is unusable under this horizontal length (of √2 at most). */
  const val MIN_HORIZONTAL = 0.2

  /** Degrees in [0, 360). */
  fun norm(deg: Double): Double {
    val r = ((deg % 360.0) + 360.0) % 360.0
    return if (r >= 360.0) 0.0 else r
  }

  /**
   * The rotation vector's unit quaternion (x, y, z, and w when the sensor gives it) as a row-major
   * 3×3 rotation matrix from the phone's axes to the world's (east, north, up): the arithmetic of
   * `SensorManager.getRotationMatrixFromVector`.
   */
  fun rotationMatrix(x: Double, y: Double, z: Double, w: Double?): DoubleArray {
    val q0 = w ?: sqrt((1.0 - x * x - y * y - z * z).coerceAtLeast(0.0))
    val sqX = 2 * x * x
    val sqY = 2 * y * y
    val sqZ = 2 * z * z
    val xy = 2 * x * y
    val zw = 2 * z * q0
    val xz = 2 * x * z
    val yw = 2 * y * q0
    val yz = 2 * y * z
    val xw = 2 * x * q0
    return doubleArrayOf(
      1 - sqY - sqZ, xy - zw, xz + yw,
      xy + zw, 1 - sqX - sqZ, yz - xw,
      xz - yw, yz + xw, 1 - sqX - sqY
    )
  }

  /**
   * The heading of the phone's forward direction, degrees clockwise from north in [0, 360), or null
   * when it points straight up or down. Forward is the top of the screen and out of the phone's back
   * (−Z) together: lying flat, where the top points; upright in a mount, where the back faces (the
   * road ahead); tilted between, the two agree. So a portrait phone reads as iOS's compass does,
   * with no switch of axes as the mount's tilt changes. Only a phone tipped about 45° face down
   * has no forward direction.
   *
   * [rotation] is the display's `Surface.ROTATION_*` (0-3): the top of the screen is the device's +Y
   * at 0, +X at 90 (the device turned a quarter counter-clockwise), −Y at 180 and −X at 270, the
   * remap `SensorManager.remapCoordinateSystem` makes for a compass at each rotation. A phone in
   * portrait is at 0; a landscape-natural tablet in portrait at 90 or 270.
   */
  fun heading(r: DoubleArray, rotation: Int = 0): Double? {
    // Column 0 is the device's +X in the world, column 1 its +Y, column 2 its +Z.
    val (topEast, topNorth) = when (rotation and 3) {
      1 -> r[0] to r[3]
      2 -> -r[1] to -r[4]
      3 -> -r[0] to -r[3]
      else -> r[1] to r[4]
    }
    val east = topEast - r[2]
    val north = topNorth - r[5]
    if (!east.isFinite() || !north.isFinite() || hypot(east, north) < MIN_HORIZONTAL) return null
    return norm(Math.toDegrees(atan2(east, north)))
  }

  /**
   * The status a reading is rated by: the lower of the rotation vector's (which Android always
   * delivers as high) and the magnetometer's calibration status, or the rotation vector's alone
   * before the magnetometer has reported ([magnetStatus] null).
   */
  fun status(rotationStatus: Int, magnetStatus: Int?): Int =
    if (magnetStatus == null) rotationStatus else minOf(rotationStatus, magnetStatus)

  /**
   * expo-location's accuracy scale (iOS `normalizeAccuracy`: 3 high, 2 medium, 1 low, 0 none):
   * none when [status] ([HeadingMath.status]) is unreliable (or no contact), else that status
   * (low, medium, high), lowered by its own heading-error estimate in radians when it gives one
   * (`values[4]`; negative is none): over 50° none, over 35° low, over 20° medium.
   */
  fun accuracyLevel(status: Int, estimateRad: Double?): Int {
    if (status <= SENSOR_STATUS_UNRELIABLE) return 0
    var level = status.coerceAtMost(3)
    if (estimateRad != null && estimateRad.isFinite() && estimateRad >= 0) {
      val deg = Math.toDegrees(estimateRad)
      val byEstimate = when {
        deg > 50 -> 0
        deg > 35 -> 1
        deg > 20 -> 2
        else -> 3
      }
      level = minOf(level, byEstimate)
    }
    return level
  }

  /** `SensorManager.SENSOR_STATUS_UNRELIABLE`, here so the arithmetic needs no Android class. */
  private const val SENSOR_STATUS_UNRELIABLE = 0
}
