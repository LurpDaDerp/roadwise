package expo.modules.dmsvision

import android.Manifest
import android.content.Context
import android.os.Build
import android.os.PowerManager
import androidx.lifecycle.LifecycleOwner
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Timer
import java.util.TimerTask

/**
 * DmsVision - the RoadCash driver-monitoring native inference layer (Android).
 *
 * JS contract: see modules/dms-vision/src/index.js and docs/dms/NATIVE_LAYER.md.
 * Events: onFrame (one per processed camera frame), onStatus (1 Hz), onError.
 */
class DmsVisionModule : Module(), DmsVisionPipeline.FrameListener {

  private var pipeline: DmsVisionPipeline? = null
  private val gaze = DmsVisionGaze()
  private var statusTimer: Timer? = null
  private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null
  @Volatile private var thermalState: String = "unknown"

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val permissionsManager: Permissions
    get() = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()

  @Synchronized
  private fun requirePipeline(): DmsVisionPipeline {
    val existing = pipeline
    if (existing != null) return existing
    val created = DmsVisionPipeline(context.applicationContext)
    created.listener = this
    pipeline = created
    return created
  }

  override fun definition() = ModuleDefinition {
    Name("DmsVision")

    Events("onFrame", "onStatus", "onError")

    OnCreate {
      try {
        thermalState = dmsThermalStateName(context)
        registerThermalListener()
      } catch (_: Exception) {
        thermalState = "unknown"
      }
    }

    OnDestroy {
      stopStatusTimer()
      unregisterThermalListener()
      // Never block the main thread on a camera teardown (unbind + a MediaPipe graph close):
      // OnDestroy runs on the main thread and stop() waits for the analysis thread to drain.
      val current = pipeline
      pipeline = null
      Thread({
        try {
          current?.stop()
        } catch (_: Exception) {
          // ignore
        }
        gaze.close()
      }, "DmsVisionTeardown").start()
    }

    // NOTE (docs/dms/INTEGRATION.md §3): there is deliberately NO OnActivityEntersBackground
    // handler.  The JS AppState listener is the single owner of the camera across app-state
    // changes; with two owners the JS-visible state and the native session disagreed.  CameraX
    // still unbinds by itself (the use case is bound to the activity lifecycle), and the
    // CameraState observer reports that as an error the JS watchdog reacts to.

    Function("isAvailable") { true }

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(permissionsManager, promise, Manifest.permission.CAMERA)
    }

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(permissionsManager, promise, Manifest.permission.CAMERA)
    }

    AsyncFunction("start") { targetFps: Double, facing: String, landmarkFrame: String,
                             mirrorPair: Boolean, rotationOffsetDegrees: Int ->
      if (mirrorPair) {
        // TODO(mirror-pair): the promoted research recipe runs the mesh twice (frame + flipped
        // frame) and averages through the 478-point mirror permutation, worth ~0.32 deg of LBW
        // error. Out of scope for this version; implement in the pipeline, not in JS.
        throw DmsVisionException("mirrorPair is not implemented in this version; pass false")
      }
      if (!permissionsManager.hasGrantedPermissions(Manifest.permission.CAMERA)) {
        throw DmsVisionException("camera permission has not been granted")
      }
      val activity = appContext.currentActivity
        ?: throw DmsVisionException("no current activity; the drive screen must be in the foreground")
      val lifecycleOwner = activity as? LifecycleOwner
        ?: throw DmsVisionException("the current activity is not a LifecycleOwner")

      gaze.prepare(context)
      requirePipeline().start(lifecycleOwner, targetFps, facing, landmarkFrame, rotationOffsetDegrees)
      startStatusTimer()
    }

    // A bare `return@AsyncFunction` is rejected by the Kotlin compiler for these generic
    // lambdas ("expected Any?, actual Unit" - EAS build cc91ab36); end each void body with `Unit`.
    AsyncFunction("stop") {
      stopStatusTimer()
      pipeline?.stop()
      Unit
    }

    Function("setTargetFps") { fps: Double ->
      pipeline?.setTargetFps(fps)
      Unit
    }

    Function("setIdleMode") { idle: Boolean ->
      pipeline?.setIdleMode(idle)
      Unit
    }

    Function("getIntrinsics") {
      requirePipeline().intrinsicsReport()
    }

    Function("getThermalState") {
      dmsThermalStateName(context).also { thermalState = it }
    }

    Function("getModelInfo") {
      val meta = gaze.loadMetadata(context)
      mapOf(
        "onnxSha256" to meta.optString("onnx_sha256", ""),
        "parameters" to meta.optInt("parameters", 0)
      )
    }

    AsyncFunction("predictGaze") { cloud: ByteArray, contextTensor: ByteArray, validity: ByteArray ->
      gaze.predict(context, cloud, contextTensor, validity)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------------------------

  private fun startStatusTimer() {
    stopStatusTimer()
    val timer = Timer("DmsVisionStatus", true)
    timer.scheduleAtFixedRate(object : TimerTask() {
      override fun run() {
        try {
          sendEvent("onStatus", statusPayload(stopped = false))
        } catch (_: Exception) {
          // the module may be tearing down
        }
      }
    }, 1000L, 1000L)
    statusTimer = timer
  }

  private fun stopStatusTimer() {
    statusTimer?.cancel()
    statusTimer = null
  }

  private fun statusPayload(stopped: Boolean): Map<String, Any?> {
    val counters = pipeline?.takeCounters() ?: Pair(0, 0)
    return mapOf(
      "thermal" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) thermalState else "unknown",
      "lowPower" to dmsLowPowerMode(context),
      "fps" to if (stopped) 0.0 else counters.first.toDouble(),
      "dropped" to counters.second,
      "running" to (pipeline?.isRunning() ?: false)
    )
  }

  private fun registerThermalListener() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
    val listener = PowerManager.OnThermalStatusChangedListener { status ->
      thermalState = dmsThermalStatusName(status)
    }
    try {
      power.addThermalStatusListener(listener)
      thermalListener = listener
    } catch (_: Exception) {
      thermalListener = null
    }
  }

  private fun unregisterThermalListener() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val listener = thermalListener ?: return
    thermalListener = null
    try {
      val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      power?.removeThermalStatusListener(listener)
    } catch (_: Exception) {
      // ignore
    }
  }

  // -------------------------------------------------------------------------------------------
  // DmsVisionPipeline.FrameListener
  // -------------------------------------------------------------------------------------------

  override fun onFrame(payload: Map<String, Any?>) {
    try {
      sendEvent("onFrame", payload)
    } catch (_: Exception) {
      // the module may be tearing down
    }
  }

  override fun onFailure(code: String, message: String) {
    try {
      sendEvent("onError", mapOf("code" to code, "message" to message))
    } catch (_: Exception) {
      // the module may be tearing down
    }
  }
}
