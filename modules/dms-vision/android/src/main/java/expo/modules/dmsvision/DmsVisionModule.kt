// DmsVision: the RoadWise driver-monitoring native module (Android). README.md is the binding contract.
// Events: frames (derived feature records, never pixels or landmarks), status (1 Hz), state.
// Every rejection carries a contract code (DmsError.code). The iOS twin is ios/DmsVisionModule.swift.
// The AsyncFunction bodies never use a labelled return (EAS build cc91ab36 refused one); each ends
// in Unit.

package expo.modules.dmsvision

import android.Manifest
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DmsVisionModule : Module() {
  private var controllerOrNull: CaptureController? = null

  /** Whether the activity is in the foreground: cached from the activity events, never read by blocking on main. */
  @Volatile private var foreground = false

  private val context: Context
    get() = appContext.reactContext ?: throw DmsError.state("the React context is gone")

  @Synchronized
  private fun controller(): CaptureController = controllerOrNull ?: CaptureController(context.applicationContext).also { c ->
    c.onFrames = { payload -> sendEvent("frames", payload) }
    c.onState = { state, reason -> sendEvent("state", mapOf("state" to state, "reason" to reason)) }
    c.onStatus = { status -> sendEvent("status", status) }
    controllerOrNull = c
  }

  private fun reject(promise: Promise, e: DmsError) = promise.reject(e.code, e.message, null)

  /** Runs `body` on the controller's session thread and settles `promise` with its result or its contract code. */
  private fun onSession(promise: Promise, body: (CaptureController) -> Any?) {
    val c = try {
      controller()
    } catch (e: DmsError) {
      reject(promise, e)
      null
    } ?: return
    c.session.post {
      try {
        promise.resolve(body(c))
      } catch (e: DmsError) {
        reject(promise, e)
      } catch (e: Exception) {
        promise.reject("E_CAMERA", e.message ?: "camera failure", null)
      }
    }
  }

  private fun permission(ask: Boolean, promise: Promise) {
    val pm = appContext.permissions
    if (pm == null) {
      promise.reject("E_UNAVAILABLE", "no permissions module", null)
      return
    }
    val listener = PermissionsResponseListener { result ->
      val r = result[Manifest.permission.CAMERA]
      val status = when (r?.status) {
        PermissionsStatus.GRANTED -> "granted"
        PermissionsStatus.DENIED -> "denied"
        else -> "undetermined"
      }
      promise.resolve(mapOf("status" to status, "canAskAgain" to (r?.canAskAgain ?: true)))
    }
    if (ask) pm.askForPermissions(listener, Manifest.permission.CAMERA) else pm.getPermissions(listener, Manifest.permission.CAMERA)
  }

  private fun start(opts: StartOptionsRecord, promise: Promise) {
    val o = try {
      opts.validated()
    } catch (e: DmsError) {
      reject(promise, e)
      return
    }
    if (appContext.permissions?.hasGrantedPermissions(Manifest.permission.CAMERA) != true) {
      reject(promise, DmsError.permission("camera permission has not been granted"))
      return
    }
    val owner = appContext.currentActivity as? LifecycleOwner
    onSession(promise) { c ->
      if (!foreground || owner == null) throw DmsError.notForeground("the app is not in the foreground")
      c.start(o, owner)
      null
    }
  }

  private fun setPolicy(p: CapturePolicyRecord, promise: Promise) {
    val v = try {
      p.validated()
    } catch (e: DmsError) {
      reject(promise, e)
      return
    }
    onSession(promise) { c ->
      c.setPolicy(v)
      null
    }
  }

  private fun modelInfo(promise: Promise) {
    try {
      promise.resolve(
        mapOf(
          "landmarkerSha256" to DmsAssets.sha256(context, "face_landmarker.task"),
          "gazeNetAvailable" to GazeNetFactory.available,
          "gazeSha256" to GazeNetFactory.modelSha256(context),
          "mediapipe" to "0.10.35",
          "onnxruntime" to GazeNetFactory.onnxRuntimeVersion
        )
      )
    } catch (e: DmsError) {
      reject(promise, e)
    }
  }

  private fun selfTest(vectorsJson: String, promise: Promise) {
    try {
      val ctx = context
      promise.resolve(SelfTest.run(vectorsJson, GazeNetFactory.available) { GazeNetFactory.make(ctx) })
    } catch (e: DmsError) {
      reject(promise, e)
    } catch (e: Exception) {
      promise.reject("E_BAD_ARGS", e.message ?: "selfTest failed", null)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("DmsVision")

    Events("frames", "status", "state")

    OnCreate {
      // The starting value, read once on the main thread; the activity events keep it current.
      Handler(Looper.getMainLooper()).post {
        val owner = appContext.currentActivity as? LifecycleOwner
        foreground = owner?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.STARTED) == true
      }
    }

    OnDestroy {
      // Never block the main thread on a camera teardown.
      controllerOrNull?.let { c -> c.session.post { c.stop("user") } }
    }

    OnActivityEntersForeground {
      foreground = true
    }

    // The native owner of the camera across app states (plan: Privacy 5): leaving the foreground
    // stops the session. Native never restarts it; JS does, through the gate, on return.
    OnActivityEntersBackground {
      foreground = false
      controllerOrNull?.let { c -> c.session.post { c.stop("background") } }
    }

    AsyncFunction("getPermission") { promise: Promise ->
      permission(false, promise)
      Unit
    }

    AsyncFunction("requestPermission") { promise: Promise ->
      permission(true, promise)
      Unit
    }

    AsyncFunction("start") { opts: StartOptionsRecord, promise: Promise ->
      start(opts, promise)
      Unit
    }

    AsyncFunction("setPolicy") { p: CapturePolicyRecord, promise: Promise ->
      setPolicy(p, promise)
      Unit
    }

    AsyncFunction("stop") { promise: Promise ->
      onSession(promise) { c ->
        c.stop("user")
        null
      }
      Unit
    }

    AsyncFunction("getStatus") { promise: Promise ->
      onSession(promise) { c -> c.snapshot(false) }
      Unit
    }

    AsyncFunction("getModelInfo") { promise: Promise ->
      modelInfo(promise)
      Unit
    }

    AsyncFunction("selfTest") { vectorsJson: String, promise: Promise ->
      selfTest(vectorsJson, promise)
      Unit
    }

    View(DmsPreviewView::class) {}
  }
}
