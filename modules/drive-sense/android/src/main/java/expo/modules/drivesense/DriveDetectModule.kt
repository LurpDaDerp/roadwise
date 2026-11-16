package expo.modules.drivesense

import android.Manifest
import android.content.Context
import android.os.Build
import expo.modules.drivesense.detect.DriveDetector
import expo.modules.drivesense.detect.notDriving
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * DriveDetect on Android: the drive detector's bridge (`src/detect/types.ts` is the binding
 * contract, the iOS `DriveDetectModule.swift` its other half). A second Expo module beside
 * DriveSense, its events on their own buffer ([DetectEventBus]). Every method hands its work to the
 * process's [DriveDetector] (its own thread) and answers from there; only `discardDrive` on the live
 * drive rejects (E_BUSY). The car link's methods and its `carLink` event are here (CarLink.kt), so JS
 * reads `DriveDetect.carLinkAvailable` as true, as on iPhone.
 */
class DriveDetectModule : Module() {
  companion object {
    /** Same names as `Events(...)` below. */
    private val OBSERVED_EVENTS = listOf("detectState", "driveStarted", "driveEnded", "carLink")
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val emitter = EventBus.Emitter { name, body -> sendEvent(name, body) }

  private fun detector(): DriveDetector = DriveDetector.get(context)

  override fun definition() = ModuleDefinition {
    Name("DriveDetect")

    // Keep this list identical to DRIVE_DETECT_EVENTS in src/detect/types.ts.
    Events("detectState", "driveStarted", "driveEnded", "carLink")

    OnCreate {
      DetectEventBus.attach(emitter)
      DriveDetector.get(context)
    }

    OnDestroy {
      DetectEventBus.detach(emitter)
    }

    // Buffering (README §3): a drive event nobody listens for waits for the first listener.
    for (name in OBSERVED_EVENTS) {
      OnStartObserving(name) { DetectEventBus.startObserving(name) }
      OnStopObserving(name) { DetectEventBus.stopObserving(name) }
    }

    AsyncFunction("setArmed") { armed: Boolean, ownerId: String, promise: Promise ->
      detector().setArmed(armed, ownerId) { promise.resolve(it) }
    }

    AsyncFunction("getState") { promise: Promise ->
      detector().getState { promise.resolve(it) }
    }

    // "Allow all the time" (Android 10+): While Using first when location is not allowed at all,
    // then the background request (Android 10 shows its dialog; 11+ opens RoadWise's location
    // settings page, and the answer comes when the driver returns). Answers the grant then, as the
    // contract's `always` / `whenInUse` / `denied`; with no activity on screen (nothing to ask
    // from) or nothing left to ask, the current answer. Never rejects.
    AsyncFunction("requestAlways") { promise: Promise ->
      val ctx = context
      val detector = detector()
      var answered = false
      val answer = {
        if (!answered) {
          answered = true
          detector.permissionsChanged()
          promise.resolve(detector.access.alwaysAnswer())
        }
      }
      val permissions = appContext.permissions
      if (appContext.currentActivity == null || permissions == null || DriveSensePermissions.hasBackgroundLocation(ctx)) {
        answer()
        return@AsyncFunction
      }
      val askBackground = {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !DriveSensePermissions.hasForegroundLocation(ctx)) {
          answer()
        } else {
          try {
            permissions.askForPermissions(PermissionsResponseListener { answer() }, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
          } catch (_: Exception) {
            answer()
          }
        }
      }
      if (DriveSensePermissions.hasForegroundLocation(ctx)) {
        askBackground()
      } else {
        try {
          permissions.askForPermissions(
            PermissionsResponseListener { askBackground() },
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
          )
        } catch (_: Exception) {
          answer()
        }
      }
    }

    AsyncFunction("startWaiting") { promise: Promise ->
      detector().startWaiting { promise.resolve(it) }
    }

    AsyncFunction("extendWaiting") { promise: Promise ->
      detector().extendWaiting { promise.resolve(it) }
    }

    AsyncFunction("cancelWaiting") { promise: Promise ->
      detector().cancelWaiting { promise.resolve(null) }
    }

    AsyncFunction("notDriving") { promise: Promise ->
      detector().notDriving { promise.resolve(null) }
    }

    // A file with no end that is not the live drive is listed as an orphan (ended) for JS to adopt.
    AsyncFunction("listDrives") { promise: Promise ->
      detector().listDrives { promise.resolve(it) }
    }

    AsyncFunction("readRows") { driveId: String, afterSeq: Double, limit: Double, promise: Promise ->
      val after = if (afterSeq.isFinite()) afterSeq.toLong() else 0L
      val n = if (limit.isFinite()) limit.toInt() else 1
      detector().readRows(driveId, after, n) { page ->
        promise.resolve(linkedMapOf<String, Any?>("rows" to page.rows, "lastSeq" to page.lastSeq, "done" to page.done))
      }
    }

    AsyncFunction("discardDrive") { driveId: String, promise: Promise ->
      detector().discardDrive(driveId) { busy ->
        if (busy) promise.reject(CodedException("E_BUSY", "the drive is still recording", null)) else promise.resolve(null)
      }
    }

    // The sign-out, device and account-switch wipes: sensing stops, every journal file goes, the
    // record is emptied (no owner, last end, rest or drive) and the detector is off.
    AsyncFunction("wipe") { promise: Promise ->
      detector().wipe { promise.resolve(null) }
    }

    // RoadWise came to the front (the detector also hears it from the activity lifecycle).
    AsyncFunction("appForeground") { promise: Promise ->
      detector().appForeground()
      promise.resolve(null)
    }

    // The car link: the connected Bluetooth audio outputs and Android Auto, read only; the paired
    // cars live natively, so the detector reads them with no JS. Each answers the state.
    AsyncFunction("carLinkState") { promise: Promise ->
      detector().carLinkState { promise.resolve(it) }
    }

    AsyncFunction("pairCar") { uid: String, promise: Promise ->
      detector().pairCar(uid) { promise.resolve(it) }
    }

    AsyncFunction("forgetCar") { uid: String, promise: Promise ->
      detector().forgetCar(uid) { promise.resolve(it) }
    }

    AsyncFunction("notMyCar") { uid: String, promise: Promise ->
      detector().notMyCar(uid) { promise.resolve(it) }
    }
  }
}
