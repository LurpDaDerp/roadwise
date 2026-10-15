package expo.modules.drivesense

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager

/**
 * The optional forgot-to-start reminder on Android (README "Forgot-to-start reminder"). Off by
 * default. While it is on and no drive is open, [ActivityTransitionReceiver] hands it each Play
 * services activity-transition batch; [TripReminderPolicy] decides, and this object reads the
 * phone, keeps the state ([DriveSensePrefs.tripReminderJson]) and shows or takes down the one
 * silent notification. No location is used.
 *
 * It only ever notifies. It never starts a capture: [CaptureService] tells it when a drive starts
 * and ends (one direction only), and the notification only opens Home.
 *
 * Every entry point is synchronized: the receiver, the module, the capture thread and the action
 * receiver may arrive together.
 */
object TripReminder {
  private fun now(): Long = System.currentTimeMillis()

  private fun load(context: Context): ReminderState =
    TripReminderState.fromJson(DriveSensePrefs.init(context).tripReminderJson) ?: ReminderState()

  /** Writes the state, and keeps the boot receiver enabled exactly while the reminder is on. */
  private fun save(context: Context, s: ReminderState) {
    DriveSensePrefs.init(context).tripReminderJson = TripReminderState.toJson(s)
    setBootReceiver(context, s.enabled)
  }

  /** The note is up only while the state says so (a settle may have expired or resolved it). */
  private fun applyShowing(context: Context, s: ReminderState) {
    if (!s.showing) TripReminderNotifier.cancel(context)
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
    capturing = CaptureService.isCapturing,
    appForeground = appInForeground(),
    inCall = inCall(context)
  )

  private fun statusMap(context: Context, s: ReminderState, now: Long): Map<String, Any?> {
    val missing = missing(context)
    val state = when {
      !DriveSensePermissions.playServicesAvailable(context) -> "unavailable"
      !s.enabled -> "off"
      missing.isNotEmpty() -> "needs"
      now < s.pausedUntil -> "paused"
      else -> "on"
    }
    return linkedMapOf(
      "enabled" to s.enabled,
      "state" to state,
      "autoOff" to s.autoOff,
      "missing" to (if (state == "needs") missing else emptyList<String>()),
      "pausedUntil" to (if (state == "paused") s.pausedUntil else null)
    )
  }

  /** JS `getTripReminderStatus`. */
  @Synchronized
  fun status(context: Context): Map<String, Any?> {
    val now = now()
    val s = TripReminderPolicy.settle(load(context), now)
    save(context, s)
    applyShowing(context, s)
    return statusMap(context, s, now)
  }

  /** JS `setTripReminder`: on clears every back-off and quiet; off forgets everything. */
  @Synchronized
  fun setEnabled(context: Context, on: Boolean): Map<String, Any?> {
    val now = now()
    val s = TripReminderPolicy.setEnabled(TripReminderPolicy.settle(load(context), now), on)
    save(context, s)
    if (on) TripReminderNotifier.ensureChannel(context)
    TripReminderNotifier.cancel(context)
    ActivityTransitions.sync(context)
    return statusMap(context, s, now)
  }

  /** The module's launch: settle, and re-register the feed (a registration the system dropped comes back here). */
  @Synchronized
  fun onLaunch(context: Context) {
    val s = TripReminderPolicy.settle(load(context), now())
    save(context, s)
    applyShowing(context, s)
    ActivityTransitions.sync(context, force = true)
  }

  /** One activity-transition batch with no drive open (the receiver re-syncs the feed after). */
  @Synchronized
  fun onTransitions(context: Context, events: List<Transition>, arrival: Long, subscribedAt: Long) {
    val r = TripReminderPolicy.onTransitions(load(context), events, arrival, subscribedAt, ctx(context))
    save(context, r.state)
    when (r.effect) {
      // A post that never showed takes no quiet, no daily slot and no outcome.
      TripReminderPolicy.Effect.POST -> if (!TripReminderNotifier.post(context)) save(context, unposted(r.state, arrival))
      TripReminderPolicy.Effect.WITHDRAW -> TripReminderNotifier.cancel(context)
      TripReminderPolicy.Effect.NONE -> applyShowing(context, r.state)
    }
  }

  /** CaptureService.beginCapture: this trip is recorded, and a recent reminder helped. */
  @Synchronized
  fun onCaptureStarted(context: Context) {
    val now = now()
    save(context, TripReminderPolicy.captureStarted(TripReminderPolicy.settle(load(context), now), now))
    TripReminderNotifier.cancel(context)
  }

  /** CaptureService.endCapture: no reminder for the next 10 min. */
  @Synchronized
  fun onCaptureEnded(context: Context) {
    val now = now()
    save(context, TripReminderPolicy.captureEnded(TripReminderPolicy.settle(load(context), now), now))
  }

  /** The notification's "Not driving": taken down, 12 h quiet, and it counts as unused. */
  @Synchronized
  fun onNotDriving(context: Context) {
    val now = now()
    val s = TripReminderPolicy.resolve(TripReminderPolicy.settle(load(context), now), TripReminderPolicy.Outcome.NOT_DRIVING, now)
    save(context, s)
    TripReminderNotifier.cancel(context)
    if (!s.enabled) ActivityTransitions.sync(context)
  }

  /** RoadWise came to the front: Home is on screen, so the note goes. */
  @Synchronized
  fun onAppForeground(context: Context) {
    val s = TripReminderPolicy.appForeground(TripReminderPolicy.settle(load(context), now()))
    save(context, s)
    TripReminderNotifier.cancel(context)
    ActivityTransitions.sync(context)
  }

  /** [s0] with the post at [at] taken back: the trip may remind at its next stop. */
  private fun unposted(s0: ReminderState, at: Long): ReminderState {
    val s = s0.deepCopy()
    val i = s.posts.lastIndexOf(at)
    if (i >= 0) s.posts.removeAt(i)
    s.trip?.reminded = false
    s.pendingAt = 0L
    s.showing = false
    s.quietUntil = 0L
    return s
  }

  // ——— the phone ———

  /** RoadWise's own screen is in front (a process woken for a broadcast is not). */
  private fun appInForeground(): Boolean = try {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  } catch (_: Exception) {
    false
  }

  /**
   * A phone call, ringing, or a VoIP call that is using the microphone. A VoIP app can leave the
   * mode at IN_COMMUNICATION with no call; that alone must not hold every stop.
   */
  private fun inCall(context: Context): Boolean {
    return try {
      val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager? ?: return false
      when (am.mode) {
        AudioManager.MODE_IN_CALL, AudioManager.MODE_RINGTONE -> true
        AudioManager.MODE_IN_COMMUNICATION -> am.activeRecordingConfigurations.isNotEmpty()
        else -> false
      }
    } catch (_: Exception) {
      false
    }
  }

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
