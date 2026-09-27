package expo.modules.drivesense

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

/**
 * The Activity Recognition Transitions feed — the ONE thing that runs while armed, delivered by
 * Google Play services at no app cost (README §1 "Battery"). Manifest-declared, not exported: Play
 * services reaches it through the explicit [PendingIntent] built in [ActivityTransitions].
 *
 * Mapping (README §3; DMS calib T12): ENTER IN_VEHICLE → `{ automotive, high }`, ENTER WALKING →
 * `{ walking, high }`, ENTER RUNNING → `{ running, high }`; EXIT WALKING / EXIT RUNNING → the same
 * type with `exit: true`, emitted live only (the host times a walk with it; `TransitionStore` keeps
 * the ENTERs); EXIT IN_VEHICLE → nothing. The feed is subscribed while armed and during every capture,
 * so a manual-only driver's drive can end on a walk too. An ENTER IN_VEHICLE while armed and not
 * capturing emits `wake` (`activityTransition`) and starts the capture service, which then starts the
 * headless JS task; JS must claim that capture within 60 s or the watchdog stops it (README §6).
 */
class ActivityTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val prefs = DriveSensePrefs.init(context)
    if (intent.action != ActivityTransitions.ACTION || !ActivityTransitionResult.hasResult(intent)) return
    // C12 round 1 (review-C12 m1): neither armed nor capturing, this is a stale registration (a capture that
    // ended without endCapture, or a late subscribe): remove it, and store nothing for a user who never armed.
    if (!prefs.armed && !CaptureService.isCapturing) {
      ActivityTransitions.unsubscribe(context)
      return
    }
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val anchor = ClockAnchor.now()
    val arrival = System.currentTimeMillis()

    // ENTERs go to the store and to JS; EXITs of the on-foot types to JS only; in arrival order.
    val mapped = ArrayList<TransitionStore.Entry>()
    val live = ArrayList<Map<String, Any>>()
    var vehicleEnterTs: Long? = null
    var inVehicle = false
    for (event in result.transitionEvents) {
      val ts = transitionTs(event.elapsedRealTimeNanos, anchor, arrival)
      val enter = event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
      val type = when (event.activityType) {
        DetectedActivity.IN_VEHICLE -> {
          inVehicle = enter
          if (enter) vehicleEnterTs = ts
          "automotive"
        }
        DetectedActivity.WALKING -> "walking"
        DetectedActivity.RUNNING -> "running"
        else -> null
      } ?: continue
      if (enter) {
        val entry = TransitionStore.Entry(type, "high", ts)
        mapped.add(entry)
        live.add(entry.toMap())
      } else if (type != "automotive") {
        live.add(linkedMapOf("type" to type, "confidence" to "high", "ts" to ts, "exit" to true))
      }
    }
    TransitionStore.append(context, mapped)

    val capturing = CaptureService.isCapturing
    for (m in live) EventBus.emit("activity", m)

    val wakeTs = vehicleEnterTs
    if (inVehicle && wakeTs != null && prefs.armed && !capturing) {
      EventBus.emit("wake", linkedMapOf("reason" to "activityTransition", "ts" to wakeTs))
      CaptureService.startNative(context)
    }
  }

  private fun transitionTs(elapsedNanos: Long, anchor: ClockAnchor, arrival: Long): Long {
    // The anchor is read as the transition is received, so the conversion is exact; a transition is
    // never in the future (the API delivers them late, not early).
    val t = anchor.epochMs + (elapsedNanos / 1e6 - anchor.clockMs)
    return if (t.isFinite() && t <= arrival && t > 0) Math.round(t) else arrival
  }
}

/**
 * Subscribing to and unsubscribing from the transitions feed: `arm` / `disarm` / boot re-arm, and
 * (DMS calib T12, WK-m1) every capture, best effort ([subscribeForCapture], [unsubscribeAfterCapture]).
 */
object ActivityTransitions {
  const val ACTION = "expo.modules.drivesense.ACTIVITY_TRANSITION"
  private const val REQUEST_CODE = 7301
  private const val TAG = "DriveSense"

  /**
   * The subscribed activities, each ENTER and EXIT (README §3). ON_FOOT is not among them: the
   * Transitions API supports IN_VEHICLE, ON_BICYCLE, RUNNING, STILL and WALKING only (ON_FOOT's
   * sub-activities are WALKING and RUNNING), and a request with an unsupported type fails whole —
   * the arming with it.
   */
  private val ACTIVITY_TYPES = listOf(DetectedActivity.IN_VEHICLE, DetectedActivity.WALKING, DetectedActivity.RUNNING)

  private fun request(): ActivityTransitionRequest {
    val transitions = ACTIVITY_TYPES.flatMap { type ->
      listOf(ActivityTransition.ACTIVITY_TRANSITION_ENTER, ActivityTransition.ACTIVITY_TRANSITION_EXIT).map { t ->
        ActivityTransition.Builder().setActivityType(type).setActivityTransition(t).build()
      }
    }
    return ActivityTransitionRequest(transitions)
  }

  /** Play services fills the transition result into this intent, so it must be mutable on API 31+ (rev1: I15). */
  fun pendingIntent(context: Context): PendingIntent {
    val intent = Intent(context, ActivityTransitionReceiver::class.java).setAction(ACTION)
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
    return PendingIntent.getBroadcast(context.applicationContext, REQUEST_CODE, intent, flags)
  }

  /** Subscribe. [onDone] gets null on success, else the failure (SecurityException = no permission). */
  @SuppressLint("MissingPermission")
  fun subscribe(context: Context, onDone: (Exception?) -> Unit) {
    try {
      ActivityRecognition.getClient(context.applicationContext)
        .requestActivityTransitionUpdates(request(), pendingIntent(context))
        .addOnSuccessListener { onDone(null) }
        .addOnFailureListener { e -> onDone(e) }
    } catch (e: Exception) {
      onDone(e)
    }
  }

  /**
   * A capture's subscription (DMS calib T12, WK-m1): only with motion granted and Play services
   * present, and never an error. A failure (a SecurityException, a missing service, anything thrown)
   * is logged and swallowed, so it can neither reject `startCapture` nor stop a capture. Idempotent
   * with [subscribe]: the same PendingIntent replaces the same request.
   */
  fun subscribeForCapture(context: Context) {
    try {
      if (!DriveSensePermissions.motionGranted(context) || !DriveSensePermissions.playServicesAvailable(context)) return
      subscribe(context) { e ->
        if (e != null) {
          Log.w(TAG, "activity transitions not subscribed for this capture: ${e.javaClass.simpleName}")
        } else if (!CaptureService.isCapturing) {
          // C12 round 1 (m1): the capture ended before this subscribe completed: undo it unless armed.
          unsubscribeAfterCapture(context)
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "activity transitions not subscribed for this capture: ${e.javaClass.simpleName}")
    }
  }

  /** A capture's end: the feed stays while armed, else it goes (DMS calib T12). */
  fun unsubscribeAfterCapture(context: Context) {
    try {
      if (!DriveSensePrefs.init(context).armed) unsubscribe(context)
    } catch (_: Exception) {
      // never fail a capture's end over the feed
    }
  }

  @SuppressLint("MissingPermission")
  fun unsubscribe(context: Context) {
    try {
      ActivityRecognition.getClient(context.applicationContext)
        .removeActivityTransitionUpdates(pendingIntent(context))
    } catch (_: Exception) {
      // Nothing to remove, or no permission to remove it with: either way we are unsubscribed.
    }
  }
}
