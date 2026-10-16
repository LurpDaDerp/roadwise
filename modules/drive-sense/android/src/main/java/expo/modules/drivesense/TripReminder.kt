package expo.modules.drivesense

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import java.util.UUID

/**
 * The optional forgot-to-start reminder on Android (README "Forgot-to-start reminder"). Off by
 * default. While it is on and no drive is open, [ActivityTransitionReceiver] hands it each Play
 * services activity-transition batch; while a drive is open, each capture batch as vehicle state
 * only. [TripReminderPolicy] decides, and this object reads the phone, keeps the state
 * ([DriveSensePrefs.tripReminderJson]) and shows, refreshes or takes down the one silent note. No
 * location is used.
 *
 * It never starts a capture: [CaptureService] tells it when a drive starts and ends (one direction
 * only). A tap on the note opens RoadWise with the note's one-use token; the module hands the token
 * to JS once ([onTapIntent]) and JS asks [claim] before it starts a drive through the same path as
 * the Start Drive tap.
 *
 * Every entry point is synchronized: the receiver, the module and the capture thread may arrive
 * together.
 */
object TripReminder {
  /** One tap's hand-over: whether JS gets it, and when (the live note's tap time, or now). */
  class TapDelivery(val delivered: Boolean, val at: Long)

  private fun now(): Long = System.currentTimeMillis()

  private fun newToken(): String = UUID.randomUUID().toString()

  private fun load(context: Context): ReminderState =
    TripReminderState.fromJson(DriveSensePrefs.init(context).tripReminderJson) ?: ReminderState()

  /** Writes the state, and keeps the boot receiver enabled exactly while the reminder is on. */
  private fun save(context: Context, s: ReminderState) {
    DriveSensePrefs.init(context).tripReminderJson = TripReminderState.toJson(s)
    setBootReceiver(context, s.enabled)
  }

  /** No token, no note. A note whose token is still live is left as it is (it may be the one just tapped). */
  private fun dropNoteIfNoToken(context: Context, s: ReminderState) {
    if (s.token.isEmpty()) TripReminderNotifier.cancel(context)
  }

  @Synchronized
  fun state(context: Context): ReminderState = load(context)

  /** What the transitions feed needs: motion access and Play services. */
  fun transitionsOk(context: Context): Boolean =
    DriveSensePermissions.motionGranted(context) && DriveSensePermissions.playServicesAvailable(context)

  private fun missing(context: Context): List<String> {
    val out = ArrayList<String>()
    if (!DriveSensePermissions.motionGranted(context)) out.add("motion")
    if (!TripReminderNotifier.enabled(context)) out.add("notifications")
    return out
  }

  private fun ctx(context: Context): ReminderCtx = ReminderCtx(
    permissionsOk = transitionsOk(context) && TripReminderNotifier.enabled(context),
    capturing = CaptureService.isCapturing
  )

  private fun statusMap(context: Context, s: ReminderState): Map<String, Any?> {
    val missing = missing(context)
    val state = when {
      !DriveSensePermissions.playServicesAvailable(context) -> "unavailable"
      !s.enabled -> "off"
      missing.isNotEmpty() -> "needs"
      else -> "on"
    }
    return linkedMapOf(
      "enabled" to s.enabled,
      "state" to state,
      "missing" to (if (state == "needs") missing else emptyList<String>())
    )
  }

  /** JS `getTripReminderStatus`. */
  @Synchronized
  fun status(context: Context): Map<String, Any?> {
    val s = TripReminderPolicy.settle(load(context), now(), CaptureService.isCapturing)
    save(context, s)
    dropNoteIfNoToken(context, s)
    return statusMap(context, s)
  }

  /** JS `setTripReminder`: on keeps the session; off forgets everything. */
  @Synchronized
  fun setEnabled(context: Context, on: Boolean): Map<String, Any?> {
    val s = TripReminderPolicy.setEnabled(TripReminderPolicy.settle(load(context), now(), CaptureService.isCapturing), on)
    save(context, s)
    if (on) TripReminderNotifier.ensureChannel(context)
    dropNoteIfNoToken(context, s)
    ActivityTransitions.sync(context)
    return statusMap(context, s)
  }

  /**
   * The module's launch: settle, and re-register the feed (a registration the system dropped comes
   * back; its replayed current activity repairs the vehicle state).
   */
  @Synchronized
  fun onLaunch(context: Context) {
    val s = TripReminderPolicy.settle(load(context), now(), CaptureService.isCapturing)
    save(context, s)
    dropNoteIfNoToken(context, s)
    ActivityTransitions.sync(context, force = true)
  }

  /** One activity-transition batch with no drive open (the receiver re-syncs the feed after). */
  @Synchronized
  fun onTransitions(context: Context, events: List<Transition>, arrival: Long, subscribedAt: Long) {
    val r = TripReminderPolicy.onTransitions(load(context), events, arrival, subscribedAt, ctx(context), newToken())
    save(context, r.state)
    val timeout = r.expiresAt - arrival
    when (r.effect) {
      // A post that never showed is taken back: the session may remind at its next stop.
      TripReminderPolicy.Effect.POST ->
        if (!TripReminderNotifier.post(context, r.state.token, r.state.postedAt, timeout)) save(context, TripReminderPolicy.unposted(r.state, r.state.token))
      TripReminderPolicy.Effect.REFRESH -> TripReminderNotifier.refresh(context, r.state.token, r.state.postedAt, timeout)
      TripReminderPolicy.Effect.WITHDRAW -> TripReminderNotifier.cancel(context)
      TripReminderPolicy.Effect.NONE -> dropNoteIfNoToken(context, r.state)
    }
  }

  /** A capture batch (a drive is open): the vehicle state only. It never posts. */
  @Synchronized
  fun onCaptureTransitions(context: Context, events: List<Transition>, subscribedAt: Long) {
    save(context, TripReminderPolicy.foldCaptureTransitions(load(context), events, subscribedAt))
  }

  /** CaptureService.beginCapture: the note goes, and driving speed must be seen again after the drive. */
  @Synchronized
  fun onCaptureStarted(context: Context) {
    val now = now()
    save(context, TripReminderPolicy.captureStarted(TripReminderPolicy.settle(load(context), now, false), now))
    TripReminderNotifier.cancel(context)
  }

  /** CaptureService.endCapture: the drive's end is the session's last driving moment. */
  @Synchronized
  fun onCaptureEnded(context: Context) {
    val now = now()
    save(context, TripReminderPolicy.captureEnded(TripReminderPolicy.settle(load(context), now, true), now))
  }

  /**
   * RoadWise came to the front: settle, take down a note whose session ended, and re-sync the feed.
   * A live note stays up (pulling the shade over RoadWise is not a reason to lose the trip's one
   * reminder).
   */
  @Synchronized
  fun onAppForeground(context: Context) {
    val s = TripReminderPolicy.settle(load(context), now(), CaptureService.isCapturing)
    save(context, s)
    dropNoteIfNoToken(context, s)
    ActivityTransitions.sync(context)
  }

  /**
   * A tap's token read from an intent. A token handed over before is never handed over again, so a
   * recreated activity's saved intent starts nothing. Persisted at once.
   */
  @Synchronized
  fun onTapIntent(context: Context, token: String): TapDelivery {
    val now = now()
    val r = TripReminderPolicy.tapDelivered(load(context), token, now)
    if (!r.delivered) return TapDelivery(false, now)
    save(context, r.state)
    val at = if (token == r.state.token && r.state.tapAt > 0L) r.state.tapAt else now
    return TapDelivery(true, at)
  }

  /**
   * JS `claimReminderTap`: true once, for the live note's token, in a live session, with no drive
   * open, within 2 min of the tap's hand-over. The note comes down when its token is spent or gone.
   */
  @Synchronized
  fun claim(context: Context, token: String): Boolean {
    val s0 = load(context)
    val r = TripReminderPolicy.claim(s0, token, now(), CaptureService.isCapturing, true)
    save(context, r.state)
    if (s0.token.isNotEmpty() && r.state.token.isEmpty()) TripReminderNotifier.cancel(context)
    if ((s0.session == null) != (r.state.session == null)) ActivityTransitions.sync(context)
    return r.ok
  }

  // ——— the phone ———

  /** The boot receiver runs only while the reminder is on. DONT_KILL_APP: switching it never kills RoadWise. */
  private fun setBootReceiver(context: Context, enabled: Boolean) {
    try {
      val component = ComponentName(context, ReminderBootReceiver::class.java)
      val want = if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
      val pm = context.packageManager
      if (pm.getComponentEnabledSetting(component) != want) {
        pm.setComponentEnabledSetting(component, want, PackageManager.DONT_KILL_APP)
      }
    } catch (_: Exception) {
      // Best effort: a missed boot only waits for the next app open.
    }
  }
}
