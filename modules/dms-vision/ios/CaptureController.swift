// The camera session, the per-frame feature pass and the native-owned lifecycle (README §6).
// Queues:
// - `sessionQueue`: start/stop/policy and every AVCaptureSession mutation;
// - `videoQueue`: frames, the landmarker results, the features and the batch.
// Shared state sits behind `lock`. Timers are wall-clock (`wallDeadline`), so they do not stall
// while the device sleeps.

import AVFoundation
import MediaPipeTasksVision
import UIKit

final class CaptureController: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  static let shared = CaptureController()

  var onFrames: (([String: Any]) -> Void)?
  var onState: ((String, String) -> Void)?
  var onStatus: (([String: Any?]) -> Void)?
  var onPreviewChange: ((AVCaptureSession?) -> Void)?

  let sessionQueue = DispatchQueue(label: "com.roadwise.dmsvision.session")
  let videoQueue = DispatchQueue(label: "com.roadwise.dmsvision.video")
  let tickQueue = DispatchQueue(label: "com.roadwise.dmsvision.tick")
  let lock = NSLock()

  // Guarded by `lock`.
  var state = "stopped"
  var token: String?
  var fps = 15
  var gazeNetWanted = false
  var gazeNetEvery = 1
  var setupMode = false
  var previewAllowed = false
  var lastHeartbeatMs = 0.0
  var pausedSinceMs: Double?
  var thermal = ThermalFloor()
  var orientation: UIDeviceOrientation = .portrait
  var processed = 0, dropped = 0
  var latLandmark = LatencyWindow(), latGaze = LatencyWindow(), latTotal = LatencyWindow()
  var lastStatus: [String: Any?]?
  var cpuPrevMs: Double?, cpuPrevWallMs = 0.0
  /// Created and closed on sessionQueue, read on videoQueue: hence under the lock.
  var landmarker: Landmarker?
  var gazeNet: GazeNetRunner?

  // sessionQueue only.
  var session: AVCaptureSession?
  var device: AVCaptureDevice?
  var tick: DispatchSourceTimer?

  // videoQueue only.
  let batcher = Batcher()
  let assembler = GazeInputAssembler()
  var inFlight: (tsMs: Int, pixel: CVPixelBuffer, ptsMs: Double, rotation: Int, submitMs: Double, focal: Double)?
  var lastAcceptedMs = -1.0
  var lastTsMs = -1
  var frameIndex = 0
  var fovDegrees = 70.0

  static func hostMs() -> Double { return CACurrentMediaTime() * 1000 }
  static func epochMs() -> Double { return Date().timeIntervalSince1970 * 1000 }

  func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

  var currentState: String { return locked { state } }

  // MARK: - Commands (sessionQueue)

  func start(token newToken: String, fps newFps: Int, gazeNet: Bool, every: Int, gpu: Bool, rotationOffset: Int) throws {
    let current = locked { (state, token) }
    if current.0 != "stopped" {
      guard current.1 == newToken else { throw DmsError.badArgs("a different gate token") }
      try applyPolicy(capture: "run", fps: newFps, gazeNet: gazeNet, every: every, setup: false, preview: false)
      return
    }
    locked {
      token = newToken; fps = newFps; gazeNetWanted = gazeNet; gazeNetEvery = every
      setupMode = false; previewAllowed = false; lastHeartbeatMs = CaptureController.hostMs(); pausedSinceMs = nil
      rotationOffsetDegrees = rotationOffset
    }
    setState("starting", "user")
    do {
      let lmk = try Landmarker(gpu: gpu) { [weak self] ts, lm, m, err in
        self?.videoQueue.async { self?.handleResult(ts, lm, m, err) }
      }
      var net: GazeNetRunner? = nil
      if gazeNet && GazeNetFactory.available {
        do { net = try GazeNetFactory.make() } catch { DmsLog.code(.gazeNetFailed) }
      }
      locked { landmarker = lmk; self.gazeNet = net }
      let made = try CaptureSetup.make(delegate: self, queue: videoQueue)
      session = made.session
      device = made.device
      fovDegrees = Double(made.device.activeFormat.videoFieldOfView)
      applyCadence()
      addObservers(made.session)
      videoQueue.sync { self.batcher.clear(); self.assembler.reset(); self.inFlight = nil; self.lastAcceptedMs = -1 }
      made.session.startRunning()
    } catch {
      teardown()
      setState("stopped", "error")
      throw error
    }
    startTick()
    let now = CaptureController.hostMs()
    locked { _ = thermal.observe(CaptureController.thermalName(), nowMs: now) }
    setState("running", "user")
    DmsLog.code(.sessionStarted)
    if !locked({ thermal.allowsCamera }) { pause("thermal") }
  }

  var rotationOffsetDegrees = 0

  func setPolicy(token given: String, capture: String, fps newFps: Int, gazeNet: Bool, every: Int, setup: Bool, preview: Bool) throws {
    let s = locked { (state, token) }
    if s.0 == "stopped" { throw DmsError.state("setPolicy while stopped") }
    guard s.1 == given else { throw DmsError.badArgs("gate token mismatch") }
    try applyPolicy(capture: capture, fps: newFps, gazeNet: gazeNet, every: every, setup: setup, preview: preview)
  }

  func applyPolicy(capture: String, fps newFps: Int, gazeNet: Bool, every: Int, setup: Bool, preview: Bool) throws {
    let st: String = locked {
      lastHeartbeatMs = CaptureController.hostMs()
      fps = newFps; gazeNetWanted = gazeNet; gazeNetEvery = every; setupMode = setup; previewAllowed = preview
      return state
    }
    if capture == "pause" {
      if st == "running" { pause("policy") }
    } else if st == "paused" {
      if locked({ thermal.allowsCamera }) { resume() }
    }
    applyCadence()
    updatePreview()
  }

  func stop(reason: String) {
    if currentState == "stopped" { return }
    teardown()
    setState("stopped", reason)
    DmsLog.code(reason == "background" ? .backgroundStopped : .sessionStopped)
  }

  func pause(_ reason: String) {
    flushBatch()
    session?.stopRunning()
    locked { pausedSinceMs = CaptureController.hostMs() }
    setState("paused", reason)
    updatePreview()
    DmsLog.code(reason == "thermal" ? .thermalPaused : .sessionPaused)
  }

  func resume() {
    locked { pausedSinceMs = nil }
    videoQueue.sync { self.inFlight = nil; self.lastAcceptedMs = -1 }
    session?.startRunning()
    setState("running", "policy")
    updatePreview()
    DmsLog.code(.sessionResumed)
  }

  func teardown() {
    stopTick()
    flushBatch()
    if let s = session { removeObservers(s); s.stopRunning() }
    session = nil
    device = nil
    let (lmk, net) = locked { () -> (Landmarker?, GazeNetRunner?) in
      let pair = (landmarker, gazeNet)
      landmarker = nil
      gazeNet = nil
      return pair
    }
    videoQueue.sync { self.inFlight = nil; self.batcher.clear() }
    lmk?.close()
    net?.close()
    locked { token = nil; pausedSinceMs = nil; setupMode = false; previewAllowed = false }
    updatePreview()
  }

  func setState(_ s: String, _ reason: String) {
    locked { state = s }
    onState?(s, reason)
  }

  func applyCadence() {
    guard let d = device else { return }
    let cap = locked { min(fps, thermal.fpsCap) }
    if cap > 0 { CaptureSetup.applyCadence(d, fps: Double(cap)) }
  }

  func updatePreview() {
    let show = locked { state == "running" && setupMode && previewAllowed }
    onPreviewChange?(show ? session : nil)
  }

  func flushBatch() {
    videoQueue.sync {
      if let payload = self.batcher.flush() { self.onFrames?(payload) }
    }
  }

  // MARK: - Frames (videoQueue)

  func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
    let (st, cap, offset, orient, landmarkerNow) = locked { (state, min(fps, thermal.fpsCap), rotationOffsetDegrees, orientation, landmarker) }
    guard st == "running", cap > 0, let lmk = landmarkerNow, let pixel = CMSampleBufferGetImageBuffer(sample) else { return }
    let ptsMs = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000
    guard ptsMs.isFinite else { return }
    let interval = 1000.0 / Double(cap)
    if lastAcceptedMs >= 0 && ptsMs - lastAcceptedMs < interval * 0.85 { return }
    if let f = inFlight {
      if ptsMs - f.ptsMs < 1000 { locked { dropped += 1 }; return }
      inFlight = nil
      locked { dropped += 1 }
    }
    let rotation = (((CaptureSetup.rotationDegrees(orient) + offset) % 360) + 360) % 360
    var tsMs = Int(ptsMs.rounded())
    if tsMs <= lastTsMs { tsMs = lastTsMs + 1 }
    lastTsMs = tsMs
    let focal = CaptureSetup.focalScale(sample, width: CVPixelBufferGetWidth(pixel), height: CVPixelBufferGetHeight(pixel),
                                        rotation: rotation, fovDegrees: fovDegrees)
    do {
      let image = try MPImage(pixelBuffer: pixel, orientation: CaptureSetup.imageOrientation(rotation))
      inFlight = (tsMs, pixel, ptsMs, rotation, CaptureController.hostMs(), focal)
      lastAcceptedMs = ptsMs
      try lmk.detect(image, timestampMs: tsMs)
    } catch {
      inFlight = nil
      locked { dropped += 1 }
    }
  }

  func handleResult(_ tsMs: Int, _ landmarks: [Double]?, _ matrix: [Double]?, _ error: String?) {
    guard let f = inFlight, f.tsMs == tsMs else { return }
    inFlight = nil
    if error != nil { locked { dropped += 1 }; return }
    guard locked({ state == "running" }) else { return }
    let latL = CaptureController.hostMs() - f.submitMs
    let (wantNet, every, netOk, netNow) = locked { (gazeNetWanted, gazeNetEvery, thermal.allowsGazeNet, gazeNet) }
    frameIndex += 1
    CVPixelBufferLockBaseAddress(f.pixel, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(f.pixel, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(f.pixel) else { return }
    let w = CVPixelBufferGetWidth(f.pixel), h = CVPixelBufferGetHeight(f.pixel)
    // Pixels are read through the buffer's own row stride, never w·4 (Task 2 review I1).
    let src = LumaSource(bytes: base.assumingMemoryBound(to: UInt8.self), width: w, height: h,
                         rowBytes: CVPixelBufferGetBytesPerRow(f.pixel), bgra: true)
    var netGaze: [Double]? = nil
    var cloud64: [Double]? = nil
    let gazeStart = CaptureController.hostMs()
    if wantNet && netOk, let net = netNow, let lm = landmarks, frameIndex % every == 0 {
      let (uw, uh) = Landmarks.uprightSize(w, h, f.rotation)
      if let p = assembler.prepare(Landmarks.toUpright(lm, f.rotation), Double(uw), Double(uh), f.focal) {
        cloud64 = p.cloud64
        netGaze = (try? net.run(cloud: p.cloud, context: p.context, validity: p.validity))?.gaze
      }
    }
    var record = FeatureExtractor.buildRecord(FrameInput(
      tMs: f.ptsMs, bufferW: w, bufferH: h, rotationDeg: f.rotation, luma: src, landmarks: landmarks,
      matrix: matrix, netGaze: netGaze, latLandmarkMs: max(0, latL), latTotalMs: 0))
    let gazeMs = CaptureController.hostMs() - gazeStart
    if let c = cloud64 {
      let flags = Int(record[F.flags])
      assembler.admit(c, f.ptsMs / 1000, earR: record[F.earR], earL: record[F.earL],
                      clippedR: flags & DmsConstants.FLAG_EYE_CLIPPED_R != 0, clippedL: flags & DmsConstants.FLAG_EYE_CLIPPED_L != 0)
    }
    let now = CaptureController.hostMs()
    record[F.latTotalMs] = max(0, now - f.ptsMs)
    locked {
      processed += 1
      latLandmark.add(latL)
      latTotal.add(record[F.latTotalMs])
      if netGaze != nil { latGaze.add(gazeMs) }
    }
    batcher.append(record, nowMs: now, epochNowMs: CaptureController.epochMs())
    if batcher.isDue(nowMs: now), let payload = batcher.flush() { onFrames?(payload) }
  }
}
