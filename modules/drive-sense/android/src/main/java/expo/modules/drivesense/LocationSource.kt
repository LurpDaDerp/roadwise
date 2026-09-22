package expo.modules.drivesense

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.os.Build
import android.os.Looper
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * GNSS while capturing, and only then (design §3.5): `full` = 1 s `PRIORITY_HIGH_ACCURACY`; `low`
 * (rev1: I5) = 10 s `PRIORITY_BALANCED_POWER_ACCURACY`. Each fix becomes a [FixSample] timed by
 * `getElapsedRealtimeNanos()` through the capture's [ClockAnchor] (not `getTime()`), with every
 * platform unknown encoded as the reference expects (README §4): a `has…()` check before every
 * read, because the getters return 0.0, not −1, for an unknown.
 */
class LocationSource(
  context: Context,
  private val looper: Looper,
  private val anchor: () -> ClockAnchor,
  private val onFix: (FixSample) -> Unit
) {
  companion object {
    const val FULL_INTERVAL_MS = 1_000L
    const val LOW_INTERVAL_MS = 10_000L
  }

  private val appContext = context.applicationContext
  private val client: FusedLocationProviderClient = LocationServices.getFusedLocationProviderClient(appContext)
  private var active = false
  private var lastAlt = 0.0

  /** Timestamps that fell back to their arrival time since the last read (README §7). */
  private var fallbacks = 0

  fun takeFallbacks(): Int = fallbacks.also { fallbacks = 0 }

  private val callback = object : LocationCallback() {
    override fun onLocationResult(result: LocationResult) {
      val a = anchor()
      // Arrival on the capture's anchored boot clock, not the wall clock (README §7, review N2N3 I2).
      val arrival = TimeBase.anchoredNow(a)
      for (location in result.locations) onFix(toFix(location, a, arrival))
    }
  }

  /** Start (or switch to) [rate]. @return false when location is not permitted or unavailable. */
  @SuppressLint("MissingPermission")
  fun start(rate: String): Boolean {
    stop()
    if (!DriveSensePermissions.hasForegroundLocation(appContext)) return false
    val request = if (rate == "low") {
      LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, LOW_INTERVAL_MS)
        .setMinUpdateIntervalMillis(LOW_INTERVAL_MS)
        .build()
    } else {
      LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, FULL_INTERVAL_MS)
        .setMinUpdateIntervalMillis(FULL_INTERVAL_MS)
        .setWaitForAccurateLocation(false)
        .build()
    }
    return try {
      client.requestLocationUpdates(request, callback, looper)
      active = true
      true
    } catch (_: SecurityException) {
      false
    } catch (_: Exception) {
      false
    }
  }

  fun stop() {
    if (!active) return
    active = false
    try {
      client.removeLocationUpdates(callback)
    } catch (_: Exception) {
      // already removed
    }
  }

  private fun toFix(l: Location, a: ClockAnchor, arrival: Double): FixSample {
    val t = TimeBase.toEpochMs(l.elapsedRealtimeNanos / 1e6, a, arrival)
    if (t.fellBack) fallbacks++
    val speedAcc =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && l.hasSpeedAccuracy()) {
        l.speedAccuracyMetersPerSecond.toDouble()
      } else {
        UNKNOWN.toDouble()
      }
    val alt = if (l.hasAltitude()) l.altitude else lastAlt
    lastAlt = alt
    return FixSample(
      t = t.t,
      lat = l.latitude,
      lng = l.longitude,
      hAcc = if (l.hasAccuracy()) l.accuracy.toDouble() else -1.0,
      speed = if (l.hasSpeed()) l.speed.toDouble() else UNKNOWN.toDouble(),
      speedAcc = speedAcc,
      course = if (l.hasBearing()) l.bearing.toDouble() else UNKNOWN.toDouble(),
      alt = alt
    )
  }
}
