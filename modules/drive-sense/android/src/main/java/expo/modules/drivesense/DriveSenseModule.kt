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
 * drive-sense on Android (task N3). README.md in the module root is the binding contract and
 * `src/types.ts` its machine-checked half; `__tests__/native-android.test.ts` holds this file to
 * both (the event list, one `AsyncFunction` per `DRIVE_SENSE_METHODS` entry, the error codes).
 *
 * Rejections are `CodedException`s with the contract codes only (README §2 "Errors"); every other
 * method never rejects.
 */
class DriveSenseModule : Module() {
  companion object {
    /** Every event, for the per-event buffer flush (README §3). Same names as `Events(...)` below. */
    private val OBSERVED_EVENTS = listOf("wake", "activity", "row", "screen", "thermal", "notificationAction", "call")
    private val MODES = setOf("mounted", "pocket", "auto")
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val emitter = EventBus.Emitter { name, body -> sendEvent(name, body) }

  private fun coded(code: String, message: String) = CodedException(code, message, null)

  override fun definition() = ModuleDefinition {
    Name("DriveSense")

    // Keep this list byte-identical to DRIVE_SENSE_EVENTS in src/types.ts and to DriveSenseModule.swift.
    Events("wake", "activity", "row", "screen", "thermal", "notificationAction", "call")

    OnCreate {
      DriveSensePrefs.init(context)
      EventBus.attach(emitter)
    }

    OnDestroy {
      // The JS runtime is going away: nobody listens for rows any more (the watchdog's signal).
      EventBus.detach(emitter)
    }

    for (name in OBSERVED_EVENTS) {
      OnStartObserving(name) { EventBus.startObserving(name) }
      OnStopObserving(name) { EventBus.stopObserving(name) }
    }

    AsyncFunction("arm") { promise: Promise ->
      val ctx = context
      val prefs = DriveSensePrefs.init(ctx)
      if (!DriveSensePermissions.playServicesAvailable(ctx)) {
        prefs.armed = false
        promise.reject(coded("E_UNAVAILABLE", "Google Play services (activity recognition) is not available"))
        return@AsyncFunction
      }
      if (DriveSensePermissions.location(ctx) != "always" || !DriveSensePermissions.motionGranted(ctx)) {
        prefs.armed = false
        ActivityTransitions.unsubscribe(ctx)
        promise.reject(coded("E_PERMISSION", "arm needs location 'always' and motion 'granted'"))
        return@AsyncFunction
      }
      ActivityTransitions.subscribe(ctx) { error ->
        if (error == null) {
          prefs.armed = true
          promise.resolve(null)
        } else {
          prefs.armed = false
          val code = if (error is SecurityException) "E_PERMISSION" else "E_UNAVAILABLE"
          promise.reject(coded(code, "activity transitions could not be requested: ${error.message}"))
        }
      }
    }

    AsyncFunction("disarm") {
      val ctx = context
      ActivityTransitions.unsubscribe(ctx)
      DriveSensePrefs.init(ctx).armed = false
    }

    AsyncFunction("startCapture") { mode: String, promise: Promise ->
      val ctx = context
      if (DriveSensePermissions.location(ctx) == "none") {
        promise.reject(coded("E_PERMISSION", "startCapture needs location permission"))
        return@AsyncFunction
      }
      CaptureService.startFromJs(ctx, if (mode in MODES) mode else "auto") { code ->
        if (code == null) {
          promise.resolve(null)
        } else {
          // From the background with only While-in-use, the refusal is the missing Always (README §2).
          val reason = if (code == "E_FGS_REFUSED" && DriveSensePermissions.location(ctx) == "whenInUse") "E_PERMISSION" else code
          promise.reject(coded(reason, "the location foreground service was refused"))
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
      val location = DriveSensePermissions.location(ctx)
      val motion = DriveSensePermissions.motion(ctx)
      // `armed` is the effective arming: a revoked permission un-arms (README §2).
      var armed = prefs.armed
      if (armed && (location != "always" || motion != "granted")) {
        prefs.armed = false
        ActivityTransitions.unsubscribe(ctx)
        armed = false
      }
      val capturing = CaptureService.isCapturing
      linkedMapOf<String, Any?>(
        "armed" to armed,
        "capturing" to capturing,
        "rate" to (if (capturing) CaptureService.currentRate ?: "full" else null),
        "mode" to (if (capturing) CaptureService.currentMode ?: prefs.mode else null),
        "platform" to "android",
        "location" to location,
        "motion" to motion,
        "lockSignal" to "reliable",
        "captureWasOpen" to DriveSensePrefs.captureWasOpenAtProcessStart,
        "captureStartedAt" to (if (capturing) CaptureService.captureStartedAt else null),
        "lastRowTs" to CaptureService.lastRowTs
      )
    }

    AsyncFunction("queryMotionHistory") { fromTs: Double, toTs: Double ->
      val ctx = context
      if (DriveSensePermissions.motion(ctx) != "granted") {
        emptyList<Map<String, Any>>()
      } else {
        TransitionStore.query(ctx, fromTs, toTs).map { it.toMap() }
      }
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

    AsyncFunction("setNotificationState") { state: Map<String, Any?> ->
      val stationary = state["stationary"] as? Boolean ?: false
      val startedAt = (state["startedAt"] as? Number)?.toLong()
      CaptureService.setNotificationState(stationary, startedAt)
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
