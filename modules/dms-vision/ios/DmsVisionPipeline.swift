// Preview-free front-camera capture + MediaPipe FaceLandmarker (LIVE_STREAM).
//
// Design (docs/dms/NATIVE_LAYER.md):
//   * we own an AVCaptureSession with a single AVCaptureVideoDataOutput on a serial queue;
//     there is no AVCaptureVideoPreviewLayer and no view, so nothing in the React tree can
//     stop the session by being unmounted;
//   * the lowest format whose long side is >= 640 px at 30 fps, zoom 1.0, stabilization off
//     (it disables intrinsics delivery), mirroring off, connection rotation left at 0;
//   * the CAPTURE RATE follows the cadence (20 / 10 / 5 fps), so the sensor and the ISP are not
//     asked for frames that would only be discarded; the auto-exposure ceiling stays at 1/30 s
//     so a slower capture rate cannot lengthen the exposure and add motion blur;
//   * the device orientation is handed to MediaPipe as MPImage.orientation - pixels are never
//     rotated - and the returned landmarks are rotated into the upright frame here;
//   * exactly one detection is in flight at a time; frames that arrive while MediaPipe is busy
//     are dropped, never queued.
//
// Every MediaPipe symbol below is verified against mediapipe v0.10.35 (the pinned pod):
// MPPBaseOptions {modelAssetPath, delegate}, MPPFaceLandmarkerOptions
// {runningMode, faceLandmarkerLiveStreamDelegate, numFaces, minFaceDetectionConfidence,
// minFacePresenceConfidence, minTrackingConfidence, outputFaceBlendshapes,
// outputFacialTransformationMatrixes}, MPImage(pixelBuffer:orientation:),
// detectAsync(image:timestampInMilliseconds:).

import Foundation
import AVFoundation
import MediaPipeTasksVision
import UIKit

internal protocol DmsVisionPipelineDelegate: AnyObject {
  func pipelineDidProduce(frame: [String: Any?])
  func pipelineDidFail(code: String, message: String)
  /// The OS interrupted (false) or resumed (true) the session; JS decides what to do about it.
  func pipelineDidChangeRunning(_ running: Bool)
}

internal final class DmsVisionPipeline: NSObject {
  weak var delegate: DmsVisionPipelineDelegate?

  // Queues.  `sessionQueue` is internal because the module's start / stop async functions are
  // dispatched onto it (`.runOnQueue`), which is what keeps every session mutation serialised
  // on one queue without a nested `sync`.
  let sessionQueue = DispatchQueue(label: "com.roadcash.dmsvision.session")
  private let videoQueue = DispatchQueue(label: "com.roadcash.dmsvision.video")

  // Session objects (sessionQueue)
  private var captureSession: AVCaptureSession?
  private var videoOutput: AVCaptureVideoDataOutput?
  private var captureDevice: AVCaptureDevice?

  // Cadence + frame bookkeeping (videoQueue only)
  private var targetFps: Double = 20
  /// `let`, not `var`: `applyCaptureCadence` reads it from sessionQueue.
  private let idleFps: Double = 5
  private var idleMode: Bool = false
  private var landmarkFrame: String = "upright"
  private var rotationOffsetDegrees: Int = 0
  private var firstFrameSeconds: Double?
  private var lastAcceptedSeconds: Double = -1
  private var lastTimestampMs: Int = -1
  private var inFlight = false
  private var inFlightSince: Double = 0
  private var pending: PendingFrame?
  private static let inFlightTimeoutSeconds: Double = 1.0
  /// Fraction of the cadence period a frame may arrive early and still be accepted.  It has to be
  /// a FRACTION, not a fixed 2 ms: once the sensor itself runs at the cadence the frames land one
  /// period apart, and a near-zero slack would reject every other one and halve the rate.
  private static let cadenceSlack: Double = 0.15

  // Shared state (stateLock)
  private let stateLock = NSLock()
  private var running = false
  private var processedInWindow = 0
  private var droppedInWindow = 0
  private var formatFovDegrees: Double = 0
  private var deviceOrientation: UIDeviceOrientation = .portrait
  private var lastIntrinsics = DmsIntrinsics()
  private var lastRotationDegrees = 90
  private var lastOrientationName = "portrait"
  private var lastIsMirrored = false
  /// False until a frame has been accepted: before that the intrinsics, the mirror flag and the
  /// orientation are placeholders and `intrinsicsReport()` reports null instead
  /// (docs/dms/DETECTION_DESIGN.md §2, §4).
  private var hasProcessedFrame = false
  private var landmarkerStorage: FaceLandmarker?
  /// The cadence the capture device is driven from, mirrored here because `targetFps` and
  /// `idleMode` belong to videoQueue while the device is configured on sessionQueue.
  private var requestedFps: Double = 20
  private var requestedIdle: Bool = false
  private var appliedDeviceFps: Double = 0

  /// Created on sessionQueue, read on videoQueue - hence the lock.
  private var landmarker: FaceLandmarker? {
    get {
      stateLock.lock()
      defer { stateLock.unlock() }
      return landmarkerStorage
    }
    set {
      stateLock.lock()
      landmarkerStorage = newValue
      stateLock.unlock()
    }
  }

  private struct PendingFrame {
    let t: Double
    /// The timestamp handed to `detectAsync`; the result callback must carry the same one or it
    /// belongs to a frame the in-flight watchdog already abandoned.
    let timestampMs: Int
    let rotationDegrees: Int
    let orientationName: String
    let intrinsics: DmsIntrinsics
    let isMirrored: Bool
    /// Held so the CVPixelBuffer MediaPipe retained cannot be recycled before the result.
    let image: MPImage
  }

  /// Main thread only: keeps `beginGeneratingDeviceOrientationNotifications` balanced with its
  /// `end...` across the several paths that stop the pipeline.
  private var orientationNotificationsActive = false

  // MARK: - Lifecycle

  /// MUST be called on `sessionQueue` (the module dispatches its `start` there with
  /// `.runOnQueue`), so nothing here may `sync` back onto that queue.
  func startOnSessionQueue(targetFps: Double, facing: String, landmarkFrame: String,
                           rotationOffsetDegrees: Int) throws {
    #if DEBUG
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    #endif
    guard facing == "front" else {
      throw DmsVisionException("only the front camera is supported (facing must be 'front')")
    }
    guard landmarkFrame == "upright" || landmarkFrame == "buffer" else {
      throw DmsVisionException("landmarkFrame must be 'upright' or 'buffer'")
    }
    guard rotationOffsetDegrees % 90 == 0 else {
      throw DmsVisionException("rotationOffsetDegrees must be a multiple of 90")
    }

    videoQueue.sync {
      self.targetFps = max(1.0, min(30.0, targetFps))
      self.landmarkFrame = landmarkFrame
      self.rotationOffsetDegrees = rotationOffsetDegrees
      self.firstFrameSeconds = nil
      self.lastAcceptedSeconds = -1
      self.lastTimestampMs = -1
      self.inFlight = false
      self.pending = nil
    }
    stateLock.lock()
    hasProcessedFrame = false
    requestedFps = max(1.0, min(30.0, targetFps))
    requestedIdle = false
    appliedDeviceFps = 0
    stateLock.unlock()

    // UIDevice.orientation is only populated after begin...Notifications() and must be read on
    // the main thread, so it is cached here and consumed on videoQueue. Until the first
    // notification arrives the cached default (portrait) applies.  The flag keeps begin / end
    // balanced across the several stop paths (a UIKit refcount, not a boolean).
    DispatchQueue.main.async {
      if !self.orientationNotificationsActive {
        self.orientationNotificationsActive = true
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(self.onDeviceOrientationChanged),
                                               name: UIDevice.orientationDidChangeNotification,
                                               object: nil)
      }
      self.updateDeviceOrientation()
    }

    do {
      try configure()
      addSessionObservers()
      captureSession?.startRunning()
      stateLock.lock()
      running = true
      stateLock.unlock()
    } catch {
      stopOnSessionQueue()
      throw error
    }
  }

  /// MUST be called on `sessionQueue` (see `startOnSessionQueue`).
  func stopOnSessionQueue() {
    #if DEBUG
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    #endif
    stateLock.lock()
    running = false
    hasProcessedFrame = false
    stateLock.unlock()

    removeSessionObservers()
    captureSession?.stopRunning()
    captureSession = nil
    videoOutput = nil
    captureDevice = nil
    landmarker = nil
    stateLock.lock()
    appliedDeviceFps = 0
    stateLock.unlock()
    videoQueue.sync {
      self.inFlight = false
      self.pending = nil
      self.firstFrameSeconds = nil
      self.lastAcceptedSeconds = -1
      self.lastTimestampMs = -1
    }
    DispatchQueue.main.async {
      if self.orientationNotificationsActive {
        self.orientationNotificationsActive = false
        NotificationCenter.default.removeObserver(self,
                                                  name: UIDevice.orientationDidChangeNotification,
                                                  object: nil)
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
      }
    }
  }

  // MARK: - Session interruptions (AVCaptureSession notifications)

  /// The OS can take the camera away (a phone call, another app, the app leaving the
  /// foreground).  AVFoundation does not tell JavaScript, so without these the session would be
  /// dead while `running` still said true and the rules kept their last frame forever.
  private func addSessionObservers() {
    guard let session = captureSession else { return }
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(onSessionRuntimeError),
                       name: .AVCaptureSessionRuntimeError, object: session)
    center.addObserver(self, selector: #selector(onSessionInterrupted),
                       name: .AVCaptureSessionWasInterrupted, object: session)
    center.addObserver(self, selector: #selector(onSessionInterruptionEnded),
                       name: .AVCaptureSessionInterruptionEnded, object: session)
  }

  private func removeSessionObservers() {
    guard let session = captureSession else { return }
    let center = NotificationCenter.default
    center.removeObserver(self, name: .AVCaptureSessionRuntimeError, object: session)
    center.removeObserver(self, name: .AVCaptureSessionWasInterrupted, object: session)
    center.removeObserver(self, name: .AVCaptureSessionInterruptionEnded, object: session)
  }

  @objc private func onSessionRuntimeError(_ note: Notification) {
    let message = (note.userInfo?[AVCaptureSessionErrorKey] as? NSError)?.localizedDescription
      ?? "the capture session failed"
    markRunning(false)
    delegate?.pipelineDidFail(code: "CAMERA_RUNTIME_ERROR", message: message)
    delegate?.pipelineDidChangeRunning(false)
  }

  @objc private func onSessionInterrupted(_ note: Notification) {
    let reason = (note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int) ?? -1
    markRunning(false)
    delegate?.pipelineDidFail(code: "CAMERA_INTERRUPTED", message: "interruption reason \(reason)")
    delegate?.pipelineDidChangeRunning(false)
  }

  @objc private func onSessionInterruptionEnded(_ note: Notification) {
    let stillRunning = captureSession?.isRunning ?? false
    if stillRunning { markRunning(true) }
    delegate?.pipelineDidChangeRunning(stillRunning)
  }

  private func markRunning(_ value: Bool) {
    stateLock.lock()
    running = value
    stateLock.unlock()
  }

  var isRunning: Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return running
  }

  func setTargetFps(_ fps: Double) {
    let clamped = max(1.0, min(30.0, fps))
    videoQueue.async { self.targetFps = clamped }
    stateLock.lock()
    requestedFps = clamped
    stateLock.unlock()
    sessionQueue.async { [weak self] in self?.applyCaptureCadence() }
  }

  func setIdleMode(_ idle: Bool) {
    videoQueue.async { self.idleMode = idle }
    stateLock.lock()
    requestedIdle = idle
    stateLock.unlock()
    sessionQueue.async { [weak self] in self?.applyCaptureCadence() }
  }

  // MARK: - Capture cadence (sessionQueue)

  /// Drives the CAMERA at the cadence instead of capturing 30 fps and dropping the surplus in
  /// software.  Sensor read-out, the ISP, the BGRA conversion and the buffer traffic are all
  /// per-frame costs (640x480x4 B = 1.2 MB per frame), so at the 20 fps target this removes a
  /// third of them and at the 5 fps no-face idle five sixths.  The software throttle in
  /// `captureOutput` stays as the authority: a device that cannot deliver the requested rate
  /// keeps its old behaviour exactly.
  private func applyCaptureCadence() {
    #if DEBUG
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    #endif
    guard let camera = captureDevice else { return }
    stateLock.lock()
    let cadence = requestedIdle ? idleFps : requestedFps
    let applied = appliedDeviceFps
    stateLock.unlock()

    let wanted = Self.supportedCaptureFps(camera, cadence)
    if abs(wanted - applied) < 0.01 { return }
    do {
      try camera.lockForConfiguration()
      let duration = CMTimeMake(value: 1000, timescale: Int32((wanted * 1000).rounded()))
      camera.activeVideoMinFrameDuration = duration
      camera.activeVideoMaxFrameDuration = duration
      Self.applyExposureCap(camera)
      camera.unlockForConfiguration()
      stateLock.lock()
      appliedDeviceFps = wanted
      stateLock.unlock()
    } catch {
      // Not fatal: the session keeps the rate it already had and the software throttle still
      // delivers the cadence.
    }
  }

  /// The rate closest to `wanted` that the ACTIVE format can actually produce, never lower than
  /// `wanted` (a lower one would starve the rule engine).  When no range reaches it, the format's
  /// fastest rate is used - i.e. exactly what the pipeline did before this existed.
  private static func supportedCaptureFps(_ device: AVCaptureDevice, _ wanted: Double) -> Double {
    var best = Double.greatestFiniteMagnitude
    var fastest = 0.0
    for range in device.activeFormat.videoSupportedFrameRateRanges {
      fastest = max(fastest, range.maxFrameRate)
      let candidate = min(max(wanted, range.minFrameRate), range.maxFrameRate)
      if candidate >= wanted - 0.01 && candidate < best { best = candidate }
    }
    if best == Double.greatestFiniteMagnitude { return fastest > 0 ? fastest : 30.0 }
    return best
  }

  /// Keeps auto-exposure at 1/30 s or shorter.  Without it, a 5 fps frame duration would let the
  /// AE algorithm expose for up to 200 ms in the dark and the face would smear - the capture rate
  /// must cost battery, never image quality.  Must be called with the device locked.
  private static func applyExposureCap(_ device: AVCaptureDevice) {
    let format = device.activeFormat
    var cap = CMTimeMake(value: 1, timescale: 30)
    if CMTimeCompare(cap, format.minExposureDuration) < 0 { cap = format.minExposureDuration }
    if CMTimeCompare(cap, format.maxExposureDuration) > 0 { cap = format.maxExposureDuration }
    guard cap.isValid, !cap.isIndefinite else { return }
    device.activeMaxExposureDuration = cap
  }

  /// Processed / dropped frame counts since the previous call.
  func takeCounters() -> (processed: Int, dropped: Int) {
    stateLock.lock()
    defer { stateLock.unlock() }
    let out = (processedInWindow, droppedInWindow)
    processedInWindow = 0
    droppedInWindow = 0
    return out
  }

  /// The camera as of the last PROCESSED frame.  Before there is one, `focalScale`,
  /// `isMirrored` and `orientation` are null rather than a placeholder: the JS side builds the
  /// rule engine from them and a latched placeholder mis-builds every zone
  /// (docs/dms/DETECTION_DESIGN.md §2, §4).
  func intrinsicsReport() -> [String: Any] {
    stateLock.lock()
    let intrinsics = lastIntrinsics
    let rotation = lastRotationDegrees
    let orientation = lastOrientationName
    let mirrored = lastIsMirrored
    let known = hasProcessedFrame
    stateLock.unlock()
    let upright = intrinsics.uprightSize(rotationDegrees: rotation)
    // NSNull() crosses the bridge as JavaScript `null`; the JS wrapper passes it through.
    let focalValue: Any = known ? intrinsics.focalScale(rotationDegrees: rotation) : NSNull()
    let orientationValue: Any = known ? orientation : NSNull()
    let mirroredValue: Any = known ? mirrored : NSNull()
    return [
      "focalScale": focalValue,
      "intrinsicsSource": intrinsics.source,
      "fx": intrinsics.fx,
      "fy": intrinsics.fy,
      "cx": intrinsics.cx,
      "cy": intrinsics.cy,
      "bufferWidth": intrinsics.bufferWidth,
      "bufferHeight": intrinsics.bufferHeight,
      "width": upright.width,
      "height": upright.height,
      "rotationDegrees": rotation,
      "orientation": orientationValue,
      "isMirrored": mirroredValue
    ]
  }

  // MARK: - Orientation (main thread)

  @objc private func onDeviceOrientationChanged() {
    updateDeviceOrientation()
  }

  private func updateDeviceOrientation() {
    let orientation = UIDevice.current.orientation
    switch orientation {
    case .portrait, .portraitUpsideDown, .landscapeLeft, .landscapeRight:
      stateLock.lock()
      deviceOrientation = orientation
      stateLock.unlock()
    default:
      break            // .faceUp / .faceDown / .unknown: keep the last real orientation
    }
  }

  // MARK: - Configuration (sessionQueue)

  private func configure() throws {
    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
      throw DmsVisionException("no front camera is available on this device")
    }

    let session = AVCaptureSession()
    session.beginConfiguration()
    // Setting activeFormat below takes priority over any preset; declare that explicitly.
    session.sessionPreset = .inputPriority

    let input: AVCaptureDeviceInput
    do {
      input = try AVCaptureDeviceInput(device: camera)
    } catch {
      session.commitConfiguration()
      throw DmsVisionException("cannot open the front camera: \(error.localizedDescription)")
    }
    guard session.canAddInput(input) else {
      session.commitConfiguration()
      throw DmsVisionException("the capture session refused the front camera input")
    }
    session.addInput(input)

    let output = AVCaptureVideoDataOutput()
    // MediaPipe's MPImage accepts 32BGRA pixel buffers.
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    output.alwaysDiscardsLateVideoFrames = true
    output.setSampleBufferDelegate(self, queue: videoQueue)
    guard session.canAddOutput(output) else {
      session.commitConfiguration()
      throw DmsVisionException("the capture session refused the video data output")
    }
    session.addOutput(output)

    if let format = Self.pickFormat(camera) {
      do {
        try camera.lockForConfiguration()
        camera.activeFormat = format
        camera.videoZoomFactor = 1.0
        camera.unlockForConfiguration()
      } catch {
        // Not fatal: the session keeps whatever format it negotiated.
      }
    }
    // The frame duration is set from the cadence (below), not pinned at 1/30.
    captureDevice = camera
    applyCaptureCadence()

    var mirrored = false
    if let connection = output.connection(with: .video) {
      connection.automaticallyAdjustsVideoMirroring = false
      if connection.isVideoMirroringSupported {
        connection.isVideoMirrored = false
      }
      // Stabilization must stay off: it invalidates the intrinsic matrix and Apple then stops
      // delivering it (Apple Developer Forums thread 82668).
      if connection.isVideoStabilizationSupported {
        connection.preferredVideoStabilizationMode = .off
      }
      // Must be set before startRunning(); buffers are never physically rotated, so the
      // intrinsic matrix stays in the delivered buffer's frame.
      if connection.isCameraIntrinsicMatrixDeliverySupported {
        connection.isCameraIntrinsicMatrixDeliveryEnabled = true
      }
      mirrored = connection.isVideoMirrored
    }
    session.commitConfiguration()

    let baseOptions = BaseOptions()
    baseOptions.modelAssetPath = try DmsVisionBundle.require("face_landmarker", "task")
    baseOptions.delegate = .CPU

    let options = FaceLandmarkerOptions()
    options.baseOptions = baseOptions
    options.runningMode = .liveStream
    options.numFaces = 1
    options.minFaceDetectionConfidence = 0.5
    options.minFacePresenceConfidence = 0.5
    options.minTrackingConfidence = 0.5
    options.outputFaceBlendshapes = false
    options.outputFacialTransformationMatrixes = false
    options.faceLandmarkerLiveStreamDelegate = self

    let created: FaceLandmarker
    do {
      created = try FaceLandmarker(options: options)
    } catch {
      throw DmsVisionException("cannot create the MediaPipe FaceLandmarker: \(error.localizedDescription)")
    }

    stateLock.lock()
    lastIsMirrored = mirrored
    formatFovDegrees = Double(camera.activeFormat.videoFieldOfView)
    stateLock.unlock()

    captureSession = session
    videoOutput = output
    landmarker = created
  }

  /// The lowest-resolution format whose long side is at least 640 px and that supports 30 fps.
  private static func pickFormat(_ device: AVCaptureDevice) -> AVCaptureDevice.Format? {
    var best: AVCaptureDevice.Format?
    var bestArea = Int.max
    for format in device.formats {
      let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
      let width = Int(dimensions.width)
      let height = Int(dimensions.height)
      guard max(width, height) >= 640, min(width, height) > 0 else { continue }
      let supports30 = format.videoSupportedFrameRateRanges.contains {
        $0.minFrameRate <= 30.0 && $0.maxFrameRate >= 30.0
      }
      guard supports30 else { continue }
      let area = width * height
      if area < bestArea {
        bestArea = area
        best = format
      }
    }
    return best
  }

  // MARK: - Helpers

  private func countDropped() {
    stateLock.lock()
    droppedInWindow += 1
    stateLock.unlock()
  }
}

// MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

extension DmsVisionPipeline: AVCaptureVideoDataOutputSampleBufferDelegate {
  func captureOutput(_ output: AVCaptureOutput,
                     didOutput sampleBuffer: CMSampleBuffer,
                     from connection: AVCaptureConnection) {
    guard isRunning, let landmarker = landmarker else { return }
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

    let presentation = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    guard presentation.isFinite else { return }

    // Cadence throttle.  The slack is a fraction of the period: the sensor is now driven at the
    // cadence, so frames land one period apart and a 2 ms slack would reject every other one (a
    // 20 fps request would have run at 10).  On a device whose format cannot produce the cadence
    // the surplus frames still fall outside the window, exactly as before.
    let cadence = idleMode ? idleFps : targetFps
    let minimumInterval = 1.0 / max(1.0, cadence)
    if lastAcceptedSeconds >= 0
        && presentation - lastAcceptedSeconds < minimumInterval * (1.0 - Self.cadenceSlack) {
      return
    }

    // Never queue: if MediaPipe still owes a result, drop this frame. The timeout covers the
    // documented case where LIVE_STREAM discards an input without emitting a result.
    if inFlight {
      if presentation - inFlightSince < Self.inFlightTimeoutSeconds {
        countDropped()
        return
      }
      inFlight = false
      pending = nil
      countDropped()
    }

    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)

    stateLock.lock()
    let orientation = deviceOrientation
    let fov = formatFovDegrees
    stateLock.unlock()

    let base = dmsRotationDegrees(for: orientation)
    let rotationDegrees = (((base + rotationOffsetDegrees) % 360) + 360) % 360
    let orientationName = dmsOrientationName(for: orientation)

    let intrinsics = dmsIntrinsicsFromSampleBuffer(sampleBuffer, width: width, height: height)
      ?? DmsIntrinsics.fromFieldOfView(fov, width: width, height: height, source: "fov")
    let mirrored = connection.isVideoMirrored

    if firstFrameSeconds == nil { firstFrameSeconds = presentation }
    let t = presentation - (firstFrameSeconds ?? presentation)

    var timestampMs = Int((presentation * 1000.0).rounded())
    if timestampMs <= lastTimestampMs { timestampMs = lastTimestampMs + 1 }
    lastTimestampMs = timestampMs

    let image: MPImage
    do {
      image = try MPImage(pixelBuffer: pixelBuffer,
                          orientation: dmsImageOrientation(forClockwiseDegrees: rotationDegrees))
    } catch {
      countDropped()
      delegate?.pipelineDidFail(code: "FRAME_CONVERSION_FAILED", message: error.localizedDescription)
      return
    }

    lastAcceptedSeconds = presentation
    pending = PendingFrame(t: t,
                           timestampMs: timestampMs,
                           rotationDegrees: rotationDegrees,
                           orientationName: orientationName,
                           intrinsics: intrinsics,
                           isMirrored: mirrored,
                           image: image)
    inFlight = true
    inFlightSince = presentation

    stateLock.lock()
    lastIntrinsics = intrinsics
    lastRotationDegrees = rotationDegrees
    lastOrientationName = orientationName
    lastIsMirrored = mirrored
    hasProcessedFrame = true            // the intrinsics report is real from here on
    stateLock.unlock()

    do {
      try landmarker.detectAsync(image: image, timestampInMilliseconds: timestampMs)
    } catch {
      inFlight = false
      pending = nil
      countDropped()
      delegate?.pipelineDidFail(code: "INFERENCE_FAILED", message: error.localizedDescription)
    }
  }
}

// MARK: - FaceLandmarkerLiveStreamDelegate

extension DmsVisionPipeline: FaceLandmarkerLiveStreamDelegate {
  func faceLandmarker(_ faceLandmarker: FaceLandmarker,
                      didFinishDetection result: FaceLandmarkerResult?,
                      timestampInMilliseconds: Int,
                      error: Error?) {
    // MediaPipe calls back on its own thread; hop to videoQueue so `pending` / `inFlight`
    // stay single-threaded.
    let flattened = Self.flatten(result)
    let failure = error?.localizedDescription
    videoQueue.async { [weak self] in
      guard let self = self else { return }
      guard let frame = self.pending else {
        self.inFlight = false
        return
      }
      // A result that does not carry the pending frame's timestamp is a late answer for a frame
      // the 1 s in-flight watchdog already abandoned: pairing it with THIS frame's metadata
      // would report the wrong rotation, intrinsics and time.
      guard frame.timestampMs == timestampInMilliseconds else {
        self.countDropped()
        return
      }
      self.pending = nil
      self.inFlight = false

      if let failure = failure {
        self.countDropped()
        self.delegate?.pipelineDidFail(code: "INFERENCE_FAILED", message: failure)
        return
      }

      let reportBuffer = self.landmarkFrame == "buffer"
      let upright = frame.intrinsics.uprightSize(rotationDegrees: frame.rotationDegrees)
      let width = reportBuffer ? frame.intrinsics.bufferWidth : upright.width
      let height = reportBuffer ? frame.intrinsics.bufferHeight : upright.height

      var payload: [String: Any?] = [
        "t": frame.t,
        "width": width,
        "height": height,
        "facePresent": flattened != nil,
        "score": flattened != nil ? 1.0 : 0.0,
        "isMirrored": frame.isMirrored,
        // `focalScale` is fx / reported width, so with landmarkFrame: 'buffer' (the harness) it
        // must be measured in the BUFFER frame, exactly like the width and height above.
        "focalScale": frame.intrinsics.focalScale(rotationDegrees: reportBuffer ? 0 : frame.rotationDegrees),
        "intrinsicsSource": frame.intrinsics.source,
        "orientation": frame.orientationName,
        "landmarks": NSNull()
      ]
      if let flattened = flattened {
        payload["landmarks"] = dmsSerializeLandmarks(
          flattened, rotationDegrees: reportBuffer ? 0 : frame.rotationDegrees)
      }

      self.stateLock.lock()
      self.processedInWindow += 1
      self.stateLock.unlock()

      self.delegate?.pipelineDidProduce(frame: payload)
    }
  }

  /// `(x, y, z) * 478` in the unrotated buffer frame, or nil when there is no usable face.
  private static func flatten(_ result: FaceLandmarkerResult?) -> [Float]? {
    guard let result = result,
          let face = result.faceLandmarks.first,
          face.count == kDmsNumLandmarks else {
      return nil
    }
    var out = [Float](repeating: 0, count: kDmsNumLandmarks * 3)
    for (index, point) in face.enumerated() {
      let x = point.x, y = point.y, z = point.z
      if !x.isFinite || !y.isFinite || !z.isFinite { return nil }
      out[index * 3 + 0] = x
      out[index * 3 + 1] = y
      out[index * 3 + 2] = z
    }
    return out
  }
}
