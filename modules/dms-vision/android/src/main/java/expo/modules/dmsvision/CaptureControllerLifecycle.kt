// CaptureController, continued: setPolicy and the small helpers, binding and unbinding the camera,
// the C2 preview, the camera-state observer (interruptions), the 1 Hz tick (watchdog, release,
// thermal floor, status with process CPU), the thermal listener and the orientation listener.
// Session thread unless stated.

package expo.modules.dmsvision

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.view.Display
import android.view.OrientationEventListener
import android.view.Surface
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.Preview
import androidx.lifecycle.Observer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

// Commands and helpers

fun CaptureController.setPolicy(p: CapturePolicy) {
  val (st, tok) = locked { Pair(state, token) }
  if (st == "stopped") throw DmsError.state("setPolicy while stopped")
  if (tok != p.token) throw DmsError.badArgs("gate token mismatch")
  applyPolicy(p.capture, p.fps, p.gazeNet, p.every, p.setupMode, p.previewAllowed)
}

/** A pause that had kept the binding for CameraX's own retry gives it up (a `pause` policy). */
fun CaptureController.releaseCamera() {
  unbindCamera()
  locked { interrupted = false }
}

fun CaptureController.setState(s: String, reason: String) {
  locked { state = s }
  emitState(s, reason)
}

fun CaptureController.emitState(s: String, reason: String) {
  onState?.invoke(s, reason)
}

fun CaptureController.applyCadence() {
  val cam = camera ?: return
  val cap = locked { min(fps, thermal.fpsCap) }
  if (cap > 0) CameraSetup.applyCadence(cam, cap)
}

/** Runs `block` on the analysis thread and waits (bounded). The analysis thread never waits on the session thread. */
internal fun CaptureController.onAnalysis(block: () -> Unit) {
  val exec = analysis ?: return
  try { exec.submit(block).get(2, TimeUnit.SECONDS) } catch (_: Exception) {}
}

/**
 * Runs `block` on the main thread and waits, bounded: a blocked main thread must not hang the session
 * thread. Returns false when it timed out (the block still runs later, in order, on main).
 */
internal fun CaptureController.runOnMain(block: () -> Unit): Boolean {
  if (Looper.myLooper() == Looper.getMainLooper()) {
    block()
    return true
  }
  val latch = CountDownLatch(1)
  Handler(Looper.getMainLooper()).post { try { block() } finally { latch.countDown() } }
  return latch.await(2, TimeUnit.SECONDS)
}

// Binding

internal fun CaptureController.bindCamera() {
  val p = provider ?: throw DmsError.camera("no camera provider")
  val o = owner ?: throw DmsError.camera("no lifecycle owner")
  val a = analysisUseCase ?: throw DmsError.camera("no analysis use case")
  var error: Exception? = null
  var cam: Camera? = null
  val observer = Observer<CameraState> { s -> onCameraState(s) }
  val done = runOnMain {
    try {
      val bound = p.bindToLifecycle(o, CameraSelector.DEFAULT_FRONT_CAMERA, a)
      bound.cameraInfo.cameraState.observe(o, observer)
      cam = bound
    } catch (e: Exception) {
      error = e
    }
  }
  if (!done) {
    // The bind may still complete later on main, leaving the camera bound with no owner state: undo it
    // there, after it (the main queue runs in order) (T4 review m3).
    Handler(Looper.getMainLooper()).post {
      try {
        cam?.cameraInfo?.cameraState?.removeObserver(observer)
        p.unbind(a)
      } catch (_: Exception) {
        // nothing was bound
      }
    }
    throw DmsError.camera("binding the front camera timed out")
  }
  error?.let { throw DmsError.camera("cannot bind the front camera: ${it.message}") }
  camera = cam ?: throw DmsError.camera("binding the front camera timed out")
  cameraObserver = observer
  bound = true
  applyCadence()
}

/** Closes the camera (the use cases are kept for a later bind). */
internal fun CaptureController.unbindCamera() {
  if (!bound) return
  val p = provider
  val cam = camera
  val obs = cameraObserver
  val cases = listOfNotNull(analysisUseCase, previewUseCase).toTypedArray()
  runOnMain {
    try {
      if (cam != null && obs != null) cam.cameraInfo.cameraState.removeObserver(obs)
      p?.unbind(*cases)
    } catch (_: Exception) {
      // the camera may already be gone
    }
    DmsPreviewRegistry.show(null)
  }
  previewUseCase = null
  cameraObserver = null
  camera = null
  bound = false
}

/** The C2 preview: a Preview use case bound next to the analysis only while setup mode allows it. */
internal fun CaptureController.updatePreview() {
  val show = locked { state == "running" && setupMode && previewAllowed }
  val current = previewUseCase
  if (show && current == null && bound) {
    val p = provider ?: return
    val o = owner ?: return
    val preview = Preview.Builder().build()
    var ok = false
    runOnMain {
      try {
        p.bindToLifecycle(o, CameraSelector.DEFAULT_FRONT_CAMERA, preview)
        DmsPreviewRegistry.show(preview)
        ok = true
      } catch (_: Exception) {
        // no preview; the analysis keeps running
      }
    }
    if (ok) previewUseCase = preview
  } else if (!show && current != null) {
    previewUseCase = null
    val p = provider
    runOnMain {
      try { p?.unbind(current) } catch (_: Exception) {}
      DmsPreviewRegistry.show(null)
    }
  }
}

/**
 * Main thread. An error (the camera taken by another app, disabled, or failed) pauses with the
 * binding kept, and marks the session interrupted; CameraX reopens the camera by itself and reports
 * OPEN, which ends the interruption. Native never resumes by itself: the next `run` policy does.
 */
internal fun CaptureController.onCameraState(s: CameraState) {
  val err = s.error
  if (err != null) {
    val critical = err.type == CameraState.ErrorType.CRITICAL
    session.post {
      locked { interrupted = true }
      if (currentState == "running") {
        pause(if (critical) "error" else "interrupted")
        DmsLog.code(if (critical) DmsLog.Code.CAMERA_ERROR else DmsLog.Code.CAMERA_INTERRUPTED)
      }
    }
  } else if (s.type == CameraState.Type.OPEN) {
    session.post {
      val was = locked {
        val w = interrupted
        interrupted = false
        w
      }
      if (was) DmsLog.code(DmsLog.Code.INTERRUPTION_ENDED)
    }
  }
}

// The 1 Hz tick. Handler times stall in deep sleep, but every decision is taken on elapsedRealtime,
// so a late tick still decides correctly.

internal fun CaptureController.startTick() {
  stopTick()
  val r = object : Runnable {
    override fun run() {
      if (tickRunnable !== this) return
      onTick()
      if (tickRunnable === this) session.postDelayed(this, 1000)
    }
  }
  tickRunnable = r
  session.postDelayed(r, 1000)
}

internal fun CaptureController.stopTick() {
  tickRunnable?.let { session.removeCallbacks(it) }
  tickRunnable = null
}

internal fun CaptureController.onTick() {
  val now = CaptureController.nowMs()
  if (refreshThermal()) applyCadence()
  val (st, hb, since) = locked { Triple(state, lastHeartbeatMs, pausedSinceMs) }
  when (LifecycleRules.decide(now, st == "running", st == "paused", hb, since)) {
    LifecycleAction.PAUSE_WATCHDOG -> { pause("watchdog"); DmsLog.code(DmsLog.Code.WATCHDOG_PAUSED) }
    LifecycleAction.STOP_WATCHDOG -> { stop("watchdog"); DmsLog.code(DmsLog.Code.WATCHDOG_STOPPED) }
    LifecycleAction.RELEASE -> { stop("released"); DmsLog.code(DmsLog.Code.MODELS_RELEASED) }
    LifecycleAction.NONE -> {}
  }
  if (currentState != "stopped") onStatus?.invoke(snapshot(true))
}

/** Observes the OS thermal state; pauses at level 3. Returns true if the floor moved. */
internal fun CaptureController.refreshThermal(): Boolean {
  val name = CameraSetup.thermalName(context)
  val moved = locked { thermal.observe(name, CaptureController.nowMs()) }
  if (currentState == "running" && !locked { thermal.allowsCamera }) pause("thermal")
  return moved
}

internal fun CaptureController.registerThermal() {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
  val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
  val listener = PowerManager.OnThermalStatusChangedListener { _ -> if (refreshThermal()) applyCadence() }
  try {
    power.addThermalStatusListener(Executor { r -> session.post(r) }, listener)
    thermalListener = listener
  } catch (_: Exception) {
    thermalListener = null
  }
}

internal fun CaptureController.unregisterThermal() {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
  val listener = thermalListener as? PowerManager.OnThermalStatusChangedListener ?: return
  thermalListener = null
  try {
    (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.removeThermalStatusListener(listener)
  } catch (_: Exception) {}
}

/** The status payload. `take` consumes the latency windows and the counters (the 1 Hz tick only). */
internal fun CaptureController.snapshot(take: Boolean): Map<String, Any?> {
  val thermalName = CameraSetup.thermalName(context)
  val lowPower = CameraSetup.lowPower(context)
  return locked {
    val last = lastStatus
    if (!take && last != null) return@locked last + ("state" to state)
    val running = state == "running"
    val lm = latLandmark.take()
    val gz = latGaze.take()
    val tot = latTotal.take()
    // Process CPU (MediaPipe runs on threads the module does not own): ms of CPU per wall second.
    val cpuMs = Process.getElapsedCpuTime().toDouble()
    val wall = CaptureController.nowMs()
    val prev = cpuPrevMs
    val cpu = if (prev != null && wall > cpuPrevWallMs) max(0.0, (cpuMs - prev) / ((wall - cpuPrevWallMs) / 1000)) else null
    cpuPrevMs = cpuMs
    cpuPrevWallMs = wall
    val status: Map<String, Any?> = mapOf(
      "state" to state,
      "fpsTarget" to if (running) min(fps, thermal.fpsCap).toDouble() else 0.0,
      "fpsActual" to processed.toDouble(),
      "dropped" to dropped,
      "gazeNetAvailable" to GazeNetFactory.available,
      "gazeNetOn" to (running && GazeNetFactory.available && gazeNetWanted && thermal.allowsGazeNet),
      "thermal" to thermalName,
      "thermalLevel" to thermal.level,
      "lowPower" to lowPower,
      "latLandmarkP50" to lm[0], "latLandmarkP95" to lm[1],
      "latGazeP50" to gz[0], "latGazeP95" to gz[1],
      "latTotalP50" to tot[0], "latTotalP95" to tot[1],
      "procCpuMsPerS" to cpu
    )
    processed = 0
    dropped = 0
    lastStatus = status
    status
  }
}

// Orientation. The app is portrait-locked, so the display never rotates; the device orientation
// comes from the accelerometer and sets the analysis target rotation, which ImageInfo.rotationDegrees
// then reports.

internal fun CaptureController.displayRotation(): Int = try {
  (context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager)?.getDisplay(Display.DEFAULT_DISPLAY)?.rotation ?: Surface.ROTATION_0
} catch (_: Exception) {
  Surface.ROTATION_0
}

internal fun CaptureController.startOrientationListener() {
  stopOrientationListener()
  val useCase = analysisUseCase
  var created: OrientationEventListener? = null
  runOnMain {
    val watcher = object : OrientationEventListener(context) {
      override fun onOrientationChanged(orientation: Int) {
        if (orientation == ORIENTATION_UNKNOWN) return
        val rotation = CameraSetup.surfaceRotation(orientation)
        if (rotation == surfaceRotation) return
        surfaceRotation = rotation
        useCase?.targetRotation = rotation
      }
    }
    if (watcher.canDetectOrientation()) {
      watcher.enable()
      created = watcher
    }
  }
  orientationListener = created
}

internal fun CaptureController.stopOrientationListener() {
  val watcher = orientationListener ?: return
  orientationListener = null
  runOnMain { watcher.disable() }
}
