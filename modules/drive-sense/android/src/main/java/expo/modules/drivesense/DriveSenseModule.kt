package expo.modules.drivesense

import android.Manifest
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.ActivityCompat
import expo.modules.drivesense.detect.DriveDetector
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
 * A plain capture starts only from a JS `startCapture` (tests and dev tools); drives are the drive
 * detector's (`DriveDetectModule`: the Start card, and automatic drives from its wakes). The
 * retired forgot-to-start reminder's shared methods answer fixed values, as on iOS: off, nothing
 * missing, no tap (its `reminderTap` event stays in the contract and is never sent). Rejections are
 * `CodedException`s with the contract codes only (README §2 "Errors"); every other method never
 * rejects.
 */
class DriveSenseModule : Module() {
  companion object {
    /** Every event, for the per-event buffer flush (README §3). Same names as `Events(...)` below. */
    private val OBSERVED_EVENTS = listOf("activity", "row", "speed", "screen", "thermal", "notificationAction", "call", "reminderTap", "dashpalLinkTick")
    private val MODES = setOf("mounted", "pocket", "auto")
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val emitter = EventBus.Emitter { name, body -> sendEvent(name, body) }

  private fun coded(code: String, message: String) = CodedException(code, message, null)

  /** The retired reminder's fixed status (`tripReminderStatusSchema`): off, nothing missing. */
  private fun reminderOff(): Map<String, Any?> = linkedMapOf("enabled" to false, "state" to "off", "missing" to emptyList<String>())

  override fun definition() = ModuleDefinition {
    Name("DriveSense")

    // Keep this list byte-identical to DRIVE_SENSE_EVENTS in src/types.ts and to DriveSenseModule.swift.
    Events("activity", "row", "speed", "screen", "thermal", "notificationAction", "call", "reminderTap", "dashpalLinkTick")

    OnCreate {
      DriveSensePrefs.init(context)
      EventBus.attach(emitter)
      // RoadWise-in-front for the rows: DriveSensePackage registers it at Application.onCreate; this
      // late registration runs only if that hook never did (seeded from the activity on screen now).
      (context as? Application)?.let { AppVisibility.registerLate(it, appContext.currentActivity) }
    }

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
      // A detector drive records (or waits to resume): it is the capture; nothing more starts (iOS's
      // capture answers the same). A running one takes the mode.
      if (DriveDetector.get(ctx).recordingNow) {
        if (CaptureService.isCapturing) CaptureService.startFromJs(ctx, if (mode in MODES) mode else "mounted") { promise.resolve(null) } else promise.resolve(null)
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

    // The drive's end for the reminder (README §2): kind "now" (nothing known), "dropped" (the drive
    // was not kept) or "at" (its driving ended at endedAt), and whether the car was at driving speed.
    // A detector drive's end from JS (its cut, journaled as the `js` end); else a plain capture's.
    AsyncFunction("stopCapture") { kind: String, endedAt: Double, drivingAtEnd: Boolean, promise: Promise ->
      val ctx = context
      val end = CaptureEnd.of(kind, endedAt, drivingAtEnd)
      DriveDetector.get(ctx).stopCapture(end) { handled ->
        if (handled) promise.resolve(null) else CaptureService.stopFromJs(ctx, end) { promise.resolve(null) }
      }
    }

    AsyncFunction("setCaptureRate") { rate: String, promise: Promise ->
      CaptureService.setRate(rate) { promise.resolve(null) }
    }

    AsyncFunction("getState") {
      val ctx = context
      val prefs = DriveSensePrefs.init(ctx)
      // A drive records (never the detector's watch, as on iOS).
      val capturing = CaptureService.recording()
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
        // The drive detector's arming and its transitions follow the grant.
        if (status == PermissionsStatus.GRANTED) DriveDetector.get(ctx).permissionsChanged()
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

    // The retired forgot-to-start reminder: fixed answers, as on iOS (the bootstrap's one switch-off
    // resolves; nothing is stored, posted or registered).
    AsyncFunction("setTripReminder") { _: Boolean ->
      reminderOff()
    }

    AsyncFunction("getTripReminderStatus") {
      reminderOff()
    }

    // The current location answer, without prompting (as iOS answers it).
    AsyncFunction("requestReminderLocation") {
      val location = DriveSensePermissions.location(context)
      if (location == "none") "denied" else location
    }

    AsyncFunction("takeReminderTap") { promise: Promise ->
      promise.resolve(null)
    }

    AsyncFunction("claimReminderTap") { _: String ->
      false
    }

    // The navigation button (README §2): which of these packages can be launched (installed, enabled,
    // with a launcher activity), in the order given, with the app's own label. Only the navigation
    // apps (NavPackages, the manifest's <queries>) are looked up; any failure skips that package.
    AsyncFunction("listInstalledApps") { packages: List<String> ->
      val pm = context.packageManager
      val out = ArrayList<Map<String, Any?>>()
      for (pkg in packages) {
        if (pkg !in NavPackages.ALLOWED) continue
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

    // Opens the app as a launcher tap does (a route in progress is resumed, not reset). False for a
    // package outside NavPackages, when it has no launch intent or the start fails.
    AsyncFunction("launchApp") { pkg: String ->
      try {
        val ctx = context
        val intent = if (pkg in NavPackages.ALLOWED) ctx.packageManager.getLaunchIntentForPackage(pkg) else null
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

    // ---- Share images (WP09). Android only: ANDROID_SHARE_METHODS in src/share.ts, outside
    // DRIVE_SENSE_METHODS (iPhone's sheet takes the image and the text itself). ----

    // The share sheet with a share image from RoadWise's cache, `text` beside it and Save image on
    // Android 10+ (ShareIntent). True once the sheet is up; false with no activity on screen or a
    // file that is not a share image. Never rejects. On the module's own queue first, where a
    // capture view-shot put in the external cache is moved into the cache (ShareIntent.intoCache,
    // disk I/O); then the main thread, which starts the chooser.
    AsyncFunction("shareImage") { uri: String, text: String?, title: String?, promise: Promise ->
      val file = try {
        ShareIntent.intoCache(context.cacheDir, context.externalCacheDir, uri)
      } catch (_: Exception) {
        null
      }
      if (file == null) {
        promise.resolve(false)
      } else {
        Handler(Looper.getMainLooper()).post {
          val activity = appContext.currentActivity
          val shown = activity != null && try {
            ShareIntent.shareImage(activity, file.absolutePath, text, title)
          } catch (_: Exception) {
            false
          }
          promise.resolve(shown)
        }
      }
    }

    // ---- The background-safe geocoder (WP10). Android only: ANDROID_GEOCODE_METHODS in
    // src/geocode.ts, outside DRIVE_SENSE_METHODS (iPhone keeps expo-location's). ----

    // The addresses at a point (expo-location's shape), in front, behind or headless (Geocode).
    // Null without a geocoder, on a failure or after its timeout. Never rejects.
    AsyncFunction("reverseGeocode") { lat: Double, lng: Double, promise: Promise ->
      val ctx = try {
        context
      } catch (_: Exception) {
        null
      }
      if (ctx == null) promise.resolve(null) else Geocode.reverse(ctx, lat, lng) { promise.resolve(it) }
    }

    // The points a typed address names (`{ latitude, longitude }`); null as above. Never rejects.
    AsyncFunction("forwardGeocode") { query: String, promise: Promise ->
      val ctx = try {
        context
      } catch (_: Exception) {
        null
      }
      if (ctx == null) promise.resolve(null) else Geocode.forward(ctx, query) { promise.resolve(it) }
    }

    // ---- "Pause app activity if unused" (ruling 15). Android only: ANDROID_UNUSED_APP_METHODS in
    // src/unusedApps.ts, outside DRIVE_SENSE_METHODS (iPhone has no such switch). ----

    // `enabled` / `disabled` / `unavailable` (UnusedAppRestrictions.read: the androidx.core future,
    // never waited on). Rejects with E_IO only when the phone could not answer (its ERROR, or no
    // answer within 5 s); JS then lists no row.
    AsyncFunction("getUnusedAppRestrictions") { promise: Promise ->
      UnusedAppRestrictions.read(context) { answer ->
        if (answer != null) promise.resolve(answer) else promise.reject(coded("E_IO", "the unused-app restriction could not be read"))
      }
    }

    // The page with the switch, started on the main thread; false where the phone has none (JS then
    // opens the app's settings page). Never rejects.
    AsyncFunction("openUnusedAppRestrictionsSettings") { promise: Promise ->
      val ctx = try {
        context
      } catch (_: Exception) {
        null
      }
      if (ctx == null) {
        promise.resolve(false)
      } else {
        Handler(Looper.getMainLooper()).post { promise.resolve(UnusedAppRestrictions.open(ctx, appContext.currentActivity)) }
      }
    }

    // ---- Spoken alerts (AlertSpeech). Android only: ANDROID_SPEECH_METHODS in src/speech.ts,
    // outside DRIVE_SENSE_METHODS (iPhone keeps expo-speech, whose engine there lives as long as
    // the app). The engine is the process's, so speech outlives a destroyed activity. ----

    // `done`, `stopped` or `error` once the phrase is over. Never rejects.
    AsyncFunction("speakAlert") { text: String, volume: Double, promise: Promise ->
      val ctx = try {
        context
      } catch (_: Exception) {
        null
      }
      if (ctx == null) promise.resolve(SpeechOutcome.ERROR) else AlertSpeech.speak(ctx, text, volume.toFloat()) { promise.resolve(it) }
    }

    AsyncFunction("stopAlertSpeech") {
      AlertSpeech.stop()
    }

    // How many voices the engine has: 0 with none, null when unreadable. Never rejects.
    AsyncFunction("alertVoiceCount") { promise: Promise ->
      val ctx = try {
        context
      } catch (_: Exception) {
        null
      }
      if (ctx == null) promise.resolve(null) else AlertSpeech.voiceCount(ctx) { promise.resolve(it) }
    }
  }
}
