// The camera session, the per-frame feature pass and the native-owned lifecycle (README §5–§6).
// Threads:
// - `session` (a HandlerThread): start/stop/policy, the 1 Hz tick, camera-state and thermal callbacks;
// - `analysis` (one single-thread scheduled executor per session): frames, landmarker results,
//   in-flight timeouts, the features and the batch;
// - main: CameraX bind/unbind, the camera-state observer, the orientation listener (bounded waits).
// Shared state sits behind `lock`. The iOS twin is ios/CaptureController.swift.

package expo.modules.dmsvision

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.OrientationEventListener
import androidx.camera.core.Camera
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Observer
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

class CaptureController(internal val context: Context) {
  var onFrames: ((Map<String, Any>) -> Unit)? = null
  var onState: ((String, String) -> Unit)? = null
  var onStatus: ((Map<String, Any?>) -> Unit)? = null

  private val sessionThread = HandlerThread("DmsVisionSession").also { it.start() }
  val session = Handler(sessionThread.looper)
  internal val lock = Any()

  // Guarded by `lock`.
  internal var state = "stopped"
  internal var token: String? = null
  internal var fps = 15
  internal var gazeNetWanted = false
  internal var gazeNetEvery = 1
  internal var setupMode = false
  internal var previewAllowed = false
  internal var rotationOffset = 0
  internal var lastHeartbeatMs = 0.0
  internal var pausedSinceMs: Double? = null
  internal val thermal = ThermalFloor()
  /** Between a CameraX camera-state error and the camera's next OPEN: a `run` policy does not resume (Task 3 review m3). */
  internal var interrupted = false
  internal var processed = 0
  internal var dropped = 0
  internal val latLandmark = LatencyWindow()
  internal val latGaze = LatencyWindow()
  internal val latTotal = LatencyWindow()
  internal var lastStatus: Map<String, Any?>? = null
  internal var cpuPrevMs: Double? = null
  internal var cpuPrevWallMs = 0.0
  /** Created and closed on the session thread, read on the analysis thread: hence under the lock. */
  internal var landmarker: Landmarker? = null
  internal var gazeNet: GazeNetRunner? = null

  // Session thread only.
  internal var provider: ProcessCameraProvider? = null
  internal var owner: LifecycleOwner? = null
  internal var camera: Camera? = null
  internal var analysisUseCase: ImageAnalysis? = null
  internal var previewUseCase: Preview? = null
  internal var bound = false
  internal var cameraObserver: Observer<CameraState>? = null
  internal var orientationListener: OrientationEventListener? = null
  internal var tickRunnable: Runnable? = null
  internal var thermalListener: Any? = null
  internal var analysis: ScheduledExecutorService? = null
  @Volatile internal var surfaceRotation = 0
  @Volatile internal var sensor: SensorGeometry? = null

  // Analysis thread only.
  private val batcher = Batcher()
  private val assembler = GazeInputAssembler()
  private val clock = FrameClock()
  private var inFlight: InFlight? = null
  private var lastAcceptedMs = -1.0
  private var lastTsMs = -1L
  private var frameIndex = 0
  /** The one bitmap MediaPipe reads, reused every frame (T4-I2). */
  private val frameBitmap = FrameBitmap()

  /** The frame MediaPipe owes a result for. Its ImageProxy stays open until then: the ROI luma is read from it. */
  private class InFlight(
    val proxy: ImageProxy, val tsMs: Long, val tMs: Double, val rotation: Int, val submitNs: Long, val focal: Double
  ) {
    var timeout: ScheduledFuture<*>? = null
    fun release() {
      timeout?.cancel(false)
      proxy.close()
    }
  }

  internal inline fun <T> locked(body: () -> T): T = synchronized(lock) { body() }

  val currentState: String get() = locked { state }

  // Commands (session thread)

  fun start(o: StartOptions, lifecycleOwner: LifecycleOwner) {
    val (st, tok) = locked { Pair(state, token) }
    if (st != "stopped") {
      if (tok != o.token) throw DmsError.badArgs("a different gate token")
      applyPolicy("run", o.fps, o.gazeNet, o.every, false, false)
      return
    }
    locked {
      token = o.token; fps = o.fps; gazeNetWanted = o.gazeNet; gazeNetEvery = o.every
      setupMode = false; previewAllowed = false; lastHeartbeatMs = nowMs(); pausedSinceMs = null
      rotationOffset = o.rotationOffset; interrupted = false
    }
    setState("starting", "user")
    try {
      provider = try {
        ProcessCameraProvider.getInstance(context).get(5, TimeUnit.SECONDS)
      } catch (e: Exception) {
        throw DmsError.camera("CameraX is not available: ${e.message}")
      }
      owner = lifecycleOwner
      val exec = Executors.newSingleThreadScheduledExecutor()
      analysis = exec
      val lmk = Landmarker(context, o.gpu) { ts, lm, m, err -> postResult(exec, ts, lm, m, err) }
      // Created whenever the build has the net, so a drive that starts slowly (CLOSURE_WATCH, net off)
      // still has it at speed; gazeNetWanted decides per frame whether it runs (T4-I1).
      var net: GazeNetRunner? = null
      if (GazeNetFactory.available) {
        try { net = GazeNetFactory.make(context) } catch (_: Exception) { DmsLog.code(DmsLog.Code.GAZE_NET_FAILED) }
      }
      locked { landmarker = lmk; gazeNet = net }
      sensor = CameraSetup.sensorGeometry(context)
      onAnalysis {
        batcher.clear(); assembler.reset(); clock.reset(); inFlight = null
        lastAcceptedMs = -1.0; lastTsMs = -1L; frameIndex = 0
      }
      surfaceRotation = displayRotation()
      val useCase = CameraSetup.buildAnalysis(surfaceRotation)
      useCase.setAnalyzer(exec) { proxy -> analyze(proxy) }
      analysisUseCase = useCase
      bindCamera()
      startOrientationListener()
      registerThermal()
    } catch (e: Exception) {
      locked { state = "stopped" }
      teardown()
      emitState("stopped", "error")
      throw if (e is DmsError) e else DmsError.camera(e.message ?: "cannot start the camera")
    }
    startTick()
    refreshThermal()
    setState("running", "user")
    DmsLog.code(DmsLog.Code.SESSION_STARTED)
    if (!locked { thermal.allowsCamera }) pause("thermal")
  }

  fun applyPolicy(capture: String, newFps: Int, net: Boolean, every: Int, setup: Boolean, preview: Boolean) {
    val st = locked {
      lastHeartbeatMs = nowMs()
      fps = newFps; gazeNetWanted = net; gazeNetEvery = every; setupMode = setup; previewAllowed = preview
      state
    }
    if (capture == "pause") {
      if (st == "running") pause("policy") else if (st == "paused" && bound) releaseCamera()
    } else if (st == "paused") {
      // Stay paused while the camera is unavailable: no re-bind churn every heartbeat (Task 3 review m3).
      if (locked { thermal.allowsCamera && !interrupted }) resume()
    }
    applyCadence()
    updatePreview()
  }

  /** Stopped under the lock first (late results are dropped), then teardown unbinds and flushes, then the event. */
  fun stop(reason: String) {
    val was = locked {
      val s = state
      state = "stopped"
      s
    }
    if (was == "stopped") return
    teardown()
    emitState("stopped", reason)
    DmsLog.code(if (reason == "background") DmsLog.Code.BACKGROUND_STOPPED else DmsLog.Code.SESSION_STOPPED)
  }

  /**
   * The order matters (Task 3 review m1): paused under the lock, so a result that lands later is
   * dropped; capture stops; the records already accepted are flushed; only then the state event. An
   * interruption or a camera error keeps the binding, so CameraX reopens the camera by itself and
   * reports OPEN (m3); every other pause unbinds, which closes the camera.
   */
  fun pause(reason: String) {
    val wasRunning = locked {
      if (state != "running") {
        false
      } else {
        state = "paused"
        pausedSinceMs = nowMs()
        true
      }
    }
    if (!wasRunning) return
    if (reason != "interrupted" && reason != "error") unbindCamera()
    flushBatch()
    emitState("paused", reason)
    updatePreview()
    DmsLog.code(if (reason == "thermal") DmsLog.Code.THERMAL_PAUSED else DmsLog.Code.SESSION_PAUSED)
  }

  fun resume() {
    locked { pausedSinceMs = null }
    onAnalysis {
      batcher.clear()
      inFlight?.release()
      inFlight = null
      lastAcceptedMs = -1.0
    }
    if (!bound) {
      try {
        bindCamera()
      } catch (_: Exception) {
        DmsLog.code(DmsLog.Code.CAMERA_ERROR)
        return
      }
    }
    setState("running", "policy")
    updatePreview()
    DmsLog.code(DmsLog.Code.SESSION_RESUMED)
  }

  fun teardown() {
    stopTick()
    unregisterThermal()
    stopOrientationListener()
    unbindCamera()
    analysisUseCase?.let { a -> runOnMain { a.clearAnalyzer() } }
    flushBatch()
    val exec = analysis
    if (exec != null) {
      onAnalysis {
        inFlight?.release()
        inFlight = null
        batcher.clear()
      }
      analysis = null
      exec.shutdown()
      try { exec.awaitTermination(500, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
    }
    // Only now can no detectAsync be running.
    val (lmk, net) = locked {
      val pair = Pair(landmarker, gazeNet)
      landmarker = null
      gazeNet = null
      pair
    }
    lmk?.close()
    net?.close()
    // The analysis thread is drained and the graph closed, so nothing can read the bitmap any more.
    frameBitmap.release()
    analysisUseCase = null
    provider = null
    owner = null
    sensor = null
    locked { token = null; pausedSinceMs = null; setupMode = false; previewAllowed = false; interrupted = false }
  }

  fun flushBatch() {
    onAnalysis { batcher.flush()?.let { onFrames?.invoke(it) } }
  }

  // Frames (analysis thread)

  private fun analyze(proxy: ImageProxy) {
    var keep = false
    try {
      val (st, cap, lmk, offset) = locked { Quad(state, min(fps, thermal.fpsCap), landmarker, rotationOffset) }
      // The predictive flush, checked at every frame before any early return, so a frame that is
      // throttled, refused or lost cannot stretch a batch past one interval (round-1 review m-r1).
      val arriveMs = clock.baseNowMs(SystemClock.elapsedRealtimeNanos(), System.nanoTime())
      if (cap > 0 && batcher.isDue(arriveMs, 1000.0 / cap)) batcher.flush()?.let { onFrames?.invoke(it) }
      if (st != "running" || cap <= 0 || lmk == null) return
      if (inFlight != null) { locked { dropped += 1 }; return }
      val frameNs = proxy.imageInfo.timestamp
      clock.calibrate(frameNs, SystemClock.elapsedRealtimeNanos(), System.nanoTime())
      val tMs = clock.tMs(frameNs)
      val interval = 1000.0 / cap
      if (lastAcceptedMs >= 0 && tMs - lastAcceptedMs < interval * 0.85) return
      val rotation = (((proxy.imageInfo.rotationDegrees + offset) % 360) + 360) % 360
      var tsMs = Math.round(tMs)
      if (tsMs <= lastTsMs) tsMs = lastTsMs + 1
      lastTsMs = tsMs
      val focal = Focal.focalScale(sensor, proxy.width, proxy.height, rotation)
      // Reusing one bitmap is safe: a frame is accepted only once the previous detection has
      // answered (inFlight == null above), so MediaPipe cannot still be reading it.
      val bitmap = frameBitmap.fill(proxy)
      val f = InFlight(proxy, tsMs, tMs, rotation, SystemClock.elapsedRealtimeNanos(), focal)
      inFlight = f
      lastAcceptedMs = tMs
      try {
        lmk.detect(bitmap, rotation, tsMs)
        keep = true
        // A lost callback holds capture for at most three frames, and never under 250 ms (Task 3 review m2).
        val holdMs = max(3 * interval, 250.0).toLong()
        f.timeout = analysis?.schedule({ onTimeout(tsMs) }, holdMs, TimeUnit.MILLISECONDS)
      } catch (_: Exception) {
        inFlight = null
        locked { dropped += 1 }
      }
    } catch (_: Exception) {
      locked { dropped += 1 }
    } finally {
      if (!keep) proxy.close()
    }
  }

  private fun onTimeout(tsMs: Long) {
    val f = inFlight ?: return
    if (f.tsMs != tsMs) return
    inFlight = null
    f.proxy.close()
    locked { dropped += 1 }
  }

  private fun postResult(exec: ScheduledExecutorService, ts: Long, lm: DoubleArray?, m: DoubleArray?, err: String?) {
    try { exec.execute { handleResult(ts, lm, m, err) } } catch (_: RejectedExecutionException) {}
  }

  private fun handleResult(ts: Long, landmarks: DoubleArray?, matrix: DoubleArray?, error: String?) {
    val f = inFlight ?: return
    if (ts >= 0 && f.tsMs != ts) return // a late answer for a frame the timeout already abandoned
    inFlight = null
    f.timeout?.cancel(false)
    try {
      if (error != null) { locked { dropped += 1 }; return }
      val snap = locked { if (state != "running") null else Snap(gazeNetWanted, gazeNetEvery, thermal.allowsGazeNet, gazeNet, min(fps, thermal.fpsCap)) }
        ?: return
      val latL = (SystemClock.elapsedRealtimeNanos() - f.submitNs) / 1e6
      frameIndex += 1
      val w = f.proxy.width
      val h = f.proxy.height
      val plane = f.proxy.planes[0]
      // Pixels are read through the plane's own strides, never w·4 (Task 2 review I1). RGBA order.
      val src = LumaSource(plane.buffer, w, h, plane.rowStride, plane.pixelStride, false)
      var netGaze: DoubleArray? = null
      var cloud64: DoubleArray? = null
      val gazeStart = SystemClock.elapsedRealtimeNanos()
      val net = snap.net
      if (snap.wantNet && snap.netOk && net != null && landmarks != null && frameIndex % snap.every == 0) {
        val size = Landmarks.uprightSize(w, h, f.rotation)
        val p = assembler.prepare(Landmarks.toUpright(landmarks, f.rotation), size[0].toDouble(), size[1].toDouble(), f.focal)
        if (p != null) {
          cloud64 = p.cloud64
          netGaze = try { net.run(p.cloud, p.context, p.validity).first } catch (_: Exception) { null }
        }
      }
      val record = FeatureExtractor.buildRecord(
        FrameInput(f.tMs, w, h, f.rotation, src, landmarks, matrix, netGaze, max(0.0, latL), 0.0)
      )
      val gazeMs = (SystemClock.elapsedRealtimeNanos() - gazeStart) / 1e6
      if (cloud64 != null) {
        val flags = record[F.flags].toInt()
        assembler.admit(
          cloud64, f.tMs / 1000, record[F.earR], record[F.earL],
          flags and DmsConstants.FLAG_EYE_CLIPPED_R != 0, flags and DmsConstants.FLAG_EYE_CLIPPED_L != 0
        )
      }
      // "Now" on the record clock and the wall clock, read together (anchorEpochMs; Task 3 review flag 4).
      val now = clock.baseNowMs(SystemClock.elapsedRealtimeNanos(), System.nanoTime())
      val epochNow = System.currentTimeMillis().toDouble()
      record[F.latTotalMs] = max(0.0, now - f.tMs)
      locked {
        processed += 1
        latLandmark.add(latL)
        latTotal.add(record[F.latTotalMs])
        if (netGaze != null) latGaze.add(gazeMs)
      }
      batcher.append(record, now, epochNow)
      if (batcher.isDue(now, 1000.0 / max(snap.cap, 1))) batcher.flush()?.let { onFrames?.invoke(it) }
    } finally {
      f.proxy.close()
    }
  }

  private data class Quad(val state: String, val cap: Int, val landmarker: Landmarker?, val offset: Int)
  private class Snap(val wantNet: Boolean, val every: Int, val netOk: Boolean, val net: GazeNetRunner?, val cap: Int)

  companion object {
    /** The lifecycle clock: elapsedRealtime keeps counting in deep sleep. */
    fun nowMs(): Double = SystemClock.elapsedRealtime().toDouble()
  }
}
