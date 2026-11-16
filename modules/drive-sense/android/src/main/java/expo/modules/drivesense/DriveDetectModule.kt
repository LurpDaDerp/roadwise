package expo.modules.drivesense

import android.content.Context
import expo.modules.drivesense.detect.DriveDetector
import expo.modules.drivesense.detect.notDriving
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
 * drive rejects (E_BUSY). The car link's methods and its `carLink` event are not here yet: JS reads
 * their absence as no car link (`DriveDetect.carLinkAvailable`).
 */
class DriveDetectModule : Module() {
  companion object {
    /** Same names as `Events(...)` below. */
    private val OBSERVED_EVENTS = listOf("detectState", "driveStarted", "driveEnded")
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val emitter = EventBus.Emitter { name, body -> sendEvent(name, body) }

  private fun detector(): DriveDetector = DriveDetector.get(context)

  override fun definition() = ModuleDefinition {
    Name("DriveDetect")

    // DRIVE_DETECT_EVENTS in src/detect/types.ts without the car link's `carLink`.
    Events("detectState", "driveStarted", "driveEnded")

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

    // "Allow all the time" is not asked for on this build: the current answer.
    AsyncFunction("requestAlways") { promise: Promise ->
      detector().requestAlways { promise.resolve(it) }
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
  }
}
