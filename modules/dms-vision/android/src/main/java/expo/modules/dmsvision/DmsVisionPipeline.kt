package expo.modules.dmsvision

import android.content.Context
import android.graphics.Bitmap
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.view.OrientationEventListener
import android.view.Surface
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.LifecycleOwner
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Preview-free front-camera capture (CameraX `ImageAnalysis`, no `Preview` use case) plus
 * MediaPipe FaceLandmarker in LIVE_STREAM mode.
 *
 * Design (docs/dms/NATIVE_LAYER.md):
 *   * `STRATEGY_KEEP_ONLY_LATEST` and a cadence throttle; frames that arrive while MediaPipe is
 *     busy are dropped, never queued;
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
    latch.await()
  }
  private var analysisExecutor: ExecutorService? = null
  private var cameraProvider: ProcessCameraProvider? = null
  private var imageAnalysis: ImageAnalysis? = null
  private var landmarker: FaceLandmarker? = null
  @Volatile private var orientationListener: OrientationEventListener? = null

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

  private data class PendingFrame(
    val t: Double,
    val rotationDegrees: Int,
    val orientationName: String,
    val intrinsics: DmsIntrinsics
  )

  private companion object {
    const val IN_FLIGHT_TIMEOUT_SECONDS = 1.0
    const val ANALYSIS_LONG_SIDE = 640
    const val ANALYSIS_SHORT_SIDE = 480
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
    if (running.get()) return

    this.targetFps = targetFps.coerceIn(1.0, 30.0)
    this.landmarkFrame = landmarkFrame
    this.rotationOffsetDegrees = rotationOffsetDegrees
    firstFrameSeconds = null
    lastAcceptedSeconds = -1.0
    lastTimestampMs = -1L
    inFlight = false
    pending = null

    landmarker = createLandmarker()
    analysisExecutor = Executors.newSingleThreadExecutor()
    surfaceRotation = currentDisplayRotation()

    val provider = try {
      ProcessCameraProvider.getInstance(appContext).get()
    } catch (e: Exception) {
      throw DmsVisionException("CameraX is not available: ${e.message}")
    }
    cameraProvider = provider

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
    analysis.setAnalyzer(analysisExecutor!!) { proxy -> analyze(proxy) }
    imageAnalysis = analysis

    var bindError: Exception? = null
    runOnMainBlocking {
      try {
        provider.unbindAll()
        // No Preview use case: nothing is rendered and no surface is needed.
        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_FRONT_CAMERA, analysis)
      } catch (e: Exception) {
        bindError = e
      }
    }
    val failure = bindError
    if (failure != null) {
      throw DmsVisionException("cannot bind the front camera: ${failure.message}")
    }

    startOrientationListener()
    running.set(true)
  }

  fun stop() {
    running.set(false)
    stopOrientationListener()

    val provider = cameraProvider
    val analysis = imageAnalysis
    runOnMainBlocking {
      try {
        analysis?.clearAnalyzer()
        provider?.unbindAll()
      } catch (_: Exception) {
        // ignore
      }
    }

    cameraProvider = null
    imageAnalysis = null
    analysisExecutor?.shutdown()
    analysisExecutor = null
    try {
      landmarker?.close()
    } catch (_: Exception) {
      // ignore
    }
    landmarker = null
    pending = null
    inFlight = false
  }

  fun isRunning(): Boolean = running.get()

  fun setTargetFps(fps: Double) {
    targetFps = fps.coerceIn(1.0, 30.0)
  }

  fun setIdleMode(idle: Boolean) {
    idleMode = idle
  }

  /** Processed / dropped frame counts since the previous call. */
  fun takeCounters(): Pair<Int, Int> =
    Pair(processedInWindow.getAndSet(0), droppedInWindow.getAndSet(0))

  fun intrinsicsReport(): Map<String, Any?> {
    val intrinsics = lastIntrinsics
    val rotation = lastRotationDegrees
    val upright = intrinsics.uprightSize(rotation)
    return mapOf(
      "focalScale" to intrinsics.focalScale(rotation),
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
      "orientation" to lastOrientationName,
      "isMirrored" to false
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
    } catch (_: Exception) {
      // the executor was shut down mid-stop
    }
  }

  private fun onLandmarkerResult(result: FaceLandmarkerResult?) {
    val flattened = flatten(result)
    val executor = analysisExecutor ?: return
    try {
      executor.execute { emitResult(flattened) }
    } catch (_: Exception) {
      // the executor was shut down mid-stop
    }
  }

  /** Runs on the analysis executor, so `pending` / `inFlight` stay single-threaded. */
  private fun emitResult(flattened: FloatArray?) {
    val frame = pending
    pending = null
    inFlight = false
    if (frame == null) return

    val reportBuffer = landmarkFrame == "buffer"
    val upright = frame.intrinsics.uprightSize(frame.rotationDegrees)
    val width = if (reportBuffer) frame.intrinsics.bufferWidth else upright.first
    val height = if (reportBuffer) frame.intrinsics.bufferHeight else upright.second
    val landmarks = flattened?.let {
      dmsSerializeLandmarks(it, if (reportBuffer) 0 else frame.rotationDegrees)
    }

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
        "focalScale" to frame.intrinsics.focalScale(frame.rotationDegrees),
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

      val cadence = if (idleMode) idleFps else targetFps
      val minimumInterval = 1.0 / cadence.coerceAtLeast(1.0)
      if (lastAcceptedSeconds >= 0.0 && seconds - lastAcceptedSeconds < minimumInterval - 0.002) {
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
      pending = PendingFrame(t, rotationDegrees, orientationName, intrinsics)
      inFlight = true
      inFlightSince = seconds

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
