package expo.modules.drivesense

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import expo.modules.drivesense.detect.DriveDetector
import expo.modules.drivesense.detect.onActivity
import expo.modules.drivesense.detect.onTransitions
import expo.modules.drivesense.detect.LiveActivity
import expo.modules.drivesense.detect.TimedTransition

/**
 * Play services' two activity feeds, delivered at no app cost through explicit, mutable
 * PendingIntents (Play services fills the result in). Manifest-declared, not exported.
 *
 * - The transitions ([ActivityTransitions]), while automatic drives are armed: the drive detector's
 *   motion history, its wake (a confident IN_VEHICLE ENTER; this broadcast lets RoadWise start its
 *   location service from the background, Android 12+), and the "Not driving?" rest's ends. Each
 *   batch goes to the detector with the time each transition happened, under goAsync until the
 *   detector has acted (a watch's service started, or nothing). A batch that arrives when nothing
 *   wants the feed is a leftover registration (an older build's, a disarm that raced it): it is
 *   removed and nothing is done.
 * - The live reports ([ActivitySource]), while RoadWise senses (a watch, a drive): every report to
 *   the detector, and to JS as `activity` (only a change in type or confidence) while a drive or a
 *   plain capture records; never during a watch.
 *
 * Transition mapping (README §3): IN_VEHICLE → `automotive`, WALKING → `walking`, RUNNING →
 * `running`, STILL → `stationary`, ON_BICYCLE → `cycling`.
 */
class ActivityTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    DriveSensePrefs.init(context)
    when (intent.action) {
      ActivityTransitions.ACTION -> onTransitions(context, intent)
      ActivitySource.ACTION -> {
        if (!ActivityRecognitionResult.hasResult(intent)) return
        val result = ActivityRecognitionResult.extractResult(intent) ?: return
        ActivitySource.onResult(context, result)
      }
    }
  }

  private fun onTransitions(context: Context, intent: Intent) {
    if (!ActivityTransitionResult.hasResult(intent)) return
    // Nothing wants the feed (disarmed, or a registration an older build left behind): remove it, act on nothing.
    if (!ActivityTransitions.wanted(context)) {
      ActivityTransitions.unsubscribe(context)
      return
    }
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val anchor = ClockAnchor.now()
    val arrival = System.currentTimeMillis()
    val batch = result.transitionEvents.mapNotNull { e ->
      val type = typeOf(e.activityType) ?: return@mapNotNull null
      TimedTransition(type, e.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER, ActivityTransitions.epochMs(e.elapsedRealTimeNanos, anchor, arrival).toDouble())
    }
    if (batch.isEmpty()) return
    // The request's stamp: whatever the request replayed happened before it.
    val subscribedNanos = DriveSensePrefs.init(context).transitionsAtNanos
    val subscribedAt = if (subscribedNanos > 0L) ActivityTransitions.epochMs(subscribedNanos, anchor, arrival).toDouble() else 0.0
    val pending = goAsync()
    try {
      DriveDetector.get(context).onTransitions(batch, arrival.toDouble(), subscribedAt) { pending.finish() }
    } catch (e: Exception) {
      Log.w("DriveSense", "transitions not handled: ${e.javaClass.simpleName}")
      pending.finish()
    }
  }

  private fun typeOf(activity: Int): String? = when (activity) {
    DetectedActivity.IN_VEHICLE -> "automotive"
    DetectedActivity.WALKING -> "walking"
    DetectedActivity.RUNNING -> "running"
    DetectedActivity.STILL -> "stationary"
    DetectedActivity.ON_BICYCLE -> "cycling"
    else -> null
  }
}

/**
 * The activity transitions feed: one rule, [sync], which the drive detector calls with whether its
 * wakes run (armed for an owner with its permissions, not off). Subscribed then (with Physical
 * activity and Play services), removed otherwise, so no registration outlives its reason. The
 * detector's set ([DETECT]): IN_VEHICLE in and out, and the ENTERs of WALKING, RUNNING, ON_BICYCLE
 * and STILL, all a motion history needs; ON_FOOT is never asked for (the Transitions API supports
 * IN_VEHICLE, ON_BICYCLE, RUNNING, STILL and WALKING only, and a request with another type fails
 * whole). Free while idle: Play services classifies activity whatever the app does.
 *
 * One PendingIntent: each request replaces the last. The request on file ([DriveSensePrefs]) skips
 * an identical re-request from this boot (each request replays the current activity) while the
 * system still holds its PendingIntent ([registered]: a force stop, an OEM cleaner or Task Manager's
 * Stop cancels it, and Play services then drops the registration, so the next sync asks again);
 * `force` re-requests anyway (a reboot or an update, which drop registrations).
 */
object ActivityTransitions {
  const val ACTION = "expo.modules.drivesense.ACTIVITY_TRANSITION"
  private const val REQUEST_CODE = 7301
  private const val TAG = "DriveSense"
  /** The name of the detector's set on file (an older build's names never match it). */
  private const val SET = "DETECT"
  private val ENTER = ActivityTransition.ACTIVITY_TRANSITION_ENTER
  private val EXIT = ActivityTransition.ACTIVITY_TRANSITION_EXIT

  /** What the detector asks for, as (activity, transition). STILL and the on-foot types with ENTER only. */
  val DETECT: List<Pair<Int, Int>> = listOf(
    DetectedActivity.IN_VEHICLE to ENTER,
    DetectedActivity.IN_VEHICLE to EXIT,
    DetectedActivity.WALKING to ENTER,
    DetectedActivity.RUNNING to ENTER,
    DetectedActivity.ON_BICYCLE to ENTER,
    DetectedActivity.STILL to ENTER
  )

  private fun request(): ActivityTransitionRequest =
    ActivityTransitionRequest(
      DETECT.map { (type, transition) ->
        ActivityTransition.Builder().setActivityType(type).setActivityTransition(transition).build()
      }
    )

  /** Play services fills the transition result into this intent, so it must be mutable on API 31+ (and explicit). */
  fun pendingIntent(context: Context): PendingIntent = broadcast(context, PendingIntent.FLAG_UPDATE_CURRENT)!!

  /** The feed's PendingIntent, if the system still holds it (never made here: FLAG_NO_CREATE, the same intent and mutability). */
  fun registered(context: Context): Boolean = try {
    broadcast(context, PendingIntent.FLAG_NO_CREATE) != null
  } catch (_: Exception) {
    true
  }

  private fun broadcast(context: Context, base: Int): PendingIntent? {
    val intent = Intent(context, ActivityTransitionReceiver::class.java).setAction(ACTION)
    var flags = base
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
    return PendingIntent.getBroadcast(context.applicationContext, REQUEST_CODE, intent, flags)
  }

  /** The detector wants the feed now (written by [sync]). */
  fun wanted(context: Context): Boolean = DriveSensePrefs.init(context).transitionsWanted

  /** A boot-clock time (ns) as epoch ms through [anchor], never after [arrival]: the API delivers late, never early. */
  fun epochMs(elapsedNanos: Long, anchor: ClockAnchor, arrival: Long): Long {
    val t = anchor.epochMs + (elapsedNanos / 1e6 - anchor.clockMs)
    return if (t.isFinite() && t <= arrival && t > 0) Math.round(t) else arrival
  }

  /**
   * Subscribe or unsubscribe to match [want], best effort and never an error: a failure (a
   * SecurityException, a missing service, anything thrown) is logged and swallowed. [onDone] runs
   * exactly once, when the request has settled.
   */
  fun sync(context: Context, want: Boolean, force: Boolean = false, onDone: () -> Unit = {}) {
    var finished = false
    val done: () -> Unit = {
      if (!finished) {
        finished = true
        onDone()
      }
    }
    try {
      val prefs = DriveSensePrefs.init(context)
      val ok = want && DriveSensePermissions.motionGranted(context) && DriveSensePermissions.playServicesAvailable(context)
      prefs.transitionsWanted = ok
      if (!ok) {
        if (prefs.transitionsTier != null) unsubscribe(context)
        done()
        return
      }
      if (force) prefs.transitionsTier = null
      val nowNanos = SystemClock.elapsedRealtimeNanos()
      val boot = bootCount(context)
      // The same request is on file, from this boot (a reboot drops every registration) and its
      // PendingIntent still held (a force stop cancels it): nothing to do. The boot count says which
      // boot; where the phone does not give it, a stamp ahead of the boot clock (which restarts at a
      // reboot) is the only sign.
      val thisBoot = prefs.transitionsAtNanos in 1L..nowNanos && (boot < 0 || prefs.transitionsBoot == boot)
      if (prefs.transitionsTier == SET && thisBoot && registered(context)) {
        done()
        return
      }
      // Stamped before the request: whatever the request replays happened before this, and the
      // detector never wakes on a replayed transition much older than it.
      prefs.transitionsTier = null
      prefs.transitionsAtNanos = nowNanos
      prefs.transitionsBoot = boot
      subscribe(context) { e ->
        if (e != null) {
          Log.w(TAG, "activity transitions not subscribed: ${e.javaClass.simpleName}")
        } else if (prefs.transitionsWanted) {
          prefs.transitionsTier = SET
        } else {
          // Disarmed while the request was in flight: follow it.
          unsubscribe(context)
        }
        done()
      }
    } catch (e: Exception) {
      Log.w(TAG, "activity transitions not synced: ${e.javaClass.simpleName}")
      done()
    }
  }

  /** This boot's number, or -1 where the phone does not say. */
  private fun bootCount(context: Context): Int = try {
    Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
  } catch (_: Exception) {
    -1
  }

  /** [onDone] gets null on success, else the failure (SecurityException = no permission). */
  @SuppressLint("MissingPermission")
  private fun subscribe(context: Context, onDone: (Exception?) -> Unit) {
    try {
      ActivityRecognition.getClient(context.applicationContext)
        .requestActivityTransitionUpdates(request(), pendingIntent(context))
        .addOnSuccessListener { onDone(null) }
        .addOnFailureListener { e -> onDone(e) }
    } catch (e: Exception) {
      onDone(e)
    }
  }

  @SuppressLint("MissingPermission")
  fun unsubscribe(context: Context) {
    try {
      val prefs = DriveSensePrefs.init(context)
      prefs.transitionsTier = null
      prefs.transitionsAtNanos = 0L
      prefs.transitionsBoot = -1
      ActivityRecognition.getClient(context.applicationContext)
        .removeActivityTransitionUpdates(pendingIntent(context))
    } catch (_: Exception) {
      // Nothing to remove, or no permission to remove it with: either way we are unsubscribed.
    }
  }
}

/**
 * The live activity reports (the iOS `ActivitySource` live updates): Play services' activity
 * recognition every [INTERVAL_MS] while RoadWise senses (a watch, a drive, a plain capture; the
 * capture service starts and stops it with its sensors), never while idle or resting. Every report
 * goes to the drive detector (the walking end, the on-foot veto, car motion, the slow-traffic start,
 * the fix-less hold) before the duplicate filter that keeps the JS feed quiet; JS hears it
 * ([LiveActivity] mapping) only while a drive or a plain capture records, never during a watch.
 */
object ActivitySource {
  const val ACTION = "expo.modules.drivesense.ACTIVITY_UPDATE"
  const val INTERVAL_MS = 5_000L
  private const val REQUEST_CODE = 7305

  /** The last report JS heard (type and confidence), for the duplicate filter; reset at each start. */
  @Volatile
  private var lastEmitted: LiveActivity.Report? = null

  @Volatile
  private var live = false

  private fun pendingIntent(context: Context): PendingIntent {
    val intent = Intent(context, ActivityTransitionReceiver::class.java).setAction(ACTION)
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
    return PendingIntent.getBroadcast(context.applicationContext, REQUEST_CODE, intent, flags)
  }

  /** Best effort: no Physical activity or no Play services leaves the feed off, and sensing runs on. */
  @SuppressLint("MissingPermission")
  fun start(context: Context) {
    lastEmitted = null
    live = true
    if (!DriveSensePermissions.motionGranted(context) || !DriveSensePermissions.playServicesAvailable(context)) return
    try {
      ActivityRecognition.getClient(context.applicationContext).requestActivityUpdates(INTERVAL_MS, pendingIntent(context))
    } catch (e: Exception) {
      Log.w("DriveSense", "activity updates not requested: ${e.javaClass.simpleName}")
    }
  }

  @SuppressLint("MissingPermission")
  fun stop(context: Context) {
    live = false
    try {
      ActivityRecognition.getClient(context.applicationContext).removeActivityUpdates(pendingIntent(context))
    } catch (_: Exception) {
      // Nothing to remove.
    }
  }

  /** One report (the receiver, main thread). A late one after the sensing stopped is dropped, and its registration removed. */
  fun onResult(context: Context, result: ActivityRecognitionResult) {
    if (!live || !CaptureService.isCapturing) {
      stop(context)
      return
    }
    val report = LiveActivity.of(result.probableActivities.map { LiveActivity.Rated(it.type, it.confidence) }) ?: return
    val anchor = ClockAnchor.now()
    val arrival = System.currentTimeMillis()
    DriveDetector.peek()?.onActivity(report.motion(arrival.toDouble()))
    if (CaptureService.watching) return
    if (lastEmitted == report) return
    lastEmitted = report
    val ts = ActivityTransitions.epochMs(result.elapsedRealtimeMillis * 1_000_000L, anchor, arrival)
    EventBus.emit("activity", linkedMapOf("type" to report.type, "confidence" to report.confidence, "ts" to ts))
  }
}
