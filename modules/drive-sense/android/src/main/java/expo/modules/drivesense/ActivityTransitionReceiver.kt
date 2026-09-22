package expo.modules.drivesense

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
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
 * Mapping (README §3): ENTER IN_VEHICLE → `{ automotive, high }`, ENTER WALKING → `{ walking, high }`,
 * EXIT → nothing. An ENTER IN_VEHICLE while armed and not capturing emits `wake`
 * (`activityTransition`) and starts the capture service, which then starts the headless JS task;
 * JS must claim that capture within 60 s or the watchdog stops it (README §6).
 */
class ActivityTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val prefs = DriveSensePrefs.init(context)
    if (intent.action != ActivityTransitions.ACTION || !ActivityTransitionResult.hasResult(intent)) return
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val anchor = ClockAnchor.now()
    val arrival = System.currentTimeMillis()

    val mapped = ArrayList<TransitionStore.Entry>()
    var vehicleEnterTs: Long? = null
    var inVehicle = false
    for (event in result.transitionEvents) {
      val ts = transitionTs(event.elapsedRealTimeNanos, anchor, arrival)
      val enter = event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
      when (event.activityType) {
        DetectedActivity.IN_VEHICLE -> {
          inVehicle = enter
          if (enter) {
            mapped.add(TransitionStore.Entry("automotive", "high", ts))
            vehicleEnterTs = ts
          }
        }
        DetectedActivity.WALKING -> if (enter) mapped.add(TransitionStore.Entry("walking", "high", ts))
      }
    }
    TransitionStore.append(context, mapped)

    val capturing = CaptureService.isCapturing
    if (!prefs.armed && !capturing) return // a stale subscription: nothing to tell JS
    for (m in mapped) EventBus.emit("activity", m.toMap())

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

/** Subscribing to and unsubscribing from the transitions feed (`arm` / `disarm` / boot re-arm). */
object ActivityTransitions {
  const val ACTION = "expo.modules.drivesense.ACTIVITY_TRANSITION"
  private const val REQUEST_CODE = 7301

  private fun request(): ActivityTransitionRequest {
    val transitions = listOf(DetectedActivity.IN_VEHICLE, DetectedActivity.WALKING).flatMap { type ->
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
