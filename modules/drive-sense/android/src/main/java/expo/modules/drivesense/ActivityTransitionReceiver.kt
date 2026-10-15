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
 * The Activity Recognition Transitions feed, delivered by Google Play services at no app cost.
 * Manifest-declared, not exported: Play services reaches it through the explicit [PendingIntent]
 * built in [ActivityTransitions].
 *
 * It never starts a capture (plan §1 decision 4). It is subscribed only during a capture, so a walk
 * can end the drive: mapped `activity` events to JS. A transition that arrives with no capture
 * running is a leftover registration and is removed.
 *
 * Mapping (README §3): ENTER IN_VEHICLE → `{ automotive, high }`, ENTER WALKING → `{ walking, high }`,
 * ENTER RUNNING → `{ running, high }`; EXIT WALKING / EXIT RUNNING → the same type with `exit: true`;
 * EXIT IN_VEHICLE → nothing to JS.
 */
class ActivityTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    DriveSensePrefs.init(context)
    if (intent.action != ActivityTransitions.ACTION || !ActivityTransitionResult.hasResult(intent)) return
    // C12 round 1 (review-C12 m1): not capturing, this is a stale registration (a capture that ended
    // without endCapture, a late subscribe, or one an older build left behind): remove it, emit nothing.
    if (!CaptureService.isCapturing) {
      ActivityTransitions.unsubscribe(context)
      return
    }
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val anchor = ClockAnchor.now()
    val arrival = System.currentTimeMillis()

    // ENTERs, and the EXITs of the on-foot types, to JS in arrival order.
    for (event in result.transitionEvents) {
      val ts = transitionTs(event.elapsedRealTimeNanos, anchor, arrival)
      val enter = event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
      val type = when (event.activityType) {
        DetectedActivity.IN_VEHICLE -> "automotive"
        DetectedActivity.WALKING -> "walking"
        DetectedActivity.RUNNING -> "running"
        else -> null
      } ?: continue
      if (enter) {
        EventBus.emit("activity", linkedMapOf("type" to type, "confidence" to "high", "ts" to ts))
      } else if (type != "automotive") {
        EventBus.emit("activity", linkedMapOf("type" to type, "confidence" to "high", "ts" to ts, "exit" to true))
      }
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
 * Subscribing to and unsubscribing from the transitions feed. [sync] is the one rule: subscribed
 * while capturing with motion granted and Play services present; removed otherwise. Every entry
 * point calls it (the module's launch, a capture's begin and end, a motion grant), so no
 * registration outlives its capture.
 */
object ActivityTransitions {
  const val ACTION = "expo.modules.drivesense.ACTIVITY_TRANSITION"
  private const val REQUEST_CODE = 7301
  private const val TAG = "DriveSense"

  /**
   * The subscribed activities, each ENTER and EXIT (README §3). ON_FOOT is not among them: the
   * Transitions API supports IN_VEHICLE, ON_BICYCLE, RUNNING, STILL and WALKING only (ON_FOOT's
   * sub-activities are WALKING and RUNNING), and a request with an unsupported type fails whole.
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

  /** Whether the feed should be subscribed now. */
  fun wanted(context: Context): Boolean =
    CaptureService.isCapturing && DriveSensePermissions.motionGranted(context) && DriveSensePermissions.playServicesAvailable(context)

  /**
   * Subscribe or unsubscribe to match [wanted], best effort and never an error: a failure (a
   * SecurityException, a missing service, anything thrown) is logged and swallowed, so it can neither
   * reject `startCapture` nor stop a capture. Idempotent: the same PendingIntent replaces the same request.
   */
  fun sync(context: Context) {
    try {
      if (wanted(context)) {
        subscribe(context) { e ->
          if (e != null) {
            Log.w(TAG, "activity transitions not subscribed: ${e.javaClass.simpleName}")
          } else if (!wanted(context)) {
            // The reason ended before this subscribe completed: undo it.
            unsubscribe(context)
          }
        }
      } else {
        unsubscribe(context)
      }
    } catch (e: Exception) {
      Log.w(TAG, "activity transitions not synced: ${e.javaClass.simpleName}")
    }
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
      ActivityRecognition.getClient(context.applicationContext)
        .removeActivityTransitionUpdates(pendingIntent(context))
    } catch (_: Exception) {
      // Nothing to remove, or no permission to remove it with: either way we are unsubscribed.
    }
  }
}
