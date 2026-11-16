package expo.modules.drivesense.detect

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import expo.modules.drivesense.ActivityTransitions
import expo.modules.drivesense.CarConnectReceiver
import expo.modules.drivesense.DetectBootReceiver
import expo.modules.drivesense.GeofenceReceiver

/**
 * The drive detector's wakes on Android (the iOS `WakeSources.swift`), none of which turns GPS on:
 * - Play services' activity transitions ([ActivityTransitions]): a confident IN_VEHICLE ENTER is
 *   the wake iOS's significant-location change and visits give (Android has neither as a wake a
 *   location service may start from: ruling 2), and the transitions are the motion history too;
 * - the parked car's geofence ("roadwise.parked": 100 m, exit only, never expiring, set where the
 *   last drive with a GPS fix ended, where a watch that saw no vehicle ran out, or where a rest
 *   ended, and replaced, never accumulated): leaving it is the `region` wake. Play services delivers
 *   it through an explicit, mutable PendingIntent ([GeofenceReceiver]); it needs "Allow all the
 *   time" (Android 10+) and the phone's location on, and in the background it may arrive a couple
 *   of minutes late, so the start is traced back with the motion history;
 * - RoadWise coming to the front (the detector's `appForeground`);
 * - a paired car's Bluetooth connecting (ruling 2; iPhone has no such wake): [CarConnectReceiver]
 *   hears every Bluetooth connection (ACL_CONNECTED, a broadcast only the system sends) while it is
 *   enabled, which is only while the wakes run and a car is paired, and wakes the detector for a
 *   paired car's address alone. Android sends it only to an app with Nearby devices (Android 12+),
 *   and it may start the location service from the background;
 * - a reboot or an app update, which drop every registration: [DetectBootReceiver] (enabled only
 *   while the wakes run) sets them again; a force stop, which cancels RoadWise's PendingIntents (and
 *   so Play services' registrations): the next launch or foreground finds them gone and sets them
 *   again ([WakeFile]).
 * Every call runs on the detector's thread; Play services answers on the main thread, and nothing
 * here waits for it. [onParked] hears (on the main thread) whether the parked geofence is on file as
 * asked: false when Play services refused it (location off, no background location), so the
 * detector sets it again later.
 */
class WakeSources(context: Context, private val onParked: (onFile: Boolean) -> Unit = {}) {
  companion object {
    const val GEOFENCE_ID = "roadwise.parked"
    private const val REQUEST_CODE = 7307
    private const val TAG = "DriveSense"

    /** A last known fix this old or newer, and this accurate, may place the parked spot at a rest's end. */
    const val LAST_KNOWN_MAX_AGE_MS = 120_000L
    const val LAST_KNOWN_MAX_ACC_M = 100f

    /** Play services fills the geofence event into this intent, so it must be mutable on API 31+ (and explicit). */
    fun geofenceIntent(context: Context): PendingIntent = broadcast(context, PendingIntent.FLAG_UPDATE_CURRENT)!!

    /** The geofence's PendingIntent, if the system still holds it (never made here: FLAG_NO_CREATE, the same intent and mutability). */
    fun geofenceIntentAlive(context: Context): Boolean = try {
      broadcast(context, PendingIntent.FLAG_NO_CREATE) != null
    } catch (_: Exception) {
      true
    }

    private fun broadcast(context: Context, base: Int): PendingIntent? {
      val intent = Intent(context, GeofenceReceiver::class.java).setAction(GeofenceReceiver.ACTION)
      var flags = base
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
      return PendingIntent.getBroadcast(context.applicationContext, REQUEST_CODE, intent, flags)
    }
  }

  private val app = context.applicationContext

  /**
   * The wakes on ([run]) or off: the transitions feed, the boot receiver and, when off, the parked
   * geofence. [force]: ask Play services again even for a request on file from this boot.
   */
  fun sync(run: Boolean, force: Boolean = false, onDone: () -> Unit = {}) {
    setBootReceiver(run)
    if (!run) removeGeofence()
    ActivityTransitions.sync(app, run, force, onDone)
  }

  /** Whether Play services can still hold the parked geofence (its PendingIntent survives; [WakeFile]). */
  fun parkedOnFile(): Boolean = geofenceIntentAlive(app)

  /** The parked geofence at [place] (null: none), replacing any other (a geofence with the same id is replaced). */
  @SuppressLint("MissingPermission")
  fun setParked(place: GeoPoint?) {
    val p = place
    if (p == null) {
      removeGeofence()
      onParked(true)
      return
    }
    try {
      val fence = Geofence.Builder()
        .setRequestId(GEOFENCE_ID)
        .setCircularRegion(p.lat, p.lng, DetectPolicy.PARKED_REGION_RADIUS_M.toFloat())
        .setExpirationDuration(Geofence.NEVER_EXPIRE)
        .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_EXIT)
        .build()
      // No initial trigger: placed where the phone is (or was), only leaving it later is a wake.
      val request = GeofencingRequest.Builder().setInitialTrigger(0).addGeofence(fence).build()
      LocationServices.getGeofencingClient(app)
        .addGeofences(request, geofenceIntent(app))
        .addOnSuccessListener { onParked(true) }
        .addOnFailureListener { e ->
          Log.w(TAG, "parked geofence not set: ${e.javaClass.simpleName}")
          onParked(false)
        }
    } catch (e: Exception) {
      // No background location, location off (GEOFENCE_NOT_AVAILABLE) or no Play services: the
      // transitions remain the wake; the next launch or foreground tries again.
      Log.w(TAG, "parked geofence not set: ${e.javaClass.simpleName}")
      onParked(false)
    }
  }

  private fun removeGeofence() {
    try {
      LocationServices.getGeofencingClient(app).removeGeofences(listOf(GEOFENCE_ID))
    } catch (_: Exception) {
      // none set
    }
  }

  /**
   * The phone's last known fix, if it is fresh and accurate enough to park on (a rest's end: no
   * GPS turned on for it; Play services' cached fix only). [done] on the main thread with null when
   * there is none.
   */
  @SuppressLint("MissingPermission")
  fun lastKnown(done: (LatLng?) -> Unit) {
    try {
      LocationServices.getFusedLocationProviderClient(app).lastLocation
        .addOnSuccessListener { l: Location? -> done(l?.takeIf { usable(it) }?.let { LatLng(it.latitude, it.longitude) }) }
        .addOnFailureListener { done(null) }
    } catch (_: Exception) {
      done(null)
    }
  }

  private fun usable(l: Location): Boolean {
    val ageMs = (SystemClock.elapsedRealtimeNanos() - l.elapsedRealtimeNanos) / 1_000_000L
    return ageMs in 0..LAST_KNOWN_MAX_AGE_MS && l.hasAccuracy() && l.accuracy <= LAST_KNOWN_MAX_ACC_M
  }

  /** The boot receiver hears a reboot or an update only while the wakes run (DONT_KILL_APP). */
  private fun setBootReceiver(on: Boolean) = setReceiver(DetectBootReceiver::class.java, on)

  /** The car's wake ([CarConnectReceiver]) hears Bluetooth connections only while the wakes run with a car paired. */
  fun setCarWake(on: Boolean) = setReceiver(CarConnectReceiver::class.java, on)

  private fun setReceiver(receiver: Class<*>, on: Boolean) {
    try {
      val component = ComponentName(app, receiver)
      val want = if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
      if (app.packageManager.getComponentEnabledSetting(component) != want) {
        app.packageManager.setComponentEnabledSetting(component, want, PackageManager.DONT_KILL_APP)
      }
    } catch (_: Exception) {
      // the receiver stays as it was
    }
  }
}
