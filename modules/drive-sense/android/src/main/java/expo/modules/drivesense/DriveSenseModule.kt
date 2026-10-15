package expo.modules.drivesense

import android.Manifest
import android.content.Context
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
 * list, one `AsyncFunction` per `DRIVE_SENSE_METHODS` entry, the error codes).
 *
 * v3 (plan §1 decision 4): a capture starts only from a JS `startCapture` (a user's tap in the
 * foreground). There is no arming, no activity-transition auto-start and no background location
 * permission. The optional forgot-to-start reminder ([TripReminder]) only notifies; JS switches it
 * and reads its status. Rejections are `CodedException`s with the contract codes only
 * (README §2 "Errors"); every other method never rejects.
 */
class DriveSenseModule : Module() {
  companion object {
    /** Every event, for the per-event buffer flush (README §3). Same names as `Events(...)` below. */
    private val OBSERVED_EVENTS = listOf("activity", "row", "screen", "thermal", "notificationAction", "call")
    private val MODES = setOf("mounted", "pocket", "auto")
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val emitter = EventBus.Emitter { name, body -> sendEvent(name, body) }

  private fun coded(code: String, message: String) = CodedException(code, message, null)

  override fun definition() = ModuleDefinition {
    Name("DriveSense")

    // Keep this list byte-identical to DRIVE_SENSE_EVENTS in src/types.ts and to DriveSenseModule.swift.
    Events("activity", "row", "screen", "thermal", "notificationAction", "call")

    OnCreate {
      DriveSensePrefs.init(context)
      EventBus.attach(emitter)
      // The transitions feed: the capture's (walking auto-end) or the forgot-to-start reminder's.
      // At launch this settles the reminder and re-requests the feed it needs (a registration the
      // system dropped comes back), or removes one an earlier process or an older build left behind.
      TripReminder.onLaunch(context)
    }

    // RoadWise is on screen: Home is visible, so a reminder still up comes down.
    OnActivityEntersForeground {
      try {
        TripReminder.onAppForeground(context)
      } catch (_: Exception) {
        // no context yet: the next launch settles it
      }
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
