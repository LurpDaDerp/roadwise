package expo.modules.drivesense

import android.Manifest
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import androidx.core.app.ActivityCompat
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * drive-sense on Android. README.md in the module root is the binding contract and `src/types.ts`
 * its machine-checked half; `__tests__/native-android.test.ts` holds this file to both (the event
 * list, one `AsyncFunction` per `DRIVE_SENSE_METHODS` entry, one `Function` per
 * `DRIVE_SENSE_SYNC_METHODS` entry, the error codes).
 *
 * v3 (plan §1 decision 4): a capture starts only from a JS `startCapture` (a user's tap in the
 * foreground). There is no arming, no activity-transition auto-start and no background location
 * permission. The optional forgot-to-start reminder ([TripReminder]) never starts a capture either:
 * a tap on its note opens RoadWise with the note's one-use token, this module hands the token to JS
 * once (`reminderTap`, `takeReminderTap`), and JS claims it (`claimReminderTap`) before it starts
 * the drive itself. Rejections are `CodedException`s with the contract codes only
 * (README §2 "Errors"); every other method never rejects.
 */
class DriveSenseModule : Module() {
  companion object {
    /** Every event, for the per-event buffer flush (README §3). Same names as `Events(...)` below. */
    private val OBSERVED_EVENTS = listOf("activity", "row", "screen", "thermal", "notificationAction", "call", "reminderTap", "dashpalLinkTick")
    private val MODES = setOf("mounted", "pocket", "auto")

    /** The reminder tap handed over and not yet taken by JS, with its hand-over time. Process-wide. */
    private val tapLock = Any()
    private var heldTap: Pair<String, Long>? = null
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val emitter = EventBus.Emitter { name, body -> sendEvent(name, body) }

  private fun coded(code: String, message: String) = CodedException(code, message, null)

  /**
   * A tap on the reminder's note: the token comes off the intent at once (a later read of the same
   * intent finds nothing), a relaunch from Recents is never a tap, and [TripReminder.onTapIntent]
   * hands each token over at most once (an activity recreated from its saved intent starts nothing).
   */
  private fun readReminderTap(intent: Intent?) {
    val i = intent ?: return
    val token = i.getStringExtra(TripReminderNotifier.EXTRA_TAP) ?: return
    i.removeExtra(TripReminderNotifier.EXTRA_TAP)
    if ((i.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
    val ctx = try {
      context
    } catch (_: Exception) {
      return
    }
    val tap = TripReminder.onTapIntent(ctx, token)
    if (tap.delivered) {
      synchronized(tapLock) { heldTap = token to tap.at }
      EventBus.emit("reminderTap", emptyMap())
    }
  }

  override fun definition() = ModuleDefinition {
    Name("DriveSense")

    // Keep this list byte-identical to DRIVE_SENSE_EVENTS in src/types.ts and to DriveSenseModule.swift.
    Events("activity", "row", "screen", "thermal", "notificationAction", "call", "reminderTap", "dashpalLinkTick")

    OnCreate {
      DriveSensePrefs.init(context)
      EventBus.attach(emitter)
      // RoadWise-in-front for the rows: DriveSensePackage registers it at Application.onCreate; this
      // late registration runs only if that hook never did (seeded from the activity on screen now).
      (context as? Application)?.let { AppVisibility.registerLate(it, appContext.currentActivity) }
      // The transitions feed: the capture's (walking auto-end) or the forgot-to-start reminder's.
      // At launch this settles the reminder and re-requests the feed it needs (a registration the
      // system dropped comes back), or removes one an earlier process or an older build left behind.
      TripReminder.onLaunch(context)
    }

    // RoadWise is on screen: a cold start's reminder tap is read first (before anything can settle
    // the state), then the reminder settles and re-syncs its feed. A live note stays up.
    OnActivityEntersForeground {
      try {
        readReminderTap(appContext.currentActivity?.intent)
        TripReminder.onAppForeground(context)
      } catch (_: Exception) {
        // no context yet: the next launch settles it
      }
    }

    // A tap on the reminder's note with RoadWise already running (MainActivity is singleTask).
    OnNewIntent { intent -> readReminderTap(intent) }

    OnDestroy {
      // The JS runtime is going away: nobody listens for rows any more (the watchdog's signal).
      EventBus.detach(emitter)
    }

    for (name in OBSERVED_EVENTS) {
      OnStartObserving(name) { EventBus.startObserving(name) }
      OnStopObserving(name) { EventBus.stopObserving(name) }
    }

    AsyncFunction("startCapture") { mode: String, promise: Promise ->
      val ctx = context
      if (DriveSensePermissions.location(ctx) == "none") {
        promise.reject(coded("E_PERMISSION", "startCapture needs location permission"))
        return@AsyncFunction
      }
      CaptureService.startFromJs(ctx, if (mode in MODES) mode else "mounted") { code ->
        if (code == null) {
          promise.resolve(null)
        } else {
          promise.reject(coded(code, "the location foreground service was refused"))
        }
      }
    }

    AsyncFunction("stopCapture") { promise: Promise ->
      CaptureService.stopFromJs(context) { promise.resolve(null) }
    }

    AsyncFunction("setCaptureRate") { rate: String, promise: Promise ->
      CaptureService.setRate(rate) { promise.resolve(null) }
    }

    AsyncFunction("getState") {
      val ctx = context
      val prefs = DriveSensePrefs.init(ctx)
      val capturing = CaptureService.isCapturing
      linkedMapOf<String, Any?>(
        "capturing" to capturing,
        "rate" to (if (capturing) CaptureService.currentRate ?: "full" else null),
        "mode" to (if (capturing) CaptureService.currentMode ?: prefs.mode else null),
        "platform" to "android",
        "location" to DriveSensePermissions.location(ctx),
        "motion" to DriveSensePermissions.motion(ctx),
        "lockSignal" to "reliable",
        // iOS's lock proof (README §5); Android reports locks exactly and needs none.
        "lockProof" to false,
        "lockDelayMs" to null,
        "captureWasOpen" to DriveSensePrefs.captureWasOpenAtProcessStart,
        "captureStartedAt" to (if (capturing) CaptureService.captureStartedAt else null),
        "lastRowTs" to CaptureService.lastRowTs
      )
    }

    AsyncFunction("getScreenState") {
      val ctx = context
      linkedMapOf("locked" to PhoneStateReceiver.locked(ctx), "on" to PhoneStateReceiver.screenOn(ctx))
    }

    AsyncFunction("getThermalState") {
      PhoneStateReceiver.thermalLevel(context)
    }

    AsyncFunction("requestMotionPermission") { promise: Promise ->
      val ctx = context
      val prefs = DriveSensePrefs.init(ctx)
      if (!DriveSensePermissions.playServicesAvailable(ctx)) {
        promise.resolve("unavailable")
        return@AsyncFunction
      }
      // Below API 29 activity recognition is an install-time permission.
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || DriveSensePermissions.motionGranted(ctx)) {
        promise.resolve("granted")
        return@AsyncFunction
      }
      val activity = appContext.currentActivity
      val permissions = appContext.permissions
      if (activity == null || permissions == null) {
        promise.resolve("denied") // nothing to prompt from (background)
        return@AsyncFunction
      }
      // "Don't ask again": refused before and the OS will not show the prompt — send to Settings.
      if (prefs.motionRequested &&
        !ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.ACTIVITY_RECOGNITION)
      ) {
        promise.resolve("denied")
        return@AsyncFunction
      }
      prefs.motionRequested = true
      val listener = PermissionsResponseListener { result ->
        val status = result[Manifest.permission.ACTIVITY_RECOGNITION]?.status
        if (status == PermissionsStatus.GRANTED) ActivityTransitions.sync(ctx)
        promise.resolve(if (status == PermissionsStatus.GRANTED) "granted" else "denied")
      }
      try {
        permissions.askForPermissions(listener, Manifest.permission.ACTIVITY_RECOGNITION)
      } catch (_: Exception) {
        promise.resolve("denied")
      }
    }

    AsyncFunction("excludeFromBackup") { _: String ->
      // Android: backup exclusion is manifest-level (allowBackup false in app.config.ts).
      Unit
    }

    // The background surface (plan §6): the capture's foreground notification. Ignored while not capturing.
    AsyncFunction("setDriveDisplay") { state: Map<String, Any?> ->
      CaptureService.setDriveDisplay(DriveDisplay.from(state))
    }

    // The optional forgot-to-start reminder (README "Forgot-to-start reminder"). It never starts a
    // capture: it notifies, and the notification only opens Home.
    AsyncFunction("setTripReminder") { enabled: Boolean ->
      TripReminder.setEnabled(context, enabled)
    }

    AsyncFunction("getTripReminderStatus") {
      TripReminder.status(context)
    }

    // Android uses no location for the reminder (activity recognition only).
    AsyncFunction("requestReminderLocation") {
      "notNeeded"
    }

    // The tap the phone handed RoadWise, once. A cold start whose foreground hook ran before this
    // module existed is read here from the launch intent (a token handed over before is dropped).
    AsyncFunction("takeReminderTap") {
      val none = synchronized(tapLock) { heldTap == null }
      if (none) readReminderTap(appContext.currentActivity?.intent)
      val tap = synchronized(tapLock) { heldTap.also { heldTap = null } }
      tap?.let { linkedMapOf<String, Any?>("token" to it.first, "at" to it.second) }
    }

    // True once, for the live note's token; JS starts the drive only after a true. Never a capture here.
    AsyncFunction("claimReminderTap") { token: String ->
      TripReminder.claim(context, token)
    }

    // The navigation button (README §2): which of these packages can be launched (installed, enabled,
    // with a launcher activity), in the order given, with the app's own label. Only packages the
    // manifest's <queries> names are visible; any failure skips that package.
    AsyncFunction("listInstalledApps") { packages: List<String> ->
      val pm = context.packageManager
      val out = ArrayList<Map<String, Any?>>()
      for (pkg in packages) {
        try {
          if (pm.getLaunchIntentForPackage(pkg) == null) continue
          @Suppress("DEPRECATION")
          val info = pm.getApplicationInfo(pkg, 0)
          if (!info.enabled) continue
          out.add(linkedMapOf("package" to pkg, "label" to pm.getApplicationLabel(info).toString()))
        } catch (_: Exception) {
          // not installed or not visible: not listed
        }
      }
      out
    }

    // Opens the app as a launcher tap does (a route in progress is resumed, not reset). False when it
    // has no launch intent or the start fails.
    AsyncFunction("launchApp") { pkg: String ->
      try {
        val ctx = context
        val intent = ctx.packageManager.getLaunchIntentForPackage(pkg)
        if (intent == null) {
          false
        } else {
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
          (appContext.currentActivity ?: ctx).startActivity(intent)
          true
        }
      } catch (_: Exception) {
        false
      }
    }

    // DashPal alerts on the phone (README §2). The DashPal link service: off, waiting or connected; a
    // running service is updated through its instance, a stopped one starts only with RoadWise visible.
    AsyncFunction("setDashpalLink") { state: String, promise: Promise ->
      DashpalLinkService.set(context, state) { promise.resolve(it) }
    }

    // Sync (README §2): read or done in the same JS turn, before the phone answers a DashPal ALERT.
    Function("audioOutputState") {
      AudioOutput.state(context)
    }

    Function("holdAwake") { ms: Int ->
      AlertWakeLock.hold(context, ms)
    }

    Function("dashpalLinkRunning") {
      DashpalLinkService.running()
    }

    // iOS only (an in-drive lock proof); Android reports locks exactly.
    AsyncFunction("markLockProof") { _: Double ->
      Unit
    }

    AsyncFunction("getLastExitInfo") {
      ExitInfoReader.read(context)
    }

    AsyncFunction("isIgnoringBatteryOptimizations") {
      val ctx = context
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager?
      pm?.isIgnoringBatteryOptimizations(ctx.packageName) ?: false
    }

    AsyncFunction("selfTest") { vectorsJson: String ->
      try {
        SelfTest.run(vectorsJson)
      } catch (e: SelfTest.InvalidInput) {
        throw coded("E_INVALID_INPUT", e.message ?: "the vectors JSON cannot be parsed")
      }
    }
  }
}
