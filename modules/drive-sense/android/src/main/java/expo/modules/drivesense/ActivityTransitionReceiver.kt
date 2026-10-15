package expo.modules.drivesense

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionEvent
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

/**
 * The Activity Recognition Transitions feed, delivered by Google Play services at no app cost.
 * Manifest-declared, not exported: Play services reaches it through the explicit [PendingIntent]
 * built in [ActivityTransitions].
 *
 * It never starts a capture (plan §1 decision 4). It serves two readers:
 * - during a capture, the walking auto-end: mapped `activity` events to JS;
 * - with no drive open, the optional forgot-to-start reminder ([TripReminder]), which reads the
 *   batch natively and at most posts one notification. Nothing reaches JS then.
 * A transition that arrives when neither wants the feed is a leftover registration and is removed.
 *
 * Capture mapping (README §3): ENTER IN_VEHICLE → `{ automotive, high }`, ENTER WALKING →
 * `{ walking, high }`, ENTER RUNNING → `{ running, high }`; EXIT WALKING / EXIT RUNNING → the same
 * type with `exit: true`; EXIT IN_VEHICLE → nothing to JS.
 */
class ActivityTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    DriveSensePrefs.init(context)
    if (intent.action != ActivityTransitions.ACTION || !ActivityTransitionResult.hasResult(intent)) return
    // C12 round 1 (review-C12 m1): nothing wants the feed (a capture that ended without endCapture,
    // the reminder switched off, a late subscribe, or one an older build left behind): remove it,
    // act on nothing.
    if (ActivityTransitions.tier(context) == TripReminderPolicy.Tier.NONE) {
      ActivityTransitions.unsubscribe(context)
      return
    }
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val anchor = ClockAnchor.now()
    val arrival = System.currentTimeMillis()

    if (CaptureService.isCapturing) {
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
      return
    }

    // No drive open: the forgot-to-start reminder reads the whole batch, then the feed is re-synced
    // (a trip opening or closing changes what is asked for).
    val subscribedNanos = DriveSensePrefs.init(context).transitionsAtNanos
    val subscribedAt = if (subscribedNanos > 0L) transitionTs(subscribedNanos, anchor, arrival) else 0L
    val batch = result.transitionEvents.mapNotNull { e ->
      reminderKind(e)?.let { Transition(it, transitionTs(e.elapsedRealTimeNanos, anchor, arrival)) }
    }
    val pending = goAsync()
    try {
      TripReminder.onTransitions(context, batch, arrival, subscribedAt)
    } catch (e: Exception) {
      Log.w("DriveSense", "reminder batch not handled: ${e.javaClass.simpleName}")
    }
    ActivityTransitions.sync(context) { pending.finish() }
  }

  /** The transitions the reminder reads: IN_VEHICLE in and out, and the ENTERs of STILL, WALKING and RUNNING. */
  private fun reminderKind(e: ActivityTransitionEvent): TransitionKind? {
    val enter = e.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
    return when (e.activityType) {
      DetectedActivity.IN_VEHICLE -> if (enter) TransitionKind.VEHICLE_ENTER else TransitionKind.VEHICLE_EXIT
      DetectedActivity.STILL -> if (enter) TransitionKind.STILL_ENTER else null
      DetectedActivity.WALKING -> if (enter) TransitionKind.WALKING_ENTER else null
      DetectedActivity.RUNNING -> if (enter) TransitionKind.RUNNING_ENTER else null
      else -> null
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
 * Subscribing to and unsubscribing from the transitions feed. [sync] is the one rule: the request
 * matches [tier] — the capture's walking set while capturing, the reminder's sets while it is on
 * with no drive open, nothing otherwise — with motion granted and Play services present. Every entry
 * point calls it (the module's launch, a capture's begin and end, a motion grant, the reminder's
 * switch and each of its batches, the boot receiver), so no registration outlives its reason.
 *
 * One PendingIntent: each request replaces the last. The tier on file ([DriveSensePrefs]) skips an
 * identical re-request (each request replays the current activity); [sync] with `force` re-requests
 * anyway, for the launch and the boot, when the system may have dropped the registration.
 */
object ActivityTransitions {
  const val ACTION = "expo.modules.drivesense.ACTIVITY_TRANSITION"
  private const val REQUEST_CODE = 7301
  private const val TAG = "DriveSense"
  private val ENTER = ActivityTransition.ACTIVITY_TRANSITION_ENTER
  private val EXIT = ActivityTransition.ACTIVITY_TRANSITION_EXIT

  /**
   * The capture's activities, each ENTER and EXIT (README §3). ON_FOOT is never requested: the
   * Transitions API supports IN_VEHICLE, ON_BICYCLE, RUNNING, STILL and WALKING only (ON_FOOT's
   * sub-activities are WALKING and RUNNING), and a request with an unsupported type fails whole.
   */
  private val CAPTURE_TYPES = listOf(DetectedActivity.IN_VEHICLE, DetectedActivity.WALKING, DetectedActivity.RUNNING)

  /**
   * What each tier asks for, as (activity, transition). The reminder's idle set wakes the app only
   * when a car trip starts; its trip set adds the stop (STILL ENTER), the car leaving (IN_VEHICLE
   * EXIT) and the driver walking off. STILL is only ever asked for with ENTER.
   */
  fun transitions(tier: TripReminderPolicy.Tier): List<Pair<Int, Int>> = when (tier) {
    TripReminderPolicy.Tier.NONE -> emptyList()
    TripReminderPolicy.Tier.CAPTURE -> CAPTURE_TYPES.flatMap { type -> listOf(type to ENTER, type to EXIT) }
    TripReminderPolicy.Tier.IDLE -> listOf(DetectedActivity.IN_VEHICLE to ENTER)
    TripReminderPolicy.Tier.TRIP -> listOf(
      DetectedActivity.IN_VEHICLE to ENTER,
      DetectedActivity.IN_VEHICLE to EXIT,
      DetectedActivity.STILL to ENTER,
      DetectedActivity.WALKING to ENTER,
      DetectedActivity.RUNNING to ENTER
    )
  }

  private fun request(tier: TripReminderPolicy.Tier): ActivityTransitionRequest =
    ActivityTransitionRequest(
      transitions(tier).map { (type, transition) ->
        ActivityTransition.Builder().setActivityType(type).setActivityTransition(transition).build()
      }
    )

  /** Play services fills the transition result into this intent, so it must be mutable on API 31+ (rev1: I15). */
  fun pendingIntent(context: Context): PendingIntent {
    val intent = Intent(context, ActivityTransitionReceiver::class.java).setAction(ACTION)
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
    return PendingIntent.getBroadcast(context.applicationContext, REQUEST_CODE, intent, flags)
  }

  /** What the feed should be now. */
  fun tier(context: Context): TripReminderPolicy.Tier =
    TripReminderPolicy.tier(TripReminder.state(context), CaptureService.isCapturing, TripReminder.transitionsOk(context))

  /**
   * Subscribe, re-subscribe or unsubscribe to match [tier], best effort and never an error: a
   * failure (a SecurityException, a missing service, anything thrown) is logged and swallowed, so it
   * can neither reject `startCapture` nor stop a capture. [onDone] runs exactly once, when the
   * request has settled (a receiver's goAsync waits on it).
   */
  fun sync(context: Context, force: Boolean = false, onDone: () -> Unit = {}) {
    var finished = false
    val done: () -> Unit = {
      if (!finished) {
        finished = true
        onDone()
      }
    }
    try {
      val prefs = DriveSensePrefs.init(context)
      if (force) prefs.transitionsTier = null
      val want = tier(context)
      if (want == TripReminderPolicy.Tier.NONE) {
        unsubscribe(context)
        done()
        return
      }
      val nowNanos = SystemClock.elapsedRealtimeNanos()
      // The same request is on file and still in this boot (the boot clock restarts at a reboot,
      // which drops every registration): nothing to do.
      if (prefs.transitionsTier == want.name && prefs.transitionsAtNanos in 1L..nowNanos) {
        done()
        return
      }
      // Stamped before the request: whatever the request replays happened before this and is dropped.
      prefs.transitionsTier = null
      prefs.transitionsAtNanos = nowNanos
      subscribe(context, want) { e ->
        if (e != null) {
          Log.w(TAG, "activity transitions not subscribed: ${e.javaClass.simpleName}")
          done()
        } else {
          prefs.transitionsTier = want.name
          // The reason changed before this request completed: follow it.
          if (tier(context) != want) sync(context, onDone = done) else done()
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "activity transitions not synced: ${e.javaClass.simpleName}")
      done()
    }
  }

  /** [onDone] gets null on success, else the failure (SecurityException = no permission). */
  @SuppressLint("MissingPermission")
  private fun subscribe(context: Context, tier: TripReminderPolicy.Tier, onDone: (Exception?) -> Unit) {
    try {
      ActivityRecognition.getClient(context.applicationContext)
        .requestActivityTransitionUpdates(request(tier), pendingIntent(context))
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
      ActivityRecognition.getClient(context.applicationContext)
        .removeActivityTransitionUpdates(pendingIntent(context))
    } catch (_: Exception) {
      // Nothing to remove, or no permission to remove it with: either way we are unsubscribed.
    }
  }
}
