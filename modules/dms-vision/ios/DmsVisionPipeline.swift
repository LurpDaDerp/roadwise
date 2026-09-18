// Preview-free front-camera capture + MediaPipe FaceLandmarker (LIVE_STREAM).
//
// Design (docs/dms/NATIVE_LAYER.md):
//   * we own an AVCaptureSession with a single AVCaptureVideoDataOutput on a serial queue;
//     there is no AVCaptureVideoPreviewLayer and no view, so nothing in the React tree can
//     stop the session by being unmounted;
//   * the lowest format whose long side is >= 640 px at 30 fps, zoom 1.0, stabilization off
//     (it disables intrinsics delivery), mirroring off, connection rotation left at 0;
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
}

internal final class DmsVisionPipeline: NSObject {
  weak var delegate: DmsVisionPipelineDelegate?

  // Queues
  private let sessionQueue = DispatchQueue(label: "com.roadcash.dmsvision.session")
  private let videoQueue = DispatchQueue(label: "com.roadcash.dmsvision.video")

  // Session objects (sessionQueue)
  private var captureSession: AVCaptureSession?
  private var videoOutput: AVCaptureVideoDataOutput?

  // Cadence + frame bookkeeping (videoQueue only)
  private var targetFps: Double = 20
  private var idleFps: Double = 5
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
  private var landmarkerStorage: FaceLandmarker?

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
    let rotationDegrees: Int
    let orientationName: String
    let intrinsics: DmsIntrinsics
    let isMirrored: Bool
    /// Held so the CVPixelBuffer MediaPipe retained cannot be recycled before the result.
    let image: MPImage
  }

  // MARK: - Lifecycle

  func start(targetFps: Double, facing: String, landmarkFrame: String, rotationOffsetDegrees: Int) throws {
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

    // UIDevice.orientation is only populated after begin...Notifications() and must be read on
    // the main thread, so it is cached here and consumed on videoQueue. Until the first
    // notification arrives the cached default (portrait) applies.
    DispatchQueue.main.async {
      UIDevice.current.beginGeneratingDeviceOrientationNotifications()
      NotificationCenter.default.addObserver(self,
                                             selector: #selector(self.onDeviceOrientationChanged),
                                             name: UIDevice.orientationDidChangeNotification,
                                             object: nil)
      self.updateDeviceOrientation()
    }

    var thrown: Error?
    sessionQueue.sync {
      do {
        try self.configure()
        self.captureSession?.startRunning()
        self.stateLock.lock()
        self.running = true
        self.stateLock.unlock()
      } catch {
        thrown = error
      }
    }
    if let thrown = thrown {
      stop()
      throw thrown
    }
  }

  func stop() {
    stateLock.lock()
    running = false
    stateLock.unlock()

    sessionQueue.sync {
      self.captureSession?.stopRunning()
      self.captureSession = nil
      self.videoOutput = nil
      self.landmarker = nil
    }
    videoQueue.sync {
      self.inFlight = false
      self.pending = nil
      self.firstFrameSeconds = nil
      self.lastAcceptedSeconds = -1
      self.lastTimestampMs = -1
    }
    DispatchQueue.main.async {
      NotificationCenter.default.removeObserver(self,
                                                name: UIDevice.orientationDidChangeNotification,
                                                object: nil)
      UIDevice.current.endGeneratingDeviceOrientationNotifications()
    }
  }

  var isRunning: Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return running
  }

  func setTargetFps(_ fps: Double) {
    videoQueue.async { self.targetFps = max(1.0, min(30.0, fps)) }
  }

  func setIdleMode(_ idle: Bool) {
    videoQueue.async { self.idleMode = idle }
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

  func intrinsicsReport() -> [String: Any] {
    stateLock.lock()
    let intrinsics = lastIntrinsics
    let rotation = lastRotationDegrees
    let orientation = lastOrientationName
    let mirrored = lastIsMirrored
    stateLock.unlock()
    let upright = intrinsics.uprightSize(rotationDegrees: rotation)
    return [
      "focalScale": intrinsics.focalScale(rotationDegrees: rotation),
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
      "orientation": orientation,
      "isMirrored": mirrored
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
        let duration = CMTime(value: 1, timescale: 30)
        camera.activeVideoMinFrameDuration = duration
        camera.activeVideoMaxFrameDuration = duration
        camera.videoZoomFactor = 1.0
        camera.unlockForConfiguration()
      } catch {
        // Not fatal: the session keeps whatever format it negotiated.
      }
    }

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

    // Cadence throttle. The 2 ms slack absorbs capture jitter at an exact divisor of 30 fps.
    let cadence = idleMode ? idleFps : targetFps
    let minimumInterval = 1.0 / max(1.0, cadence)
    if lastAcceptedSeconds >= 0 && presentation - lastAcceptedSeconds < minimumInterval - 0.002 {
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
        "focalScale": frame.intrinsics.focalScale(rotationDegrees: frame.rotationDegrees),
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
