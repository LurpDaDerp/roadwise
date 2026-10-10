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
 * v3: it never starts a capture (plan §1 decision 4). It is subscribed for exactly two reasons:
 * - during a capture, so a walk can end the drive — mapped `activity` events;
 * - while the forgot-to-start reminder is on ([ForgotToStartReminder]) — an IN_VEHICLE period with
 *   no capture posts a quiet notification after its EXIT, never while in the vehicle.
 *
 * Mapping (README §3): ENTER IN_VEHICLE → `{ automotive, high }`, ENTER WALKING → `{ walking, high }`,
 * ENTER RUNNING → `{ running, high }`; EXIT WALKING / EXIT RUNNING → the same type with `exit: true`,
 * emitted live only (`TransitionStore` keeps the ENTERs); EXIT IN_VEHICLE → nothing to JS.
 */
class ActivityTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val prefs = DriveSensePrefs.init(context)
    if (intent.action != ActivityTransitions.ACTION || !ActivityTransitionResult.hasResult(intent)) return
    // C12 round 1 (review-C12 m1): neither capturing nor reminding, this is a stale registration (a capture that
    // ended without endCapture, or a late subscribe): remove it and store nothing.
    if (!prefs.reminderEnabled && !CaptureService.isCapturing) {
      ActivityTransitions.unsubscribe(context)
      return
    }
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val anchor = ClockAnchor.now()
    val arrival = System.currentTimeMillis()

    // ENTERs go to the store and to JS; EXITs of the on-foot types to JS only; in arrival order.
    val mapped = ArrayList<TransitionStore.Entry>()
    val live = ArrayList<Map<String, Any>>()
    for (event in result.transitionEvents) {
      val ts = transitionTs(event.elapsedRealTimeNanos, anchor, arrival)
      val enter = event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
      val type = when (event.activityType) {
        DetectedActivity.IN_VEHICLE -> "automotive"
        DetectedActivity.WALKING -> "walking"
        DetectedActivity.RUNNING -> "running"
        else -> null
      } ?: continue
      if (type == "automotive") {
        if (enter) ForgotToStartReminder.onVehicleEnter(context, ts) else ForgotToStartReminder.onVehicleExit(context, ts)
      }
      if (enter) {
        val entry = TransitionStore.Entry(type, "high", ts)
        mapped.add(entry)
        live.add(entry.toMap())
      } else if (type != "automotive") {
        live.add(linkedMapOf("type" to type, "confidence" to "high", "ts" to ts, "exit" to true))
      }
    }
    TransitionStore.append(context, mapped)

    // Live events reach JS only while a capture runs: the reminder alone keeps nothing awake in JS.
    if (CaptureService.isCapturing) for (m in live) EventBus.emit("activity", m)
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
 * while (motion granted and Play services present) and (capturing or the reminder is on); removed
 * otherwise. Every entry point calls it (the module's launch, a capture's begin and end, the
 * setting's change), so no registration outlives its reason.
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
    (CaptureService.isCapturing || DriveSensePrefs.init(context).reminderEnabled) &&
      DriveSensePermissions.motionGranted(context) && DriveSensePermissions.playServicesAvailable(context)

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
