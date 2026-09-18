package expo.modules.dmsvision

import android.content.Context
import android.graphics.Bitmap
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.util.Range
import android.view.OrientationEventListener
import android.view.Surface
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Observer
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Preview-free front-camera capture (CameraX `ImageAnalysis`, no `Preview` use case) plus
 * MediaPipe FaceLandmarker in LIVE_STREAM mode.
 *
 * Design (docs/dms/NATIVE_LAYER.md):
 *   * `STRATEGY_KEEP_ONLY_LATEST` and a cadence throttle; frames that arrive while MediaPipe is
 *     busy are dropped, never queued;
 *   * the SENSOR is driven at the cadence through `CONTROL_AE_TARGET_FPS_RANGE` (Camera2 interop),
 *     so the ISP and CameraX's YUV -> RGBA conversion are not paid for frames the throttle would
 *     discard; only ranges the device advertises are used, and the highest lower bound among them
 *     is preferred so auto-exposure cannot stretch the exposure and blur the face;
 *   * `setOutputImageRotationEnabled` is left off (its javadoc costs 10-15 ms per 640x480 frame);
 *     the rotation travels to MediaPipe as `ImageProcessingOptions.rotationDegrees` (clockwise,
 *     per the MediaPipe javadoc) and the returned landmarks are rotated into the upright frame
 *     here;
 *   * `ImageAnalysis.setMirrorMode` throws on CameraX, so Android buffers are never mirrored:
 *     `isMirrored` is always false.
 */
class DmsVisionPipeline(private val appContext: Context) {

  /** Named FrameListener, not Delegate: MediaPipe's own `Delegate` enum is imported here. */
  interface FrameListener {
    fun onFrame(payload: Map<String, Any?>)
    fun onFailure(code: String, message: String)
  }

  @Volatile var listener: FrameListener? = null

  private val mainHandler = Handler(Looper.getMainLooper())

  /** Runs [block] on the main thread and waits for it, without deadlocking when already there. */
  private fun runOnMainBlocking(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
      return
    }
    val latch = java.util.concurrent.CountDownLatch(1)
    mainHandler.post {
      try {
        block()
      } finally {
        latch.countDown()
      }
    }
    // BOUNDED: an unbounded await would hang this thread for ever if the main thread is blocked
    // (and would turn any ordering mistake into an ANR instead of a late frame).
    latch.await(MAIN_THREAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
  }
  // @Volatile throughout: `analyze()` runs on the analysis executor while start / stop run on
  // the Expo async queue, and `stop()` must be able to pull the landmarker out from under a
  // frame that is about to use it (see the ordering in stop()).
  @Volatile private var analysisExecutor: ExecutorService? = null
  @Volatile private var cameraProvider: ProcessCameraProvider? = null
  @Volatile private var imageAnalysis: ImageAnalysis? = null
  @Volatile private var landmarker: FaceLandmarker? = null
  @Volatile private var orientationListener: OrientationEventListener? = null
  @Volatile private var cameraStateObserver: Observer<CameraState>? = null
  @Volatile private var boundCameraInfo: androidx.camera.core.CameraInfo? = null
  @Volatile private var boundCamera: Camera? = null
  /** The AE range currently pushed to the device; null = the device's own default. */
  @Volatile private var appliedAeRange: Range<Int>? = null

  /** Serialises start() against stop(): a double start or a stop mid-start is impossible. */
  private val lifecycleLock = ReentrantLock()

  private val running = AtomicBoolean(false)
  private val processedInWindow = AtomicInteger(0)
  private val droppedInWindow = AtomicInteger(0)
  @Volatile private var targetFps: Double = 20.0
  @Volatile private var idleFps: Double = 5.0
  @Volatile private var idleMode: Boolean = false
  @Volatile private var landmarkFrame: String = "upright"
  @Volatile private var rotationOffsetDegrees: Int = 0
  @Volatile private var surfaceRotation: Int = Surface.ROTATION_0

  // Touched only on the analysis executor thread.
  private var firstFrameSeconds: Double? = null
  private var lastAcceptedSeconds: Double = -1.0
  private var lastTimestampMs: Long = -1L
  private var inFlight = false
  private var inFlightSince: Double = 0.0
  private var pending: PendingFrame? = null

  // Reported diagnostics.
  @Volatile private var lastIntrinsics: DmsIntrinsics = DmsIntrinsics.default(1, 1)
  @Volatile private var lastRotationDegrees: Int = 270
  @Volatile private var lastOrientationName: String = "portrait"
  /**
   * False until a frame has been accepted: until then `lastIntrinsics` is a 1x1 placeholder and
   * `intrinsicsReport()` reports null, because the JS side builds the rule engine from these
   * values and a latched placeholder mis-builds every zone (docs/dms/DETECTION_DESIGN.md §2, §4).
   */
  @Volatile private var hasProcessedFrame: Boolean = false

  private data class PendingFrame(
    val t: Double,
    /**
     * The timestamp handed to `detectAsync`. A result that carries a different one is a late
     * answer for a frame the in-flight watchdog already abandoned, and pairing it with THIS
     * frame's rotation and intrinsics would report the wrong geometry.
     */
    val timestampMs: Long,
    val rotationDegrees: Int,
    val orientationName: String,
    val intrinsics: DmsIntrinsics
  )

  private companion object {
    const val IN_FLIGHT_TIMEOUT_SECONDS = 1.0
    /**
     * Fraction of the cadence period a frame may arrive early and still be accepted.  It has to be
     * a FRACTION, not a fixed 2 ms: once the sensor runs at the cadence the frames land one period
     * apart, and a near-zero slack would reject every other one and halve the rate.
     */
    const val CADENCE_SLACK = 0.15
    const val ANALYSIS_LONG_SIDE = 640
    const val ANALYSIS_SHORT_SIDE = 480
    const val MAIN_THREAD_TIMEOUT_SECONDS = 2L
    const val PROVIDER_TIMEOUT_SECONDS = 5L
    const val EXECUTOR_DRAIN_MILLIS = 500L
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  fun start(
    lifecycleOwner: LifecycleOwner,
    targetFps: Double,
    facing: String,
    landmarkFrame: String,
    rotationOffsetDegrees: Int
  ) {
    if (facing != "front") {
      throw DmsVisionException("only the front camera is supported (facing must be 'front')")
    }
    if (landmarkFrame != "upright" && landmarkFrame != "buffer") {
      throw DmsVisionException("landmarkFrame must be 'upright' or 'buffer'")
    }
    if (rotationOffsetDegrees % 90 != 0) {
      throw DmsVisionException("rotationOffsetDegrees must be a multiple of 90")
    }

    lifecycleLock.withLock {
      if (running.get()) return

      this.targetFps = targetFps.coerceIn(1.0, 30.0)
      this.landmarkFrame = landmarkFrame
      this.rotationOffsetDegrees = rotationOffsetDegrees
      firstFrameSeconds = null
      lastAcceptedSeconds = -1.0
      lastTimestampMs = -1L
      inFlight = false
      pending = null
      hasProcessedFrame = false

      // The provider comes FIRST: creating the MediaPipe graph and the analysis thread before a
      // bind that can throw leaked both on every failed start.  BOUNDED get(): an unbounded one
      // hangs the caller for ever when CameraX cannot initialise.
      val provider = try {
        ProcessCameraProvider.getInstance(appContext).get(PROVIDER_TIMEOUT_SECONDS, TimeUnit.SECONDS)
      } catch (e: Exception) {
        throw DmsVisionException("CameraX is not available: ${e.message}")
      }

      var createdLandmarker: FaceLandmarker? = null
      var createdExecutor: ExecutorService? = null
      try {
        val newLandmarker = createLandmarker()
        createdLandmarker = newLandmarker
        val newExecutor = Executors.newSingleThreadExecutor()
        createdExecutor = newExecutor
        cameraProvider = provider
        landmarker = newLandmarker
        analysisExecutor = newExecutor

        // The sensor listener is started BEFORE the use case is built so that a rotation it can
        // already report seeds `surfaceRotation`; it usually cannot (the first callback arrives
        // one sensor sample later), which costs a few wrongly rotated frames at start - they
        // carry no face and the engine drops them (docs/dms/NATIVE_LAYER.md §2.2).
        surfaceRotation = currentDisplayRotation()
        startOrientationListener()

        val analysis = ImageAnalysis.Builder()
          .setResolutionSelector(
            ResolutionSelector.Builder()
              .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
              .setResolutionStrategy(
                ResolutionStrategy(
                  android.util.Size(ANALYSIS_LONG_SIDE, ANALYSIS_SHORT_SIDE),
                  ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                )
              )
              .build()
          )
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
          .setTargetRotation(surfaceRotation)
          .build()
        analysis.setAnalyzer(newExecutor) { proxy -> analyze(proxy) }
        imageAnalysis = analysis

        var bindError: Exception? = null
        var camera: Camera? = null
        runOnMainBlocking {
          try {
            provider.unbindAll()
            // No Preview use case: nothing is rendered and no surface is needed.
            camera = provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_FRONT_CAMERA, analysis)
          } catch (e: Exception) {
            bindError = e
          }
        }
        val failure = bindError
        if (failure != null) {
          throw DmsVisionException("cannot bind the front camera: ${failure.message}")
        }
        boundCamera = camera
        appliedAeRange = null
        applyCaptureCadence()
        observeCameraState(camera, lifecycleOwner)
        running.set(true)
      } catch (e: Exception) {
        // Release EVERYTHING this attempt created before the failure leaves the module.
        releaseAfterFailedStart(provider, createdLandmarker, createdExecutor)
        throw e
      }
    }
  }

  fun stop() {
    lifecycleLock.withLock {
      running.set(false)
      stopOrientationListener()

      // 1. Drop the landmarker reference FIRST.  `analyze()` reads it through `?: return`, so
      //    from here on no frame can capture it, and the one that already did is still inside
      //    analyze() - which step 2 waits for.  MediaPipe's TaskRunner.close() is not
      //    synchronised against detectAsync(), so closing it under a live call is a native crash.
      val doomed = landmarker
      landmarker = null

      val provider = cameraProvider
      val analysis = imageAnalysis
      val observer = cameraStateObserver
      val cameraInfo = boundCameraInfo
      cameraStateObserver = null
      boundCameraInfo = null
      runOnMainBlocking {
        try {
          if (observer != null && cameraInfo != null) cameraInfo.cameraState.removeObserver(observer)
          analysis?.clearAnalyzer()
          provider?.unbindAll()
        } catch (_: Exception) {
          // ignore
        }
      }
      cameraProvider = null
      imageAnalysis = null
      boundCamera = null
      appliedAeRange = null

      // 2. Stop the analysis thread and wait for the frame in flight to leave analyze().
      val executor = analysisExecutor
      analysisExecutor = null
      if (executor != null) {
        try {
          executor.shutdownNow()
          executor.awaitTermination(EXECUTOR_DRAIN_MILLIS, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
        } catch (_: Exception) {
          // ignore
        }
      }

      // 3. Only now can nothing be inside detectAsync any more.
      try {
        doomed?.close()
      } catch (_: Exception) {
        // ignore
      }
      pending = null
      inFlight = false
      hasProcessedFrame = false
    }
  }

  /** Undo a partial start: unbind, stop the thread, close the graph. Never throws. */
  private fun releaseAfterFailedStart(
    provider: ProcessCameraProvider?,
    created: FaceLandmarker?,
    executor: ExecutorService?
  ) {
    running.set(false)
    stopOrientationListener()
    val analysis = imageAnalysis
    runOnMainBlocking {
      try {
        analysis?.clearAnalyzer()
        provider?.unbindAll()
      } catch (_: Exception) {
        // ignore
      }
    }
    imageAnalysis = null
    cameraProvider = null
    cameraStateObserver = null
    boundCameraInfo = null
    boundCamera = null
    appliedAeRange = null
    landmarker = null
    analysisExecutor = null
    try {
      executor?.shutdownNow()
    } catch (_: Exception) {
      // ignore
    }
    try {
      created?.close()
    } catch (_: Exception) {
      // ignore
    }
  }

  /**
   * CameraX reopens the camera by itself when another app gives it back, but it never tells
   * JavaScript that it went away.  A CLOSED state with an error is reported as `onError` so the
   * JS watchdog can stop trusting the frames it is no longer getting.
   */
  private fun observeCameraState(camera: Camera?, lifecycleOwner: LifecycleOwner) {
    val info = camera?.cameraInfo ?: return
    val observer = Observer<CameraState> { state ->
      val error = state?.error
      if (state?.type == CameraState.Type.CLOSED && error != null) {
        listener?.onFailure("CAMERA_CLOSED", "CameraX closed the camera (code ${error.code})")
      }
    }
    runOnMainBlocking {
      try {
        info.cameraState.observe(lifecycleOwner, observer)
        cameraStateObserver = observer
        boundCameraInfo = info
      } catch (_: Exception) {
        cameraStateObserver = null
        boundCameraInfo = null
      }
    }
  }

  fun isRunning(): Boolean = running.get()

  fun setTargetFps(fps: Double) {
    targetFps = fps.coerceIn(1.0, 30.0)
    applyCaptureCadence()
  }

  fun setIdleMode(idle: Boolean) {
    idleMode = idle
    applyCaptureCadence()
  }

  /**
   * Asks the CAMERA for the cadence instead of capturing at the sensor's default rate and dropping
   * the surplus in software.  Sensor read-out, the ISP and CameraX's YUV -> RGBA conversion are all
   * per-frame costs (640x480x4 B = 1.2 MB per delivered frame), so at the 20 fps target this
   * removes about a third of them and at the 5 fps no-face idle about five sixths.
   *
   * Only a range the device advertises in `CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES` is ever sent,
   * and anything unexpected leaves the camera exactly as it was: the software throttle in
   * [analyze] remains the authority for what the rule engine sees.
   */
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
  private fun applyCaptureCadence() {
    val camera = boundCamera ?: return
    val cadence = if (idleMode) idleFps else targetFps
    val wanted = supportedAeRange(camera, cadence) ?: return
    if (wanted == appliedAeRange) return
    try {
      Camera2CameraControl.from(camera.cameraControl).setCaptureRequestOptions(
        CaptureRequestOptions.Builder()
          .setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, wanted)
          .build()
      )
      appliedAeRange = wanted
    } catch (_: Exception) {
      // The camera keeps the rate it had; the software throttle still delivers the cadence.
    }
  }

  /**
   * The advertised AE range whose upper bound is closest to [cadence] without falling below it
   * (a lower one would starve the rule engine), preferring the highest lower bound among equals -
   * a fixed [20, 20] over [7, 20] - so low light cannot lengthen the exposure.  Null when the
   * device advertises nothing usable, which leaves its default untouched.
   */
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
  private fun supportedAeRange(camera: Camera, cadence: Double): Range<Int>? {
    val target = Math.round(cadence).toInt().coerceIn(1, 240)
    val available = try {
      Camera2CameraInfo.from(camera.cameraInfo)
        .getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
    } catch (_: Exception) {
      null
    } ?: return null
    var best: Range<Int>? = null
    for (range in available) {
      if (range.upper < target) continue
      val current = best
      if (current == null ||
        range.upper < current.upper ||
        (range.upper == current.upper && range.lower > current.lower)
      ) {
        best = range
      }
    }
    return best
  }

  /** Processed / dropped frame counts since the previous call. */
  fun takeCounters(): Pair<Int, Int> =
    Pair(processedInWindow.getAndSet(0), droppedInWindow.getAndSet(0))

  /**
   * The camera as of the last PROCESSED frame.  Before there is one, `focalScale`, `isMirrored`
   * and `orientation` are null rather than a placeholder (see [hasProcessedFrame]).
   */
  fun intrinsicsReport(): Map<String, Any?> {
    val intrinsics = lastIntrinsics
    val rotation = lastRotationDegrees
    val known = hasProcessedFrame
    val upright = intrinsics.uprightSize(rotation)
    return mapOf(
      "focalScale" to if (known) intrinsics.focalScale(rotation) else null,
      "intrinsicsSource" to intrinsics.source,
      "fx" to intrinsics.fx,
      "fy" to intrinsics.fy,
      "cx" to intrinsics.cx,
      "cy" to intrinsics.cy,
      "bufferWidth" to intrinsics.bufferWidth,
      "bufferHeight" to intrinsics.bufferHeight,
      "width" to upright.first,
      "height" to upright.second,
      "rotationDegrees" to rotation,
      "orientation" to if (known) lastOrientationName else null,
      // ImageAnalysis.Builder.setMirrorMode throws on CameraX, so an analysis buffer is never
      // mirrored - but the JS side may not learn that before the first frame either.
      "isMirrored" to if (known) false else null
    )
  }

  // -------------------------------------------------------------------------------------------
  // MediaPipe
  // -------------------------------------------------------------------------------------------

  private fun createLandmarker(): FaceLandmarker {
    val baseOptions = BaseOptions.builder()
      // A direct ByteBuffer, so nothing depends on the asset being stored uncompressed.
      .setModelAssetBuffer(DmsVisionAssets.readDirectBuffer(appContext, "face_landmarker.task"))
      .setDelegate(Delegate.CPU)
      .build()
    val options = FaceLandmarker.FaceLandmarkerOptions.builder()
      .setBaseOptions(baseOptions)
      .setRunningMode(RunningMode.LIVE_STREAM)
      .setNumFaces(1)
      .setMinFaceDetectionConfidence(0.5f)
      .setMinFacePresenceConfidence(0.5f)
      .setMinTrackingConfidence(0.5f)
      .setOutputFaceBlendshapes(false)
      .setOutputFacialTransformationMatrixes(false)
      // The second parameter is the INPUT image, not a timestamp; the timestamp travels on the
      // result itself (TaskResult.timestampMs(), the same value detectAsync was given).
      .setResultListener { result, _ -> onLandmarkerResult(result) }
      .setErrorListener { error -> onLandmarkerError(error) }
      .build()
    return try {
      FaceLandmarker.createFromOptions(appContext, options)
    } catch (e: Exception) {
      throw DmsVisionException("cannot create the MediaPipe FaceLandmarker: ${e.message}")
    }
  }

  private fun onLandmarkerError(error: RuntimeException) {
    val executor = analysisExecutor ?: return
    val message = error.message ?: "MediaPipe error"
    try {
      executor.execute {
        pending = null
        inFlight = false
        droppedInWindow.incrementAndGet()
        listener?.onFailure("INFERENCE_FAILED", message)
      }
      // (the error listener carries no timestamp, so the pending frame is dropped either way)
    } catch (_: Exception) {
      // the executor was shut down mid-stop
    }
  }

  private fun onLandmarkerResult(result: FaceLandmarkerResult?) {
    val flattened = flatten(result)
    val timestampMs = try {
      result?.timestampMs() ?: -1L
    } catch (_: Exception) {
      -1L
    }
    val executor = analysisExecutor ?: return
    try {
      executor.execute { emitResult(flattened, timestampMs) }
    } catch (_: Exception) {
      // the executor was shut down mid-stop
    }
  }

  /** Runs on the analysis executor, so `pending` / `inFlight` stay single-threaded. */
  private fun emitResult(flattened: FloatArray?, timestampMs: Long) {
    val frame = pending
    if (frame == null) {
      inFlight = false
      return
    }
    // A result whose timestamp is not the pending frame's is a late answer for a frame the
    // in-flight watchdog already abandoned: pairing it with THIS frame's rotation, intrinsics
    // and time would report the wrong geometry.  (timestampMs <= 0 means the runtime did not
    // report one, in which case the pairing is all there is.)
    if (timestampMs > 0L && frame.timestampMs != timestampMs) {
      droppedInWindow.incrementAndGet()
      return
    }
    pending = null
    inFlight = false

    val reportBuffer = landmarkFrame == "buffer"
    val upright = frame.intrinsics.uprightSize(frame.rotationDegrees)
    val width = if (reportBuffer) frame.intrinsics.bufferWidth else upright.first
    val height = if (reportBuffer) frame.intrinsics.bufferHeight else upright.second
    val landmarks = flattened?.let {
      dmsSerializeLandmarks(it, if (reportBuffer) 0 else frame.rotationDegrees)
    }
    // `focalScale` is fx / reported width, so with landmarkFrame: 'buffer' (the harness) it must
    // be measured in the BUFFER frame, exactly like the width and height above.
    val focalScale = frame.intrinsics.focalScale(if (reportBuffer) 0 else frame.rotationDegrees)

    processedInWindow.incrementAndGet()
    listener?.onFrame(
      mapOf(
        "t" to frame.t,
        "width" to width,
        "height" to height,
        "facePresent" to (flattened != null),
        "score" to if (flattened != null) 1.0 else 0.0,
        // ImageAnalysis.Builder.setMirrorMode throws "setMirrorMode is not supported", so
        // CameraX analysis buffers are never mirrored.
        "isMirrored" to false,
        "focalScale" to focalScale,
        "intrinsicsSource" to frame.intrinsics.source,
        "orientation" to frame.orientationName,
        "landmarks" to landmarks
      )
    )
  }

  private fun flatten(result: FaceLandmarkerResult?): FloatArray? {
    val faces = result?.faceLandmarks() ?: return null
    if (faces.isEmpty()) return null
    val face = faces[0]
    if (face.size != DMS_NUM_LANDMARKS) return null
    val out = FloatArray(DMS_NUM_LANDMARKS * 3)
    for (i in 0 until DMS_NUM_LANDMARKS) {
      val point = face[i]
      val x = point.x()
      val y = point.y()
      val z = point.z()
      if (!x.isFinite() || !y.isFinite() || !z.isFinite()) return null
      out[i * 3] = x
      out[i * 3 + 1] = y
      out[i * 3 + 2] = z
    }
    return out
  }

  // -------------------------------------------------------------------------------------------
  // Frame intake (analysis executor)
  // -------------------------------------------------------------------------------------------

  private fun analyze(proxy: ImageProxy) {
    try {
      if (!running.get()) return
      val landmarkerRef = landmarker ?: return

      // ImageInfo.timestamp is in nanoseconds on a monotonic clock.
      val seconds = proxy.imageInfo.timestamp / 1_000_000_000.0
      if (!seconds.isFinite() || seconds <= 0.0) return

      // The slack is a fraction of the period: the sensor is now asked for the cadence, so frames
      // land one period apart and a 2 ms slack would reject every other one (a 20 fps request would
      // have run at 10).  On a device that cannot produce the cadence the surplus frames still fall
      // outside the window, exactly as before.
      val cadence = if (idleMode) idleFps else targetFps
      val minimumInterval = 1.0 / cadence.coerceAtLeast(1.0)
      if (lastAcceptedSeconds >= 0.0 &&
        seconds - lastAcceptedSeconds < minimumInterval * (1.0 - CADENCE_SLACK)
      ) {
        return
      }

      // Never queue: if MediaPipe still owes a result, drop this frame.
      if (inFlight) {
        if (seconds - inFlightSince < IN_FLIGHT_TIMEOUT_SECONDS) {
          droppedInWindow.incrementAndGet()
          return
        }
        inFlight = false
        pending = null
        droppedInWindow.incrementAndGet()
      }

      val width = proxy.width
      val height = proxy.height
      val base = proxy.imageInfo.rotationDegrees
      val rotationDegrees = (((base + rotationOffsetDegrees) % 360) + 360) % 360
      val orientationName = dmsOrientationName(surfaceRotation)
      val intrinsics = if (lastIntrinsics.bufferWidth == width && lastIntrinsics.bufferHeight == height) {
        lastIntrinsics
      } else {
        dmsFrontCameraIntrinsics(appContext, width, height)
      }

      if (firstFrameSeconds == null) firstFrameSeconds = seconds
      val t = seconds - (firstFrameSeconds ?: seconds)

      var timestampMs = Math.round(seconds * 1000.0)
      if (timestampMs <= lastTimestampMs) timestampMs = lastTimestampMs + 1
      lastTimestampMs = timestampMs

      val bitmap: Bitmap = try {
        proxy.toBitmap()
      } catch (e: Exception) {
        droppedInWindow.incrementAndGet()
        listener?.onFailure("FRAME_CONVERSION_FAILED", e.message ?: "toBitmap failed")
        return
      }

      lastAcceptedSeconds = seconds
      lastIntrinsics = intrinsics
      lastRotationDegrees = rotationDegrees
      lastOrientationName = orientationName
      pending = PendingFrame(t, timestampMs, rotationDegrees, orientationName, intrinsics)
      inFlight = true
      inFlightSince = seconds
      hasProcessedFrame = true          // the intrinsics report is real from here on

      try {
        val image = BitmapImageBuilder(bitmap).build()
        val processing = ImageProcessingOptions.builder()
          // MediaPipe's setRotationDegrees is documented CLOCKWISE, and CameraX's
          // ImageInfo.rotationDegrees is "the clockwise rotation to apply to the buffer".
          .setRotationDegrees(rotationDegrees)
          .build()
        landmarkerRef.detectAsync(image, processing, timestampMs)
      } catch (e: Exception) {
        inFlight = false
        pending = null
        droppedInWindow.incrementAndGet()
        listener?.onFailure("INFERENCE_FAILED", e.message ?: "detectAsync failed")
      } finally {
        // MediaPipe copies the bitmap into its packet inside detectAsync.
        bitmap.recycle()
      }
    } finally {
      proxy.close()
    }
  }

  // -------------------------------------------------------------------------------------------
  // Orientation
  // -------------------------------------------------------------------------------------------

  private fun currentDisplayRotation(): Int {
    return try {
      val displayManager = appContext.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
      displayManager?.getDisplay(android.view.Display.DEFAULT_DISPLAY)?.rotation ?: Surface.ROTATION_0
    } catch (_: Exception) {
      Surface.ROTATION_0
    }
  }

  /**
   * The app is portrait-locked, so `Display.getRotation()` never changes; the physical device
   * orientation has to come from the accelerometer instead. Updating the analysis use case's
   * target rotation is what makes `ImageInfo.rotationDegrees` track the mount.
   */
  private fun startOrientationListener() {
    stopOrientationListener()
    runOnMainBlocking {
      val watcher = object : OrientationEventListener(appContext) {
        override fun onOrientationChanged(orientation: Int) {
          if (orientation == ORIENTATION_UNKNOWN) return
          val rotation = dmsSurfaceRotation(orientation)
          if (rotation == surfaceRotation) return
          surfaceRotation = rotation
          imageAnalysis?.targetRotation = rotation
        }
      }
      if (watcher.canDetectOrientation()) {
        watcher.enable()
        orientationListener = watcher
      }
    }
  }

  private fun stopOrientationListener() {
    val watcher = orientationListener ?: return
    orientationListener = null
    runOnMainBlocking { watcher.disable() }
  }
}
